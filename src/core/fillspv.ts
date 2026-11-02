// fillspv.ts; the LIVE production FillSpvIo for the V28 open-lane (fclaim) fill fund boundary.
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
  parseRecord,
  fclaimHoldEnd, MAX_SCAN, FCLAIM_MAX_HOLD_SPAN,
  deploy, mint, nameClaim, isNameGive, MAX_AMOUNT, DEPLOY_FEE, TREASURY_ADDR, DOMAIN, V11_HEIGHT, ACTIVATION_HEIGHT,
  provenOfferTerms, provenOfferRefusal, MAX_ACTIVE_CLAIMS, myProvenFillClosedOffer, countOtherHoldsAtGrant,
  resolve,
  type Tx, type FillSpvIo, type ProvenEvent, type ProvenPropose, type MintedProvenOfferTerms, type OfferRecord, type HoldCandidate,
} from "../vendor/cairnx-spv.js";
import { liveSpvSource, type LiveSpvOpts, type SpvSource } from "./namespv.js";
import { BodyMismatchError, bindBlock, bindSigner, recoverSigner, toChainEvent } from "./spvbind.js";
import { OfferNotAdmittedError } from "./fillpreflight.js";

// B4a (REBIND W2): the fee/rebate term derivation is SINGLE-SOURCED in the vendored cairnx-core
// (`provenOfferTerms` + `feeBpsAt`, verifyfill.ts) - this file used to carry its own hand copies of
// both (a fifth `feeBpsAt` duplication and one of four hand-built ProvenOfferTerms producers), the
// exact drift class W2 exists to kill. Corpus-equivalence over every real on-chain offer (55) plus
// synthetic envelope variants proved the old copies byte-identical to canonical before the swap
// (test/proven-terms-corpus.test.mjs pins it forever). Re-exported so tests and fillpreflight.ts keep one
// import site; the re-export is a POINTER, never a re-declaration.
export { feeBpsAt, type ProvenOfferTerms, type MintedProvenOfferTerms } from "../vendor/cairnx-spv.js";

// GIVE-BACKING SYNTHESIS (accepted N1 residual): a proof that starts at the offer cannot reach the offer's give-backing
// (a token's deploy and mint, or a name's registration), which is arbitrarily old, so without it resolve() would hit
// "unknown ticker" / "you don't own this name" and refuse every honest fill. A minimal, generous backing is synthesized
// from the MERKLE-PROVEN offer record so the offer MATERIALIZES. It is RESOLVER-TRUSTED (as the pre-V28 fill trusted the
// resolver's whole answer) and materializes the give only: the synthetic ids are never scanned, eager-authed or
// cap-counted, so no grant, denial, holder, cancel or progress verdict rides on them. A forged give (a seller who never
// owned it) is the same N1 residual, no worse. Shared by the fclaim scan and the offer-id lane's progress proof.
function giveBacking(offerRec: OfferRecord | null, seller: string, verifiedTip: number): ProvenPropose[] {
  const out: ProvenPropose[] = [];
  const synth = (built: { uri: string; payloadHash: string }, height: number, paidTo: Record<string, string>) => {
    const sid = String(built.payloadHash).toLowerCase();   // the record's own payload_hash: a stable, unique id
    out.push({ kind: "propose", id: sid, proposer: seller, uri: built.uri, payloadHash: sid, expiresEpoch: 9_000_000_000, height, pos: 0, paidTo, depth: verifiedTip - height + 1 } as ProvenPropose);
  };
  if (offerRec && offerRec.t === "offer" && offerRec.give) {
    if (isNameGive(offerRec.give)) {
      // a pre-V15 direct name registration by the seller: effHeight ~ V11 out-ages the sale embargo, and the
      // no-lease default paidThrough (V15_EPOCH + NAME_TERM) covers any realistic near-tip offer window. (A name
      // offer with an unusually far-future expiresEpoch beyond that default fail-safe REFUSES, never burns; the
      // deferred lifecycle scan is the full fix.) Fee generously overpaid so the registration always clears.
      synth(nameClaim({ name: offerRec.give.name }), V11_HEIGHT + 1, { [TREASURY_ADDR]: String(MAX_AMOUNT) });
    } else if ((offerRec.give as { ticker?: string }).ticker) {
      // deploy (just above ACTIVATION_HEIGHT, below v1.1 so no fee gate; resolve() ignores anything below the
      // activation floor) + an issuer mint of the max supply to the seller, so any give amount is available.
      // resolve() processes these before the offer (lower heights), materializing the give.
      synth(deploy({ ticker: offerRec.give.ticker, decimals: 0, supply: String(MAX_AMOUNT), mint: "issuer" }), ACTIVATION_HEIGHT + 1, { [TREASURY_ADDR]: String(DEPLOY_FEE) });
      synth(mint({ ticker: offerRec.give.ticker, amount: String(MAX_AMOUNT) }), ACTIVATION_HEIGHT + 2, {});
    }
  }
  return out;
}

// The fill boundary's bind contract: a body that fails the shared bind throws, so every read here fails closed;
// a merkle mismatch throws BodyMismatchError so fillpreflight.ts can name the RPC and the header source.
async function bindBlockOrThrow(spv: SpvSource, height: number): Promise<{ ids: string[]; rebuilt: Tx[] }> {
  const b = await bindBlock(spv, height);
  if (b.ok) return { ids: b.ids, rebuilt: b.rebuilt };
  throw b.kind === "body-mismatch" ? new BodyMismatchError(height, spv.bodySource, spv.headerSource) : new Error(b.reason);
}

// Bounded-concurrency fan-out preserving fail-closed semantics (BP4/N11), for the block-window fetch and the
// per-id proveEventAt reads: a tiny shared-index worker pool with at most `limit` in flight (bounding the burst
// against the per-IP proxy budget) while any throw (a tamper) rejects the whole pool. Order of completion does
// not matter to the callers: the window fetch only fills the per-height memo, read back in height order.
const SCAN_POOL = 12;
export async function mapPool<T>(items: readonly T[], limit: number, fn: (item: T, i: number) => Promise<void>): Promise<void> {
  let i = 0;
  const worker = async () => { while (i < items.length) { const idx = i++; await fn(items[idx]!, idx); } };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length || 1)) }, worker));
}

export interface FillSpvHints { offerId: string; fclaimTxid: string; me: string; offerHeight: number; }

/**
 * Build the live FillSpvIo over the wallet's PoW light client. Fails CLOSED (throws or yields null) on any
 * unverifiable read, so a preflight that awaits it refuses rather than proceeds. `opts.spvSource` injects the
 * seam for tests; production builds the real one from the light client. The returned io carries
 * `myLiveHoldsAtGrant`, cairnx-core `countOtherHoldsAtGrant` over the buyer's other fclaims the scan proved: an
 * upper bound of their holds live at the grant, in consensus order; a grant outside its domain throws.
 *
 * Fund-safety scan design (all hint-independent, so a hostile resolver cannot narrow the evidence):
 *  - The window is TIP-ANCHORED [tip - (MAX_SCAN + FCLAIM_MAX_HOLD_SPAN), tip]: a fclaim hold lasts at most
 *    FCLAIM_MAX_HOLD_SPAN blocks past its grant and a fillable fclaim is within its hold (verifyFillSpv's deadline
 *    guard), so this always covers [true-grant - MAX_SCAN, tip] no matter what height the
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
 * PRE-WINDOW WITHHOLDING: this scan cannot see a cancel or consuming fill OLDER than the tip-anchored window,
 * and a full anchor-to-tip scan is too slow for the hot path (an offer can be weeks old). fillpreflight.ts
 * fclaimLanePreflight therefore reads the OFFER by id from the second resolver (clarvis) beside this scan and
 * refuses when it reports the offer closed, further filled, or held by another reservation through our hold
 * (offerxcheck.ts, test/fill-offer-crosscheck.test.mjs). The gap is closed when clarvis answers before the scan
 * ends and is honest. It stays open when clarvis is down, slower than the scan, or withholding the same event.
 * The chain-only closure is still the deferred warm-snapshot lifecycle scan (verified-event proof cache).
 *
 * GIVE-BACKING is separately RESOLVER-TRUSTED (the accepted N1 residual): the offer's token/name backing is
 * synthesized from the merkle-proven offer record (see below) so the offer materializes, and it NEVER affects
 * the grant/denial/holder/cancel verdict (which rides the proven lane events). Same trust as the pre-V28 fill.
 *
 * WHAT THIS BOUNDARY STOPS (stated exactly, no overstatement): once the wallet ROUTES to it (STRUCTURALLY, on
 * `proposalId !== offer.id`, so a hostile PRIMARY can no longer WITHHOLD/alter the D2 `fclaimId` to steer the
 * fill away from the boundary -- see fillpreflight.ts fillOfferPreflight), it stops a denied / superseded / forged-holder
 * / below-depth fclaim and an in-window scriptSig-suppressed hold/cancel/fill. It does NOT stop: (1) a PRE-window
 * withheld cancel/consuming-fill (above; the second-source read covers it only when clarvis answers); (2) resolver-trusted give-backing (above); (3) a fill the wallet routes
 * to the LEGACY lane (`proposalId === offer.id` with no live fclaim hold -- a taker-bound fill or a pre-V28
 * sunset hold), which stays resolver-trusted exactly as pre-V28 (N1). A hostile primary that also relabels
 * `offer.id === proposalId` lands in that same pre-existing legacy N1 residual, not a new V28 lane.
 */
export async function liveFillSpvSource(opts: LiveSpvOpts & { hints: FillSpvHints; spvSource?: SpvSource; offerHeightOf?: (offerId: string) => Promise<number | null> }): Promise<FillSpvIo & { myLiveHoldsAtGrant: number; provenTerms: MintedProvenOfferTerms; tipFloored: boolean }> {
  const spv = opts.spvSource ?? await liveSpvSource(opts);
  const offerId = String(opts.hints.offerId).toLowerCase();
  const fclaimTxid = String(opts.hints.fclaimTxid).toLowerCase();
  const me = String(opts.hints.me).toLowerCase();
  const offerHeight = Math.floor(Number(opts.hints.offerHeight));
  if (!Number.isFinite(offerHeight) || offerHeight < 0)
    throw new Error("fill-SPV: the resolver gave no usable offer height to anchor its proof");

  // Sync PoW-verified headers to the node tip (prepare caps its sync at the node tip, so a large target forces
  // a full sync); the fill needs burial-to-tip, not just headers up to a record. A lying-high header throws.
  const { verifiedTip, floorTip: rawFloorTip, tipKnown } = await spv.prepare(Number.MAX_SAFE_INTEGER);
  if (!Number.isFinite(verifiedTip)) throw new Error("fill-SPV: no PoW-verified tip");
  // Without a node tip nothing was synced, and holds would be judged against a verified tip that may be behind.
  if (tipKnown === false) throw new Error("fill-SPV: the node tip could not be read, so the hold cannot be checked against the chain tip");
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
  const otherFclaims: { id: string; height: number; pos: number; offer: string; uri: string; payloadHash: string; expiresEpoch: number }[] = [];
  const add = (id: string, h: number) => { const k = id.toLowerCase(); if (!heightOf.has(k)) heightOf.set(k, h); ids.add(k); };
  const markScanned = (id: string, h: number) => { scannedIds.add(id.toLowerCase()); add(id, h); };

  // Per-HEIGHT bind memo (BP4/N11): bindBlock (fetch + merkle-verify a whole block) is the scan's cost. The
  // scan populates this once per height; proveEventAt and step 3 then reuse those bodies instead of re-fetching,
  // so no block is bound twice per preflight. A tamper still THROWS (fail-closed) on first bind, verified once.
  const blockMemo = new Map<number, { ids: string[]; rebuilt: Tx[] }>();
  async function bindBlockMemo(height: number): Promise<{ ids: string[]; rebuilt: Tx[] }> {
    const hit = blockMemo.get(height);
    if (hit) return hit;
    const b = await bindBlockOrThrow(spv, height);
    blockMemo.set(height, b);
    return b;
  }

  const proven = new Map<string, ProvenEvent | null>();   // memoize per id; blockMemo binds each block once
  const boundSigner = new Map<string, string>();         // id -> its prevout-bound author, event or not
  async function proveEventAt(id: string, height: number): Promise<ProvenEvent | null> {
    const k = id.toLowerCase();
    if (proven.has(k)) return proven.get(k) ?? null;
    let ev: ProvenEvent | null = null;
    const { ids: bids, rebuilt } = await bindBlockMemo(height);
    const pos = bids.findIndex((x) => x.toLowerCase() === k);
    if (pos >= 0) {
      // bids is rebuilt.map(ctxid), so a found id has its body; a gap throws, keeping the scan fail-closed.
      const tx = rebuilt[pos], bid = bids[pos];
      if (!tx || bid === undefined) throw new Error(`block ${height}: no rebuilt body for ${k}`);
      // NSPV-SIGSUB-1: the signer must own the coin the record spends; an unbindable record proves no event.
      const author = await bindSigner(tx, spv);
      if (author.ok) boundSigner.set(k, author.signer);
      const base = author.ok ? toChainEvent(tx, bid, height, pos, author.signer) : null;
      if (base) ev = { ...base, depth: verifiedTip - height + 1 };   // verifyFillSpv reads the PoW burial depth
    }
    proven.set(k, ev);
    return ev;
  }

  // TIP-ANCHORED scan (FUND-SAFETY, not latency): surface every fclaim / offer / fill / cancel / legacy-claim
  // bearing on this offer (or on the buyer's cap) from PoW-verified BLOCK BODIES, so neither a withheld prior
  // hold nor an inflated served height can slip past the replay or the cap count.
  const from = Math.max(0, verifiedTip - (MAX_SCAN + FCLAIM_MAX_HOLD_SPAN));
  const heights: number[] = [];
  for (let h = from; h <= verifiedTip; h++) heights.push(h);
  // TRANSPORT ONLY (BP4/N11): fetch + merkle-verify the whole window with a bounded worker pool (the sequential
  // walk was ~224 by-height reads, the multi-second fclaim-fill delay). Every block is still independently bound
  // to its PoW-verified merkle root inside bindBlock, and the RESULTS are then processed STRICTLY in ascending
  // height order below, so the first-set semantics (heightOf/markScanned) and every buffer are byte-identical to
  // the old sequential walk. A tamper throws inside a worker and rejects the pool -> the preflight fails closed.
  await mapPool(heights, SCAN_POOL, async (h) => { await bindBlockMemo(h); });
  for (const h of heights) {
    const { ids: bids, rebuilt } = blockMemo.get(h)!;   // populated by the pool above; present or the pool threw
    for (const [pos, tx] of rebuilt.entries()) {
      const app = tx.app;
      if (!app || app.type === "None") continue;
      const bid = bids[pos];
      if (bid === undefined) throw new Error(`block ${h}: no txid for body ${pos}`);   // bids is rebuilt.map(ctxid)
      const id = bid.toLowerCase();
      if (app.type === "Propose") {
        if (id === offerId) { markScanned(id, h); continue; }   // the offer, if it anchored in-window
        // F8 (wallet-vs-site parity): only cairnx-domain Proposes bind the resolver's replay, mirroring the site
        // swapguard.js:704 (`tx.app.domain !== DOMAIN && idl !== offerId`). toChainEvent maps a foreign-domain
        // Propose to no event, so collecting a SELLER-signed one whose uri parses as a cairnx ocancel/fclaim would
        // fail the eager authorship check below and refuse an honest, open offer the resolver and the /trade site
        // fill. The offer itself is exempt (the id === offerId continue above), exactly as the site exempts it.
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
        else otherFclaims.push({ id, height: h, pos, offer: String(rec.offer).toLowerCase(), uri: app.uri, payloadHash: String(app.payloadHash), expiresEpoch: Number(app.expiresEpoch) });
      } else {
        const proposalId = String(app.proposalId).toLowerCase();
        attestBuf.push({ id, height: h, proposalId });
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
  const grantPos = blockMemo.get(grantHeight)?.ids.findIndex((x) => x.toLowerCase() === fclaimTxid) ?? -1;
  if (grantPos < 0) throw new Error("fill-SPV: the fclaim being filled has no position in its proven block");

  // DEFECT-2 fix: authenticate each in-window OTHER-offer fclaim's proposer with the prevout-ownership bind
  // (recoverSigner alone is spoofable). Fail toward OVER-count: a hold that is MINE **or that cannot be bound**
  // is counted (dropping a possibly-mine hold under-counts and burns); only a hold provably bound to ANOTHER
  // address is excluded. Only holds still live at the grant height are proven (each costs a prevout read).
  const held: HoldCandidate[] = [];
  // proveEventAt fan-out at SCAN_POOL (12). Order of completion does not matter: the predicate just counts.
  const liveOthers = otherFclaims.filter((c) => fclaimHoldEnd(c.expiresEpoch) >= grantHeight);
  const heldBuf: typeof held = new Array(liveOthers.length);
  await mapPool(liveOthers, SCAN_POOL, async (c, i) => {
    const ev = await proveEventAt(c.id, c.height);
    const proposer = ev && ev.kind === "propose" ? ev.proposer : me;   // unbindable -> attribute to me (over-count)
    heldBuf[i] = { id: c.id, height: c.height, pos: c.pos, proposer, uri: c.uri, payloadHash: c.payloadHash, expiresEpoch: c.expiresEpoch };
  });
  for (const h of heldBuf) if (h) held.push(h);
  // countOtherHoldsAtGrant refuses a grant below LEGACY_HOLD_SUNSET_HEIGHT, where a pre-V28 legacy hold it does not
  // read could still count against the cap; the refusal fails this source closed.
  const target = { id: fclaimTxid, height: grantHeight, pos: grantPos, offer: offerId };
  const holdsAtGrant = (closedIds?: ReadonlySet<string>): number => {
    const hc = countOtherHoldsAtGrant(held, target, me, closedIds);
    if (!hc.ok) throw new Error(`fill-SPV: ${hc.reason}`);
    return hc.count;
  };
  // Past V29 the resolver skips holds on offers that are no longer open. Only when the plain count would refuse
  // (so no fill that passes today pays any extra read) look for this wallet's own proven fill of each counted
  // hold. Any lookup or proof failure leaves the hold counted.
  const closed = new Set<string>();
  const rawCount = holdsAtGrant();
  if (rawCount >= MAX_ACTIVE_CLAIMS && opts.offerHeightOf) {
    const lookup = opts.offerHeightOf;
    // Recover each candidate fill's signer from its already-bound block before any network read, so attests
    // anyone can mine naming my fclaim cannot force prevout or resolver reads. A swapped scriptSig can only
    // drop an exclusion here (over-count); proveEventAt still binds the signer to the spent coin.
    const signerIsMe = (id: string, height: number): boolean => {
      const b = blockMemo.get(height);
      const pos = b ? b.ids.findIndex((x) => x.toLowerCase() === id) : -1;
      return pos >= 0 && String(recoverSigner(b!.rebuilt[pos]!) ?? "").toLowerCase() === me;
    };
    const provenClosed = async (c: (typeof liveOthers)[number]): Promise<boolean> => {
      const fills = attestBuf.filter((a) => a.proposalId === c.id && signerIsMe(a.id, a.height));
      if (fills.length === 0) return false;
      const oh = await lookup(c.offer);
      if (oh === null) return false;
      const offerEv = await proveEventAt(c.offer, oh);
      for (const a of fills) if (myProvenFillClosedOffer(await proveEventAt(a.id, a.height), c, offerEv, me, grantHeight)) return true;
      return false;
    };
    const counted = liveOthers.filter((c) => held.some((h) => h.id === c.id && h.proposer.toLowerCase() === me));
    await mapPool(counted, SCAN_POOL, async (c) => { if (await provenClosed(c).catch(() => false)) closed.add(c.id); });
  }
  const myLiveHoldsAtGrant = closed.size === 0 ? rawCount : holdsAtGrant(closed);
  // Legacy SCORE_CLAIM holds are not scanned: the grants one can still reach (below LEGACY_HOLD_SUNSET_HEIGHT)
  // are refused by countOtherHoldsAtGrant above.

  // DEFECT-3 fix: EAGERLY authenticate every lane event the scan FOUND in a merkle-bound block, HERE (not in
  // provenEvent alone). verifyFillSpv silently SKIPS a null provenEvent AND its per-event try/catch swallows a
  // throw, so on the REPLAY leg a bind-failure = "the event never happened" (fail-OPEN). An event found in a
  // merkle-bound body but whose authorship cannot be prevout-bound is a SUPPRESSION: a hostile node swapped its
  // scriptSig (the txid strips it, so the merkle check still passes) to make a prior HOLD / CANCEL / consuming
  // FILL vanish from the replay -> a denied-fclaim / cancelled-offer false-accept -> BURN. Fail CLOSED here (the
  // wallet retries as VERIFY_UNAVAILABLE), mirroring namespv's fail-closed-on-unbindable. An honestly-mined tx
  // binds: L0 mined it with the owner's compact low-S signature, and csd-crypto verifyDigest reads the 64 bytes the
  // same way (test/sig-vectors.test.mjs), so an honest read does not trip this. A
  // genuinely-ADDED fake id (a lying resolver hint, absent from every block) is NOT here -- scannedIds holds
  // ONLY events THIS independent scan proved in a merkle-bound block, so it correctly cannot be a suppression.
  // The offer is the one scanned id that may be a foreign-domain Propose (the scan exempts it from its domain
  // filter, and toChainEvent maps it to no event): its authorship is what this checks, and the admission check
  // below refuses it by domain.
  const scanned = [...scannedIds];
  await mapPool(scanned, SCAN_POOL, async (wid) => {
    const h = heightOf.get(wid);
    if (h === undefined) return;
    const ev = await proveEventAt(wid, h);
    if (ev === null && !(wid === offerId && boundSigner.has(wid)))
      throw new Error("fill-SPV: a lane event could not be authorship-bound (possible scriptSig suppression) - refusing");
  });

  // The give-backing is synthesized below (giveBacking): the scan's window does not reach it. The admission check reads the offer's own bound tx (proveEventAt bound its block into blockMemo): its domain is
  // not on the event, and a foreign-domain offer maps to no event at all, so it is refused here by name.
  const offerHeight0 = heightOf.get(offerId)!;
  const offerEv = await proveEventAt(offerId, offerHeight0);
  const ob = blockMemo.get(offerHeight0);
  const opos = ob ? ob.ids.findIndex((x) => x.toLowerCase() === offerId) : -1;
  const offerApp = opos >= 0 ? ob!.rebuilt[opos]?.app : undefined;
  const offerSeller = boundSigner.get(offerId);
  if (!offerApp || offerApp.type !== "Propose" || !offerSeller) throw new Error("fill-SPV: the offer could not be merkle-proven");
  const offerRec = parseRecord(offerApp.uri, String(offerApp.payloadHash)) as OfferRecord | null;
  const notAdmitted = offerRec && offerRec.t === "offer"
    ? provenOfferRefusal(offerRec, { domain: offerApp.domain, height: offerHeight0, expiresEpoch: offerApp.expiresEpoch, seller: offerSeller })
    : null;
  if (notAdmitted) throw new OfferNotAdmittedError(notAdmitted);
  if (!offerEv || offerEv.kind !== "propose") throw new Error("fill-SPV: the offer could not be merkle-proven");
  // The payment recipients are bound by verifyFillSpv's sums option (the caller's planned per-address legs must
  // equal the need-map of the replayed proven offer), so this source carries no separate payto or seller field.
  // F2 (amount leg): the fee/rebate-relevant fields from the merkle-proven offer, via the ONE vendored
  // producer (B4a; the proven CREATION height is the input, never a served height - a lying resolver
  // deflating feeBps/height/value/taker cannot under-size a leg, which resolve() would reject AFTER the
  // payment moved = pay-without-delivery burn).
  // A null or non-offer record throws or mints terms the replay then refuses; either way nothing is signed.
  const provenTerms: MintedProvenOfferTerms = provenOfferTerms(offerRec as OfferRecord, offerEv.height); // MUTATE_LIVE_PROVEN_TERMS
  const synthetic = new Map<string, ProvenEvent>(giveBacking(offerRec, offerEv.proposer, verifiedTip).map((e) => [e.id, e]));

  return {
    myLiveHoldsAtGrant,
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

/** A partial offer's running state from its proven listed fills, or why the list does not prove. */
export type OfferProgress = { paid: string; delivered: string } | { unproven: string };

// F2-legacy: prove an offer's PAYMENT recipients (want.payto + the seller/rebate address) for the LEGACY /
// dApp fill lane (fillOfferPreflight), which has no fclaim SPV io to source them from. Merkle-proves the offer
// Propose tx at its confirmed height and derives: seller = the prevout-bound author (the coin can only be spent
// by its owner's key, and the owner is txid-committed, NOT scriptSig-derived); payto = the record's explicit
// want.payto (merkle-committed) or, absent, the seller. Returns { payto, seller } (lowercased 0x-addrs) or null
// on ANY unprovable / tampered / unreachable read, so the caller fails CLOSED-RETRYABLE (never a hard decline on
// an honest fill). A proven offer the resolver does not admit (cairnx-core provenOfferRefusal) returns
// { refused: reason }, a definite refusal. Reuses the same light-client primitives (liveSpvSource, bindBlock,
// prevoutScriptPubkey).
// With `fills` (a partial offer: the fills the offer service lists, in any order), it also proves the offer's running
// state: each listed fill is merkle-proven at its listed height and bound to the coin its signer spent, and the
// vendored resolve() replays them over the proven offer, so `progress` carries the paid and delivered the chain gives
// those fills, or `unproven` when one is not this offer's mined, bound fill. Cost: one block bind per distinct listed
// height beside the offer's, in parallel; none without `fills` or when none is listed.
export async function provenOfferPayto(
  opts: LiveSpvOpts & { offerId: string; offerHeight: number; spvSource?: SpvSource; fills?: readonly { txid: string; height: number }[] },
): Promise<{ payto: string; seller: string; terms: MintedProvenOfferTerms; expiresEpoch: number; height: number; progress?: OfferProgress } | { refused: string } | null> {
  const offerId = String(opts.offerId).toLowerCase();
  const offerHeight = Math.floor(Number(opts.offerHeight));
  if (!/^0x[0-9a-f]{64}$/.test(offerId) || !Number.isFinite(offerHeight) || offerHeight < 0) return null;
  const fills = opts.fills?.map((f) => ({ txid: String(f.txid).toLowerCase(), height: Math.floor(Number(f.height)) }));
  if (fills?.some((f) => !/^0x[0-9a-f]{64}$/.test(f.txid) || !Number.isSafeInteger(f.height) || f.height < 0)) return null;
  try {
    const spv = opts.spvSource ?? await liveSpvSource(opts);
    const top = Math.max(offerHeight, ...(fills ?? []).map((f) => f.height));
    const { verifiedTip } = await spv.prepare(top);                // PoW-verify headers through the highest height read
    if (!Number.isFinite(verifiedTip) || verifiedTip < top) return null;   // couldn't reach it -> retry
    const { ids: bids, rebuilt } = await bindBlockOrThrow(spv, offerHeight);   // merkle-COMPLETE bodies; throws on tamper
    const pos = bids.findIndex((x) => x.toLowerCase() === offerId);
    const tx = rebuilt[pos];
    if (pos < 0 || !tx) return null;                               // the offer is not in its claimed block (tampered)
    const app = tx.app;
    if (!app || app.type !== "Propose") return null;
    const rec = parseRecord(app.uri, String(app.payloadHash)) as { t?: string; want?: { payto?: string; value?: string; ticker?: string; amount?: string }; taker?: string; bid?: string; min?: string } | null;
    if (!rec || rec.t !== "offer") return null;
    const author = await bindSigner(tx, spv);
    if (!author.ok) return null;                                   // authorship not prevout-bound (tampered)
    const seller = author.signer;
    const refused = provenOfferRefusal(rec as OfferRecord, { domain: app.domain, height: offerHeight, expiresEpoch: app.expiresEpoch, seller });
    if (refused) return { refused };                               // a proven offer the resolver does not admit
    const payto = (rec.want?.payto && /^0x[0-9a-f]{40}$/.test(String(rec.want.payto).toLowerCase())) ? String(rec.want.payto).toLowerCase() : seller; // MUTATE_PROVEN_PAYTO_DERIVE
    // B4a: same single-sourced producer as the fclaim lane; offerHeight is the merkle-proven block
    // the offer was found in (bindBlock verified it), never a served height.
    const terms: MintedProvenOfferTerms = provenOfferTerms(rec as OfferRecord, offerHeight); // MUTATE_PROVEN_TERMS_HEIGHT
    // The proven expiry and anchor height (never served values) for the offer-id lanes' expiry check.
    const base = { payto, seller, terms, expiresEpoch: Number(app.expiresEpoch), height: offerHeight };
    if (!fills) return base;
    const offerEv = toChainEvent(tx, offerId, offerHeight, pos, seller);
    if (!offerEv) return null;
    const heights = [...new Set(fills.map((f) => f.height))].filter((h) => h !== offerHeight);
    const bound = new Map<number, { ids: string[]; rebuilt: Tx[] }>([[offerHeight, { ids: bids, rebuilt }]]);
    await mapPool(heights, SCAN_POOL, async (h) => { bound.set(h, await bindBlockOrThrow(spv, h)); });
    const events: ProvenEvent[] = [...giveBacking(rec as OfferRecord, seller, verifiedTip), { ...offerEv, depth: verifiedTip - offerHeight + 1 } as ProvenEvent];
    for (const f of fills) {
      const b = bound.get(f.height)!;
      const at = b.ids.findIndex((x) => x.toLowerCase() === f.txid);
      const ftx = b.rebuilt[at];
      if (at < 0 || !ftx) return { ...base, progress: { unproven: `listed fill ${f.txid.slice(0, 12)}… is not in block ${f.height}` } };
      const author = await bindSigner(ftx, spv);
      if (!author.ok) return { ...base, progress: { unproven: `listed fill ${f.txid.slice(0, 12)}… could not be bound to the coin it spends` } };
      const ev = toChainEvent(ftx, f.txid, f.height, at, author.signer);
      if (!ev || ev.kind !== "attest" || ev.proposalId !== offerId) return { ...base, progress: { unproven: `listed fill ${f.txid.slice(0, 12)}… is not a fill of this offer` } };
      events.push({ ...ev, depth: verifiedTip - f.height + 1 } as ProvenEvent);
    }
    const st = resolve(events, verifiedTip).offers[offerId];
    if (!st) return { ...base, progress: { unproven: "the offer does not resolve from its proven record" } };
    return { ...base, progress: { paid: String(st.paid ?? "0"), delivered: String(st.delivered ?? "0") } };
  } catch { return null; }
}
