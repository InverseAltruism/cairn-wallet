// The session pin: the newest stored header the light client verified in this browser session, kept in
// chrome.storage.session (memory only, cleared when the browser closes). A service-worker restart in the same
// session restores the stored suffix by a hash walk to the pin instead of re-running every consensus check on it;
// a browser start finds no pin and runs them all. Trust argument: docs/DESIGN-namespv-scaling.md, "Session pin".
import { LightClient, verifyLinkedRecords, deserializeHeader, HEADER_BYTES, LWMA_WINDOW } from "../vendor/cairnx-spv.js";
import { SPV_CHUNK } from "./spvanchors.js";

/** `work` is the decimal chainwork at `tip`, counted from the light client's seed below the anchor at `newest`. */
export interface SpvPin { v: 1; newest: number; tip: number; hash: string; work: string }
export interface PinSlot { get(): Promise<unknown>; set(pin: SpvPin): Promise<void> }

export function parsePin(raw: unknown): SpvPin | null {
  const p = raw as SpvPin | null;
  if (!p || typeof p !== "object" || p.v !== 1) return null;
  if (!Number.isSafeInteger(p.newest) || !Number.isSafeInteger(p.tip) || p.tip <= p.newest) return null;
  if (typeof p.hash !== "string" || !/^0x[0-9a-f]{64}$/.test(p.hash) || typeof p.work !== "string" || !/^[0-9]{1,40}$/.test(p.work)) return null;
  return { v: 1, newest: p.newest, tip: p.tip, hash: p.hash, work: p.work };
}

/** The pin, or null when the slot is empty, unreadable or holds anything else. */
export async function readPin(slot: PinSlot): Promise<SpvPin | null> {
  try { return parsePin(await slot.get()); }
  catch (e) { console.warn("[namespv] session pin unreadable; full restore:", e); return null; }
}

/**
 * When the records of `suffix` from height newest + 1 up to `pin.tip` hash-link from the table hash at `newest` to
 * `pin.hash`, and `checkpoints` holds no entry in that range (the walk checks none): the height of the walked record
 * with the latest timestamp (the first such), for `latestTimeHolds`. Else null, and the caller runs the full
 * restore. One run of SPV_CHUNK records per task.
 */
export async function walkToPin(suffix: Uint8Array, newest: number, pin: SpvPin, checkpoints: Readonly<Record<number, string>>, yieldTask: () => Promise<void>): Promise<number | null> {
  const HB = HEADER_BYTES;
  const n = pin.tip - newest;
  const anchorHash = checkpoints[newest];
  if (pin.newest !== newest || !anchorHash || n < 1 || suffix.length < n * HB) return null;
  if (Object.keys(checkpoints).some((h) => Number(h) > newest && Number(h) <= pin.tip)) return null;
  let prev = anchorHash, latest = newest + 1, latestTime = -1;
  for (let i = 0; i < n; i += SPV_CHUNK) {
    const end = Math.min(n, i + SPV_CHUNK);
    const lastHash = end === n ? pin.hash : deserializeHeader(suffix.subarray(end * HB, (end + 1) * HB)).prev;
    try { verifyLinkedRecords(suffix.subarray(i * HB, end * HB), { firstHeight: newest + 1 + i, prevHash: prev, lastHash }); }
    catch (e) { console.warn("[namespv] stored headers do not walk to the session pin; full restore:", e); return null; }
    for (let j = i; j < end; j++) {
      const t = Number(deserializeHeader(suffix.subarray(j * HB, (j + 1) * HB)).time);
      if (t > latestTime) { latestTime = t; latest = newest + 1 + j; }
    }
    prev = lastHash;
    await yieldTask();
  }
  return latest;
}

/**
 * Restore parity for the one check the walk does not repeat, the time rules against today's clock (the future-drift
 * bound). `records` are heights firstHeight to firstHeight + LWMA_WINDOW + 1, hash-linked already; the vendored light
 * client seeds the first LWMA_WINDOW + 1 against the last one's prev and ingests the last with every check (verifyOne,
 * the drift bound included). The drift bound only falls with the timestamp, so the walked record with the latest
 * timestamp passes it exactly when every walked record does. False on any failure: the caller runs the full restore.
 */
export async function latestTimeHolds(records: Uint8Array, firstHeight: number, checkpoints: Readonly<Record<number, string>>): Promise<boolean> {
  const HB = HEADER_BYTES, seed = LWMA_WINDOW + 1;
  if (records.length !== (seed + 1) * HB) return false;
  const anchorHeight = firstHeight + seed - 1;
  const anchorHash = checkpoints[anchorHeight] ?? deserializeHeader(records.subarray(seed * HB)).prev;
  try {
    const { failed } = await LightClient.fromRecords(records, { firstHeight, anchorHeight }, { checkpoints: { ...checkpoints, [anchorHeight]: anchorHash } });
    if (failed) console.warn(`[namespv] a stored header fails the time rules now (${failed.reason}); full restore`);
    return !failed;
  } catch (e) { console.warn("[namespv] stored header time check failed; full restore:", e); return false; }
}
