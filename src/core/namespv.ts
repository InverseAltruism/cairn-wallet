// namespv.ts; trustless .csd name → address verification (XREPO-1 cure, Phase 5).
//
// THE THREAT: the wallet's resolveName() takes the resolver's `addr` verbatim. A hostile/MITM'd
// resolver can answer "alice.csd → 0xATTACKER" and the wallet would send funds there.
//
// THE CURE (reuses audited code, never re-types it): the wallet fetches the resolver's name-history
// HINTS (untrusted txids), then INDEPENDENTLY proves them against a PoW header chain it verified
// itself (the vendored LightClient), and re-runs the AUDITED CairnX resolver over the merkle-verified
// events. The recomputed (owner, addr) must equal what the resolver claimed; a server cannot fabricate
// a mapping it has no signed, mined events for.
//
//   per block touched: fetch it, rebuild EVERY tx, require merkleRoot(txids) == the PoW-verified
//                      header's merkle root (so a lying node can't omit/alter/add a committed tx body),
//                      then authenticate each relevant tx's SIGNER by its signature (the merkle root
//                      does NOT commit the scriptSig) and reconstruct the resolver ChainEvent.
//   then: resolve(events, verifiedTip).names[name]; the audited resolver, byte-for-byte.
//
// HONEST SCOPE (must NOT be overstated in the UI): this proves the mapping is backed by SPV-verified,
// correctly-signed, mined events AS SHOWN by the resolver's hint list. It defeats FABRICATION (the
// dominant hostile-resolver redirect; the attacker has no signed/mined events for 0xATTACKER). It does
// NOT by itself prove COMPLETENESS: the resolver chooses WHICH txids to show, and the wallet cannot prove
// it was shown ALL of a name's events. So a hostile resolver can WITHHOLD events to mislead the replay:
// two cases, both real:
//   (a) stale: hide a later nxfer/nset so an old (real) mapping looks current → routes to a prior owner.
//   (b) **competing-claim**: hide the legitimate owner's WINNING claim (lower effectiveHeight) and show
//       only an attacker's REAL, mined, fee-paid but LOSING `name` registration for the same name → the
//       replay sees only the attacker's claim → resolves to the ATTACKER's address → matches the hostile
//       resolver's claim → verified:true. NOT arbitrary (the attacker must have pre-registered + paid for
//       a losing claim on that exact name AND control/MITM the resolver) but it CAN route to an attacker.
// So "verified" means "chain-backed AS SHOWN", never "provably the current/winning mapping". The send UX
// keeps a loud caution for high-value sends; the COMPLETENESS cure is a second-source / multi-resolver
// cross-check (doc 34 §6 follow-on), still unbuilt. Everything here fails CLOSED: any gap, mismatch, or
// error returns verified:false with a reason; never a false pass against FABRICATION.
import { LightClient, CsdClient, rpcTxToTx, txid as ctxid, resolve, verifyLinkedRecords, serializeHeader, deserializeHeader, HEADER_BYTES, LWMA_WINDOW, type BlockHeader, type RpcTxJson } from "../vendor/cairnx-spv.js";
import { sortHintPairs, type HintPair } from "./namecache.js";
import { SPV_ANCHORS, SPV_CHUNK, SPV_FLOOR } from "./spvanchors.js";
import { ChunkLru, chunkAcquirer, chunkOf, chunkSpec, FIRST_CHUNK, type ChunkSpec, type HeaderStore, type StoreWrite } from "./headerstore.js";
import { readPin, walkToPin, latestTimeHolds, type PinSlot, type SpvPin } from "./spvpin.js";
import { bindBlock, bindSigner, toChainEvent, type ChainEvent } from "./spvbind.js";


export interface NameVerification {
  verified: boolean;          // true ⇒ the mapping is chain-backed AS SHOWN
  addr?: string;              // the chain-verified send target (use THIS when verified)
  owner?: string;
  via?: "nset" | "owner";
  depth?: number;             // confirmations of the most recent defining record
  reason?: string;            // fail-closed explanation when !verified
  // NSPV-CLAIMCAP-1 (H1): true when the winning record was acquired via an on-chain offer FILL/recapture
  // (cairnx resolver `viaFill`). Such ownership can depend on out-of-name-scope state (the V17 open-lane
  // claim cap is global over ALL offers; a name-for-token fill depends on the buyer's global token balance),
  // so a name-scoped SPV replay cannot soundly prove it. Surfaced so the UI never shows it as plain "verified".
  viaFill?: boolean;
  // Multi-source cross-check (NSPV-COMPLETE-1 cure, doc 36 Part B): how many resolvers (name sources) were
  // unioned, and whether any disagreed (a source whose stated claim ≠ the SPV-proven union winner; caught
  // + flagged; the send still goes to the proven winner). (D3: the `agreed` count and the `scope` label
  // were deleted; nothing in production read them; the badge reads sources/disagree/soleSource/viaFill.)
  sources?: number;
  disagree?: boolean;
  // WALLET-LAPSE-TIP-1: a lease-LAPSED verdict is only CONFIDENT (`lapsed:true`) when corroborated; a second
  // name source, or the persisted monotonic tip floor (a tip trusted across prior sessions) also
  // past expiry. An UNCORROBORATED single-source lapse degrades to CAUTION: `verified:false` + `lapsed` falsy
  // + a "may have lapsed" reason, so a fresh-install + MITM inflating the node tip cannot assert a false
  // confident lapse that hard-blocks a legit send. Fail-soft (availability valve), never a false green.
  lapsed?: boolean;
  // NS-1 (HIGH, RESIDUAL; not a closed defense): true when the union failed and only ONE source solo-
  // recovered the winner, so a lone (possibly hostile) source alone decided the send target; NOT
  // corroborated by another source. Surfaced so the badge stops asserting multi-source "chain-verified"; the
  // send still goes to the PROVEN winner (vetoing would drop back to the resolver-served address = the B5e
  // single-source DoS/trust regression). Real closure remains a genuinely-independent second source.
  soleSource?: boolean;
  // 0.2.70: true only on the M12 solo-recovery path. Confirm-time hint-set skip must NEVER
  // cache or skip merkle when this is set (advisor 2.4). Absent on a clean union success.
  recovered?: boolean;
  // Sorted (txid, height) pairs of the unioned hints that produced this verdict. Present on a
  // clean union success so the wallet can cache them for confirm-time skip. Omitted on M12.
  hintPairs?: { txid: string; height: number }[];
}

export interface NameClaim { addr?: string; owner?: string; via?: string; lapsed?: boolean }
export interface NameHint { txid: string; height: number; pos: number; kind?: string }
// A name-history source (resolver) to cross-check against. `base` ends at the trade-API root, e.g.
// "https://cairn-substrate.com/trade/api" or "https://clarvis.cairn-substrate.com/trade/api"; those two defaults
// have one operator, so they are not independent of each other (SECURITY.md).
export interface ResolverSource { label: string; base: string }
export interface SourceResult { label: string; ok: boolean; unregistered?: boolean; claim?: NameClaim; hints: NameHint[]; error?: string; scopedReplaySufficient?: boolean }
export interface NameUnionFetch {
  results: SourceResult[];
  usable: SourceResult[];
  pairs: HintPair[];
  hints: NameHint[];
  conflict: boolean;
  existenceDisagree: boolean;
  /** A source served a hint below the names floor; the hint was dropped and the verdict is flagged `disagree`. */
  belowFloor: boolean;
}

/** Fetch + union name-history hints (no merkle). Shared by verifyNameUnion and confirm-time skip. */
export async function fetchNameUnion(name: string, sources: ResolverSource[], fetchImpl: typeof fetch = fetch): Promise<NameUnionFetch> {
  const seen = new Set<string>();
  const uniq = sources.filter((s) => s.base && !seen.has(s.base.replace(/\/$/, "")) && seen.add(s.base.replace(/\/$/, "")));
  const fetched = await Promise.all(uniq.map((s) => fetchNameHistory(s, name, fetchImpl)));
  // No header below the names floor is stored or fetched, so such a hint cannot be proven. It is dropped rather
  // than refused: a refusal would let one source push every verify into per-source recovery.
  let belowFloor = false;
  const results = fetched.map((r) => {
    const kept = r.hints.filter((h) => !(Number.isInteger(Number(h.height)) && Number(h.height) < SPV_FLOOR.height));
    if (kept.length === r.hints.length) return r;
    belowFloor = true;
    return { ...r, hints: kept };
  });
  const usable = results.filter((r) => r.ok && r.hints.length > 0);
  const existenceDisagree = results.some((r) => r.unregistered);
  const byTxid = new Map<string, NameHint>();
  let conflict = false;
  for (const r of usable) for (const h of r.hints) {
    const k = String(h.txid).toLowerCase();
    const prev = byTxid.get(k);
    if (prev) { if (Number(prev.height) !== Number(h.height)) conflict = true; }
    else byTxid.set(k, h);
  }
  const hints = [...byTxid.values()];
  return { results, usable, pairs: sortHintPairs(hints), hints, conflict, existenceDisagree, belowFloor };
}

// The SPV data seam. Production wires the real LightClient (liveSpvSource); tests inject synthetic
// PoW-verified blocks so the merkle-bind + replay + fail-closed logic is exercised without a chain.
export interface SpvSource {
  // Ensure verified headers cover up to `maxEventHeight` (the name's most recent record; no need to
  // sync the whole chain to tip for an old, sparse name). Returns the PoW-VERIFIED tip actually reached
  // AND the (untrusted) node-reported chain tip used ONLY for the lease-lapse epoch (a deflated value is
  // the documented stale residual; an inflated one is fail-closed-safe, since a higher epoch ⇒ "lapsed").
  // `floorTip` (optional, WALLET-LAPSE-TIP-1): the persisted monotonic tip high-water as seeded from PRIOR
  // sessions; a tip we already trusted BEFORE this (possibly-MITM'd) session, EXCLUDING the current read.
  // Used ONLY to CORROBORATE a lease-lapse verdict: a lapse that also holds at floorTip is confident; one
  // that holds only at the current nodeTip degrades to caution. Omitted ⇒ no corroboration available.
  // `tipKnown` false: the node tip could not be read this call, so nothing was synced past the verified tip.
  prepare(maxEventHeight: number): Promise<{ verifiedTip: number; nodeTip: number; floorTip?: number; tipKnown?: boolean }>;
  // The PoW-VERIFIED merkle root for `height` + that block's node-JSON txs. THROWS if it cannot verify.
  blockAt(height: number): Promise<{ merkle: string; txs: RpcTxJson[] }>;
  // NSPV-SIGSUB-1 (H3): resolve the scriptPubkey of a record's spent prevout, BOUND to its txid; the
  // fetched source tx must recompute to `prevTxid` (the consensus txid commits its outputs incl. scriptPubkey),
  // reusing the TXB-1 fetch+recompute pattern. Lets replayName require that the recovered signer actually OWNS
  // the coin it spends (mirroring consensus / BIP-174), so a hostile node can't swap in a foreign valid
  // scriptSig to re-attribute a record. Returns the 0x-prefixed 20-byte scriptPubkey, or null on any
  // mismatch / unavailable / malformed body → the caller fails CLOSED.
  prevoutScriptPubkey(prevTxid: string, vout: number): Promise<string | null>;
  // 0.2.70: network-free reads of the already-verified header chain. Confirm-time hint-set
  // skip uses hashAt to refuse a skip when the local header at a hinted height has moved
  // (reorg / reseed). Omitted on synthetic sources that do not carry headers.
  hashAt?(height: number): Promise<string | null>;
  merkleAt?(height: number): Promise<string | null>;
  /** Where block bodies come from (the configured node RPC), named when a body does not match its header. */
  bodySource?: string;
  /** Where the verified headers come from (the Cairn API this source was built on), named beside bodySource. */
  headerSource?: string;
}

// Headers to sync past the last record so its inclusion proof has a confirmation cushion. The verifier
// never needs the full chain tip for inclusion; only up to the records it must prove.
const CONF_BUFFER = 12;

const fail = (reason: string): NameVerification => ({ verified: false, reason });

// Core SPV replay (no claim gate): SPV-verify `hints` against the chain and recompute the name's (owner,addr)
// via the AUDITED resolver. Shared by the single-source verifyName and the multi-source verifyNameUnion.
type Replay =
  | { ok: true; owner: string; addr: string; via: "nset" | "owner"; depth: number; viaFill: boolean }
  // WALLET-LAPSE-TIP-1: a lease-lapse failure carries `lapsed` + whether the persisted floor corroborated it,
  // so the caller can present a confident lapse vs a single-source caution. Other failures leave both unset.
  | { ok: false; reason: string; lapsed?: boolean; floorCorroborated?: boolean };
// Cap the hinted records a verify will SPV-prove (L8 / HINTDOS): each hint now also costs a prevout fetch
// (H3), so an unbounded attacker-chosen hint list could fan out into many round-trips. A real name has a
// handful of records; 256 is far above any honest history and bounds a hostile source's fetch amplification.
const MAX_HINTS = 256;
async function replayName(name: string, hints: NameHint[], src: SpvSource): Promise<Replay> {
  if (!Array.isArray(hints) || hints.length === 0) return { ok: false, reason: "no on-chain records were offered for this name" };
  if (hints.length > MAX_HINTS) return { ok: false, reason: `too many record hints for one name (>${MAX_HINTS}) — refusing` };
  // group hinted txids by block height; verify each block ONCE against its PoW-committed merkle root
  const byHeight = new Map<number, NameHint[]>();
  let maxHeight = 0;
  for (const h of hints) {
    const height = Number(h.height);
    if (!Number.isInteger(height) || height < 0) return { ok: false, reason: "a record hint has an invalid height" };
    (byHeight.get(height) ?? byHeight.set(height, []).get(height)!).push(h);
    if (height > maxHeight) maxHeight = height;
  }
  const { verifiedTip, nodeTip, floorTip } = await src.prepare(maxHeight);
  if (maxHeight > verifiedTip) return { ok: false, reason: `a record at height ${maxHeight} is above the verified tip (${verifiedTip})` };
  const lapseTip = Math.max(verifiedTip, Number.isFinite(nodeTip) ? nodeTip : 0);

  const events: ChainEvent[] = [];
  for (const [height, hs] of byHeight) {
    // FULL-block bind (throws if the header can't be PoW-verified); a body that fails it fails this replay.
    const bound = await bindBlock(src, height);
    if (!bound.ok) return { ok: false, reason: bound.reason };
    const { ids, rebuilt } = bound;
    for (const hint of hs) {
      const pos = ids.findIndex((x) => x.toLowerCase() === String(hint.txid).toLowerCase());
      if (pos < 0) return { ok: false, reason: `record ${hint.txid} is not in verified block ${height}` };
      const tx = rebuilt[pos], id = ids[pos];   // ids is rebuilt.map(ctxid): a found id has its body
      if (!tx || id === undefined) throw new Error(`block ${height}: no rebuilt body for ${hint.txid}`);
      // NSPV-SIGSUB-1 (H3): the signer must own the coin the record spends; each refusal keeps its own reason.
      const author = await bindSigner(tx, src);
      if (!author.ok) {
        const why = author.kind === "unsigned" ? "couldn't be authenticated (not a signed cairnx record)"
          : author.kind === "no-input" ? "has no spendable authenticating input"
          : "signer does not own the coin it spends (rejected possible scriptSig substitution)";
        return { ok: false, reason: `record ${hint.txid} ${why}` };
      }
      const ev = toChainEvent(tx, id, height, pos, author.signer);
      if (!ev) return { ok: false, reason: `record ${hint.txid} is not a cairnx app record` };
      events.push(ev);
    }
  }
  // Replay the AUDITED resolver over ONLY the verified events. `lapseTip` (≥ the node-reported chain tip,
  // monotonic-floored) drives the lease-lapse epoch fail-closed.
  const state = resolve(events, lapseTip);
  const rec = state.names[name];
  if (!rec) return { ok: false, reason: "the verified records don't establish ownership of this name" };
  if (rec.expired) {
    // WALLET-LAPSE-TIP-1: corroborate the lapse against the persisted tip FLOOR (a tip already trusted BEFORE
    // this; possibly MITM'd; session). Re-running the AUDITED resolver at floorTip re-derives "expired"
    // without any consensus math here; if the lease is expired even at that trusted lower-bound tip, the lapse
    // is confident. If it is expired ONLY at the current (claimed) nodeTip, the caller degrades it to caution
    // unless a second source corroborates; so an inflated fresh-install tip can't assert a false lapse.
    const floor = Number.isFinite(floorTip as number) ? Number(floorTip) : 0;
    const floorCorroborated = floor > 0 && resolve(events, floor).names[name]?.expired === true;
    return { ok: false, lapsed: true, floorCorroborated, reason: `${name}.csd lease has lapsed (per the chain) — refusing to send` };
  }
  // v2.5: a `pending` reservation is a payment-free registration/recapture reserve that has NOT been finalized:
  // it confers no address and is not an owned name yet. Fail CLOSED (never resolve it to the owner) so a name
  // that is only reserved, or whose promoting `nfinalize` is being withheld from the hint set, can never be a
  // send target. A finalized name is not pending (nfinalize clears the flag), so this only blocks true reserves.
  if (rec.pending) return { ok: false, reason: `${name}.csd is a reservation that has not been finalized on-chain yet — refusing to send` };
  return { ok: true, owner: String(rec.owner).toLowerCase(), addr: String(rec.addr ?? rec.owner).toLowerCase(), via: rec.addr ? "nset" : "owner", depth: Math.max(0, verifiedTip - maxHeight + 1), viaFill: !!rec.viaFill };
}

// D2 (register §3, 2026-09-12): the single-source verifyName twin is DELETED. It had zero production
// callers (names.ts verifyName and every resolve path go through verifyNameUnion below), it had already
// drifted from the union's behavior, and its existence let the test suite certify a function production
// never ran. The shared machinery (replayName, fail, toChainEvent) stays; the union uses it.

// Fetch one resolver's /cairnx/name-history. Fail-soft: any error → ok:false (the union tolerates a down source).
async function fetchNameHistory(s: ResolverSource, name: string, fetchImpl: typeof fetch): Promise<SourceResult> {
  try {
    const r = await fetchImpl(`${s.base.replace(/\/$/, "")}/cairnx/name-history/${encodeURIComponent(name)}`, { signal: AbortSignal.timeout(8000) });
    if (r.status === 404) return { label: s.label, ok: false, unregistered: true, hints: [] };
    if (!r.ok) return { label: s.label, ok: false, hints: [], error: `${r.status}` };
    const j: any = await r.json();
    if (!j?.ok) return { label: s.label, ok: false, hints: [], error: j?.error ?? "name-history unavailable" };
    // Capture the resolver's scopedReplaySufficient flag (cairnx `service.ts`): true = "a name-scoped replay
    // reproduces the same owner/addr as the full chain"; false = "ownership depends on out-of-name-scope state
    // (V17 open-lane claim cap / name-for-token balance); the wallet MUST fail closed". We HONOR a served
    // false but never TRUST a served true (the self-computed viaFill gate in verifyNameUnion is the real check).
    return { label: s.label, ok: true, hints: Array.isArray(j.events) ? j.events : [], claim: { addr: j.resolve?.addr, owner: j.resolve?.owner, via: j.resolve?.via, lapsed: j.resolve?.lapsed }, scopedReplaySufficient: typeof j.scopedReplaySufficient === "boolean" ? j.scopedReplaySufficient : undefined };
  } catch (e) { return { label: s.label, ok: false, hints: [], error: (e as Error)?.message ?? String(e) }; }
}

/**
 * NSPV-COMPLETE-1 cure (doc 36 Part B): verify `name → addr` against ≥2 name-history sources
 * (e.g. cairn-substrate.com + clarvis.cairn-substrate.com, which share one operator). Each source's hints are fetched, UNIONed by
 * lowercase txid, SPV-verified together against the wallet's own PoW header chain, and replayed by the
 * audited resolver to the true winner. Because every unioned event is SPV-authenticated, a source can only
 * ADD real events (filling another's omission); never fabricate; so the union defeats a WITHHOLDING
 * resolver as long as ONE source is honest (an attacker must make BOTH hosts withhold the SAME event, which
 * their common operator, or whoever controls both, can). The send target is the SPV-PROVEN union winner, and any source whose stated claim disagrees with
 * it is flagged. Fail-soft: 1 usable source → single-source (caution); ≥2 agree → strong; a disagreement is
 * flagged but the send still goes to the proven winner (the disagreeing source was lying/stale, not trusted).
 */
export async function verifyNameUnion(name: string, sources: ResolverSource[], src: SpvSource, fetchImpl: typeof fetch = fetch): Promise<NameVerification> {
  try {
    const { results, usable, pairs, hints, conflict, existenceDisagree, belowFloor } = await fetchNameUnion(name, sources, fetchImpl);
    if (usable.length === 0) {
      if (results.some((r) => r.unregistered)) return { ...fail(`${name}.csd is not registered`), sources: 0, disagree: false };
      return { ...fail("no on-chain records could be fetched for this name (name service unavailable)"), sources: 0, disagree: false };
    }
    // S-B6 (2026-09-09; DELETES the H1 pre-replay short-circuit): a source's clean 404 used to VETO the
    // union here, before any replay; and resolveName then fell through to serving the hint-serving
    // source's RAW (unproven) claim with a caution badge. That was strictly worse on both planes:
    // availability (a LAGGING second resolver 404s every brand-new name until it indexes, so routine
    // sends degraded to unverified) and trust (what got served was the raw claim, not the SPV-proven
    // winner). The replay itself is the existence check: fabricated events are not mined and fail SPV,
    // and a genuinely-unregistered name has no mined events to serve. The out-of-name-scope classes the
    // 404 veto was meant to catch (V17 claim cap / token-balance fills) stay fail-closed via the viaFill /
    // scopedReplaySufficient gates below; those are computed from OUR verified events, not a served flag.
    // So: replay, serve ONLY the proven winner, and carry the 404 as a `disagree` flag for the UI badge.
    // A throw here (one source's hint naming a block the SPV source cannot serve) is a failed replay like
    // any other, so per-source recovery below still runs instead of the outer catch aborting the verify.
    const rep: Replay = await replayName(name, hints, src).catch((e) => ({ ok: false as const, reason: `couldn't verify on-chain (fail-closed): ${(e as Error)?.message ?? e}` }));
    if (!rep.ok) {
      // WALLET-LAPSE-TIP-1: a lapse is CONFIDENT when corroborated; ≥2 name sources served the
      // events establishing the lease, OR the persisted tip floor is also past expiry. A lone usable source
      // with an uncorroborated (current-tip-only) lapse degrades to CAUTION, never a false confident lapse
      // from a fresh-install + MITM-inflated tip. Fail-soft (availability valve), never a false green.
      if (rep.lapsed) {
        const confident = usable.length >= 2 || rep.floorCorroborated === true;
        return confident
          ? { ...fail(rep.reason), sources: usable.length, disagree: false, lapsed: true }
          : { ...fail(`${name}.csd may have lapsed, but only one name source is available to confirm the chain tip — confirm out-of-band before sending`), sources: usable.length, disagree: false, lapsed: false };
      }
      // M12 (B5e): the UNIONED replay failed. A single hostile source can poison the combined hint set
      // with ONE junk hint (a txid not in its claimed block, an unauthenticated record), aborting the whole
      // replay; after which resolveName drops to the served address with only a caution badge, and that
      // address can come from the very source that poisoned it. Retry EACH source's hints ALONE (this runs
      // ONLY on the already-failed path, so it slows nothing that was working): a poisoned source still
      // fails on its own junk and drops out, while an honest source's own complete history replays to the
      // true winner. Honor it ONLY if every recovered source AGREES on the address (a genuine two-source
      // disagreement stays fail-closed) and none is a lapse/viaFill/scope-insufficient result (those keep
      // their own fail-closed handling). This cannot re-open the withholding gap: a source serving a
      // stale-but-clean subset that replays to a WRONG winner produces a disagreement and is refused.
      if (usable.length > 1) {
        type OkReplay = Extract<Replay, { ok: true }>;
        const recovered: { label: string; rep: OkReplay; claim?: NameClaim }[] = [];
        for (const r of usable) {
          const solo = await replayName(name, r.hints, src).catch(() => ({ ok: false as const, reason: "solo replay threw" }));
          if (solo.ok && !solo.viaFill && r.scopedReplaySufficient !== false) recovered.push({ label: r.label, rep: solo, claim: r.claim });
        }
        const addrs = new Set(recovered.map((p) => p.rep.addr));
        const first = recovered[0];
        if (first && addrs.size === 1) {
          const win = first.rep;
          let agreed = 0; for (const r of usable) { const c = r.claim?.addr ? String(r.claim.addr).toLowerCase() : null; if (c === win.addr) agreed++; }
          // NS-1: keep verified:true + the PROVEN winner addr (vetoing would drop resolveName back to the
          // RESOLVER-SERVED address = the B5e single-source DoS/trust regression, D2 K.5#3). But when only ONE
          // source solo-recovered the winner, that lone source (possibly the poisoner) alone decided the
          // target - it is NOT corroborated by another source. Surface `soleSource` so the badge stops asserting
          // multi-source "chain-verified". This is MITIGATION BY DISCLOSURE, not closure: a lone hostile
          // source still decides the send target (recorded residual). A recovery ALWAYS flags disagree.
          const soleSource = recovered.length === 1;
          return { verified: true, addr: win.addr, owner: win.owner, via: win.via, depth: win.depth, sources: usable.length, disagree: recovered.length < usable.length || agreed < usable.length || existenceDisagree || belowFloor, soleSource, viaFill: false, recovered: true };
        }
      }
      return { ...fail(rep.reason), sources: usable.length, disagree: false };
    }
    // NSPV-CLAIMCAP-1 (H1): never present a fill-acquired ("viaFill") name; or a name any usable source
    // flagged scopedReplaySufficient:false; as plain verified. Its ownership can hinge on out-of-name-scope
    // state (the V17 open-lane claim cap is global over ALL offers; a name-for-token fill depends on the
    // buyer's global token balance) that this name-scoped replay provably cannot reconstruct, and a second
    // honest source runs the IDENTICAL scoped selector, so the union cannot fill the gap. `viaFill` is
    // COMPUTED from our own SPV-verified events (we honor a served false but never TRUST a served true).
    // Fail CLOSED to caution. (B3 will re-green legitimately taker-bound purchases via self-derived binding.)
    const servedInsufficient = usable.some((r) => r.scopedReplaySufficient === false);
    if (rep.viaFill || servedInsufficient) {
      // Distinct, accurate reasons for the two triggers (QA-3): a self-computed viaFill winner vs a source
      // that explicitly reported its answer is not name-scope-provable. Both are fail-closed to caution.
      const reason = rep.viaFill
        ? `${name}.csd changed hands through a market sale, or was re-claimed after its lease lapsed, and the wallet can't confirm the new owner from the name's own records: confirm the address out-of-band before sending`
        : `a name source reported that ${name}.csd cannot be name-scope-proven (its replay may disagree with the full chain) — confirm the address out-of-band before sending`;
      return { ...fail(reason), sources: usable.length, disagree: false, viaFill: !!rep.viaFill };
    }
    // Cross-check: each usable source's STATED claim.addr against the SPV-proven union winner.
    // (D3 follow-through: the agreed COUNTER is gone; only the disagreement set feeds the flag.)
    const disagreeing: string[] = [];
    for (const r of usable) {
      const c = r.claim?.addr ? String(r.claim.addr).toLowerCase() : null;
      if (c !== rep.addr) disagreeing.push(r.label);
    }
    const disagree = disagreeing.length > 0 || conflict || existenceDisagree || belowFloor; // S-B6: a 404-ing source counts
    return { verified: true, addr: rep.addr, owner: rep.owner, via: rep.via, depth: rep.depth, sources: usable.length, disagree, viaFill: false, hintPairs: pairs };
  } catch (e) {
    return { ...fail(`couldn't verify on-chain (fail-closed): ${(e as Error)?.message ?? e}`), sources: 0, disagree: false };
  }
}

// ── production SPV source: the release anchor table, the header store and the PoW-verified suffix ───────
// Trust rule (cairn docs/Plans/86 section 3.2): a header at or below the newest table anchor is used only from a
// chunk whose records hash-link to two baked table hashes in this session; above it, only from the light client,
// seeded from that anchor's verified chunk and synced forward with every consensus check. Every table entry is a
// light-client checkpoint for the life of the release; nothing here removes, skips or overrides one.

/** The pre-0.2.99 chrome.storage.local header snapshot, read to migrate it into the store and then deleted. */
export interface LegacySnapshot {
  get(): Promise<unknown | null>;
  del(): Promise<void>;
  /** Bytes the snapshot occupies, or null when the storage area cannot say. */
  bytes(): Promise<number | null>;
  /** Failed migrations so far (a store that cannot be written); the snapshot is deleted after MIGRATE_MAX. */
  attempts: { get(): Promise<number>; set(n: number): Promise<void> };
}

export interface LiveSpvOpts {
  rpcBase: string;       // e.g. https://cairn-substrate.com/api/rpc  (CsdClient block/tx reads)
  headersBase: string;   // e.g. https://cairn-substrate.com          (/api/headers batch header source)
  /** The anchor table: the release table when absent; only a prefix of it is accepted (see anchorTable). */
  anchors?: readonly string[];
  /** Opens the IndexedDB header store; null, a throw or absence runs the session in memory. */
  store?: () => Promise<HeaderStore | null>;
  /** The legacy snapshot to migrate (section 3.8 of the plan). */
  legacy?: LegacySnapshot;
  // optional persisted node-tip high-water (NSPV-STALE-LAPSE / NAME-4). The monotonic floor below only
  // protects WITHIN a session; persisting it lets the floor survive MV3 service-worker restarts so a deflated
  // tip served on the first verify of a fresh session cannot roll lease-state back below a height we have
  // already trusted. A single integer, written (awaited) only when the observed tip ADVANCES, on the .csd
  // name-resolve path; off the send hot path; a write failure is swallowed (the floor just degrades to
  // within-session, the prior behaviour).
  floor?: { get(): Promise<number | null>; set(v: number): Promise<void> };
  /** The session pin (chrome.storage.session); without it a restore runs every consensus check. */
  pin?: PinSlot;
}

// M9 (B5a): the lapse-floor advance rule, ONE pure function so the clamp and its use-site cannot drift.
// The floor is a cross-session HIGH-WATER of the node tip whose job is to stop lapse-state ROLLBACK (a
// deflated tip on a fresh session). Persisting the RAW served tip made it hostile-INFLATABLE: one lying
// read became an unbounded monotonic lie, persisted forever, driving every later lease-expiry epoch and
// every guard the wallet clamps with the floor. The candidate is therefore clamped to
// verifiedTip + FLOOR_SLACK: the floor may never exceed PoW-verified evidence by more than the sync
// cushion the client already targets. Callers advance the floor only AFTER a successful LC.sync (a
// failed or lying sync advances nothing; a lying-high header chain throws in LC.sync, fail-closed).
// Coverage limit, stated not assumed away: the floor advances only inside prepare(), so a fresh install
// has floor 0 and any guard clamped by it is disarmed until the first successful verify; fail-open in
// the SAFE direction (no false refusal), same posture as WALLET-LAPSE-TIP-1.
export const FLOOR_SLACK = CONF_BUFFER;
export function floorAdvance(seenFloor: number, nodeTip: number, verifiedTip: number): number {
  const raw = Number.isFinite(nodeTip) ? nodeTip : 0;
  const cand = Math.min(raw, (Number.isFinite(verifiedTip) ? verifiedTip : 0) + FLOOR_SLACK);
  return cand > seenFloor ? cand : seenFloor;
}

// M8 (B5e): the transient-vs-STRUCTURAL sync-failure classifier, ONE exported source so prepare()'s catch
// and the test cannot drift. Transient (rate limit / gateway / timeout / non-dense range / a 200 with a
// non-JSON body) KEEPS the cache and rethrows fail-closed; a STRUCTURAL break (prev-link / PoW / bits / hash)
// reseeds. See prepare()'s catch for why the JSON-parse markers are transport, not chain, faults.
export function isTransientSyncError(msg: string): boolean {
  return /\b(429|50[0-9]|timeout|timed out|abort|aborted|headers|non-dense|failed to fetch|fetch failed|networkerror|load failed)\b/i.test(msg)
    || /unexpected (token|end)|json/i.test(msg);
}

const HB = HEADER_BYTES;
/** /api/headers page: sync and backfill requests start on a multiple of it, so finalized pages share edge-cached URLs. */
const PAGE = 512;
/** Records that seed the light client: the LWMA window below the anchor plus the anchor itself. */
const SEED = LWMA_WINDOW + 1;
interface AnchorTable { anchors: readonly string[]; newestK: number; newest: number; checkpoints: Readonly<Record<number, string>> }
/**
 * The anchor table a source runs on: the release table, or a prefix of it (tests and the acceptance harness, whose
 * header fixtures end below the newest entry). Any other table is refused, so this cannot add a hash the release
 * does not carry; a prefix only moves the newest anchor down, and the heights above it are forward-verified against
 * the full release checkpoint map (SPV_CHECKPOINTS), so a prefix removes no pin.
 */
function anchorTable(anchors: readonly string[] = SPV_ANCHORS): AnchorTable {
  // A longer table fails the comparison too: its extra entry compares against undefined.
  if (!anchors.length || anchors.some((h, i) => h !== SPV_ANCHORS[i])) {
    throw new Error("liveSpvSource: the anchor table must be the release table or a prefix of it");
  }
  const newestK = FIRST_CHUNK + anchors.length - 1;
  return {
    anchors, newestK, newest: newestK * SPV_CHUNK + SPV_CHUNK - 1,
    checkpoints: Object.freeze(Object.fromEntries([
      [SPV_FLOOR.height, SPV_FLOOR.hash],
      ...anchors.map((hash, i) => [(FIRST_CHUNK + i) * SPV_CHUNK + SPV_CHUNK - 1, hash]),
    ])),
  };
}
const RELEASE_TABLE = anchorTable();
/** The newest release anchor. Heights at or below it are read from verified chunks, heights above it from the light client. */
export const SPV_NEWEST = RELEASE_TABLE.newest;
/** Every release table entry, floor included, as light-client checkpoints. */
export const SPV_CHECKPOINTS = RELEASE_TABLE.checkpoints;
/** A legacy snapshot above this is absurd or hostile: it is deleted unread. */
export const LEGACY_MAX_BYTES = 200 * 1024 * 1024;
export const MIGRATE_MAX = 3;
/** The light client's wall-clock future-drift refusal (time > now + 2 h), the one refusal the user's clock can cause. */
const CLOCK_FAULT = /time too far in future/;

const tipOf = (lc: { baseHeight: number; chain: { length: number } }) => lc.baseHeight + lc.chain.length - 1;
const concatBytes = (parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};
const yieldTask = () => new Promise<void>((r) => setTimeout(r, 0));

function verifyChunk(records: Uint8Array, spec: ChunkSpec): void {
  verifyLinkedRecords(records, { firstHeight: spec.firstHeight, firstHash: spec.firstHash, prevHash: spec.prevHash, lastHash: spec.lastHash, lastHeight: spec.lastHeight });
}

const pinRefusal = (height: number, e: unknown) =>
  new Error(`the wallet could not match the chain to its built-in checkpoints (height ${height}); update the wallet or try again later. ${(e as Error)?.message ?? e}`);
// The header may also be forged (the time check runs before PoW), so the copy says what was seen, not who is wrong.
const clockRefusal = (detail: string) =>
  new Error(`a block header is dated more than 2 hours ahead of this computer's clock. If the clock is behind, set it correctly and try again (${detail})`);
// The light client's own reason ("invalid PoW at N") is logged, not shown.
const headersRefusal = (headersBase: string, verified: number) =>
  new Error(`the wallet could not verify the block headers from ${headersBase} above height ${verified}: they do not pass the chain's checks. Try again later.`);
const lessWorkRefusal = (headersBase: string, anchor: number, current: number) =>
  new Error(`the block headers from ${headersBase} above height ${anchor} carry less proof of work than the chain this wallet already verified to height ${current}; the wallet keeps its verified chain. Try again later.`);
const PIN_MISMATCH = /checkpoint mismatch at (\d+)/;

/**
 * The reseed rule: a replacement chain is adopted only when its cumulative work exceeds the current chain's, the
 * max-work rule the vendored `tryReorg` applies to a competing branch. Both clients are seeded from the same anchor
 * records, so the two totals are comparable. A tie keeps the current chain; the next honest block breaks it.
 */
export function reseedAdopts(current: { chainwork: bigint }, fresh: { chainwork: bigint }): boolean {
  return fresh.chainwork > current.chainwork;
}

/** The record at `h` of verified records, its hash (the next record's prev, or `lastHash` for the last) and merkle root. */
function chunkHeader(records: Uint8Array, spec: Pick<ChunkSpec, "firstHeight" | "lastHash">, h: number): { hash: string; merkle: string } {
  const i = h - spec.firstHeight;
  const n = records.length / HB;
  const merkle = deserializeHeader(records.subarray(i * HB, (i + 1) * HB)).merkle;
  const hash = i + 1 < n ? deserializeHeader(records.subarray((i + 1) * HB, (i + 2) * HB)).prev : spec.lastHash;
  return { hash: hash.toLowerCase(), merkle };
}

interface LegacyRecords { base: number; top: number; records(from: number, to: number): Uint8Array }

/** The v1 snapshot as records, or null when it is not one. Records are serialized per range, on demand. */
function legacyRecords(raw: unknown): LegacyRecords | null {
  const s = raw as { v?: unknown; baseHeight?: unknown; headers?: unknown } | null;
  if (!s || typeof s !== "object" || s.v !== 1 || !Array.isArray(s.headers) || !s.headers.length) return null;
  const base = Number(s.baseHeight);
  if (!Number.isSafeInteger(base) || base < 0) return null;
  const hs = s.headers as { height?: unknown; header?: unknown }[];
  return {
    base, top: base + hs.length - 1,
    records(from, to) {
      const out = new Uint8Array((to - from + 1) * HB);
      for (let h = from; h <= to; h++) {
        const e = hs[h - base];
        if (Number(e?.height) !== h) throw new Error(`legacy header snapshot is not contiguous at ${h}`);
        out.set(serializeHeader(e!.header as BlockHeader), (h - from) * HB);
      }
      return out;
    },
  };
}

// Storage failures around the legacy snapshot are warned and never fail the restore.
async function dropLegacy(l: LegacySnapshot, why: string, e?: unknown): Promise<void> {
  console.warn(`[namespv] legacy header snapshot ${why}; deleting it`, ...(e === undefined ? [] : [e]));
  try { await l.del(); } catch (d) { console.warn("[namespv] legacy header snapshot delete failed:", d); }
}
async function setAttempts(l: LegacySnapshot, n: number): Promise<void> {
  try { await l.attempts.set(n); } catch (e) { console.warn("[namespv] migration attempt count not saved:", e); }
}

async function readLegacy(l: LegacySnapshot): Promise<LegacyRecords | null> {
  let bytes: number | null = null;
  try { bytes = await l.bytes(); } catch (e) { console.warn("[namespv] legacy header snapshot size unavailable:", e); }
  if (bytes !== null && bytes > LEGACY_MAX_BYTES) { await dropLegacy(l, `is ${bytes} bytes, read nothing`); return null; }
  let raw: unknown = null;
  try { raw = await l.get(); } catch (e) { console.warn("[namespv] legacy header snapshot unreadable this start:", e); return null; }
  if (raw == null) return null;
  const lr = legacyRecords(raw);
  if (!lr) await dropLegacy(l, "is not a v1 snapshot");
  return lr;
}

/**
 * Builds the live SPV source: restore from the header store (section 3.5 of the plan), migrating the legacy
 * snapshot first when the store has no head (section 3.8). Restore reads the newest anchor's chunk (store or
 * 8 aligned requests) and the stored suffix above it, and no other history.
 */
export async function liveSpvSource(opts: LiveSpvOpts): Promise<SpvSource> {
  let store: HeaderStore | null = null;
  if (opts.store) {
    try { store = await opts.store(); }
    catch (e) { console.warn("[namespv] header store unavailable; running without it this session:", e); }
  }
  // A failed build is retried by the next caller with a new connection, so this one is released.
  try { return await restoreSpvSource(opts, store); }
  catch (e) {
    if (store) { acquirers.delete(store); store.close(); }
    throw e;
  }
}

async function restoreSpvSource(opts: LiveSpvOpts, store: HeaderStore | null): Promise<SpvSource> {
  const { anchors, newestK, newest } = anchorTable(opts.anchors);
  const boundFetch = (...a: Parameters<typeof fetch>) => fetch(...a);
  // timeoutMs 12s (> the /api/rpc proxy's 4s+6s failover worst case): the vendored client's 10s
  // default TIED the inner chain exactly; an abort could fire the instant the proxy's fallback
  // would have answered (timeout-inversion class, docs/Plans/66 B2).
  // No parseJson: the client's default, parseJsonExact, keeps a Propose's u64 expires_epoch above 2^53 exact, so the
  // txid recompute of a block body or a prevout source tx carrying one still matches (test/spv-poison-e2e.test.mjs).
  const client = new CsdClient({ baseUrl: opts.rpcBase.replace(/\/$/, ""), fetch: boundFetch, timeoutMs: 12_000 });
  const headersBase = opts.headersBase.replace(/\/$/, "");
  // The /api/headers endpoint is budget-limited (DOS-HDR-1) and deadline-bounded (it answers a clean
  // 502 at ~10s instead of grinding on a slow indexer). A legit cold sync paces itself:
  //  - 429 (budget) → sleep the server's own Retry-After hint (capped 15s; it says when the window
  //    resets; the old fixed 1.2s×n ladder maxed ~25s and could NOT span a 60s budget window);
  //  - 502/503 (deadline/data-availability hiccup) → short ladder retry: our aborted request left
  //    stragglers warming the server's header cache, so the retry is cheap and usually instant.
  // Every retried header is still fully re-verified (PoW/prev-link/LWMA) downstream; retrying
  // transport carries zero trust. After bounded retries we still THROW → verify fails closed.
  // Client timeout 15s sits ABOVE the server's 10s deadline (the server answers first by design).
  const headersBatch = async (from: number, count: number) => {
    for (let attempt = 0; ; attempt++) {
      const r = await fetch(`${headersBase}/api/headers/${from}/${count}`, { signal: AbortSignal.timeout(15_000) });
      if (r.status === 429 && attempt < 6) {
        const ra = Number(r.headers.get("retry-after")) || 0;
        await sleep(Math.min(ra > 0 ? ra * 1000 : 1200 * (attempt + 1), 15_000));
        continue;
      }
      if ((r.status === 502 || r.status === 503) && attempt < 6) { await sleep(1200 * (attempt + 1)); continue; }
      if (!r.ok) throw new Error(`/api/headers ${r.status}`);
      const rows = (await r.json())?.headers;
      if (!Array.isArray(rows) || rows.length !== count) throw new Error("/api/headers: non-dense range");
      // Served JSON: the light client checks every header (links, PoW, LWMA) before it is used.
      return rows.map((row: { header: BlockHeader; hash: string }) => ({ header: row.header, hash: row.hash }));
    }
  };
  // A request that ends on a page top fetches the whole page: every row of it is at or below the sync target,
  // so it exists whenever the sync can succeed at all.
  const pageBatch = async (from: number, count: number) => {
    const a = from - (from % PAGE);
    if (a !== from && from + count === a + PAGE) return (await headersBatch(a, PAGE)).slice(from - a);
    return headersBatch(from, count);
  };
  const lcOpts = { client, headersBatchProvider: pageBatch, checkpoints: SPV_CHECKPOINTS as Record<number, string> };

  const fetchChunk = async (spec: ChunkSpec): Promise<Uint8Array> => {
    const out = new Uint8Array((spec.lastHeight - spec.firstHeight + 1) * HB);
    for (let p = spec.firstHeight - (spec.firstHeight % PAGE); p <= spec.lastHeight; p += PAGE) {
      const rows = await headersBatch(p, PAGE);
      for (let i = Math.max(0, spec.firstHeight - p); i < PAGE; i++) {
        try { out.set(serializeHeader(rows[i]?.header as BlockHeader), (p + i - spec.firstHeight) * HB); }   // a short batch lands in the catch
        catch (e) { throw new Error(`chunk ${spec.k} (heights ${spec.firstHeight} to ${spec.lastHeight}) failed verification: the header served at ${p + i} is malformed (${(e as Error)?.message ?? e})`); }
      }
    }
    return out;
  };

  // BP4/N11: one serializer for every light-client mutation and every chunk acquisition, so concurrent consumers
  // of this shared source never interleave ingests and never fetch one chunk twice. A serialized op must never
  // await `acquire` (it would wait on itself), which is why the anchor chunk is held below.
  const serializeSync = makeSerializer();
  const lru = new ChunkLru(8);
  const acq = chunkAcquirer({ store, lru, anchors, serialize: serializeSync, verify: verifyChunk, fetchChunk });
  if (store) acquirers.set(store, acq);
  const acquire = async (height: number) => {
    try { return await acq.acquire(height); }
    catch (e) {
      const spec = chunkSpec(chunkOf(height), anchors);
      if (spec && /failed verification/.test(String((e as Error)?.message))) throw pinRefusal(spec.lastHeight, e);
      throw e;
    }
  };

  // ── restore ──
  const keys = store ? await store.listChunks().catch((e) => { console.warn("[namespv] header store listing failed:", e); return [] as number[]; }) : [];
  const head = store ? await store.getHead().catch(() => null) : null;
  let legacy = opts.legacy ? await readLegacy(opts.legacy) : null;
  let migrateError: unknown = null;
  if (legacy && !head) {
    // Chunk presence is the truth: a chunk already stored is kept (it is walked whenever it is read).
    try {
      for (let k = FIRST_CHUNK; k <= newestK && legacy; k++) {
        const spec = chunkSpec(k, anchors)!;
        if (spec.firstHeight < legacy.base || spec.lastHeight > legacy.top || (keys.includes(k) && k !== newestK)) continue;
        let recs: Uint8Array;
        try { recs = legacy.records(spec.firstHeight, spec.lastHeight); verifyChunk(recs, spec); }
        catch (e) { await dropLegacy(opts.legacy!, `failed at chunk ${k}, the wallet seeds from the table`, e); legacy = null; break; }
        if (k === newestK) lru.set(k, recs);
        if (store && !keys.includes(k)) await store.write({ put: [{ k, records: recs }] });
        await yieldTask();
      }
    } catch (e) { migrateError = e; }
  }
  const anchorSpec = chunkSpec(newestK, anchors)!;
  const anchor = (await acquire(newest)).records;
  const stored: Uint8Array[] = [];
  for (let k = newestK + 1; store && keys.includes(k); k++) {
    let r: Uint8Array | null = null;
    try { r = await store.getChunk(k); } catch (e) { console.warn(`[namespv] stored chunk ${k} unreadable; the sync refetches it:`, e); }
    if (!r || !r.length || r.length % HB || r.length > SPV_CHUNK * HB) break;
    stored.push(r);
    if (r.length < SPV_CHUNK * HB) break;
  }
  const storedSuffix = concatBytes(stored);
  const storedTip = newest + storedSuffix.length / HB;
  let fromLegacy: Uint8Array = new Uint8Array(0);
  if (legacy && legacy.base <= storedTip + 1 && legacy.top > storedTip) {
    try { fromLegacy = legacy.records(storedTip + 1, legacy.top); }
    catch (e) { console.warn("[namespv] legacy header snapshot suffix unreadable; the sync refetches it:", e); }
  }
  // A worker restart in a browser session that already verified the stored suffix walks it to the session pin,
  // re-runs the time rules on the walked record with the latest timestamp against today's clock, and seeds the light
  // client at the pin; anything stored above the pin is ingested with every check.
  const pin = opts.pin && !fromLegacy.length ? await readPin(opts.pin) : null;
  const latest = pin && pin.tip - newest >= SEED && pin.tip <= storedTip ? await walkToPin(storedSuffix, newest, pin, SPV_CHECKPOINTS, yieldTask) : null;
  // Heights newest - SEED + 1 to newest + n in one view: the anchor's seed records, then the stored suffix.
  const seedAndSuffix = (lo: number, hi: number) => {
    const tail = anchor.subarray(anchor.length - SEED * HB), from = lo - (newest - SEED + 1), to = hi - (newest - SEED + 1) + 1;
    return concatBytes([tail.subarray(Math.min(from, SEED) * HB, Math.min(to, SEED) * HB), storedSuffix.subarray(Math.max(0, from - SEED) * HB, Math.max(0, to - SEED) * HB)]);
  };
  const pinned = latest !== null && await latestTimeHolds(seedAndSuffix(latest - SEED, latest), latest - SEED, SPV_CHECKPOINTS); // MUTATE_PIN_TIME
  const pinBase = pin && pinned ? pin.tip - SEED + 1 : newest - SEED + 1;
  const restored = pin && pinned
    ? await LightClient.fromRecords(storedSuffix.subarray((pinBase - newest - 1) * HB), { firstHeight: pinBase, anchorHeight: pin.tip },
      { ...lcOpts, checkpoints: { ...SPV_CHECKPOINTS, [pin.tip]: pin.hash } })
    : await LightClient.fromRecords(
      concatBytes([anchor.subarray(anchor.length - SEED * HB), storedSuffix, fromLegacy]),
      { firstHeight: newest - SEED + 1, anchorHeight: newest }, lcOpts);
  let LC = restored.client;
  // The walked records below a pin-seeded client (heights newest + 1 to LC.baseHeight - 1), and the work they and
  // the anchor seed carry, so heldWork() compares with a client seeded from the anchor. Both empty otherwise.
  let walked: Uint8Array = pin && pinned ? storedSuffix.subarray(0, (pinBase - newest - 1) * HB) : new Uint8Array(0);
  let workBase = pin && pinned ? BigInt(pin.work) - LC.chain[pin.tip - LC.baseHeight]!.chainwork : 0n;
  const heldWork = () => ({ chainwork: LC.chainwork + workBase });
  // The pin may run ahead of a detached store write; a store that does not walk to it gets the full restore.
  const writePin = (tip: number) => {
    const vh = LC.chain[tip - LC.baseHeight];
    if (!opts.pin || !vh || tip - newest < SEED || (pin && pin.tip === tip && pin.hash === String(vh.hash).toLowerCase())) return;
    const next: SpvPin = { v: 1, newest, tip, hash: String(vh.hash).toLowerCase(), work: (vh.chainwork + workBase).toString() };
    opts.pin.set(next).catch((e) => console.warn("[namespv] session pin not saved:", e));
  };
  // The highest height whose stored record equals the light client's. A record that failed for any reason
  // but the clock is rewritten or deleted by the next persist; a clock fault leaves the store as it is.
  let persistedTip = Math.min(storedTip, tipOf(LC));
  if (restored.failed) {
    console.warn(CLOCK_FAULT.test(restored.failed.reason)
      ? `[namespv] restore stopped at ${restored.failed.height}: ${clockRefusal(restored.failed.reason).message}`
      : `[namespv] restore stopped at ${restored.failed.height} (${restored.failed.reason}); the sync refetches from there`);
  }

  // One write for every chunk from the one holding persistedTip + 1 to the tip, the head, and the deletion of
  // anything stored above the tip, so after it lands the stored suffix is exactly the light client's.
  const suffixWrite = (): StoreWrite | null => {
    const tip = tipOf(LC);
    if (!store || tip <= persistedTip) return null;
    const lo = Math.max(chunkOf(persistedTip + 1) * SPV_CHUNK, newest + 1);
    const own = LC.toRecords(Math.max(lo, LC.baseHeight));
    const recs = lo >= LC.baseHeight ? own : concatBytes([walked.subarray((lo - newest - 1) * HB), own]);
    const put: { k: number; records: Uint8Array }[] = [];
    for (let k = chunkOf(lo); k <= chunkOf(tip); k++) {
      const a = Math.max(k * SPV_CHUNK, lo), b = Math.min(k * SPV_CHUNK + SPV_CHUNK - 1, tip);
      put.push({ k, records: recs.subarray((a - lo) * HB, (b - lo + 1) * HB) });
    }
    persistedTip = tip;
    writePin(tip);
    return { put, deleteAbove: chunkOf(tip), head: { v: 2, tip, tipHash: String(LC.chain[LC.chain.length - 1]!.hash).toLowerCase() } };
  };
  const persist = () => { const w = suffixWrite(); if (w) detachStoreWrite(store!, w); };

  if (opts.legacy && legacy) {
    const before = persistedTip;
    try {
      if (!store) throw new Error("no header store this session");
      if (migrateError) throw migrateError;
      const w = suffixWrite() ?? { head: { v: 2 as const, tip: tipOf(LC), tipHash: String(LC.chain[LC.chain.length - 1]!.hash).toLowerCase() } };
      await store.write(w);
      const back = await store.getHead();
      if (back?.tip !== w.head!.tip || back.tipHash !== w.head!.tipHash) throw new Error("the header store head did not read back");
      try { await opts.legacy.del(); } catch (d) { console.warn("[namespv] migrated legacy header snapshot not deleted; retried next start:", d); }
      await setAttempts(opts.legacy, 0);
    } catch (e) {
      persistedTip = before;
      const n = (Number(await opts.legacy.attempts.get().catch(() => 0)) || 0) + 1;
      if (n >= MIGRATE_MAX) {
        await dropLegacy(opts.legacy, `could not be migrated ${n} times, the session runs from memory`, e);
        await setAttempts(opts.legacy, 0);
      } else {
        console.warn(`[namespv] header store migration failed (attempt ${n} of ${MIGRATE_MAX}); retried next start:`, e);
        await setAttempts(opts.legacy, n);
      }
    }
  }

  if (!legacy) writePin(persistedTip);

  // Seeds a fresh client from the anchor chunk held in memory: no request, every pin enforced by seedTrusted.
  const seedFromAnchor = async () => (await LightClient.fromRecords(anchor.subarray(anchor.length - SEED * HB), { firstHeight: newest - SEED + 1, anchorHeight: newest }, lcOpts)).client;

  // The verified header at `h`: from a walked chunk at or below the newest anchor, from the light client above it.
  const headerAt = async (h: number): Promise<{ hash: string; merkle: string } | null> => {
    if (!Number.isSafeInteger(h) || h < SPV_FLOOR.height) return null;
    if (h > newest) {
      if (h < LC.baseHeight) return chunkHeader(walked, { firstHeight: newest + 1, lastHash: String(LC.chain[0]!.header.prev) }, h);
      const vh = LC.chain[h - LC.baseHeight];
      return vh ? { hash: String(vh.hash).toLowerCase(), merkle: String(vh.header.merkle) } : null;
    }
    if (chunkOf(h) === newestK) return chunkHeader(anchor, anchorSpec, h);
    const { spec, records } = await acquire(h);
    return chunkHeader(records, spec, h);
  };
  const headerOrNull = async (h: number) => {
    try { return await headerAt(h); }
    catch (e) { console.warn(`[namespv] no verified header at ${h}:`, e); return null; }
  };

  let seenFloor = 0;
  if (opts.floor) { try { const f = Number(await opts.floor.get()); if (Number.isFinite(f) && f > 0) seenFloor = f; } catch { /* no persisted floor → start at 0 */ } }
  // WALLET-LAPSE-TIP-1: freeze the floor as seeded from PRIOR sessions, BEFORE any current-session read
  // advances seenFloor. This is the trusted-across-sessions tip used ONLY to corroborate a lease-lapse
  // verdict (replayName re-runs the audited resolver at it). On a fresh install it is 0 → a lapse rests on
  // the current node tip alone → caution; on an established install it is high → a genuine lapse is confident.
  const persistedFloor = seenFloor;

  return {
    async prepare(maxEventHeight: number) {
      let nodeTip = 0;
      try { nodeTip = Number((await client.tip())?.height); } catch { /* node tip unknown → lapse uses the floor / verified tip */ }
      const tipKnown = Number.isSafeInteger(nodeTip) && nodeTip > 0;
      // Inclusion only needs headers up to the record + cushion (kept cheap; an old, sparse name does not
      // pay a full chain sync). LC.sync re-derives PoW+LWMA per header, so a lying-high cushion fails closed.
      // An unknown tip syncs nothing: there is no height the chain is known to reach.
      const want = tipKnown ? Math.min(nodeTip, maxEventHeight + CONF_BUFFER) : tipOf(LC);
      // The tip is re-read inside the serializer, so a sync another consumer already did is a no-op here.
      await serializeSync(async () => {
        const cur = tipOf(LC);
        if (want <= cur) return;
        try {
          await syncWithPartialPersist(LC, want, persist);
          await syncAligned(LC, want);                  // a lying-high header THROWS here (fail-closed)
        } catch (e) {
          // Verified progress is kept before the failure is classified; it never advances the lapse floor,
          // which moves only after this block completes.
          persist();
          const msg = String((e as Error)?.message || e);
          if (CLOCK_FAULT.test(msg)) throw clockRefusal(msg);
          if (isTransientSyncError(msg)) throw e;
          // A structural break (a reorg orphaned the stored tip): reseed from the anchor chunk and sync the served
          // chain again. The stored suffix is replaced only once the new one has verified up to `want`.
          const fresh = await seedFromAnchor();
          try {
            await syncAligned(fresh, want);
            // `want` can sit far below the node tip (a name's record height plus the cushion), where an honest
            // winning branch may still hold less work than the held branch has at its tip; the comparison is
            // made at the node tip in that case, so the refusal below is never an artefact of a low `want`.
            if (!reseedAdopts(heldWork(), fresh) && tipKnown && nodeTip > tipOf(fresh)) await syncAligned(fresh, nodeTip); // MUTATE_RESEED_TO_TIP
          } catch (e2) {
            const m2 = String((e2 as Error)?.message || e2);
            if (CLOCK_FAULT.test(m2)) throw clockRefusal(m2);
            if (isTransientSyncError(m2)) throw e2;
            // Nothing served links to the newest anchor: a reorg deeper than it, a wrong table entry or another chain.
            if (tipOf(fresh) === newest) throw pinRefusal(newest, e2);
            const pinned = PIN_MISMATCH.exec(m2);
            if (pinned) throw pinRefusal(Number(pinned[1]), e2);
            console.warn(`[namespv] served headers above ${tipOf(fresh)} failed verification:`, m2);
            throw headersRefusal(headersBase, tipOf(fresh));
          }
          // A valid chain with no more work than the one held (a fork decayed to low difficulty with spread
          // timestamps) is not adopted; the held chain and its stored suffix stay.
          if (!reseedAdopts(heldWork(), fresh)) throw lessWorkRefusal(headersBase, newest, tipOf(LC)); // MUTATE_RESEED_WORK
          LC = fresh;
          walked = new Uint8Array(0);
          workBase = 0n;
          persistedTip = newest;
        }
        persist();
      });
      // M9 (B5a): advance + persist the floor ONLY after the sync above succeeded (a throw skips this),
      // and never above verifiedTip + FLOOR_SLACK (floorAdvance). The RETURNED nodeTip still carries the
      // raw served tip for THIS session's lapse epoch (pre-existing design: a lying-high tip only makes
      // leases look expired sooner, over-caution; deflation is floored); only what the wallet TRUSTS
      // ACROSS SESSIONS is clamped to PoW evidence.
      const verifiedTip = tipOf(LC);
      const cand = floorAdvance(seenFloor, nodeTip, verifiedTip);
      if (cand > seenFloor) { seenFloor = cand; if (opts.floor) { try { await opts.floor.set(seenFloor); } catch { /* persist best-effort */ } } }
      // Report the floored tip so verifyName's lapse epoch (max(verifiedTip, nodeTip)) can only move FORWARD.
      // floorTip is the PRIOR-session high-water (WALLET-LAPSE-TIP-1), for lapse corroboration only.
      return { verifiedTip, nodeTip: Math.max(seenFloor, tipKnown ? nodeTip : 0), floorTip: persistedFloor, tipKnown };
    },
    async blockAt(height: number) {
      const vh = await headerAt(height);
      if (!vh) throw new Error(`no PoW-verified header at ${height}`);
      const b = await client.blockByHeight(height);
      return { merkle: vh.merkle, txs: b.txs };
    },
    bodySource: opts.rpcBase.replace(/\/$/, ""),
    headerSource: headersBase,
    async hashAt(height: number) { return (await headerOrNull(height))?.hash ?? null; },
    async merkleAt(height: number) { return (await headerOrNull(height))?.merkle ?? null; },
    // NSPV-SIGSUB-1 (H3): fetch a record's spent prevout and bind it to its txid exactly as verifyInputValues
    // (TXB-1) does; fetch the source tx, recompute its consensus txid, and require it == prevTxid (the txid
    // commits every output incl. its 20-byte scriptPubkey). A hostile node cannot serve a fake body whose
    // recomputed txid still matches the outpoint. Returns the 0x scriptPubkey, or null (→ fail-closed) on any
    // missing / not-yet-mined / mismatched / malformed body. Same untrusted-node read path as blockAt.
    async prevoutScriptPubkey(prevTxid: string, vout: number) {
      try {
        const body = (await client.tx(prevTxid))?.tx;
        if (!body) return null;
        const tx = rpcTxToTx(body);
        if (String(ctxid(tx)).toLowerCase() !== String(prevTxid).toLowerCase()) return null; // forged source body
        const out = tx.outputs?.[vout];
        if (!out) return null;
        const a = String(out.scriptPubkey ?? "").toLowerCase().replace(/^0x/, "");
        return /^[0-9a-f]{40}$/.test(a) ? "0x" + a : null;
      } catch { return null; }
    },
  };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Store writes leave the serialized sync and the click path: one chained writer per store, and a write that
// arrives while another is pending is merged into it by chunk key, so a burst of advances costs one transaction
// and no chunk a pending write carried is lost. A write error is warned, never a refusal: every chunk is
// verified when it is read, and a missing one is refetched.
const storeWriters = new Map<HeaderStore, { tail: Promise<void>; busy: boolean; pending: StoreWrite | null }>();
const acquirers = new Map<HeaderStore, { writes(): Promise<void> }>();

/** `newer` after `older` as one write: newer's puts and head win, and older's puts above newer's deleteAbove are dropped. */
export function mergeStoreWrites(older: StoreWrite, newer: StoreWrite): StoreWrite {
  if (older.del?.length || newer.del?.length) throw new Error("mergeStoreWrites: suffix writes carry no del");
  const put = new Map<number, Uint8Array>();
  for (const p of older.put ?? []) if (newer.deleteAbove === undefined || p.k <= newer.deleteAbove) put.set(p.k, p.records);
  for (const p of newer.put ?? []) put.set(p.k, p.records);
  const deleteAbove = newer.deleteAbove ?? older.deleteAbove;
  const head = newer.head ?? older.head;
  return { put: [...put].map(([k, records]) => ({ k, records })), ...(deleteAbove !== undefined ? { deleteAbove } : {}), ...(head ? { head } : {}) };
}

export function detachStoreWrite(store: HeaderStore, w: StoreWrite): void {
  let s = storeWriters.get(store);
  if (!s) storeWriters.set(store, s = { tail: Promise.resolve(), busy: false, pending: null });
  const st = s;
  st.pending = st.pending ? mergeStoreWrites(st.pending, w) : w;
  if (st.busy) return;
  st.busy = true;
  st.tail = st.tail.then(async () => {
    try {
      while (st.pending) {
        const job = st.pending;
        st.pending = null;
        try { await store.write(job); }
        catch (e) { console.warn("[namespv] header store write failed (the sync refetches next session):", e); }
      }
    } finally { st.busy = false; }
  });
}

/** Test hook: settles when every detached header-store write issued so far has finished. */
export async function flushSpvStoreWrites(): Promise<void> {
  await Promise.all([...[...storeWriters.values()].map((s) => s.tail), ...[...acquirers.values()].map((a) => a.writes())]);
}

// Serialize async operations so they never OVERLAP, while each caller still awaits its own operation and sees
// its own result/error. A prior rejection is swallowed for chaining ONLY (the rejecting caller still gets its
// error); it never wedges the chain. BP4/N11: the wallet shares ONE light client across name-verify AND the
// fill lanes, so two consumers can call prepare() -> LC.sync() concurrently; LightClient.ingest asserts strict
// height order and THROWS "out-of-order ingest" on an interleave -> a spurious fail-closed decline on a
// legitimate action. Serializing the SYNC (not the whole consumer) removes the interleave while keeping the
// block reads (blockAt, which never syncs) fully parallel. EXPORTED for a direct unit test.
export function makeSerializer(): <T>(op: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(op: () => Promise<T>): Promise<T> => {
    const run = tail.then(op, op);   // run AFTER the prior settles, regardless of its outcome
    tail = run.catch(() => { /* the chain settles either way, so a failed op does not block the ops queued after it */ });
    return run;                      // the caller sees THIS op's own result/error
  };
}

/** Syncs to `want` one /api/headers page at a time, each request ending on a page top or at `want`. */
export async function syncAligned(lc: { baseHeight: number; chain: { length: number }; sync(to: number): Promise<unknown> }, want: number): Promise<void> {
  for (let cur = tipOf(lc); cur < want; cur = tipOf(lc)) await lc.sync(Math.min(want, cur + 1 - ((cur + 1) % PAGE) + PAGE - 1));
}

// BP8b (N10 wallet-half / N14): a long sync persists its verified progress every SYNC_PERSIST_WINDOW headers, so a
// rate-limited (429'd) or interrupted cold sync, even in a service worker killed mid-backoff, resumes from the
// stored suffix next time and bills only the remaining span. The final leg to `want` stays at the call site,
// whose catch persists a mid-window tail before failing closed. Only the persistence timing changes, never
// what a restore trusts: a restored suffix is re-verified record by record (fromRecords). This function never
// touches the lapse floor, and a persist failure is the store writer's (warned, refetched next session).
// A daily sync (about 720 headers) never enters the loop. EXPORTED, with a structural lc type, for a direct test.
export const SYNC_PERSIST_WINDOW = 8192;
export async function syncWithPartialPersist(
  lc: { baseHeight: number; chain: { length: number }; sync(to: number): Promise<unknown> },
  want: number,
  persist: (() => void) | null,
): Promise<void> {
  for (let next = tipOf(lc) + SYNC_PERSIST_WINDOW; next < want; next += SYNC_PERSIST_WINDOW) {
    await syncAligned(lc, next);       // throws on any verify/transport failure (fail-closed, caller classifies)
    persist?.();
  }
}
