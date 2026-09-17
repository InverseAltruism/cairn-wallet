// Confirm-time hint-set cache helpers. The first review always runs full SPV (verifyNameUnion).
// Confirm may skip merkle/prevout IFF a CLEAN union (never M12 sole-recovery) was cached AND the
// freshly fetched sorted (txid, height) pairs match AND no source served lapsed:true AND the local
// header hash at each hinted height is unchanged AND the short TTL / tip-epoch bound still holds.
// Re-point still refuses: a new nset/nxfer changes the pair set, so we fall through to full verify.

export const HINTSET_TTL_MS = 120_000;

export type HintPair = { txid: string; height: number };

export interface HintSetEntry {
  name: string;
  pairs: HintPair[];
  hashes: Record<number, string>;
  addr: string;
  owner?: string;
  via?: string;
  depth?: number;
  ts: number;
  epoch: number;
}

export function sortHintPairs(hints: Iterable<{ txid: string; height: number }>): HintPair[] {
  return [...hints]
    .map((h) => ({ txid: String(h.txid).toLowerCase(), height: Number(h.height) }))
    .filter((h) => h.txid && Number.isInteger(h.height) && h.height >= 0)
    .sort((a, b) => (a.txid < b.txid ? -1 : a.txid > b.txid ? 1 : a.height - b.height));
}

export function hintPairsEqual(a: HintPair[], b: HintPair[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i]!.txid !== b[i]!.txid || a[i]!.height !== b[i]!.height) return false;
  }
  return true;
}

export function claimsMeta(
  claims: { addr?: string; lapsed?: boolean }[],
  provenAddr: string,
  conflict: boolean,
  existenceDisagree: boolean,
): { disagree: boolean; sources: number; anyLapsed: boolean } {
  const want = provenAddr.toLowerCase();
  let disagreeing = 0;
  let anyLapsed = false;
  for (const c of claims) {
    if (c.lapsed === true) anyLapsed = true;
    const a = c.addr ? String(c.addr).toLowerCase() : null;
    if (a !== want) disagreeing++;
  }
  return {
    disagree: disagreeing > 0 || conflict || existenceDisagree,
    sources: claims.length,
    anyLapsed,
  };
}

export async function evaluateHintSetSkip(opts: {
  cache: HintSetEntry | undefined;
  pairs: HintPair[];
  claims: { addr?: string; lapsed?: boolean }[];
  conflict: boolean;
  existenceDisagree: boolean;
  now: number;
  epoch: number | null;
  hashAt?: (height: number) => Promise<string | null>;
}): Promise<{ skip: true; disagree: boolean; sources: number } | { skip: false; reason: string }> {
  const { cache } = opts;
  if (!cache) return { skip: false, reason: "no reviewed hint-set" };
  if (opts.epoch == null || !Number.isFinite(opts.epoch)) return { skip: false, reason: "no tip epoch" };
  if (opts.now - cache.ts > HINTSET_TTL_MS) return { skip: false, reason: "ttl" };
  if (opts.epoch !== cache.epoch) return { skip: false, reason: "epoch" };
  if (!hintPairsEqual(cache.pairs, opts.pairs)) return { skip: false, reason: "hint-set" };
  const meta = claimsMeta(opts.claims, cache.addr, opts.conflict, opts.existenceDisagree);
  if (meta.anyLapsed) return { skip: false, reason: "lapsed" };
  if (!opts.hashAt) return { skip: false, reason: "no hashAt" };
  const heights = [...new Set(cache.pairs.map((p) => p.height))];
  for (const h of heights) {
    const live = await opts.hashAt(h);
    const want = cache.hashes[h];
    if (!live || !want || live.toLowerCase() !== want.toLowerCase()) return { skip: false, reason: "header-hash" };
  }
  return { skip: true, disagree: meta.disagree, sources: meta.sources };
}
