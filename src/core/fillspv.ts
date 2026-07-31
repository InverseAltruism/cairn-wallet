// fillspv.ts — the LIVE production FillSpvIo for the V28 open-lane (fclaim) fill fund boundary.
//
// The pure fail-closed verdict lives in the vendored cairnx-core `verifyFillSpv` (src/vendor/cairnx-spv.js,
// §31/B4): it re-derives the ENTIRE fclaim grant + hold from PoW-buried, MERKLE-PROVEN events and NEVER
// trusts a served "granted" flag, because a resolver-DENIED fclaim is an L0-valid but delivery-less attest
// target (filling it BURNS the payment). All of that surface's chain access flows through an injected
// `FillSpvIo` seam; this file wires the REAL one over the wallet's PoW-verified light client, reusing the
// audited namespv `liveSpvSource` (tip / merkle-verified block bodies / prevout-ownership bind) so the
// crypto-critical header + merkle verification is the same reviewed code the name path already ships.
//
// COMPLETENESS is a seam obligation the pure layer cannot verify: a WITHHELD real event (a prior live hold,
// a consuming fill, a cancel) makes the replay see the offer as MORE open than it is and would false-accept a
// denied fclaim. So `offerEventIds` derives the evidence from PoW-verified BLOCK BODIES over a TIP-ANCHORED
// window (never a resolver-supplied height, which a hostile source could inflate to shift the window past a
// prior hold), NOT a resolver hint list. Any gap/mismatch/error THROWS → the preflight fails CLOSED.
import {
  rpcTxToTx, txid as ctxid, sighash, merkleRoot, recoverSigner as recoverSig, paidToFromOutputs, parseRecord,
  fclaimHoldEnd, MAX_SCAN, EPOCH_LEN, FCLAIM_MAX_EPOCH_AHEAD, SCORE_CLAIM, CLAIM_WINDOW_BLOCKS_V20, CLAIM_FILL_GRACE_BLOCKS,
  deploy, mint, nameClaim, isNameGive, MAX_AMOUNT, DEPLOY_FEE, TREASURY_ADDR, DOMAIN, V11_HEIGHT, V28_HEIGHT, ACTIVATION_HEIGHT,
  provenOfferTerms,
  type RpcTxJson, type Tx, type FillSpvIo, type ProvenEvent, type ProvenPropose, type ProvenOfferTerms, type MintedProvenOfferTerms,
} from "../vendor/cairnx-spv.js";
import { liveSpvSource, type LiveSpvOpts, type SpvSource } from "./namespv.js";

// B4a (REBIND W2): the fee/rebate term derivation is SINGLE-SOURCED in the vendored cairnx-core
// (`provenOfferTerms` + `feeBpsAt`, verifyfill.ts) - this file used to carry its own hand copies of
// both (a fifth `feeBpsAt` duplication and one of four hand-built ProvenOfferTerms producers), the
// exact drift class W2 exists to kill. Corpus-equivalence over every real on-chain offer (55) plus
// synthetic envelope variants proved the old copies byte-identical to canonical before the swap
// (test/proven-terms-corpus.test.mjs pins it forever). Re-exported so tests and wallet.ts keep one
// import site; the re-export is a POINTER, never a re-declaration.
export { feeBpsAt, type ProvenOfferTerms, type MintedProvenOfferTerms } from "../vendor/cairnx-spv.js";

// A fclaim hold lasts at most MAX_HOLD_SPAN blocks past its grant (a grant at an epoch's first block with
// ee = epochOf(h)+2 holds through h+89). A FILLABLE fclaim is within its hold (verifyFillSpv's deadline guard),
// so its grant height is at most MAX_HOLD_SPAN below the tip. LEGACY_MAX_HOLD = the widest pre-V28 legacy claim
// hold (window + fill grace); a legacy claim older than this is provably lapsed.
const MAX_HOLD_SPAN = EPOCH_LEN * (FCLAIM_MAX_EPOCH_AHEAD + 1) - 1;   // 89
const LEGACY_MAX_HOLD = CLAIM_WINDOW_BLOCKS_V20 + CLAIM_FILL_GRACE_BLOCKS;

// The all-zeros coinbase outpoint (consensus): a coinbase tx is never a signed cairnx record, so an event
// whose authenticating input looks like one has no prevout owner to bind against. Mirrors namespv.ts.
const COINBASE_TXID = "0x" + "00".repeat(32);
const isCoinbaseInput = (i: { prevTxid: string; vout: number }) =>
  String(i.prevTxid).toLowerCase() === COINBASE_TXID && Number(i.vout) === 0xffffffff;

// outputs → addr→sum(value) map via the vendored sink (the exact aggregation the resolver/scanner use).
// SPV-specific glue only: raw outputs carry a scriptPubkey, not an addr. Mirrors namespv.ts outputsToPaidTo.
function outputsToPaidTo(outputs: Tx["outputs"]): Record<string, string> {
  const decoded: { addr: string; value: number }[] = [];
  for (const o of outputs) {
    const a = String(o.scriptPubkey ?? "").toLowerCase().replace(/^0x/, "");
    if (!/^[0-9a-f]{40}$/.test(a)) continue;
    decoded.push({ addr: "0x" + a, value: Number(o.value) });
  }
  return paidToFromOutputs(decoded);
}

// Recover + AUTHENTICATE a tx's signer (the merkle root commits the body but NOT the scriptSig). null on any
// malformation / bad signature. Same strict vendored recoverSigner + sighash(tx) as namespv.ts.
function recoverSigner(tx: Tx): string | null {
  const ss = tx.inputs?.[0]?.scriptSig;
  if (typeof ss !== "string") return null;
  try { return recoverSig(ss, sighash(tx)); } catch { return null; }
}

// ★ KEEP-IN-SYNC with namespv.ts toChainEvent + the cairnx scanner: the emitted field shapes must match so
// resolve()/verifyFillSpv produce identical state from either feed. Adds the PoW-verified burial `depth`.
function toProvenEvent(tx: Tx, id: string, height: number, pos: number, signer: string, depth: number): ProvenEvent | null {
  if (!tx.app || tx.app.type === "None") return null;
  const paidTo = outputsToPaidTo(tx.outputs);
  if (tx.app.type === "Propose") {
    return { kind: "propose", id: id.toLowerCase(), proposer: signer, uri: tx.app.uri, payloadHash: String(tx.app.payloadHash).toLowerCase(), expiresEpoch: Number(tx.app.expiresEpoch), height, pos, paidTo, depth };
  }
  const conf = Number(tx.app.confidence);
  return { kind: "attest", txid: id.toLowerCase(), proposalId: String(tx.app.proposalId).toLowerCase(), attester: signer, score: Number(tx.app.score), confidence: Number.isSafeInteger(conf) && conf >= 0 ? conf : 0, height, pos, paidTo, depth };
}

// Fetch a block, rebuild EVERY tx, and require merkleRoot(txids) == the PoW-verified header's merkle root, so
// a lying node cannot omit/alter/add any committed body. THROWS (fail-closed) on any mismatch. A plain/coinbase
// tx may carry no `app` → default {None} before decode so it can't DoS the whole verify by making rpcTxToTx throw.
async function bindBlock(spv: SpvSource, height: number): Promise<{ ids: string[]; rebuilt: Tx[] }> {
  const { merkle, txs } = await spv.blockAt(height);
  const rebuilt = txs.map((t) => rpcTxToTx(t.app ? (t as RpcTxJson) : ({ ...t, app: { type: "None" } } as RpcTxJson)));
  const ids = rebuilt.map(ctxid);
  // M7 (B5e, CVE-2012-2459): merkleRoot self-pairs an odd final row, so a served body whose LAST tx is
  // duplicated hashes to the SAME root as the honest body. A real block can never contain a duplicate
  // txid (double-spend of the coinbase output within one block), so reject it BEFORE the root compare -
  // otherwise a hostile read path could smuggle a duplicated filler tx past the merkle bind.
  if (new Set(ids.map((x) => x.toLowerCase())).size !== ids.length)
    throw new Error(`block ${height} has a duplicate txid (malleated read path, CVE-2012-2459)`);
  if (String(merkleRoot(ids)).toLowerCase() !== String(merkle).toLowerCase())
    throw new Error(`block ${height} does not match its PoW-verified merkle root (tampered read path)`);
  return { ids, rebuilt };
}

// Bounded-concurrency block fetch preserving fail-closed semantics (BP4/N11): mirrors node.ts mapLimit -- a
// tiny shared-index worker pool so the window is fetched with at most `limit` in flight (bounding the burst
// against the per-IP proxy budget) while any thrown tamper rejects the whole pool. Order of COMPLETION does
// not matter: `fn` only populates the per-height memo; the caller reads it back in strict height order.
const SCAN_POOL = 12;
async function bindBlockPool(heights: readonly number[], limit: number, fn: (h: number) => Promise<unknown>): Promise<void> {
  let i = 0;
  const worker = async () => { while (i < heights.length) { const idx = i++; await fn(heights[idx]!); } };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, heights.length || 1)) }, worker));
}

export interface FillSpvHints { offerId: string; fclaimTxid: string; me: string; offerHeight: number; }

// The cross-offer MAX_ACTIVE_CLAIMS count (`myLiveHoldsAtGrant` for verifyFillSpv): a CONSERVATIVE OVER-count
// of the buyer's OTHER-offer fclaim holds that could be live at the grant height of the fclaim being filled.
// verifyFillSpv's lane-scoped replay cannot see other-offer holds, and the cap is the ONE grant clause counted
// across offers, so a wrong-LOW count fail-OPENS the cap and BURNS (a resolver that D2-aliases a cap-denied
// fclaim as "granted" would pass); a wrong-HIGH count only false-refuses (retryable, at worst a wasted claim).
// PURE so the live scan and the tests drive the identical predicate. The caller supplies AUTHENTICATED
// proposers (production: prevout-ownership bound, with any UNBINDABLE hold attributed to `me` = over-count) and
// the fclaim's PROVEN grant height (never a resolver-served height).
export function countMyOtherLiveHolds(
  events: readonly { kind?: string; proposer?: string; uri?: string; payloadHash?: string; expiresEpoch?: number }[],
  offerId: string, me: string, grantHeight: number,
): number {
  const oid = String(offerId).toLowerCase(), meL = String(me).toLowerCase();
  let n = 0;
  for (const e of events) {
    if (e?.kind !== "propose" || String(e.proposer ?? "").toLowerCase() !== meL) continue;
    const rec = parseRecord(String(e.uri ?? ""), String(e.payloadHash ?? "")) as { t?: string; offer?: string } | null;
    if (!rec || rec.t !== "fclaim") continue;
    if (String(rec.offer ?? "").toLowerCase() === oid) continue;      // this offer's own holds do NOT count
    if (fclaimHoldEnd(Number(e.expiresEpoch)) < grantHeight) continue; // lapsed before our grant height
    n++;
  }
  return n;
}

/**
 * Build the live FillSpvIo over the wallet's PoW light client. Fails CLOSED (throws or yields null) on any
 * unverifiable read, so a preflight that awaits it refuses rather than proceeds. `opts.spvSource` injects the
 * seam for tests; production builds the real one from the light client. The returned io carries the computed
 * `myLiveHoldsAtGrant` cross-offer cap over-count.
 *
 * Fund-safety scan design (all hint-independent, so a hostile resolver cannot narrow the evidence):
 *  - The window is TIP-ANCHORED [tip - (MAX_SCAN + MAX_HOLD_SPAN), tip]; a fillable fclaim is within
 *    MAX_HOLD_SPAN of the tip, so this always covers [true-grant - MAX_SCAN, tip] no matter what height the
 *    resolver asserts. (Anchoring on the served height would let an inflated hint push a prior hold out.)
 *  - The fclaim's grant height is its PROVEN mined height from the scan, never the served hint; the source
 *    fails CLOSED if the fclaim is not merkle-proven in-window.
 *  - Every counted OTHER-offer hold is authenticated by the prevout-ownership bind (a hostile node cannot swap
 *    a scriptSig to strip my authorship); a hold that is mine OR cannot be bound is counted (over-count).
 *
 * IN-window suppression is CLOSED: every lane event this scan proved in a merkle-bound block is EAGERLY
 * authorship-bound below and fails CLOSED if unbindable, so a scriptSig-swap cannot make an in-window prior
 * hold / cancel / consuming fill vanish from the replay.
 *
 * RESIDUAL (precise, and ACCEPTED as resolver-compromise-bounded): the ONE leg left open is a hostile PRIMARY
 * resolver WITHHOLDING a genuine PRE-window event (a cancel or consuming fill OLDER than the tip-anchored
 * window), which only an unbounded anchor-to-tip body scan would surface, and that is hot-path-infeasible (a
 * V22+ offer can be weeks old). None of the earlier "mitigations" close it -- Correction 2 only freezes a
 * cancel landing DURING a live hold (a cancel BEFORE the grant is a real cancellation, not frozen); the B6
 * clarvis cross-check gives ZERO protection (a cancel changes no value field, and an honest clarvis simply 404s
 * the denied fclaim = fail-soft PROCEED); reorg depth is irrelevant to a genuinely-buried OLD cancel. Its only
 * closure is the deferred B4 warm-snapshot + chunked lifecycle scan (verified-event proof cache), the same
 * "as-shown" completeness limit namespv already accepts. B6 is a STRICT improvement over the pre-B6 fill, which
 * trusted the resolver's ENTIRE answer; here only this bounded pre-window-withholding leg remains.
 *
 * GIVE-BACKING is separately RESOLVER-TRUSTED (the accepted N1 residual): the offer's token/name backing is
 * synthesized from the merkle-proven offer record (see below) so the offer materializes, and it NEVER affects
 * the grant/denial/holder/cancel verdict (which rides the proven lane events). Same trust as the pre-V28 fill.
 *
 * WHAT THIS BOUNDARY STOPS (stated exactly, no overstatement): once the wallet ROUTES to it (STRUCTURALLY, on
 * `proposalId !== offer.id`, so a hostile PRIMARY can no longer WITHHOLD/alter the D2 `fclaimId` to steer the
 * fill away from the boundary -- see wallet.ts fillOfferPreflight), it stops a denied / superseded / forged-holder
 * / below-depth fclaim and an in-window scriptSig-suppressed hold/cancel/fill. It does NOT stop: (1) a PRE-window
 * withheld cancel/consuming-fill (above); (2) resolver-trusted give-backing (above); (3) a fill the wallet routes
 * to the LEGACY lane (`proposalId === offer.id` with no live fclaim hold -- a taker-bound fill or a pre-V28
 * sunset hold), which stays resolver-trusted exactly as pre-V28 (N1). A hostile primary that also relabels
 * `offer.id === proposalId` lands in that same pre-existing legacy N1 residual, not a new V28 lane.
 */
export async function liveFillSpvSource(opts: LiveSpvOpts & { hints: FillSpvHints; spvSource?: SpvSource }): Promise<FillSpvIo & { myLiveHoldsAtGrant: number; provenPayto: string; provenSeller: string; provenTerms: MintedProvenOfferTerms; tipFloored: boolean }> {
  const spv = opts.spvSource ?? await liveSpvSource(opts);
  const offerId = String(opts.hints.offerId).toLowerCase();
  const fclaimTxid = String(opts.hints.fclaimTxid).toLowerCase();
  const me = String(opts.hints.me).toLowerCase();
  const offerHeight = Math.floor(Number(opts.hints.offerHeight));
  if (!Number.isFinite(offerHeight) || offerHeight < 0)
    throw new Error("fill-SPV: the resolver gave no usable offer height to anchor its proof");

  // Sync PoW-verified headers to the node tip (prepare caps its sync at the node tip, so a large target forces
  // a full sync) — the fill needs burial-to-tip, not just headers up to a record. A lying-high header throws.
  const { verifiedTip, floorTip: rawFloorTip } = await spv.prepare(Number.MAX_SAFE_INTEGER);
  if (!Number.isFinite(verifiedTip)) throw new Error("fill-SPV: no PoW-verified tip");
  const floorTip = Number.isFinite(rawFloorTip as number) ? Number(rawFloorTip) : 0;
  // FILLSPV-01: the deadline/hold-liveness guards in verifyFillSpv read io.tip(). A DEFLATED served tip
  // under-states verifiedTip (prepare syncs only to the served tip), so a hold that has ACTUALLY lapsed can
  // read as still live -> the fill signs -> the chain rejects it -> the payment burns. Clamp the reported tip
  // UP to the PoW-backed cross-session floor: both terms are PoW evidence, so the max can only OVER-state by
  // reorg depth (fail-closed, more refusals) and never under-state. NEVER the served nodeTip (attacker-settable
  // upward). ev.depth is computed from raw verifiedTip below, and verifyFillSpv's depthOf takes min(ev.depth,
  // tip-height+1), so raising the reported tip cannot weaken burial depth (still the conservative raw depth).
  let reportedTip = verifiedTip;
  if (floorTip > reportedTip) reportedTip = floorTip;   // MUTATE_FILLSPV_TIP_FLOOR
  const tipFloored = floorTip > verifiedTip;            // the floor had to override a lower verified tip (deep reorg OR active deflation) -> a resulting refusal is "could not confirm", not a factual "lapsed"

  const heightOf = new Map<string, number>();
  const ids = new Set<string>();                       // events for verifyFillSpv's offer replay
  const scannedIds = new Set<string>();                // ids merkle-proven DURING the scan (TRUE mined height)
  const laneProposals = new Set<string>([offerId]);    // the offer + every fclaim-for-this-offer
  const attestBuf: { id: string; height: number; proposalId: string }[] = [];
  const otherFclaims: { id: string; height: number; uri: string; payloadHash: string; expiresEpoch: number }[] = [];
  const legacyClaims: { id: string; height: number }[] = [];   // pre-V28 SCORE_CLAIM attests on OTHER offers
  const add = (id: string, h: number) => { const k = id.toLowerCase(); if (!heightOf.has(k)) heightOf.set(k, h); ids.add(k); };
  const markScanned = (id: string, h: number) => { scannedIds.add(id.toLowerCase()); add(id, h); };

  // Per-HEIGHT bind memo (BP4/N11): bindBlock (fetch + merkle-verify a whole block) is the scan's cost. The
  // scan populates this once per height; proveEventAt and step 3 then reuse those bodies instead of re-fetching,
  // so no block is bound twice per preflight. A tamper still THROWS (fail-closed) on first bind, verified once.
  const blockMemo = new Map<number, { ids: string[]; rebuilt: Tx[] }>();
  async function bindBlockMemo(height: number): Promise<{ ids: string[]; rebuilt: Tx[] }> {
    const hit = blockMemo.get(height);
    if (hit) return hit;
    const b = await bindBlock(spv, height);
    blockMemo.set(height, b);
    return b;
  }

  const proven = new Map<string, ProvenEvent | null>();   // memoize per id; blockMemo binds each block once
  async function proveEventAt(id: string, height: number): Promise<ProvenEvent | null> {
    const k = id.toLowerCase();
    if (proven.has(k)) return proven.get(k) ?? null;
    let ev: ProvenEvent | null = null;
    const { ids: bids, rebuilt } = await bindBlockMemo(height);
    const pos = bids.findIndex((x) => x.toLowerCase() === k);
    if (pos >= 0) {
      const tx = rebuilt[pos];
      const signer = recoverSigner(tx);
      const in0 = tx.inputs?.[0];
      // NSPV-SIGSUB-1: bind the recovered signer to the COIN it spends (the merkle root does not commit the
      // scriptSig), so a hostile node cannot swap in a foreign valid signature to re-attribute a record's author.
      if (signer && in0 && !isCoinbaseInput(in0)) {
        const spk = await spv.prevoutScriptPubkey(String(in0.prevTxid), Number(in0.vout));
        if (spk && spk.toLowerCase() === signer) ev = toProvenEvent(tx, bids[pos], height, pos, signer, verifiedTip - height + 1);
      }
    }
    proven.set(k, ev);
    return ev;
  }

  // TIP-ANCHORED scan (FUND-SAFETY, not latency): surface every fclaim / offer / fill / cancel / legacy-claim
  // bearing on this offer (or on the buyer's cap) from PoW-verified BLOCK BODIES, so neither a withheld prior
  // hold nor an inflated served height can slip past the replay or the cap count.
  const from = Math.max(0, verifiedTip - (MAX_SCAN + MAX_HOLD_SPAN));
  const heights: number[] = [];
  for (let h = from; h <= verifiedTip; h++) heights.push(h);
  // TRANSPORT ONLY (BP4/N11): fetch + merkle-verify the whole window with a bounded worker pool (the sequential
  // walk was ~224 by-height reads, the multi-second fclaim-fill delay). Every block is still independently bound
  // to its PoW-verified merkle root inside bindBlock, and the RESULTS are then processed STRICTLY in ascending
  // height order below, so the first-set semantics (heightOf/markScanned) and every buffer are byte-identical to
  // the old sequential walk. A tamper throws inside a worker and rejects the pool -> the preflight fails closed.
  await bindBlockPool(heights, SCAN_POOL, bindBlockMemo);
  for (const h of heights) {
    const { ids: bids, rebuilt } = blockMemo.get(h)!;   // populated by the pool above; present or the pool threw
    for (let pos = 0; pos < rebuilt.length; pos++) {
      const tx = rebuilt[pos];
      const app = tx.app;
      if (!app || app.type === "None") continue;
      const id = bids[pos].toLowerCase();
      if (app.type === "Propose") {
        if (id === offerId) { markScanned(id, h); continue; }   // the offer, if it anchored in-window
        // F8 (wallet-vs-site parity): only cairnx-domain Proposes bind the resolver's replay, mirroring the site
        // swapguard.js:704 (`tx.app.domain !== DOMAIN && idl !== offerId`). Without this the scan is domain-blind:
        // a SELLER-signed foreign-domain Propose whose uri parses as a cairnx ocancel/fclaim would be fed to
        // resolve() and cancel/deny the offer in the WALLET's replay only (a hard FILL_UNSAFE the authoritative
        // resolver and the /trade site ignore) = a wallet-vs-site false-refuse fork on an honest, open offer. The
        // offer itself is exempt (handled by the id === offerId continue above), exactly as the site exempts it.
        if (app.domain !== DOMAIN) continue;
        const rec = parseRecord(app.uri, String(app.payloadHash)) as { t?: string; offer?: string } | null;
        if (!rec) continue;
        // F8 (wallet-vs-site divergence fix): an ocancel (bulk offer-cancel-all) is a Propose resolve() ACTS on
        // -- it cancels the seller's matching open offers (resolve.ts). An ocancel landing BEFORE the fclaim grant
        // is a REAL cancellation the replay MUST see (Correction-2 only freezes an ocancel DURING a live hold), so
        // dropping it here false-accepts a fill on a cancelled offer (buyer pays, receives 0). Feed it to the
        // replay (ids) AND eager-auth-bind it (scannedIds), mirroring the site swapguard.js:707. A hostile-INJECTED
        // ocancel cannot false-refuse: resolve() applies it only when o.seller === ocancel.proposer (prevout-bound),
        // so a foreign/forged or wrong-ticker ocancel is simply ignored.
        if (rec.t === "ocancel") { markScanned(id, h); continue; } // MUTATE_OCANCEL_SCAN
        if (rec.t !== "fclaim") continue;
        if (String(rec.offer).toLowerCase() === offerId) { laneProposals.add(id); markScanned(id, h); }
        else otherFclaims.push({ id, height: h, uri: app.uri, payloadHash: String(app.payloadHash), expiresEpoch: Number(app.expiresEpoch) });
      } else {
        const proposalId = String(app.proposalId).toLowerCase();
        attestBuf.push({ id, height: h, proposalId });
        if (Number(app.score) === SCORE_CLAIM && proposalId !== offerId) legacyClaims.push({ id, height: h });
      }
    }
  }
  // Second pass: keep only the attests (fills / cancels) that reference the offer or a lane fclaim.
  for (const a of attestBuf) if (laneProposals.has(a.proposalId)) markScanned(a.id, a.height);
  // The offer may predate the window; prove it at the resolver-asserted height (fail-closed if lied).
  add(offerId, offerHeight);

  // DEFECT-1 fix: the cap keys on the fclaim's PROVEN mined height, never the served hint. Fail CLOSED if the
  // fclaim being filled was not merkle-proven in-window (an inflated hint or a non-mined target).
  if (!scannedIds.has(fclaimTxid)) throw new Error("fill-SPV: the fclaim being filled was not merkle-proven in the scan window");
  const grantHeight = heightOf.get(fclaimTxid)!;

  // DEFECT-2 fix: authenticate each in-window OTHER-offer fclaim's proposer with the prevout-ownership bind
  // (recoverSigner alone is spoofable). Fail toward OVER-count: a hold that is MINE **or that cannot be bound**
  // is counted (dropping a possibly-mine hold under-counts and burns); only a hold provably bound to ANOTHER
  // address is excluded. Only holds still live at the grant height are considered.
  const held: { kind: "propose"; proposer: string; uri: string; payloadHash: string; expiresEpoch: number }[] = [];
  for (const c of otherFclaims) {
    if (fclaimHoldEnd(c.expiresEpoch) < grantHeight) continue;      // provably lapsed before the grant
    const ev = await proveEventAt(c.id, c.height);
    const proposer = ev && ev.kind === "propose" ? ev.proposer : me;   // unbindable -> attribute to me (over-count)
    held.push({ kind: "propose", proposer, uri: c.uri, payloadHash: c.payloadHash, expiresEpoch: c.expiresEpoch });
  }
  let myLiveHoldsAtGrant = countMyOtherLiveHolds(held, offerId, me, grantHeight);

  // OBS-3 (V28 activation window): resolve()'s cap also counts a still-live pre-V28 LEGACY hold (a SCORE_CLAIM
  // attest on an offer, 40+5-block window). New clients build none, so this only bites during the V28
  // transition; count them the same over-count way (mine OR unbindable) so a live legacy hold on another offer
  // at grant is not under-counted during the transition.
  //
  // BP6 SUNSET TOMBSTONE (REBIND Track P): skip the legacy scan+count, AND with it the hostile-minable prevout
  // fetch (proveEventAt reads a prevout script for each attacker-plantable SCORE_CLAIM), once it is provably
  // unreachable. NOTE the floor here is HIGHER than the site's 60,045 and higher than the plan's stated 60,045,
  // because OBS-3 counts a hold live at the fclaim's GRANT height, not at the tip:
  //   - a legacy hold the resolver ALSO counts is a SCORE_CLAIM granted BELOW V28 (a SCORE_CLAIM at height >=
  //     V28_HEIGHT is resolver-rejected, so counting it only OVER-counts -> over-refuse, never a burn); such a
  //     hold is live at a grant G only while G < (V28_HEIGHT - 1) + LEGACY_MAX_HOLD, i.e. G <= 60,043; and
  //   - a FILLABLE fclaim's grant is at most MAX_HOLD_SPAN below the verified tip (verifyFillSpv's deadline
  //     guard; see MAX_HOLD_SPAN above), so G >= verifiedTip - MAX_HOLD_SPAN.
  // Both can hold only while verifiedTip - MAX_HOLD_SPAN <= 60,043, i.e. verifiedTip < V28_HEIGHT +
  // LEGACY_MAX_HOLD + MAX_HOLD_SPAN (= 60,134). At/above that tip no legacy hold can be live at any fillable
  // fclaim's grant, so the count is provably zero; skipping is fail-safe (it only ever drops an over-refuse,
  // and no genuine hold is left to under-count). Below the gate it runs exactly as before (pinned by fill-
  // fclaim-preflight OBS3 at tip 60,010). Self-activating on the verified tip, so it is correct regardless of
  // the merge tip: the wallet half's true crossing is tip >= 60,134, NOT 60,045 (recorded for the runbook).
  if (verifiedTip < V28_HEIGHT + LEGACY_MAX_HOLD + MAX_HOLD_SPAN) {
    for (const c of legacyClaims) {
      if (c.height < grantHeight - LEGACY_MAX_HOLD) continue;         // provably lapsed before the grant
      const ev = await proveEventAt(c.id, c.height);
      if (!ev || ev.kind !== "attest" || ev.attester === me) myLiveHoldsAtGrant++;   // mine OR unbindable -> count
    }
  }

  // DEFECT-3 fix: EAGERLY authenticate every lane event the scan FOUND in a merkle-bound block, HERE (not in
  // provenEvent alone). verifyFillSpv silently SKIPS a null provenEvent AND its per-event try/catch swallows a
  // throw, so on the REPLAY leg a bind-failure = "the event never happened" (fail-OPEN). An event found in a
  // merkle-bound body but whose authorship cannot be prevout-bound is a SUPPRESSION: a hostile node swapped its
  // scriptSig (the txid strips it, so the merkle check still passes) to make a prior HOLD / CANCEL / consuming
  // FILL vanish from the replay -> a denied-fclaim / cancelled-offer false-accept -> BURN. Fail CLOSED here (the
  // wallet retries as VERIFY_UNAVAILABLE), mirroring namespv's fail-closed-on-unbindable. An honestly-mined tx
  // always binds (L0 required the owner's valid signature to mine it), so an honest read never trips this. A
  // genuinely-ADDED fake id (a lying resolver hint, absent from every block) is NOT here -- scannedIds holds
  // ONLY events THIS independent scan proved in a merkle-bound block, so it correctly cannot be a suppression.
  for (const wid of scannedIds) {
    const h = heightOf.get(wid);
    if (h !== undefined && (await proveEventAt(wid, h)) === null)
      throw new Error("fill-SPV: a lane event could not be authorship-bound (possible scriptSig suppression) - refusing");
  }

  // GIVE-BACKING SYNTHESIS (accepted N1 residual): the scan drops the offer's give-backing (a token's deploy+mint,
  // or a name's registration) because it is arbitrarily OLD (outside the tip-anchored window), so without this
  // resolve() would hit "unknown ticker" / "you don't own this name" and verifyFillSpv would FALSELY REFUSE every
  // honest token/name fclaim fill. Synthesize a minimal, generous backing from the MERKLE-PROVEN offer record so
  // the offer MATERIALIZES and previewFill is deliverable. This backing is RESOLVER-TRUSTED (identical to the
  // pre-V28 fill, which trusted the resolver's ENTIRE answer; N1), and it materializes the GIVE only -- the
  // grant/denial/holder/cancel VERDICT rides the PROVEN lane events above and NEVER the synthesized backing (the
  // synthetic ids are never in scannedIds, so they are neither eager-authed nor cap-counted). A forged give (a
  // seller who never owned it) is the same N1 residual the pre-V28 wallet already carries, no worse.
  const offerEv = await proveEventAt(offerId, heightOf.get(offerId)!);
  if (!offerEv || offerEv.kind !== "propose") throw new Error("fill-SPV: the offer could not be merkle-proven");
  const offerRec = parseRecord(offerEv.uri, offerEv.payloadHash) as { t?: string; give?: { ticker?: string; name?: string }; want?: { payto?: string; value?: string }; taker?: string; bid?: string; min?: string } | null;
  // F2: the PAYMENT recipients, derived from the merkle-proven offer (never the resolver-served fields). The
  // seller (= the prevout-bound author) owns the rebate leg; the payment recipient is the record's explicit
  // want.payto (merkle-committed) or, absent, the seller. verifyFillSpv proves DELIVERY but not these, so the
  // caller binds the resolver-served payto/seller to them (fail-closed) before sizing the fill.
  const provenSeller = String(offerEv.proposer).toLowerCase(); // MUTATE_LIVE_PROVEN_SELLER
  const provenPayto = (offerRec?.want?.payto && /^0x[0-9a-f]{40}$/.test(String(offerRec.want.payto).toLowerCase())) ? String(offerRec.want.payto).toLowerCase() : provenSeller; // MUTATE_LIVE_PROVEN_PAYTO
  // F2 (amount leg): the fee/rebate-relevant fields from the merkle-proven offer, via the ONE vendored
  // producer (B4a; the proven CREATION height is the input, never a served height - a lying resolver
  // deflating feeBps/height/value/taker cannot under-size a leg, which resolve() would reject AFTER the
  // payment moved = pay-without-delivery burn).
  const provenTerms: MintedProvenOfferTerms = provenOfferTerms(offerRec, offerEv.height); // MUTATE_LIVE_PROVEN_TERMS
  const synthetic = new Map<string, ProvenEvent>();
  const synth = (built: { uri: string; payloadHash: string }, height: number, paidTo: Record<string, string>) => {
    const sid = String(built.payloadHash).toLowerCase();   // the record's own payload_hash: a stable, unique id
    synthetic.set(sid, { kind: "propose", id: sid, proposer: offerEv.proposer, uri: built.uri, payloadHash: sid, expiresEpoch: 9_000_000_000, height, pos: 0, paidTo, depth: verifiedTip - height + 1 } as ProvenPropose);
  };
  if (offerRec && offerRec.t === "offer" && offerRec.give) {
    if (isNameGive(offerRec.give)) {
      // a pre-V15 direct name registration by the seller: effHeight ~ V11 out-ages the sale embargo, and the
      // no-lease default paidThrough (V15_EPOCH + NAME_TERM) covers any realistic near-tip offer window. (A name
      // offer with an unusually far-future expiresEpoch beyond that default fail-safe REFUSES, never burns; the
      // deferred lifecycle scan is the full fix.) Fee generously overpaid so the registration always clears.
      synth(nameClaim({ name: offerRec.give.name! }), V11_HEIGHT + 1, { [TREASURY_ADDR]: String(MAX_AMOUNT) });
    } else if (offerRec.give.ticker) {
      // deploy (just above ACTIVATION_HEIGHT, below v1.1 so no fee gate; resolve() ignores anything below the
      // activation floor) + an issuer mint of the max supply to the seller, so any give amount is available.
      // resolve() processes these before the offer (lower heights), materializing the give.
      synth(deploy({ ticker: offerRec.give.ticker, decimals: 0, supply: String(MAX_AMOUNT), mint: "issuer" }), ACTIVATION_HEIGHT + 1, { [TREASURY_ADDR]: String(DEPLOY_FEE) });
      synth(mint({ ticker: offerRec.give.ticker, amount: String(MAX_AMOUNT) }), ACTIVATION_HEIGHT + 2, {});
    }
  }

  return {
    myLiveHoldsAtGrant,
    provenPayto,
    provenSeller,
    provenTerms,
    tipFloored,
    async tip() { return reportedTip; },
    async offerEventIds() { return [...ids, ...synthetic.keys()]; },
    async provenEvent(id: string) {
      const k = String(id).toLowerCase();
      if (synthetic.has(k)) return synthetic.get(k)!;
      const h = heightOf.get(k);
      return h === undefined ? null : await proveEventAt(id, h);
    },
  };
}

// F2-legacy: prove an offer's PAYMENT recipients (want.payto + the seller/rebate address) for the LEGACY /
// dApp fill lane (fillOfferPreflight), which has no fclaim SPV io to source them from. Merkle-proves the offer
// Propose tx at its confirmed height and derives: seller = the prevout-bound author (the coin can only be spent
// by its owner's key, and the owner is txid-committed, NOT scriptSig-derived); payto = the record's explicit
// want.payto (merkle-committed) or, absent, the seller. Returns { payto, seller } (lowercased 0x-addrs) or null
// on ANY unprovable / tampered / unreachable read, so the caller fails CLOSED-RETRYABLE (never a hard decline on
// an honest fill). Reuses the same audited light-client primitives (liveSpvSource, bindBlock, prevoutScriptPubkey).
export async function provenOfferPayto(
  opts: LiveSpvOpts & { offerId: string; offerHeight: number; spvSource?: SpvSource },
): Promise<{ payto: string; seller: string; terms: MintedProvenOfferTerms; wantTicker?: string; wantAmount?: string } | null> {
  const offerId = String(opts.offerId).toLowerCase();
  const offerHeight = Math.floor(Number(opts.offerHeight));
  if (!/^0x[0-9a-f]{64}$/.test(offerId) || !Number.isFinite(offerHeight) || offerHeight < 0) return null;
  try {
    const spv = opts.spvSource ?? await liveSpvSource(opts);
    const { verifiedTip } = await spv.prepare(offerHeight);        // PoW-verify headers through the offer height
    if (!Number.isFinite(verifiedTip) || verifiedTip < offerHeight) return null;   // couldn't reach it -> retry
    const { ids: bids, rebuilt } = await bindBlock(spv, offerHeight);   // merkle-COMPLETE bodies; throws on tamper
    const pos = bids.findIndex((x) => x.toLowerCase() === offerId);
    if (pos < 0) return null;                                      // the offer is not in its claimed block (tampered)
    const tx = rebuilt[pos];
    const app = tx.app;
    if (!app || app.type !== "Propose") return null;
    const rec = parseRecord(app.uri, String(app.payloadHash)) as { t?: string; want?: { payto?: string; value?: string; ticker?: string; amount?: string }; taker?: string; bid?: string; min?: string } | null;
    if (!rec || rec.t !== "offer") return null;
    const signer = recoverSigner(tx);
    const in0 = tx.inputs?.[0];
    if (!signer || !in0 || isCoinbaseInput(in0)) return null;
    const owner = await spv.prevoutScriptPubkey(String(in0.prevTxid), Number(in0.vout));
    if (!owner || owner.toLowerCase() !== signer) return null;     // authorship not prevout-bound (tampered) MUTATE_FILLSPV_PREVOUT_BIND
    const seller = signer;
    const payto = (rec.want?.payto && /^0x[0-9a-f]{40}$/.test(String(rec.want.payto).toLowerCase())) ? String(rec.want.payto).toLowerCase() : seller; // MUTATE_PROVEN_PAYTO_DERIVE
    // B4a: same single-sourced producer as the fclaim lane; offerHeight is the merkle-proven block
    // the offer was found in (bindBlock verified it), never a served height.
    const terms: MintedProvenOfferTerms = provenOfferTerms(rec, offerHeight); // MUTATE_PROVEN_TERMS_HEIGHT
    // B7e-FIX (REBIND W1 token-lane close): surface the merkle-proven token WANT (the ticker + amount the
    // buyer PAYS). bindOfferTerms binds the want TYPE only, and provenOfferTerms drops the token ticker/amount,
    // so the token-lane content bind (wallet.ts fillOfferPreflight) needs these directly to mirror the site
    // swapguard verifyOfferContent want.ticker/want.amount bind. Undefined on a CSD-priced offer (no want.ticker).
    const wantTicker = rec.want?.ticker !== undefined ? String(rec.want.ticker) : undefined; // MUTATE_PROVEN_WANT_TICKER
    const wantAmount = rec.want?.amount !== undefined ? String(rec.want.amount) : undefined; // MUTATE_PROVEN_WANT_AMOUNT
    return { payto, seller, terms, wantTicker, wantAmount };
  } catch { return null; }
}
