// Where a light client starts: one helper seeds it at a trusted top (the table's newest entry, a seal, the session
// pin, a rebase point) and carries the work base, so every client's held work counts from the light client's seed
// below the table's newest entry. And the choice of the seal to seed from. Design: cairn
// docs/Plans/91-evidence/wallet-wl2-design-2026-11-22.md, sections 1 (invariant 1), 3 and 4.
import { LightClient, verifyLinkedRecords, HEADER_BYTES, LWMA_WINDOW } from "../vendor/cairnx-spv.js";
import { SPV_CHUNK } from "./spvanchors.js";
import type { SealedChunk } from "./spvseal.js";

/** Records that seed a light client: the LWMA window below the trusted top plus the top itself. */
export const SEED = LWMA_WINDOW + 1;
type LcOpts = NonNullable<Parameters<typeof LightClient.fromRecords>[2]> & { checkpoints: Record<number, string> };
export interface Seeded { client: LightClient; failed?: { height: number; reason: string }; workBase: bigint }

export const chunkTop = (k: number): number => k * SPV_CHUNK + SPV_CHUNK - 1;
/** The highest chunk sealable at `tip`: its top at least SPV_CHUNK below the tip. */
export const sealableK = (tip: number): number => Math.floor((tip - 2 * SPV_CHUNK + 1) / SPV_CHUNK);

/**
 * A light client seeded at `top` (its hash `topHash`, the seed checked against it; a release table entry at `top` wins
 * over it) from `records`, the SEED records
 * ending at `top` followed by the records above it, which are ingested with every check. `work` is the chainwork at
 * `top` counted from the table seed, as seals and the session pin carry it; null when `top` is the table's newest
 * entry itself, whose own count is that base. The client's held work is `client.chainwork + workBase`.
 */
export async function seededClient(records: Uint8Array, top: number, topHash: string, work: bigint | null, opts: LcOpts): Promise<Seeded> {
  const r = await LightClient.fromRecords(records, { firstHeight: top - SEED + 1, anchorHeight: top }, { ...opts, checkpoints: { [top]: topHash, ...opts.checkpoints } });
  const atTop = r.client.chain[SEED - 1]!.chainwork;
  return { client: r.client, ...(r.failed ? { failed: r.failed } : {}), workBase: work === null ? 0n : work - atTop };
}

/**
 * The seed for a sealed restore: top-down, the highest sealed chunk whose stored bytes walk from the top below it
 * (the table hash for the first) to its own sealed top. An entry whose chunk is missing, short or holds other bytes
 * is skipped as absent. Null when none walks: the restore seeds at the table.
 */
export async function sealSeed(sealed: readonly SealedChunk[], tableHash: string, read: (k: number) => Promise<Uint8Array | null>): Promise<{ i: number; records: Uint8Array } | null> {
  for (let i = sealed.length - 1; i >= 0; i--) {
    const e = sealed[i]!;
    const records = await read(e.k);
    if (!records || records.length !== SPV_CHUNK * HEADER_BYTES) continue;
    try {
      verifyLinkedRecords(records, { firstHeight: e.k * SPV_CHUNK, prevHash: i ? sealed[i - 1]!.top : tableHash, lastHash: e.top, lastHeight: chunkTop(e.k) });
      return { i, records };
    } catch (err) { console.warn(`[namespv] stored chunk ${e.k} does not walk to its seal; verified without it:`, err); }
  }
  return null;
}
