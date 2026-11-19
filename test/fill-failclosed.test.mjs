// B1 (Plans/68 M-MKT-5 + N-1; the Plan 63 B2 flip): fillOffer preflight fails CLOSED unless the
// resolver POSITIVELY parses to a CairnX offer.
//
// Pre-0.2.57, a clean 404 (a valid L1 proposal that is NOT an open CairnX offer) and a 200 whose body
// lacks a parseable status (MITM / garbling proxy) both PROCEEDED to sign: the wallet paid, L1 moved
// the CSD, and resolve() ignored the attest; the whole payment burned. Now both refuse with the
// retryable OFFER_UNKNOWN. The 5xx/unreachable posture (VERIFY_UNAVAILABLE) and the happy path are
// pinned unchanged.
//
// MUTATION CONTRACT: the 404 and garbled-200 cases FAIL on 0.2.56 (they submit).
import { Wallet } from "../src/core/wallet.js";
import { memoryStore } from "../src/core/storage.js";
import { requiredFillOutputs } from "../src/core/cairnx.js";
import { SPV_NEWEST } from "../src/core/namespv.js";
import { EPOCH_LEN, offerExpiryHeightOf } from "../src/vendor/cairnx-spv.js";
import { mkCoin, txReply } from "./_coin.js";
import { checker } from "./helpers/check.mjs";

const { check, done } = checker();
const origFetch = globalThis.fetch;

const w = new Wallet(memoryStore());
const { addr: A } = await w.create("super-secret-pw");
// F2-legacy: the legacy CSD lane now binds the payment recipient to the merkle-proven offer author. The success
// case's offer is honest (payto 0xce, seller 0xcd); inject the proven author so it is not falsely refused. The
// fail-closed cases (404/garbled/status-less/5xx) refuse BEFORE this bind, so they are unaffected.
w.provenPaytoForTest = () => ({ payto: "0x" + "ce".repeat(20), seller: "0x" + "cd".repeat(20), expiresEpoch: 9e15, height: 47_000, terms: { height: 47_000, feeBps: 150, value: "5000000", taker: String(A).toLowerCase(), bid: undefined, giveTicker: "TKN", giveAmount: "5", giveName: undefined, wantType: "csd" } });   // B7e: proven give matches the served offer (give leg passes)
const coin = mkCoin(100_000_002);
const served = [coin];

function mkStub(offerReply, tip = 50_000) {
  const stats = { submits: [] };
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.includes("/tx/submit")) { stats.submits.push(1); return { ok: true, status: 200, json: async () => ({ ok: true, txid: "0x" + "aa".repeat(32) }) }; }
    if (u.match(/\/utxos\//)) return { ok: true, status: 200, json: async () => ({ confirmed_balance: coin.coin.value, utxos: [coin.coin] }) };
    if (u.endsWith("/tip")) return tip === null ? { ok: false, status: 503, json: async () => ({}) } : { ok: true, status: 200, json: async () => ({ height: tip }) };
    if (u.includes("/cairnx/offer/")) return offerReply();
    const t = txReply(u, served);
    if (t) return t;
    return { ok: false, status: 404, json: async () => ({}) };
  };
  return stats;
}

const id = "0x" + "6f".repeat(32);
const offer = {
  id, seller: "0x" + "cd".repeat(20), give: { ticker: "TKN", amount: "5" },
  want: { value: "5000000", payto: "0x" + "ce".repeat(20) },
  status: "open", expiresEpoch: 9e15, height: 47_000, feeBps: 150, taker: A,
};
const outputs = requiredFillOutputs(offer, 5_000_000n).map(({ to, value }) => ({ to, value: Number(value) }));

console.log("B1: fail-closed fill preflight:");
{
  const s = mkStub(() => ({ ok: false, status: 404, json: async () => ({ error: "not found" }) }));
  const r = await w.fillOffer({ proposalId: id, outputs });
  check("clean 404 (proposal is not a CairnX offer) refuses with OFFER_UNKNOWN", r?.ok === false && r?.code === "OFFER_UNKNOWN");
  check("…and nothing was submitted", s.submits.length === 0);
}
{
  const s = mkStub(() => ({ ok: true, status: 200, json: async () => { throw new Error("garbled body"); } }));
  const r = await w.fillOffer({ proposalId: id, outputs });
  check("garbled 200 (unparseable body) refuses with OFFER_UNKNOWN", r?.ok === false && r?.code === "OFFER_UNKNOWN");
  check("…and nothing was submitted", s.submits.length === 0);
}
{
  const s = mkStub(() => ({ ok: true, status: 200, json: async () => ({ some: "object", without: "a status" }) }));
  const r = await w.fillOffer({ proposalId: id, outputs });
  check("status-less 200 refuses with OFFER_UNKNOWN", r?.ok === false && r?.code === "OFFER_UNKNOWN");
  check("…and nothing was submitted", s.submits.length === 0);
}
{
  const s = mkStub(() => ({ ok: false, status: 503, json: async () => ({}) }));
  const r = await w.fillOffer({ proposalId: id, outputs });
  check("5xx keeps the VERIFY_UNAVAILABLE posture (unchanged)", r?.ok === false && r?.code === "VERIFY_UNAVAILABLE");
  check("…and nothing was submitted", s.submits.length === 0);
}
{
  const s = mkStub(() => ({ ok: true, status: 200, json: async () => offer }));
  const r = await w.fillOffer({ proposalId: id, outputs });
  check("a positively-parsed open offer still proceeds and submits (no over-refusal)", r?.ok === true && s.submits.length === 1);
}

// Offer expiry on the offer-id lane. A taker-bound offer created at H0 expires at EXP (offerExpiryHeightOf): the node
// refuses the fill's attest from there, so a fill not mined by LAST = EXP - 1 strands. The resolver serves the offer
// open until its own tip reaches LAST, so the wallet checks the merkle-proven expiry itself, refusing when LAST is
// below the compared height + FILL_TIP_MARGIN (4), the bundle's margin for the same strand on the fclaim lane. The
// compared height is offerIdChainBound (served tip, stored floor, release anchor), so every height here sits above
// the release's newest anchor, written against SPV_NEWEST so a newer anchor table changes no expectation.
console.log("\nOffer expiry on the offer-id CSD lane:");
{
  const H0 = (Math.floor(SPV_NEWEST / EPOCH_LEN) + 1_000) * EPOCH_LEN, E = H0 / EPOCH_LEN + 1;
  const EXP = offerExpiryHeightOf(E, H0), LAST = EXP - 1;
  const n = (v) => v.toLocaleString("en-US");
  const expOffer = { ...offer, id: "0x" + "7e".repeat(32), expiresEpoch: E, height: H0 };
  const expOuts = requiredFillOutputs(expOffer, 5_000_000n).map(({ to, value }) => ({ to, value: Number(value) }));
  const fresh = async (floor = 0) => {
    const st = memoryStore();
    const wx = new Wallet(st);
    const { addr } = await wx.create("expiry-pw-12345");
    if (floor > 0) await st.set("spvNodeTipFloor", floor);
    wx.provenPaytoForTest = () => ({ payto: "0x" + "ce".repeat(20), seller: "0x" + "cd".repeat(20), expiresEpoch: E, height: H0, terms: { height: H0, feeBps: 150, value: "5000000", taker: String(addr).toLowerCase(), bid: undefined, giveTicker: "TKN", giveAmount: "5", giveName: undefined, wantType: "csd" } });
    return { wx, served: { ...expOffer, taker: addr } };
  };
  const run = async (tip, floor = 0) => {
    const { wx, served } = await fresh(floor);
    const s = mkStub(() => ({ ok: true, status: 200, json: async () => served }), tip);
    const r = await wx.fillOffer({ proposalId: expOffer.id, outputs: expOuts });
    return { r, submits: s.submits.length };
  };
  check(`fixture: the offer is created above the release's newest anchor (${n(H0)} > ${n(SPV_NEWEST)})`, H0 > SPV_NEWEST && LAST > H0);
  const past = await run(EXP);
  check(`tip in the epoch after expiry, offer still served open: refused (${past.r?.code})`, past.r?.ok === false && past.r?.code === "FILL_UNSAFE" && past.submits === 0);
  const edge = await run(LAST - 3);
  check(`tip ${n(LAST - 3)}, last live block ${n(LAST)} below tip + 4: refused (${edge.r?.code})`, edge.r?.ok === false && edge.r?.code === "FILL_UNSAFE" && edge.submits === 0);
  const ok25 = await run(LAST - 4);
  check(`tip ${n(LAST - 4)}, last live block ${n(LAST)} at tip + 4: signs and submits (${ok25.r?.code ?? "ok"})`, ok25.r?.ok === true && ok25.submits === 1);
  const deflated = await run(H0 - 1_000, LAST - 2);
  check(`a deflated tip (${n(H0 - 1_000)}) with the stored floor at ${n(LAST - 2)}: refused (${deflated.r?.code})`, deflated.r?.ok === false && deflated.r?.code === "FILL_UNSAFE" && deflated.submits === 0);
  // With no readable tip and no floor the release anchor alone is compared: an offer that expires after it signs.
  const noTip = await run(null);
  check(`no readable tip and no floor, offer live past the anchor: the fill signs (${noTip.r?.code ?? "ok"})`, noTip.r?.ok === true && noTip.submits === 1);
}

// A served tip below the release anchor with floor 0: an offer anchored at 47,000 (above V22) whose last live block is
// past that tip but below the anchor plus FILL_TIP_MARGIN is refused, because the chain is at least at the anchor. With
// the anchor taken out of the bound this fill signs.
{
  const H1 = 47_000, E1 = Math.floor(SPV_NEWEST / EPOCH_LEN) - 1;
  const EXP1 = offerExpiryHeightOf(E1, H1), LAST1 = EXP1 - 1, SERVED = 50_000;
  check(`fixture: last live block ${LAST1.toLocaleString("en-US")} is past the served tip plus the margin and within the margin of the anchor ${SPV_NEWEST.toLocaleString("en-US")}`, LAST1 >= SERVED + 4 && LAST1 < SPV_NEWEST + 4);
  const st = memoryStore();
  const wx = new Wallet(st);
  const { addr } = await wx.create("anchor-pw-12345");
  wx.provenPaytoForTest = () => ({ payto: "0x" + "ce".repeat(20), seller: "0x" + "cd".repeat(20), expiresEpoch: E1, height: H1, terms: { height: H1, feeBps: 150, value: "5000000", taker: String(addr).toLowerCase(), bid: undefined, giveTicker: "TKN", giveAmount: "5", giveName: undefined, wantType: "csd" } });
  const served = { ...offer, id: "0x" + "7f".repeat(32), expiresEpoch: E1, height: H1, taker: addr };
  const outs = requiredFillOutputs(served, 5_000_000n).map(({ to, value }) => ({ to, value: Number(value) }));
  const s = mkStub(() => ({ ok: true, status: 200, json: async () => served }), SERVED);
  const r = await wx.fillOffer({ proposalId: served.id, outputs: outs });
  check(`served tip 50,000, floor 0, offer whose last live block is within the margin of the anchor: refused (${r?.code ?? "signed"})`, r?.ok === false && r?.code === "FILL_UNSAFE" && s.submits.length === 0);
}

globalThis.fetch = origFetch;
done("fill-failclosed");
