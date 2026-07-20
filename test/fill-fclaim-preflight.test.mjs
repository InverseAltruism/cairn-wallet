// B6 (Plans/69 V28 fclaim) — the wallet fclaim-lane fill preflight wires the vendored fail-closed fund
// boundary (verifyFillSpv) and refuses a DENIED fclaim on the SHIPPED wallet artifact.
//
// Under V28 the open-lane claim is a short-expiry `fclaim` PROPOSE and the fill ATTESTS the fclaim txid.
// A resolver-DENIED fclaim is still an L0-valid attest target, so building the fill on it BURNS the whole
// payment. The wallet must refuse unless PoW-buried, merkle-proven events prove the fclaim was GRANTED to
// this wallet as the offer's live routing target and both are buried. This drives the REAL wallet preflight
// (through the vendored bundle's verifyFillSpv) with a synthetic PoW/merkle-pre-satisfied FillSpvIo, exactly
// as the B4 core test and namespv test inject a chain-free seam.
//
// Proves: honest granted+buried fill ACCEPTED; denied-fclaim REFUSED; forged-holder (someone else's fclaim)
// REFUSED; below-depth REFUSED; a clarvis 404 on a brand-new fclaim txid is fail-soft PROCEED; a clarvis VALUE
// divergence REFUSES; the cross-offer MAX_ACTIVE_CLAIMS cap over-count is COMPUTED from the scan (2 holds
// ACCEPTED, adding a 3rd FLIPS to REFUSED, never hardcoded 0). The denied-fclaim guard is MUTATION-VERIFIED
// (removed from the wallet source, the same forgery then SUBMITS, proving the guard is the sole rejecter).
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { Wallet } from "../src/core/wallet.js";
import { memoryStore } from "../src/core/storage.js";
import { requiredFillOutputs } from "../src/core/cairnx.js";
import { countMyOtherLiveHolds, liveFillSpvSource, provenOfferPayto, feeBpsAt } from "../src/core/fillspv.js";
import {
  deploy, mint, offer, fclaim, offerCancelAll, resolve, verifyFillSpv, V28_HEIGHT, TREASURY_ADDR, DEPLOY_FEE, epochOf, fclaimHoldEnd, MAX_ACTIVE_CLAIMS,
  SCORE_CLAIM, SCORE_CANCEL, CLAIM_WINDOW_BLOCKS_V20, CLAIM_FILL_GRACE_BLOCKS,
} from "../src/vendor/cairnx-spv.js";
import { proposeTx, attestTx, addrFromPriv, signSighash, buildScriptSig, ctxid, vSighash, merkleRoot, rpcTxToTx, prevoutFor, pick } from "./_spvrig.ts";
import { mkCoin, txReply } from "./_coin.js";

let pass = 0, fail = 0;
const check = (n, c) => { c ? (pass++, console.log("  ✓ " + n)) : (fail++, console.error("  ✗ " + n)); };
const origFetch = globalThis.fetch;

const S = "0x" + "55".repeat(20);            // seller
const OID = "0x" + "0f".repeat(32);
const OID2 = "0x" + "e2".repeat(32), OID3 = "0x" + "e3".repeat(32), OID4 = "0x" + "e4".repeat(32);
const id = (n) => "0x" + n.repeat(32);
const H0 = V28_HEIGHT;                        // synthetic V28 height (never the real one)
const V = 5_000_000;                          // want: 0.05 CSD (the mock coin covers it)
const E = epochOf(H0 + 3) + 2;
const HOLD_END = fclaimHoldEnd(E);
const fc1 = id("fa"), fc2 = id("fb"), fcC = id("fc"), fcH = id("f1");
const C = "0x" + "cc".repeat(20);            // a DIFFERENT holder (forged-holder case)

const PE = (i, built, height, proposer, ee, pos = 0, paidTo = {}) =>
  ({ kind: "propose", id: i, proposer, uri: built.uri, payloadHash: built.payloadHash, expiresEpoch: ee, height, pos, paidTo });

// base backing: S deploys+mints AAA and posts an OPEN CSD-priced offer (10 AAA for V to S).
const baseFor = () => [
  PE(id("01"), deploy({ ticker: "AAA", decimals: 0, supply: "1000", mint: "issuer" }), H0, S, 9e9, 0, { [TREASURY_ADDR]: String(DEPLOY_FEE) }),
  PE(id("02"), mint({ ticker: "AAA", amount: "1000" }), H0 + 1, S, 9e9),
  PE(OID, offer({ give: { ticker: "AAA", amount: "10" }, want: { value: String(V), payto: S } }), H0 + 2, S, 9e9),
];
const fcFor = (txid, offerId, height, holder) => PE(txid, fclaim({ offer: offerId }), height, holder, E);

// The synthetic seam: PoW/merkle already satisfied. depth = tip - height + 1 (the verified burial). The io
// carries myLiveHoldsAtGrant COMPUTED by the SAME pure counter the live source uses (never hardcoded).
const idOf = (e) => (e.kind === "propose" ? e.id : e.txid).toLowerCase();
// F2 (amount leg): the fee/rebate-relevant terms derived from an offer (matching what liveFillSpvSource proves).
const termsFor = (o) => ({ height: Number(o.height), feeBps: feeBpsAt(Number(o.height)), value: o.want?.value !== undefined ? String(o.want.value) : undefined, taker: o.taker !== undefined ? String(o.taker).toLowerCase() : undefined, bid: o.bid !== undefined ? String(o.bid).toLowerCase() : undefined, min: o.min !== undefined ? String(o.min) : undefined });
function makeIo(events, tip, me, fillFclaimHeight) {
  // F2: the proven payment recipients + fee/rebate terms, derived from the PROVEN offer event (never the
  // resolver-served offer), exactly as the live source does. The synthetic offer (baseFor) has proposer S,
  // want.payto S, height H0+2, no taker/bid.
  const offerEv = events.find((e) => idOf(e) === OID.toLowerCase());
  let seller = String(offerEv?.proposer ?? "").toLowerCase(), payto = seller, orec = {};
  try { orec = JSON.parse(offerEv.uri); if (orec?.want?.payto) payto = String(orec.want.payto).toLowerCase(); } catch {}
  return {
    myLiveHoldsAtGrant: countMyOtherLiveHolds(events, OID, me, fillFclaimHeight),
    provenPayto: payto,
    provenSeller: seller,
    provenTerms: { height: Number(offerEv?.height), feeBps: feeBpsAt(Number(offerEv?.height)), value: orec?.want?.value !== undefined ? String(orec.want.value) : undefined, taker: orec?.taker !== undefined ? String(orec.taker).toLowerCase() : undefined, bid: orec?.bid !== undefined ? String(orec.bid).toLowerCase() : undefined, min: orec?.min !== undefined ? String(orec.min) : undefined },
    async tip() { return tip; },
    async offerEventIds() { return events.map(idOf); },
    async provenEvent(x) { const e = events.find((y) => idOf(y) === String(x).toLowerCase()); return e ? { ...e, depth: tip - e.height + 1 } : null; },
  };
}

// The D2-aliased offer the resolver serves on a GET of the fclaim txid (offer + fclaim link fields).
const servedOffer = (fclaimTxid, fclaimHeight, extra = {}) => ({
  id: OID, seller: S, give: { ticker: "AAA", amount: "10" }, want: { value: String(V), payto: S },
  status: "open", height: H0 + 2, feeBps: 150,
  fclaimId: fclaimTxid, fclaimHeight, fclaimExpiresEpoch: E, ...extra,
});

const coin = mkCoin(100_000_002);
const served = [coin];
// outputs are offer-term-derived (independent of the buyer), so the same list fills any scenario.
const outputs = requiredFillOutputs(servedOffer(fcH, H0 + 3), BigInt(V)).map(({ to, value }) => ({ to, value: Number(value) }));

function mkStub({ offerReply, clarvisReply = () => ({ ok: false, status: 404, json: async () => ({}) }), tip = 50_000 }) {
  const stats = { submits: [] };
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes("/tx/submit")) { stats.submits.push(1); return { ok: true, status: 200, json: async () => ({ ok: true, txid: "0x" + "aa".repeat(32) }) }; }
    if (u.includes("clarvis") && u.includes("/cairnx/offer/")) return clarvisReply();
    if (u.includes("/cairnx/offer/")) return offerReply();
    if (u.match(/\/utxos\//)) return { ok: true, status: 200, json: async () => ({ confirmed_balance: coin.coin.value, utxos: [coin.coin] }) };
    if (u.endsWith("/tip")) return { ok: true, status: 200, json: async () => ({ height: tip }) };
    const t = txReply(u, served);
    if (t) return t;
    return { ok: false, status: 404, json: async () => ({}) };
  };
  return stats;
}

async function freshWallet(pw) { const w = new Wallet(memoryStore()); const { addr } = await w.create(pw); return { w, addr }; }

console.log("B6 — fclaim-lane fill preflight (verifyFillSpv fund boundary):");

// 0. the cap over-count is a PURE function of the scanned events (not hardcoded).
{
  const meX = "0x" + "77".repeat(20);
  const withOthers = (oids) => [...baseFor(), fcFor(fcH, OID, H0 + 3, meX), ...oids.map((o, i) => fcFor(id("d" + (i + 2)), o, H0 + 3, meX))];
  check("count: 2 in-window other-offer holds by me -> 2", countMyOtherLiveHolds(withOthers([OID2, OID3]), OID, meX, H0 + 3) === 2);
  check("count: adding a 3rd -> 3 (crosses MAX_ACTIVE_CLAIMS)", countMyOtherLiveHolds(withOthers([OID2, OID3, OID4]), OID, meX, H0 + 3) === MAX_ACTIVE_CLAIMS);
  check("count: this offer's OWN fclaim is NOT counted", countMyOtherLiveHolds([...baseFor(), fcFor(fcH, OID, H0 + 3, meX)], OID, meX, H0 + 3) === 0);
  check("count: another buyer's other-offer hold is NOT mine", countMyOtherLiveHolds([fcFor(id("d2"), OID2, H0 + 3, C)], OID, meX, H0 + 3) === 0);
  check("count: an other-offer hold lapsed before my grant is NOT counted", countMyOtherLiveHolds([PE(id("d9"), fclaim({ offer: OID2 }), H0 + 3, meX, epochOf(H0 - 200))], OID, meX, H0 + 3) === 0);
}

// 1. HONEST granted + buried fclaim fill is ACCEPTED (no false refusal).
{
  const { w } = await freshWallet("pw-honest");
  w.fillSpvIoForTest = (oid, fc, me) => makeIo([...baseFor(), fcFor(fcH, OID, H0 + 3, me)], HOLD_END - 5, me, H0 + 3);
  const s = mkStub({ offerReply: () => ({ ok: true, status: 200, json: async () => servedOffer(fcH, H0 + 3) }) });
  const r = await w.fillOffer({ proposalId: fcH, outputs });
  check(`honest granted+buried fclaim fill is ACCEPTED and submits (${r?.error ?? "ok"})`, r?.ok === true && s.submits.length === 1);
}

// 2. DENIED-fclaim fill is REFUSED (fc1 holds; fc2 posted while fc1's hold is live -> resolver DENIES fc2).
{
  const MB = "0x" + "b2".repeat(20);
  const st = resolve([...baseFor(), fcFor(fc1, OID, H0 + 3, MB), fcFor(fc2, OID, H0 + 5, MB)], HOLD_END - 5);
  check("sanity: fc2 is DENIED (fc1 stays the live routing target)", st.fclaims[fc1] !== undefined && st.fclaims[fc2] === undefined && st.offers[OID].claimTxid === fc1);
  const { w } = await freshWallet("pw-denied");
  w.fillSpvIoForTest = (oid, fc, me) => makeIo([...baseFor(), fcFor(fc1, OID, H0 + 3, me), fcFor(fc2, OID, H0 + 5, me)], HOLD_END - 5, me, H0 + 5);
  const s = mkStub({ offerReply: () => ({ ok: true, status: 200, json: async () => servedOffer(fc2, H0 + 5) }) });
  const r = await w.fillOffer({ proposalId: fc2, outputs });
  check(`denied-fclaim fill is REFUSED (${r?.error})`, r?.ok === false && r?.code === "FILL_UNSAFE");
  check("…and nothing was submitted (the payment did not burn)", s.submits.length === 0);
}

// 3. FORGED-HOLDER fill is REFUSED (C holds fcC; this wallet is not the holder).
{
  const { w } = await freshWallet("pw-forged");
  w.fillSpvIoForTest = (oid, fc, me) => makeIo([...baseFor(), fcFor(fcC, OID, H0 + 3, C)], HOLD_END - 5, me, H0 + 3);
  const s = mkStub({ offerReply: () => ({ ok: true, status: 200, json: async () => servedOffer(fcC, H0 + 3, { claimedBy: C }) }) });
  const r = await w.fillOffer({ proposalId: fcC, outputs });
  check(`forged-holder (fill on someone else's fclaim) is REFUSED (${r?.error})`, r?.ok === false && r?.code === "FILL_UNSAFE");
  check("…and nothing was submitted", s.submits.length === 0);
}

// 4. BELOW-DEPTH fclaim fill is REFUSED (fclaim mined at H0+3, tip H0+4 -> depth 2 < requiredClaimDepth).
{
  const { w } = await freshWallet("pw-shallow");
  w.fillSpvIoForTest = (oid, fc, me) => makeIo([...baseFor(), fcFor(fcH, OID, H0 + 3, me)], H0 + 4, me, H0 + 3);
  const s = mkStub({ offerReply: () => ({ ok: true, status: 200, json: async () => servedOffer(fcH, H0 + 3) }) });
  const r = await w.fillOffer({ proposalId: fcH, outputs });
  check(`below-depth fclaim fill is REFUSED (${r?.error})`, r?.ok === false && r?.code === "FILL_UNSAFE" && /buried/.test(r?.error ?? ""));
  check("…and nothing was submitted", s.submits.length === 0);
}

// 5a. clarvis 404 on a brand-new fclaim txid is FAIL-SOFT PROCEED (an honest buy is never blocked by a lagging 2nd source).
{
  const { w } = await freshWallet("pw-clarvis404");
  w.fillSpvIoForTest = (oid, fc, me) => makeIo([...baseFor(), fcFor(fcH, OID, H0 + 3, me)], HOLD_END - 5, me, H0 + 3);
  const s = mkStub({
    offerReply: () => ({ ok: true, status: 200, json: async () => servedOffer(fcH, H0 + 3) }),
    clarvisReply: () => ({ ok: false, status: 404, json: async () => ({ error: "not found" }) }),
  });
  const r = await w.fillOffer({ proposalId: fcH, outputs });
  check(`clarvis 404 on the fclaim txid is fail-soft PROCEED (honest buy submits) (${r?.error ?? "ok"})`, r?.ok === true && s.submits.length === 1);
}

// 5b. clarvis VALUE divergence REFUSES (a second source disagrees on want.payto), even though SPV would pass.
{
  const { w } = await freshWallet("pw-clarvisdiv");
  w.fillSpvIoForTest = (oid, fc, me) => makeIo([...baseFor(), fcFor(fcH, OID, H0 + 3, me)], HOLD_END - 5, me, H0 + 3);
  const s = mkStub({
    offerReply: () => ({ ok: true, status: 200, json: async () => servedOffer(fcH, H0 + 3) }),
    clarvisReply: () => ({ ok: true, status: 200, json: async () => servedOffer(fcH, H0 + 3, { want: { value: String(V), payto: "0x" + "ee".repeat(20) } }) }),
  });
  const r = await w.fillOffer({ proposalId: fcH, outputs });
  check(`clarvis value divergence (want.payto) REFUSES (${r?.error})`, r?.ok === false && r?.code === "SOURCE_DIVERGENCE");
  check("…and nothing was submitted", s.submits.length === 0);
}

// 5c. clarvis-OPTIONAL: a REACHABLE clarvis returning HTTP 200 with a degraded body that carries NO offer terms
// (an error/aliased/unknown-offer body, no want AND no give) is fail-soft PROCEED, NOT a false value divergence.
// This keeps clarvis a strictly-optional second source: a reachable-but-useless clarvis can never turn into a
// hard blocker of a legit buy. (A reachable clarvis that DOES serve a real offer with a conflicting want/give
// still REFUSES per 5b.)
{
  const { w } = await freshWallet("pw-clarvisdegraded");
  w.fillSpvIoForTest = (oid, fc, me) => makeIo([...baseFor(), fcFor(fcH, OID, H0 + 3, me)], HOLD_END - 5, me, H0 + 3);
  const s = mkStub({
    offerReply: () => ({ ok: true, status: 200, json: async () => servedOffer(fcH, H0 + 3) }),
    clarvisReply: () => ({ ok: true, status: 200, json: async () => ({ ok: false, error: "unknown offer" }) }), // 200, no want/give
  });
  const r = await w.fillOffer({ proposalId: fcH, outputs });
  check(`reachable clarvis with no offer terms is fail-soft PROCEED (honest buy submits) (${r?.error ?? "ok"})`, r?.ok === true && s.submits.length === 1);
}

// 6. CROSS-OFFER cap: the count is COMPUTED from the scan. 2 other-offer holds ACCEPTS; adding a 3rd FLIPS to REFUSE.
{
  const { w } = await freshWallet("pw-cap-01");
  const eventsWith = (me, oids) => [...baseFor(), fcFor(fcH, OID, H0 + 3, me), ...oids.map((o, i) => fcFor(id("d" + (i + 2)), o, H0 + 3, me))];
  const s = mkStub({ offerReply: () => ({ ok: true, status: 200, json: async () => servedOffer(fcH, H0 + 3) }) });
  w.fillSpvIoForTest = (oid, fc, me) => makeIo(eventsWith(me, [OID2, OID3]), HOLD_END - 5, me, H0 + 3);
  const rUnder = await w.fillOffer({ proposalId: fcH, outputs });
  check(`cap: 2 computed other-offer holds (< MAX_ACTIVE_CLAIMS) is ACCEPTED (${rUnder?.error ?? "ok"})`, rUnder?.ok === true);
  const n0 = s.submits.length;
  w.fillSpvIoForTest = (oid, fc, me) => makeIo(eventsWith(me, [OID2, OID3, OID4]), HOLD_END - 5, me, H0 + 3);   // one more hold, nothing else changed
  const rOver = await w.fillOffer({ proposalId: fcH, outputs });
  check(`cap: adding a 3rd other-offer hold FLIPS to REFUSED (count computed, not hardcoded) (${rOver?.error})`, rOver?.ok === false && rOver?.code === "FILL_UNSAFE" && /cap/.test(rOver?.error ?? ""));
  check("…and the cap-refused fill did NOT submit", s.submits.length === n0);
}

// 6b. a source that does not compute the count (no myLiveHoldsAtGrant) fails CLOSED (0 is NEVER assumed).
{
  const { w } = await freshWallet("pw-nocount");
  w.fillSpvIoForTest = (oid, fc, me) => { const io = makeIo([...baseFor(), fcFor(fcH, OID, H0 + 3, me)], HOLD_END - 5, me, H0 + 3); delete io.myLiveHoldsAtGrant; return io; };
  const s = mkStub({ offerReply: () => ({ ok: true, status: 200, json: async () => servedOffer(fcH, H0 + 3) }) });
  const r = await w.fillOffer({ proposalId: fcH, outputs });
  check(`no computed cap count -> fail CLOSED (never assume 0) (${r?.error})`, r?.ok === false && r?.code === "VERIFY_UNAVAILABLE");
  check("…and nothing was submitted", s.submits.length === 0);
}

// F2. a lying resolver swaps the served want.payto (or seller) to an attacker while the PROVEN offer still pays
// the real seller S. verifyFillSpv proves DELIVERY but NOT the payment recipients; the F2 bind must REFUSE and
// nothing may submit. (clarvis is fail-soft 404 here, exactly the residual F2 closes at the fund boundary.)
{
  const ATT = "0x" + "a7".repeat(20);
  const attackOffer = (extra = {}) => ({ ...servedOffer(fcH, H0 + 3), ...extra });
  const io = (me) => makeIo([...baseFor(), fcFor(fcH, OID, H0 + 3, me)], HOLD_END - 5, me, H0 + 3);   // PROVEN offer pays S
  // (a) swapped want.payto -> the seller PAYMENT is redirected (theft)
  {
    const { w } = await freshWallet("pw-f2-payto");
    const served = attackOffer({ want: { value: String(V), payto: ATT } });
    const outs = requiredFillOutputs(served, BigInt(V)).map(({ to, value }) => ({ to, value: Number(value) }));
    w.fillSpvIoForTest = (oid, fc, me) => io(me);
    const s = mkStub({ offerReply: () => ({ ok: true, status: 200, json: async () => served }) });
    const r = await w.fillOffer({ proposalId: fcH, outputs: outs });
    check(`F2: a swapped served want.payto is REFUSED (proven author S != attacker) (${r?.error})`, r?.ok === false && r?.code === "FILL_UNSAFE" && /payment recipient/.test(r?.error ?? ""));
    check("…and nothing was submitted (the payment did not go to the attacker)", s.submits.length === 0);
  }
  // (b) swapped seller -> the REBATE leg mis-sizes so resolve() would reject the fill (burn)
  {
    const { w } = await freshWallet("pw-f2-seller");
    const served = attackOffer({ seller: ATT });
    const outs = requiredFillOutputs(served, BigInt(V)).map(({ to, value }) => ({ to, value: Number(value) }));
    w.fillSpvIoForTest = (oid, fc, me) => io(me);
    const s = mkStub({ offerReply: () => ({ ok: true, status: 200, json: async () => served }) });
    const r = await w.fillOffer({ proposalId: fcH, outputs: outs });
    check(`F2: a swapped served seller (rebate leg) is REFUSED (proven seller S != attacker) (${r?.error})`, r?.ok === false && r?.code === "FILL_UNSAFE" && /payment recipient/.test(r?.error ?? ""));
    check("…and nothing was submitted", s.submits.length === 0);
  }
}

// ── DEFECT/OBS re-confirm: drive the REAL liveFillSpvSource (a synthetic PoW SpvSource over REAL signed txs).
//    The chain-free injected seam above hands proposer + true height directly, so it exercises NEITHER the
//    resolver-height path (DEFECT 1) nor the scriptSig-swap path (DEFECT 2). These drive the production count. ──
const meKey = "0x" + "1a".repeat(32), foreignKey = "0x" + "2b".repeat(32);
const ME = addrFromPriv(meKey).toLowerCase();
const Hfc = H0 + 3, TIP = H0 + 10;
const LEGACY_HOLD = CLAIM_WINDOW_BLOCKS_V20 + CLAIM_FILL_GRACE_BLOCKS;
const FILLER = { version: 1, locktime: 0, inputs: [{ prev_txid: "0x" + "00".repeat(32), vout: 1, script_sig: "0x" }], outputs: [{ value: 1, script_pubkey: "0x" + "77".repeat(20) }] };
// A synthetic SpvSource whose blocks carry a REAL merkle root (so bindBlock genuinely passes) and returns a
// filler-only block for empty heights (the fill scan iterates every height in the tip-anchored window).
function fillSource(blocks, tip) {
  return {
    async prepare() { return { verifiedTip: tip, nodeTip: tip }; },
    async blockAt(height) {
      const txs = blocks.get(height) ?? [FILLER];
      return { merkle: merkleRoot(txs.map((t) => ctxid(rpcTxToTx(t.app ? t : { ...t, app: { type: "None" } })))), txs };
    },
    async prevoutScriptPubkey(prevTxid) { return prevoutFor(prevTxid); },
  };
}
const worldOf = (placements) => { const b = new Map(); for (const { height, tx } of placements) (b.get(height) ?? b.set(height, []).get(height)).push(tx); return b; };
// A REAL offer (so the production io can prove + synthesize its give-backing, FIX B); the lane fclaims target it.
const sellerKeyD = "0x" + "5e".repeat(32);
const offTxD = proposeTx({ ...pick(offer({ give: { ticker: "AAA", amount: "10" }, want: { value: String(V), payto: addrFromPriv(sellerKeyD) } })), priv: sellerKeyD, expiresEpoch: 9e9 });
const LOID = ctxid(rpcTxToTx(offTxD)).toLowerCase();
const withOffer = (placements) => worldOf([{ height: H0 + 2, tx: offTxD }, ...placements]);
const runLive = (blocks, fclaimTxid, offerId = LOID) => liveFillSpvSource({ rpcBase: "http://x", headersBase: "http://x", spvSource: fillSource(blocks, TIP), hints: { offerId, fclaimTxid, me: ME, offerHeight: H0 + 2 } });
const fcTxFor = (offerId = LOID, priv = meKey) => proposeTx({ ...pick(fclaim({ offer: offerId })), priv, expiresEpoch: E });

// DEFECT 1: the cap keys on the PROVEN mined grant height (from the scan), never a served/inflated one. 3
// genuine me-holds live at the true grant height -> 3; keying on a height past their holdEnd would UNDER-count.
{
  const fill = fcTxFor();
  const holds = [fcTxFor(OID2), fcTxFor(OID3), fcTxFor(OID4)];
  const blocks = withOffer([fill, ...holds].map((tx) => ({ height: Hfc, tx })));
  const io = await runLive(blocks, ctxid(rpcTxToTx(fill)));
  check(`DEFECT1: cap counts 3 genuine me-holds on the PROVEN grant height (got ${io.myLiveHoldsAtGrant})`, io.myLiveHoldsAtGrant === 3);
  const evs = holds.map((t) => { const x = rpcTxToTx(t); return { kind: "propose", proposer: ME, uri: x.app.uri, payloadHash: String(x.app.payloadHash), expiresEpoch: E }; });
  check("DEFECT1: keying on an INFLATED height (> holdEnd) would UNDER-count to 0 (the burn the fix prevents)", countMyOtherLiveHolds(evs, LOID, ME, HOLD_END + 1) === 0 && countMyOtherLiveHolds(evs, LOID, ME, Hfc) === 3);
}

// DEFECT 2: authenticate each counted hold with the prevout-ownership bind. A me-hold whose scriptSig was SWAPPED
// to a foreign valid signature (over the same sighash) but whose SPENT COIN is still mine is UNBINDABLE -> COUNTED
// (over-count); a genuine stranger hold (foreign signs, foreign owns the coin) is bound to them -> NOT counted.
{
  const fill = fcTxFor();
  const legit = fcTxFor(OID2);                                  // my coin, my sig
  const swapped = JSON.parse(JSON.stringify(legit));
  const sig = signSighash(vSighash(rpcTxToTx(legit)), foreignKey);
  swapped.inputs[0].script_sig = buildScriptSig(sig.sig64, sig.pub33);   // re-attribute the author; txid unchanged
  const stranger = fcTxFor(OID3, foreignKey);                  // foreign coin, foreign sig
  const blocks = withOffer([{ height: Hfc, tx: fill }, { height: Hfc, tx: swapped }, { height: Hfc, tx: stranger }]);
  const io = await runLive(blocks, ctxid(rpcTxToTx(fill)));
  check(`DEFECT2: a scriptSig-swapped ME-hold is still COUNTED (bind rejects re-attribution) and a bound stranger is NOT (got ${io.myLiveHoldsAtGrant})`, io.myLiveHoldsAtGrant === 1);
}

// OBS 3: a still-live pre-V28 LEGACY hold (score=SCORE_CLAIM attest on another offer) by me counts toward the
// cap in the ~45-block V28 transition; a stranger's and a provably-lapsed (older than LEGACY_HOLD) one do not.
{
  const fill = fcTxFor();
  const legacyMine = attestTx({ proposalId: OID2, score: SCORE_CLAIM, priv: meKey });
  const legacyStranger = attestTx({ proposalId: OID3, score: SCORE_CLAIM, priv: foreignKey });
  const legacyOld = attestTx({ proposalId: OID4, score: SCORE_CLAIM, priv: meKey });
  const blocks = withOffer([
    { height: Hfc, tx: fill }, { height: Hfc, tx: legacyMine }, { height: Hfc, tx: legacyStranger },
    { height: Hfc - LEGACY_HOLD - 1, tx: legacyOld },
  ]);
  const io = await runLive(blocks, ctxid(rpcTxToTx(fill)));
  check(`OBS3: a live legacy me-hold counts; a stranger's and a lapsed one do not (got ${io.myLiveHoldsAtGrant})`, io.myLiveHoldsAtGrant === 1);
}

// DEFECT 1 backstop: the fclaim being filled MUST be merkle-proven in the scan window, else fail CLOSED
// (an inflated/forged height can never anchor the cap on a non-proven target).
{
  const blocks = withOffer([{ height: Hfc, tx: fcTxFor(OID2) }]);   // no fclaim-for-LOID present at all
  let threw = false;
  try { await runLive(blocks, id("ab")); } catch { threw = true; }
  check("DEFECT1: an unprovable fclaim-being-filled fails CLOSED (throws -> preflight VERIFY_UNAVAILABLE)", threw === true);
}

// DEFECT 3 (replay leg): an in-window LANE event the scan FOUND in a merkle-bound block but whose scriptSig was
// swapped (unbindable) must FAIL CLOSED, not silently vanish from the grant replay (which would false-accept a
// denied fclaim / cancelled offer -> BURN). Drive the REAL liveFillSpvSource scan with a real buildScriptSig swap.
const swapSig = (rpcTx, newPriv) => { const t = JSON.parse(JSON.stringify(rpcTx)); const s = signSighash(vSighash(rpcTxToTx(rpcTx)), newPriv); t.inputs[0].script_sig = buildScriptSig(s.sig64, s.pub33); return t; };
{
  // positive control: an HONEST competing prior hold binds fine -> no throw (the eager auth never false-refuses).
  const fc2 = fcTxFor(), fc1 = fcTxFor(LOID, foreignKey);
  let threw = false, io = null;
  try { io = await runLive(withOffer([{ height: Hfc, tx: fc2 }, { height: Hfc, tx: fc1 }]), ctxid(rpcTxToTx(fc2))); } catch { threw = true; }
  check("DEFECT3: an HONEST competing hold in-window binds fine (no false-refuse)", threw === false && io !== null);
}
{
  // a competing prior HOLD fc1 present in a merkle-bound block with a SWAPPED scriptSig (author suppressed).
  const fc2 = fcTxFor(), fc1swapped = swapSig(fcTxFor(LOID, foreignKey), meKey);
  let threw = false;
  try { await runLive(withOffer([{ height: Hfc, tx: fc2 }, { height: Hfc, tx: fc1swapped }]), ctxid(rpcTxToTx(fc2))); } catch { threw = true; }
  check("DEFECT3: a scriptSig-suppressed competing HOLD fails the replay CLOSED (throws, not vanishes)", threw === true);
}
{
  // an in-window maker CANCEL of the offer with a SWAPPED scriptSig (suppressed so the offer looks still open).
  const fc = fcTxFor(), cancelSwapped = swapSig(attestTx({ proposalId: LOID, score: SCORE_CANCEL, priv: foreignKey }), meKey);
  let threw = false;
  try { await runLive(withOffer([{ height: Hfc, tx: fc }, { height: Hfc, tx: cancelSwapped }]), ctxid(rpcTxToTx(fc))); } catch { threw = true; }
  check("DEFECT3: a scriptSig-suppressed in-window CANCEL fails the replay CLOSED (throws, not vanishes)", threw === true);
}

// F8 (wallet-vs-site divergence): an ocancel (bulk offer-cancel-all) by the offer's SELLER landing BEFORE the
// fclaim grant CANCELS the offer, so a fill on it is a pay-without-delivery burn. The scan MUST collect the
// ocancel and feed it to the grant replay (the pre-fix code dropped it at fillspv.ts:211 -> false-accept).
{
  const fill = fcTxFor();
  const cancel = proposeTx({ ...pick(offerCancelAll({ ticker: "AAA" })), priv: sellerKeyD, expiresEpoch: 9e9 });  // the offer's own seller
  const io = await runLive(withOffer([{ height: Hfc - 1, tx: cancel }, { height: Hfc, tx: fill }]), ctxid(rpcTxToTx(fill)));
  const v = await verifyFillSpv(LOID, ctxid(rpcTxToTx(fill)).toLowerCase(), ME, io, { myLiveHoldsAtGrant: io.myLiveHoldsAtGrant, pay: BigInt(V) });
  check(`F8: a pre-grant seller ocancel CANCELS the offer -> verifyFillSpv REFUSES safe:false (${v.reason ?? "safe"})`, v.safe === false);
}
{
  // positive control: an ocancel for a DIFFERENT ticker does NOT cancel this offer -> still ACCEPTS (no over-refuse).
  const fill = fcTxFor();
  const otherCancel = proposeTx({ ...pick(offerCancelAll({ ticker: "ZZZ" })), priv: sellerKeyD, expiresEpoch: 9e9 });
  const io = await runLive(withOffer([{ height: Hfc - 1, tx: otherCancel }, { height: Hfc, tx: fill }]), ctxid(rpcTxToTx(fill)));
  const v = await verifyFillSpv(LOID, ctxid(rpcTxToTx(fill)).toLowerCase(), ME, io, { myLiveHoldsAtGrant: io.myLiveHoldsAtGrant, pay: BigInt(V) });
  check(`F8: an ocancel for a DIFFERENT ticker does NOT cancel -> verifyFillSpv still ACCEPTS (${v.reason ?? "safe"})`, v.safe === true);
}
{
  // F8 domain guard (wallet-vs-site parity): a seller-signed matching ocancel in a FOREIGN (non-cairnx) domain is
  // IGNORED by the scan (mirroring swapguard.js:704), so the offer stays open and the honest fill still ACCEPTS.
  // WITHOUT the domain guard the wallet would collect it, cancel the offer in its replay only, and HARD-decline an
  // honest fill the authoritative resolver and the /trade site fill fine.
  const fill = fcTxFor();
  const foreignCancel = proposeTx({ ...pick(offerCancelAll({ ticker: "AAA" })), priv: sellerKeyD, expiresEpoch: 9e9, domain: "cairn:v1" });
  const io = await runLive(withOffer([{ height: Hfc - 1, tx: foreignCancel }, { height: Hfc, tx: fill }]), ctxid(rpcTxToTx(fill)));
  const v = await verifyFillSpv(LOID, ctxid(rpcTxToTx(fill)).toLowerCase(), ME, io, { myLiveHoldsAtGrant: io.myLiveHoldsAtGrant, pay: BigInt(V) });
  check(`F8: a FOREIGN-domain seller ocancel is ignored -> honest fill still ACCEPTS (no wallet-vs-site false-refuse) (${v.reason ?? "safe"})`, v.safe === true);
}

// F2-legacy: the REAL provenOfferPayto (the legacy/dApp lane's payment-recipient SPV) over a synthetic PoW
// SpvSource. Every legacy-lane preflight test STUBS this via provenPaytoForTest, so this pins the real
// merkle-proving path: a null-returning bug would false-refuse EVERY honest legacy/dApp fill (the no-false-refuse
// UX red line), and a wrong-owner bug would re-open the F2 theft. Honest -> correct {payto,seller,terms}; a
// scriptSig-swapped author -> null (prevout-bound); a lied offer height -> null (no substitution).
{
  const sellerAddr = addrFromPriv(sellerKeyD).toLowerCase();
  const src = fillSource(withOffer([]), TIP);   // just the honest offer offTxD at H0+2
  const honest = await provenOfferPayto({ rpcBase: "http://x", headersBase: "http://x", spvSource: src, offerId: LOID, offerHeight: H0 + 2 });
  check(`F2-legacy: provenOfferPayto proves the honest offer author + terms (no-false-refuse control) (${honest?.seller})`,
    honest !== null && honest.seller === sellerAddr && honest.payto === sellerAddr && honest.terms.feeBps === 150 && honest.terms.height === H0 + 2 && honest.terms.value === String(V));
  const wrongHeight = await provenOfferPayto({ rpcBase: "http://x", headersBase: "http://x", spvSource: src, offerId: LOID, offerHeight: H0 + 5 });
  check("F2-legacy: provenOfferPayto with a LIED offer height fails CLOSED (null, no substitution)", wrongHeight === null);
  const swappedOffer = swapSig(offTxD, meKey);   // re-sign the offer with a FOREIGN key (txid unchanged)
  const swapped = await provenOfferPayto({ rpcBase: "http://x", headersBase: "http://x", spvSource: fillSource(worldOf([{ height: H0 + 2, tx: swappedOffer }]), TIP), offerId: ctxid(rpcTxToTx(swappedOffer)).toLowerCase(), offerHeight: H0 + 2 });
  check("F2-legacy: provenOfferPayto rejects a scriptSig-swapped author (null, prevout-owner-bound)", swapped === null);
}

{
  // wallet-level end-to-end: a source THROW (the DEFECT-3 suppression path) surfaces as retryable
  // VERIFY_UNAVAILABLE, NEVER a signed fill — the fail-closed default holds through the whole preflight.
  const { w } = await freshWallet("pw-throw01");
  w.fillSpvIoForTest = () => { throw new Error("fill-SPV: a lane event could not be authorship-bound (possible scriptSig suppression) - refusing"); };
  const s = mkStub({ offerReply: () => ({ ok: true, status: 200, json: async () => servedOffer(fcH, H0 + 3) }) });
  const r = await w.fillOffer({ proposalId: fcH, outputs });
  check(`DEFECT3: a source suppression THROW surfaces as VERIFY_UNAVAILABLE at the wallet (never a signed fill) (${r?.error})`, r?.ok === false && r?.code === "VERIFY_UNAVAILABLE");
  check("…and nothing was submitted", s.submits.length === 0);
}

// FIX A (RT3): an offer-txid fill during a LIVE fclaim hold at tip>=V28 must REFUSE (Correction 1 mirror), never
// sign an SCORE_FILL on the offer id (the resolver routes fills to the fclaim; the offer-txid attest burns).
{
  const { w, addr: W } = await freshWallet("pw-wrongtarget");
  const held = { id: OID, seller: S, give: { ticker: "TKN", amount: "5" }, want: { value: String(V), payto: S }, status: "open", height: H0 + 2, feeBps: 150, claimTxid: fcH, claimedBy: W, claimUntilHeight: 100_200 };
  const s = mkStub({ offerReply: () => ({ ok: true, status: 200, json: async () => held }), tip: 100_100 });   // GET on the OFFER id
  const r = await w.fillOffer({ proposalId: OID, outputs });
  check(`FIXA: offer-txid fill during a live fclaim hold is REFUSED (${r?.error})`, r?.ok === false && r?.code === "FILL_WRONG_TARGET");
  check("…and nothing was submitted (the payment did not burn)", s.submits.length === 0);
}
{
  const { w, addr: W } = await freshWallet("pw-belowv28");
  const taker = { id: OID, seller: S, give: { ticker: "TKN", amount: "5" }, want: { value: String(V), payto: S }, status: "open", height: 47_000, feeBps: 150, taker: W };
  w.provenPaytoForTest = () => ({ payto: S.toLowerCase(), seller: S.toLowerCase(), terms: termsFor(taker) });   // F2-legacy: honest proven author + terms
  const s = mkStub({ offerReply: () => ({ ok: true, status: 200, json: async () => taker }), tip: 50_000 });
  const r = await w.fillOffer({ proposalId: OID, outputs });
  check(`FIXA: a below-V28 offer-txid fill is UNAFFECTED (no FILL_WRONG_TARGET false-refuse) (${r?.error ?? "ok"})`, r?.code !== "FILL_WRONG_TARGET" && r?.ok === true && s.submits.length === 1);
}

// WANT-TYPE (legacy lane, 2026-07-18): a hostile/MITM resolver serves a genuinely TOKEN-priced offer as
// CSD-priced (drop want.ticker, add a fake want.value). The proven offer is token-priced (terms.value
// undefined), so the wallet must REFUSE before signing a CSD payment that resolve() would reject (no delivery)
// = pay-without-delivery burn/theft. Mirrors the fclaim lane's isTokenWant rejection.
{
  const { w, addr: W } = await freshWallet("pw-wanttype");
  const servedCsd = { id: OID, seller: S, give: { ticker: "TKN", amount: "5" }, want: { value: String(V), payto: S }, status: "open", height: 47_000, feeBps: 150, taker: W };   // SERVED as CSD-priced + taker-bound (legacy lane)
  const provenTokenTerms = termsFor({ height: 47_000, want: { ticker: "BAR", amount: "1" }, taker: W });   // PROVEN offer is TOKEN-priced -> terms.value undefined (the hidden lie)
  w.provenPaytoForTest = () => ({ payto: S.toLowerCase(), seller: S.toLowerCase(), terms: provenTokenTerms });
  const s = mkStub({ offerReply: () => ({ ok: true, status: 200, json: async () => servedCsd }), tip: 50_000 });
  const r = await w.fillOffer({ proposalId: OID, outputs });
  check(`WANT-TYPE: a token-priced offer served as CSD-priced is REFUSED (${r?.error})`, r?.ok === false && r?.code === "FILL_UNSAFE" && /not CSD-priced/i.test(String(r?.error)));
  check("…and nothing was submitted (the payment did not burn)", s.submits.length === 0);
}
{
  // no-false-refuse control: the SAME served shape with a genuinely CSD-priced PROVEN offer (terms.value
  // defined) is NOT refused by the want-type guard (proves it keys on the proven want-type, not the served one).
  const { w, addr: W } = await freshWallet("pw-wanttype-ok");
  const servedCsd = { id: OID, seller: S, give: { ticker: "TKN", amount: "5" }, want: { value: String(V), payto: S }, status: "open", height: 47_000, feeBps: 150, taker: W };
  w.provenPaytoForTest = () => ({ payto: S.toLowerCase(), seller: S.toLowerCase(), terms: termsFor(servedCsd) });   // honest CSD-priced proven (terms.value defined)
  const s = mkStub({ offerReply: () => ({ ok: true, status: 200, json: async () => servedCsd }), tip: 50_000 });
  const r = await w.fillOffer({ proposalId: OID, outputs });
  check(`WANT-TYPE control: an honest CSD-priced offer is NOT want-type-refused (${r?.error ?? "ok"})`, r?.ok === true && s.submits.length === 1);
}
// RT-STEER (bypass close): the fclaim-lane routing is STRUCTURAL (proposalId != offer.id), NOT the resolver-echoed
// fclaimId, so a hostile primary that WITHHOLDS/alters fclaimId cannot steer a denied-fclaim fill into the
// resolver-trusted legacy lane. The served offer omits fclaimId AND crafts a legacy-passable open-CSD claim
// (claimedBy=me): the OLD code would fall to legacy fillIsSafe and BURN; the fixed code STILL runs the SPV boundary.
{
  const { w, addr: W } = await freshWallet("pw-steer01");
  const served = { id: OID, seller: S, give: { ticker: "AAA", amount: "10" }, want: { value: String(V), payto: S }, status: "open", height: H0 + 2, feeBps: 150, claimedBy: W, claimUntilHeight: 9e15 };   // NO fclaimId
  w.fillSpvIoForTest = (oid, fc, me) => makeIo([...baseFor(), fcFor(fc1, OID, H0 + 3, me), fcFor(fc2, OID, H0 + 5, me)], HOLD_END - 5, me, H0 + 5);
  const s = mkStub({ offerReply: () => ({ ok: true, status: 200, json: async () => served }) });
  const r = await w.fillOffer({ proposalId: fc2, outputs });   // fc2 (DENIED) != offer.id -> MUST route to SPV
  check(`RT-STEER: fclaimId withheld but proposalId != offer.id -> SPV STILL runs; DENIED fclaim REFUSED (bypass closed) (${r?.error})`, r?.ok === false && r?.code === "FILL_UNSAFE");
  check("…and nothing was submitted (the payment did not burn)", s.submits.length === 0);
}
{
  const { w } = await freshWallet("pw-steer02");
  const served = { id: OID, seller: S, give: { ticker: "AAA", amount: "10" }, want: { value: String(V), payto: S }, status: "open", height: H0 + 2, feeBps: 150 };   // honest, NO fclaimId
  w.fillSpvIoForTest = (oid, fc, me) => makeIo([...baseFor(), fcFor(fcH, OID, H0 + 3, me)], HOLD_END - 5, me, H0 + 3);
  const s = mkStub({ offerReply: () => ({ ok: true, status: 200, json: async () => served }) });
  const r = await w.fillOffer({ proposalId: fcH, outputs });   // honest fclaim != offer.id -> SPV -> ACCEPT
  check(`RT-STEER: an honest fclaim-lane fill with fclaimId WITHHELD still ACCEPTS (structural routing) (${r?.error ?? "ok"})`, r?.ok === true && s.submits.length === 1);
}
{
  const { w, addr: W } = await freshWallet("pw-legacy01");
  const taker = { id: OID, seller: S, give: { ticker: "AAA", amount: "10" }, want: { value: String(V), payto: S }, status: "open", height: 47_000, feeBps: 150, taker: W };
  w.provenPaytoForTest = () => ({ payto: S.toLowerCase(), seller: S.toLowerCase(), terms: termsFor(taker) });   // F2-legacy: honest proven author + terms
  const s = mkStub({ offerReply: () => ({ ok: true, status: 200, json: async () => taker }), tip: 100_100 });
  const r = await w.fillOffer({ proposalId: OID, outputs });   // proposalId === offer.id, no claimTxid -> legacy path
  check(`RT-STEER: a legacy taker-bound fill (proposalId===offer.id, no claimTxid) proceeds via legacy at V28 (no false-refuse) (${r?.error ?? "ok"})`, r?.ok === true && s.submits.length === 1);
}
// F2-legacy: the SPV-less legacy/dApp lane must ALSO bind the payment recipient. A lying resolver swaps the
// served want.payto (or seller) on a taker-bound (proposalId===offer.id) fill; the F2-legacy bind must REFUSE.
// The transient valve: an UNPROVABLE (null) proof yields retryable VERIFY_UNAVAILABLE, never a hard decline.
{
  const ATT = "0x" + "a8".repeat(20);
  const { w, addr: W1 } = await freshWallet("pw-legacy-f2");
  const taker = (extra) => ({ id: OID, seller: S, give: { ticker: "AAA", amount: "10" }, want: { value: String(V), payto: S }, status: "open", height: 47_000, feeBps: 150, taker: W1, ...extra });
  // (a) swapped served want.payto -> REFUSED (proven author S)
  {
    const served = taker({ want: { value: String(V), payto: ATT } });
    const outs = requiredFillOutputs(served, BigInt(V)).map(({ to, value }) => ({ to, value: Number(value) }));
    w.provenPaytoForTest = () => ({ payto: S.toLowerCase(), seller: S.toLowerCase(), terms: termsFor(taker()) });
    const s = mkStub({ offerReply: () => ({ ok: true, status: 200, json: async () => served }), tip: 100_100 });
    const r = await w.fillOffer({ proposalId: OID, outputs: outs });
    check(`F2-legacy: a swapped served want.payto on the legacy lane is REFUSED (${r?.error})`, r?.ok === false && r?.code === "FILL_UNSAFE" && /payment recipient/.test(r?.error ?? ""));
    check("…and nothing was submitted", s.submits.length === 0);
  }
  // (a2) F2-legacy partial leg: a SPURIOUS served `min` on a whole-fill offer -> REFUSED (proven has no min)
  {
    const served = taker({ min: "1" });   // SPURIOUS min (proven offer has none)
    const outs = requiredFillOutputs(taker(), BigInt(V)).map(({ to, value }) => ({ to, value: Number(value) }));
    w.provenPaytoForTest = () => ({ payto: S.toLowerCase(), seller: S.toLowerCase(), terms: termsFor(taker()) });   // proven: NO min
    const s = mkStub({ offerReply: () => ({ ok: true, status: 200, json: async () => served }), tip: 100_100 });
    const r = await w.fillOffer({ proposalId: OID, outputs: outs });
    check(`F2-legacy: a SPURIOUS served min on the legacy lane is REFUSED (${r?.error})`, r?.ok === false && r?.code === "FILL_UNSAFE" && /fee\/rebate terms/.test(r?.error ?? ""));
    check("…and nothing was submitted", s.submits.length === 0);
  }
  // (a3) F2-legacy honest partial (served min == proven min) is NOT false-refused for a terms mismatch (UX valve)
  {
    const served = taker({ min: "50000000" });
    const outs = requiredFillOutputs(served, BigInt(V)).map(({ to, value }) => ({ to, value: Number(value) }));
    w.provenPaytoForTest = () => ({ payto: S.toLowerCase(), seller: S.toLowerCase(), terms: termsFor(served) });   // proven min == served min
    const s = mkStub({ offerReply: () => ({ ok: true, status: 200, json: async () => served }), tip: 100_100 });
    const r = await w.fillOffer({ proposalId: OID, outputs: outs });
    check(`F2-legacy: an honest partial offer (min matches on-chain) is NOT refused for a terms mismatch (${r?.code ?? "ok"})`, !(r?.code === "FILL_UNSAFE" && /fee\/rebate terms/.test(r?.error ?? "")));
  }
  // (b) UNPROVABLE author (null) -> retryable VERIFY_UNAVAILABLE, NOT a hard decline (the transient valve)
  {
    const served = taker();
    w.provenPaytoForTest = () => null;
    const s = mkStub({ offerReply: () => ({ ok: true, status: 200, json: async () => served }), tip: 100_100 });
    const r = await w.fillOffer({ proposalId: OID, outputs });
    check(`F2-legacy: an UNPROVABLE author fails SOFT (retryable VERIFY_UNAVAILABLE, not a hard decline) (${r?.error})`, r?.ok === false && r?.code === "VERIFY_UNAVAILABLE");
    check("…and nothing was submitted", s.submits.length === 0);
  }
}

// F2 (amount leg): a lying resolver serves HONEST payto/seller but a DEFLATED feeBps=0 while the offer's
// merkle-proven creation height implies 150. requiredFillOutputs would size treasury=0; resolve() (using the
// REAL proven fee) rejects the fill AFTER the payment leg moved = pay-without-delivery burn (theft if the
// attacker is the seller). clarvis is fail-soft 404 here, so the SPV fee-terms bind is the sole robust defense.
{
  const { w } = await freshWallet("pw-f2-fee");
  const served = servedOffer(fcH, H0 + 3, { feeBps: 0 });   // DEFLATED (proven feeBpsAt(H0+2) = 150)
  const outs = requiredFillOutputs(served, BigInt(V)).map(({ to, value }) => ({ to, value: Number(value) }));
  w.fillSpvIoForTest = (oid, fc, me) => makeIo([...baseFor(), fcFor(fcH, OID, H0 + 3, me)], HOLD_END - 5, me, H0 + 3);
  const s = mkStub({ offerReply: () => ({ ok: true, status: 200, json: async () => served }) });
  const r = await w.fillOffer({ proposalId: fcH, outputs: outs });
  check(`F2: a DEFLATED served feeBps (0 vs proven 150) is REFUSED (pay-without-delivery burn averted) (${r?.error})`, r?.ok === false && r?.code === "FILL_UNSAFE" && /fee\/rebate terms/.test(r?.error ?? ""));
  check("…and nothing was submitted (the payment did not burn)", s.submits.length === 0);
}

// F2 (partial-fill leg): a lying resolver serves HONEST payto/seller/fee but ADDS a spurious `min` (absent
// on-chain) to a whole-fill offer -> previewFill/requiredFillOutputs flip to the PARTIAL branch (rebate 0), the
// fill drops the maker-rebate output, and resolve() (whole-fill branch on the REAL min-less offer) rejects
// "maker rebate unpaid" AFTER the payment moved = full-payment burn. The `min` bind catches it (proven has no
// min); paid/delivered stay resolver-trusted (running state, not bound). Mutation-sensitive: reverting the min
// leg of provenTermsMismatch lets this served offer through (r.code != FILL_UNSAFE), so this test fails.
{
  const { w } = await freshWallet("pw-f2-min");
  const served = servedOffer(fcH, H0 + 3, { min: "1" });   // SPURIOUS min (proven offer has none)
  const outs = requiredFillOutputs(servedOffer(fcH, H0 + 3), BigInt(V)).map(({ to, value }) => ({ to, value: Number(value) }));
  w.fillSpvIoForTest = (oid, fc, me) => makeIo([...baseFor(), fcFor(fcH, OID, H0 + 3, me)], HOLD_END - 5, me, H0 + 3);
  const s = mkStub({ offerReply: () => ({ ok: true, status: 200, json: async () => served }) });
  const r = await w.fillOffer({ proposalId: fcH, outputs: outs });
  check(`F2: a SPURIOUS served min on a whole-fill offer is REFUSED (maker-rebate-drop burn averted) (${r?.error})`, r?.ok === false && r?.code === "FILL_UNSAFE" && /fee\/rebate terms/.test(r?.error ?? ""));
  check("…and nothing was submitted (the payment did not burn)", s.submits.length === 0);
}

// FIX B (RT2-secondary): the PRODUCTION io must MATERIALIZE a token/name offer (synthesize the give-backing the
// scan drops) so an honest token/name fclaim fill is ACCEPTED, while the grant/denial VERDICT still rides the
// PROVEN lane events. Drives the REAL liveFillSpvSource + the vendored verifyFillSpv (no deploy/mint in the blocks).
{
  const sellerKey = "0x" + "3c".repeat(32), seller = addrFromPriv(sellerKey).toLowerCase();
  const offTx = proposeTx({ ...pick(offer({ give: { ticker: "TKN", amount: "5" }, want: { value: String(V), payto: seller } })), priv: sellerKey, expiresEpoch: 9e9 });
  const loid = ctxid(rpcTxToTx(offTx)).toLowerCase();
  const fill = fcTxFor(loid), fid = ctxid(rpcTxToTx(fill)).toLowerCase();
  const io = await liveFillSpvSource({ rpcBase: "http://x", headersBase: "http://x", spvSource: fillSource(worldOf([{ height: H0 + 2, tx: offTx }, { height: Hfc, tx: fill }]), TIP), hints: { offerId: loid, fclaimTxid: fid, me: ME, offerHeight: H0 + 2 } });
  const v = await verifyFillSpv(loid, fid, ME, io, { myLiveHoldsAtGrant: io.myLiveHoldsAtGrant, pay: V });
  check(`FIXB: an honest TOKEN-give fclaim fill is ACCEPTED via the REAL io (synthesized backing materializes the give) (${v.reason})`, v.safe === true);
}
{
  const sellerKey = "0x" + "4d".repeat(32), seller = addrFromPriv(sellerKey).toLowerCase();
  const offTx = proposeTx({ ...pick(offer({ give: { ticker: "TKN", amount: "5" }, want: { value: String(V), payto: seller } })), priv: sellerKey, expiresEpoch: 9e9 });
  const loid = ctxid(rpcTxToTx(offTx)).toLowerCase();
  const fc1 = fcTxFor(loid), fc2 = fcTxFor(loid), fid2 = ctxid(rpcTxToTx(fc2)).toLowerCase();   // fc1 holds -> fc2 DENIED
  const io = await liveFillSpvSource({ rpcBase: "http://x", headersBase: "http://x", spvSource: fillSource(worldOf([{ height: H0 + 2, tx: offTx }, { height: Hfc, tx: fc1 }, { height: Hfc + 2, tx: fc2 }]), TIP), hints: { offerId: loid, fclaimTxid: fid2, me: ME, offerHeight: H0 + 2 } });
  const v = await verifyFillSpv(loid, fid2, ME, io, { myLiveHoldsAtGrant: io.myLiveHoldsAtGrant, pay: V });
  check(`FIXB: a DENIED fclaim on a token-give offer is STILL refused (proven lane verdict, not the trusted backing) (${v.reason})`, v.safe === false);
}
{
  // the flagship CNS NAME buy: a name-give offer (realistic near-tip expiry) also materializes via synthesized
  // name backing, so the honest name fclaim fill is ACCEPTED (not falsely refused post-V28).
  const sellerKey = "0x" + "6a".repeat(32), seller = addrFromPriv(sellerKey).toLowerCase();
  const offTx = proposeTx({ ...pick(offer({ give: { name: "flagship" }, want: { value: String(V), payto: seller } })), priv: sellerKey, expiresEpoch: E });
  const loid = ctxid(rpcTxToTx(offTx)).toLowerCase();
  const fill = fcTxFor(loid), fid = ctxid(rpcTxToTx(fill)).toLowerCase();
  const io = await liveFillSpvSource({ rpcBase: "http://x", headersBase: "http://x", spvSource: fillSource(worldOf([{ height: H0 + 2, tx: offTx }, { height: Hfc, tx: fill }]), TIP), hints: { offerId: loid, fclaimTxid: fid, me: ME, offerHeight: H0 + 2 } });
  const v = await verifyFillSpv(loid, fid, ME, io, { myLiveHoldsAtGrant: io.myLiveHoldsAtGrant, pay: V });
  check(`FIXB: an honest NAME-give (CNS) fclaim fill is ACCEPTED via the REAL io (synthesized name backing) (${v.reason})`, v.safe === true);
}

// 7. MUTATION VERIFICATION: remove the wallet's denied-fclaim guard from the SOURCE; the same forgery then SUBMITS.
const here = path.dirname(fileURLToPath(import.meta.url));
const WSRC = path.join(here, "..", "src", "core", "wallet.ts");
async function withGuardRemoved(marker, run) {
  const src = readFileSync(WSRC, "utf8");
  const lines = src.split("\n");
  const kept = lines.filter((l) => !l.includes(marker));
  if (kept.length !== lines.length - 1) throw new Error(`mutation marker ${marker} must match exactly one line (matched ${lines.length - kept.length})`);
  const tmp = path.join(here, "..", "src", "core", `__mutant_wallet_${Date.now()}.ts`);
  writeFileSync(tmp, kept.join("\n"));
  try { return await run(await import(pathToFileURL(tmp).href)); }
  finally { unlinkSync(tmp); }
}

const mut = await withGuardRemoved("MUTATE_FCLAIM_GUARD", async (mod) => {
  const wm = new mod.Wallet(memoryStore());
  await wm.create("pw-mutant");
  wm.fillSpvIoForTest = (oid, fc, me) => makeIo([...baseFor(), fcFor(fc1, OID, H0 + 3, me), fcFor(fc2, OID, H0 + 5, me)], HOLD_END - 5, me, H0 + 5);
  const s = mkStub({ offerReply: () => ({ ok: true, status: 200, json: async () => servedOffer(fc2, H0 + 5) }) });
  const r = await wm.fillOffer({ proposalId: fc2, outputs });
  return { r, submits: s.submits.length };
});
check(`MUTATION[denied-fclaim guard removed]: the forgery now SUBMITS (proves the guard is the sole rejecter)`, mut.r?.ok === true && mut.submits === 1);

// ── BP4/N11 (REQUEST-BUDGET): the scan is transport-parallelized with a per-height memo. Pin: every window
//    height fetched EXACTLY ONCE (no duplicate re-fetch by proveEventAt = the memo), the window is a
//    contiguous ascending range covering the offer height, blocks are fetched with BOUNDED CONCURRENCY > 1
//    (not the old sequential walk), and the VERDICT is byte-identical to the sequential fetch order. ──
{
  // count + concurrency-instrument the SpvSource the real liveFillSpvSource drives.
  const fill = fcTxFor();
  const holds = [fcTxFor(OID2), fcTxFor(OID3), fcTxFor(OID4)];
  const blocks = withOffer([fill, ...holds].map((tx) => ({ height: Hfc, tx })));
  const base = fillSource(blocks, TIP);
  const fetched = [];
  let inFlight = 0, maxInFlight = 0;
  const counting = {
    prepare: () => base.prepare(),
    prevoutScriptPubkey: (p) => base.prevoutScriptPubkey(p),
    async blockAt(height) {
      fetched.push(height);
      inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
      try { await Promise.resolve(); return await base.blockAt(height); }   // yield so the pool window is observable
      finally { inFlight--; }
    },
  };
  const io = await liveFillSpvSource({ rpcBase: "http://x", headersBase: "http://x", spvSource: counting, hints: { offerId: LOID, fclaimTxid: ctxid(rpcTxToTx(fill)), me: ME, offerHeight: H0 + 2 } });
  const uniq = new Set(fetched);
  const min = Math.min(...fetched), max = Math.max(...fetched);
  const contiguous = max - min + 1 === uniq.size && max === TIP;
  check(`BP4: NO block fetched twice per preflight (memo) - ${fetched.length} fetches, ${uniq.size} unique`, fetched.length === uniq.size);
  check(`BP4: the scan window is a contiguous ascending range ending at the tip, covering the offer height ${H0 + 2}`, contiguous && min <= H0 + 2);
  check(`BP4: blocks fetched with BOUNDED concurrency > 1 (parallel, not sequential) - maxInFlight ${maxInFlight}`, maxInFlight > 1 && maxInFlight <= 16);
  check(`BP4: verdict byte-identical under the parallel+memo scan (cap still 3 genuine me-holds)`, io.myLiveHoldsAtGrant === 3);
}

globalThis.fetch = origFetch;
console.log(`\nfill-fclaim-preflight: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
