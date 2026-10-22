// Name resolution for sends to a .csd name: the resolver's answer, verified against the chain by the wallet's
// own SPV source and the second source (namespv.ts), and the confirm-time hint-set skip (namecache.ts).
import { isPlainName } from "./cairnx.js";
import { EPOCH_LEN } from "../vendor/cairnx-spv.js";
import { verifyNameUnion, fetchNameUnion, type NameVerification, type SpvSource, type ResolverSource } from "./namespv.js";
import { evaluateHintSetSkip, sortHintPairs, type HintSetEntry } from "./namecache.js";
import { CLARVIS_TRADE_API } from "./endpoints.js";

// What resolveName and confirmName answer: a refusal (ok false, with error), or the address to send to and how
// far it was verified.
export type NameResolution = { ok: boolean; name?: string; addr?: string; via?: string; owner?: string; lapsed?: boolean; error?: string; verified?: boolean; verifyReason?: string; depth?: number; sources?: number; disagree?: boolean; soleSource?: boolean; viaFill?: boolean };
// What name resolution reads through the wallet. verifyName is called through the wallet so an instance override
// applies (test/resolve-lapse-corroborate replaces it to test the resolve logic without SPV). spvGen is bumped on
// every endpoint change: a verification that began under an older value caches nothing.
export interface NameIo {
  tradeGet(path: string): Promise<Response>;
  tip(): Promise<number | null>;
  spvSource(): Promise<SpvSource>;
  verifyName(name: string): Promise<NameVerification & { name: string }>;
  tradeApi(): string;
  spvGen(): number;
  nameHints(): Map<string, HintSetEntry>;
}

// Normalize a .csd name for lookup/verify: lowercase and strip a trailing ".csd".
const normName = (name: unknown): string => String(name || "").toLowerCase().replace(/\.csd$/, "");

// Forward resolution for "send to a .csd name". Fail-CLOSED on a lapsed/expired lease so the
// popup never routes funds to a name's stale address. Returns the nset addr if set, else the
// owner (so a name works as a recipient even before its holder sets a resolver record).
export async function resolveName(wallet: NameIo, name: string): Promise<NameResolution> {
  const nm = normName(name);
  // XREPO-1 hardening (audit nit D): validate the name against the convention's NAME_RE BEFORE
  // interpolating it into the resolver URL; a name with `/`, `..`, `%`, or query chars must never
  // reach the path. (encodeURIComponent is belt-and-braces.) A non-name can't be a real .csd name.
  if (!isPlainName(nm)) return { ok: false, error: `${nm} is not a valid .csd name` };
  try {
    // Base-claim fetch with clarvis FALLBACK (2026-07-09): a primary-resolver outage used to block
    // EVERY name send with "name lookup failed" even though clarvis, the second source, could
    // answer; and the SPV verifyName below is the trust anchor either way (the base answer is
    // UNTRUSTED no matter which source served it, so falling back is no weaker). Only a definitive
    // 404 from the source that answered short-circuits; network/5xx tries the second source.
    let r: Response | null = null;
    try { r = await wallet.tradeGet(`/cairnx/resolve/${encodeURIComponent(nm)}`); } catch { r = null; } // 12s (> the proxy's 10s upstream): recipient path fails clean
    if (r && r.status === 404) return { ok: false, error: `${nm}.csd is not registered` };
    if (!r || !r.ok) {
      try {
        // 12s like the primary: clarvis fronts the same cairn proxy shape (10s upstream wait).
        const c = await fetch(`${CLARVIS_TRADE_API}/cairnx/resolve/${encodeURIComponent(nm)}`, { signal: AbortSignal.timeout(12000) });
        // Only accept a POSITIVE answer from the fallback; a 404 from a degraded/withholding second
        // source is NOT trustworthy enough to definitively claim "not registered" (fail-closed to the
        // retryable "name lookup failed" below instead; the primary being down is transient).
        if (c.ok) r = c;
      } catch { /* both sources down; fall through to the honest failure */ }
    }
    if (!r || !r.ok) return { ok: false, error: "name lookup failed" };
    const j = await r.json();
    if (j?.lapsed) {
      // N19 (B5b): do NOT hard-refuse on a single source's SERVED `lapsed` flag; that short-circuit
      // fired BEFORE the SPV union, so the two-source lapse corroboration (WALLET-LAPSE-TIP-1) could
      // never see the claim it exists to corroborate, and one hostile/buggy primary could permanently
      // block sends to a healthy name. Consult the union: chain proves the lease CURRENT -> serve the
      // PROVEN answer (the served flag was false); union corroborates the lapse -> refuse with
      // confidence; union unavailable -> keep today's fail-closed refusal, with honest uncorroborated
      // copy. A real lapse still refuses exactly as before; this only removes the FALSE refusal.
      const lv = await wallet.verifyName(nm).catch(() => null);
      if (lv?.verified && lv.addr)
        return { ok: true, name: nm, addr: lv.addr, via: j.via, owner: j.owner, lapsed: false, verified: true, depth: lv.depth, sources: lv.sources, disagree: lv.disagree, soleSource: lv.soleSource };
      return lv?.lapsed === true
        ? { ok: false, lapsed: true, error: `${nm}.csd lease has lapsed — can't send to it` }
        : { ok: false, lapsed: true, error: `${nm}.csd: the resolver reports the lease lapsed, but this couldn't be confirmed on-chain — refusing to send to a possibly-stale address (try again, or check the name on the explorer)` };
    }
    if (!j?.addr || !/^0x[0-9a-f]{40}$/.test(String(j.addr).toLowerCase())) return { ok: false, error: `${nm}.csd has no address` };
    const base = { ok: true as const, name: nm, addr: String(j.addr).toLowerCase(), via: j.via, owner: j.owner, lapsed: false };
    // XREPO-1 cure: independently SPV-verify the name → address against the chain. The resolver's
    // answer above is UNTRUSTED; the union serves the chain-PROVEN winner (never the served claim),
    // flagging any source disagreement on the result; an unavailable verifier returns the served
    // address with a caution flag (never silently "verified"). (D2: the old single-source
    // "does NOT match / hostile resolver" refusal branch is deleted; the union replaced that
    // refusal with serve-the-proven-winner + disagree, so no emitted reason ever matched it.)
    const v = await wallet.verifyName(nm).catch(() => null);
    if (v?.verified && v.addr) return { ...base, addr: v.addr, verified: true, depth: v.depth, sources: v.sources, disagree: v.disagree, soleSource: v.soleSource };
    // NS-2: gate on the PROVEN lapse, not a served flag. A resolver that OMITS `lapsed` but serves an
    // address for a genuinely-lapsed name reaches here; verifyName's union already computed the lapse
    // (resolve(events, lapseTip).expired, corroborated by the persisted floor at namespv.ts). Refuse a
    // CONFIDENT lapse exactly as the served-flag branch does. An UNCORROBORATED lapse is left to the
    // fall-through caution below (the WALLET-LAPSE-TIP-1 availability valve: never hard-block on an
    // uncorroborated lapse that could be a MITM-inflated tip on a fresh install).
    if (v?.lapsed === true) return { ok: false, lapsed: true, error: `${nm}.csd has lapsed, so we did not send. Send to the owner's 0x address directly, or ask them to renew the name before sending again.` }; // MUTATE_NS2_PROVEN_LAPSE
    // Surface viaFill (NSPV-CLAIMCAP-1 / H1) so the UI shows the specific "acquired by fill; not name-scope
    // provable" caution rather than the generic "couldn't verify" one. Still verified:false (fail-closed).
    return { ...base, verified: false, verifyReason: v?.reason ?? "on-chain verification unavailable", viaFill: v?.viaFill === true };
  } catch { return { ok: false, error: "name lookup failed" }; }
}

// XREPO-1: trustlessly SPV-verify a .csd name → address against a PoW header chain the wallet verifies
// itself, replaying the AUDITED resolver over merkle-verified records (see core/namespv.ts). Returns the
// fail-closed tri-state. Called by resolveName; not exposed on the popup or dApp channel.
export async function verifyName(wallet: NameIo, name: string): Promise<NameVerification & { name: string }> {
  const nm = normName(name);
  if (!isPlainName(nm)) return { verified: false, reason: `${nm} is not a valid .csd name`, name: nm };
  try {
    // Cross-check the user's configured primary resolver against the clarvis second source (same operator as
    // the default primary, so not independent of it; NSPV-COMPLETE-1 cure, doc 36 Part B). verifyNameUnion
    // fetches name-history from each, unions the SPV-verified events, and resolves to the chain-proven winner:
    // defeating a withholding resolver.
    const gen = wallet.spvGen();
    const src = await wallet.spvSource();
    const res = await verifyNameUnion(nm, nameSources(wallet), src);
    try { await rememberHintSet(wallet, nm, res, src, gen); } catch { /* cache write is fail-soft: never downgrade a green verify */ }
    return { ...res, name: nm };
  } catch (e) {
    return { verified: false, reason: `on-chain verification unavailable (${(e as Error)?.message ?? e})`, name: nm };
  }
}

// Confirm-time cheap path (0.2.70): skip merkle/prevout only when a clean (non-M12) review
// cache exists AND the freshly fetched hint pairs + header hashes + TTL/epoch still match.
// Else fall through to resolveName (full SPV). Re-point still refuses via reresolveUnchanged.
export async function confirmName(wallet: NameIo, name: string): Promise<NameResolution> {
  const nm = normName(name);
  if (!isPlainName(nm)) return { ok: false, error: `${nm} is not a valid .csd name` };
  try {
    const skipped = await tryConfirmHintSet(wallet, nm);
    if (skipped) return skipped;
  } catch { /* fall through to full resolve */ }
  return resolveName(wallet, nm);
}

function nameSources(wallet: NameIo): ResolverSource[] {
  return [{ label: "primary", base: wallet.tradeApi() }, { label: "clarvis", base: CLARVIS_TRADE_API }];
}

// `src` and `gen` are the ones `res` was verified with: the cached hashes come from that source, and a
// verification superseded by an endpoint change caches nothing.
async function rememberHintSet(wallet: NameIo, nm: string, res: NameVerification, src: SpvSource, gen: number): Promise<void> {
  // Advisor 2.4: cache ONLY a clean union success. Never M12 recovered / soleSource / viaFill / lapse.
  if (!res.verified || !res.addr || res.recovered || res.soleSource || res.viaFill || res.lapsed === true) return;
  const pairs = res.hintPairs && res.hintPairs.length ? sortHintPairs(res.hintPairs) : null;
  if (!pairs || !pairs.length) return;
  if (!src.hashAt) return;
  const hashes: Record<number, string> = {};
  for (const p of pairs) {
    const h = await src.hashAt(p.height);
    if (!h) return;
    hashes[p.height] = h.toLowerCase();
  }
  const tip = await wallet.tip();
  if (tip == null || !Number.isFinite(tip) || gen !== wallet.spvGen()) return;
  wallet.nameHints().set(nm, {
    name: nm, pairs, hashes, addr: res.addr, owner: res.owner, via: res.via, depth: res.depth,
    ts: Date.now(), epoch: Math.floor(tip / EPOCH_LEN),
  });
}

async function tryConfirmHintSet(wallet: NameIo, nm: string): Promise<{ ok: true; name: string; addr: string; via?: string; owner?: string; lapsed: false; verified: true; depth?: number; sources: number; disagree: boolean; soleSource: false; viaFill: false } | null> {
  const gen = wallet.spvGen();
  const cache = wallet.nameHints().get(nm);
  if (!cache) return null;
  const bundle = await fetchNameUnion(nm, nameSources(wallet));
  if (!bundle.usable.length) return null;
  const src = await wallet.spvSource();
  const tip = await wallet.tip();
  const verdict = await evaluateHintSetSkip({
    cache,
    pairs: bundle.pairs,
    claims: bundle.usable.map((r) => r.claim ?? {}),
    conflict: bundle.conflict,
    existenceDisagree: bundle.existenceDisagree,
    belowFloor: bundle.belowFloor,
    now: Date.now(),
    epoch: tip == null ? null : Math.floor(tip / EPOCH_LEN),
    hashAt: src.hashAt ? (h) => src.hashAt!(h) : undefined,
  });
  if (!verdict.skip || gen !== wallet.spvGen()) return null;
  return {
    ok: true, name: nm, addr: cache.addr, via: cache.via, owner: cache.owner, lapsed: false,
    verified: true, depth: cache.depth, sources: verdict.sources, disagree: verdict.disagree,
    soleSource: false, viaFill: false,
  };
}
