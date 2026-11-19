// The offer-id sunset and expiry refusals and the height they compare (fillpreflight.ts offerIdChainBound,
// legacySunsetRefusal, offerExpiryRefusal).
//
// From the bundle's LEGACY_HOLD_SUNSET_HEIGHT (60,044) no legacy hold is live, so the resolver rejects every offer-id
// fill of an open CSD offer after the payment moved. The refusal reads no served claim field, so a resolver
// that omits `claimTxid` and forges `claimedBy` cannot steer a buyer into that lane. The height is the largest of the
// served tip, the stored floor and the release's newest anchor (SPV_NEWEST): the chain is at least that high whatever
// is served or stored, so a served tip below the sunset on an install whose floor is 0 does not disarm the refusal.
// The same bound arms the expiry check, which matters most below V22, where the bundle caps an offer's life and the node
// admits a fill the resolver refuses as expired. Taker-bound and token-priced offers stay exempt from the sunset refusal.
// Every height below is written against the constants, so a newer anchor table changes no expectation.
//
// Run: TSX_DISABLE_CACHE=1 node --import tsx test/fill-legacy-sunset.test.mjs   (offline)
import { Wallet } from "../src/core/wallet.js";
import { memoryStore } from "../src/core/storage.js";
import { requiredFillOutputs } from "../src/core/cairnx.js";
import { offerIdChainBound, legacySunsetRefusal } from "../src/core/fillpreflight.js";
import { SPV_NEWEST } from "../src/core/namespv.js";
import { V28_HEIGHT, V22_HEIGHT, CLAIM_WINDOW_BLOCKS_V20, LEGACY_HOLD_SUNSET_HEIGHT, EPOCH_LEN, offerExpiryHeightOf, hasLiveClaim } from "../src/vendor/cairnx-spv.js";
import { mkCoin, txReply } from "./_coin.js";
import { checker } from "./helpers/check.mjs";

const { check, done } = checker("offer-id sunset and expiry refusals at the anchor-bounded height:");
const origFetch = globalThis.fetch;
const fmt = (n) => n.toLocaleString("en-US");

const SUNSET = LEGACY_HOLD_SUNSET_HEIGHT;
{
  // The last legacy grant is at V28 - 1; its hold is live one block before the sunset and not at it.
  const me = "0x" + "ab".repeat(20), grant = V28_HEIGHT - 1, last = { claimedBy: me, claimUntilHeight: grant + CLAIM_WINDOW_BLOCKS_V20 };
  check(`the bundle's sunset is 60,044 (got ${fmt(SUNSET)}); the last legacy hold is live at ${fmt(SUNSET - 1)} and not at ${fmt(SUNSET)}`,
    SUNSET === 60_044 && hasLiveClaim(last, me, SUNSET - 1) === true && hasLiveClaim(last, me, SUNSET) === false);
}
check(`the release's newest anchor is past the sunset (SPV_NEWEST ${fmt(SPV_NEWEST)})`, SPV_NEWEST >= SUNSET);

// 1. The bound: never below the anchor; a higher served tip or stored floor raises it; garbage counts as 0.
check("bound: no tip and no floor gives the anchor", offerIdChainBound(0, 0) === SPV_NEWEST);
check("bound: a served tip below the sunset with floor 0 gives the anchor", offerIdChainBound(50_000, 0) === SPV_NEWEST);
check("bound: a served tip above the anchor is kept", offerIdChainBound(SPV_NEWEST + 10, 0) === SPV_NEWEST + 10);
check("bound: a stored floor above the anchor is kept", offerIdChainBound(50_000, SPV_NEWEST + 7) === SPV_NEWEST + 7);
check("bound: a non-finite tip or floor counts as 0", offerIdChainBound(Number.NaN, Number.POSITIVE_INFINITY) === SPV_NEWEST);

const coin = mkCoin(100_000_002);
const served = [coin];
const OID = "0x" + "5e".repeat(32);
const PAYTO = "0x" + "ce".repeat(20);
const SELLER = "0x" + "cd".repeat(20);

// tip: a served /tip height, or null for a /tip that fails.
function mkStub({ offer, tip }) {
  const stats = { submits: [] };
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes("/tx/submit")) { stats.submits.push(1); return { ok: true, status: 200, json: async () => ({ ok: true, txid: "0x" + "aa".repeat(32) }) }; }
    if (u.match(/\/utxos\//)) return { ok: true, status: 200, json: async () => ({ confirmed_balance: coin.coin.value, utxos: [coin.coin] }) };
    if (u.endsWith("/tip")) return tip === null ? { ok: false, status: 502, json: async () => ({}) } : { ok: true, status: 200, json: async () => ({ height: tip }) };
    if (u.includes("/cairnx/offer/")) return { ok: true, status: 200, json: async () => offer };
    const t = txReply(u, served);
    if (t) return t;
    return { ok: false, status: 404, json: async () => ({}) };
  };
  return stats;
}

// An open CSD offer (no taker, CSD want) served with the claim fields forged as a hostile front door would serve them:
// `claimTxid` omitted (so the FILL_WRONG_TARGET mirror stays out of the way) and `claimedBy` the buyer with a live
// `claimUntilHeight` at the served tip (so the served-field claim gate passes).
const openOffer = (me, claimUntil, expiresEpoch = 9e15) => ({
  id: OID, seller: SELLER, give: { ticker: "TKN", amount: "5" },
  want: { value: "5000000", payto: PAYTO },
  status: "open", expiresEpoch, height: 47_000, feeBps: 150,
  claimedBy: me, claimUntilHeight: claimUntil,
});
const provenTerms = { height: 47_000, feeBps: 150, value: "5000000", taker: undefined, bid: undefined, giveTicker: "TKN", giveAmount: "5", giveName: undefined, wantType: "csd" };
const outputsFor = (offer) => requiredFillOutputs(offer, 5_000_000n).map(({ to, value }) => ({ to, value: Number(value) }));

async function freshWallet(pw, { floor = 0, expiresEpoch = 9e15, taker = false, height = 47_000 } = {}) {
  const st = memoryStore();
  const w = new Wallet(st);
  const { addr } = await w.create(pw);
  if (floor > 0) await st.set("spvNodeTipFloor", floor);
  w.provenPaytoForTest = () => ({ payto: PAYTO, seller: SELLER, expiresEpoch, height, terms: { ...provenTerms, height, taker: taker ? String(addr).toLowerCase() : undefined } });
  return { w, addr };
}

// 2. The predicate at an explicit height. The height is asked only for an open CSD offer.
{
  const me = "0x" + "ab".repeat(20);
  const open = openOffer(me, 99_999);
  const at = (h) => async () => h;
  check(`predicate: open CSD offer one block below the sunset (${fmt(SUNSET - 1)}) is not refused`, (await legacySunsetRefusal(open, true, at(SUNSET - 1))) === null);
  const r0 = await legacySunsetRefusal(open, true, at(SUNSET));
  check(`predicate: at the sunset (${fmt(SUNSET)}) it refuses FILL_LEGACY_SUNSET (${r0?.code})`, r0?.ok === false && r0?.code === "FILL_LEGACY_SUNSET");
  const r1 = await legacySunsetRefusal(open, true, at(SUNSET + 1));
  check(`predicate: above the sunset it refuses (${r1?.code})`, r1?.code === "FILL_LEGACY_SUNSET");
  let asked = 0;
  const counted = async () => { asked++; return SPV_NEWEST; };
  check("predicate: a taker-bound CSD offer is exempt", (await legacySunsetRefusal({ ...open, taker: me }, true, counted)) === null);
  check("predicate: a token-priced offer is exempt", (await legacySunsetRefusal({ ...open, want: { ticker: "PAY", amount: "7" } }, false, counted)) === null);
  check(`...and neither exempt lane asked for the height (asked ${asked} times)`, asked === 0);
}

// 3. The real preflight on a fresh install (floor 0) with forged claim fields: a served tip below the sunset, one
//    inside the last legacy band, and no tip at all are each refused, and nothing is submitted.
for (const [label, tip, claimUntil] of [["served tip 50,000", 50_000, 50_030], ["served tip 60,010", 60_010, 60_030], ["no served tip", null, 99_999]]) {
  const { w, addr } = await freshWallet(`pw-deflate-${tip}-12345`);
  const offer = openOffer(addr, claimUntil);
  const s = mkStub({ offer, tip });
  const r = await w.fillOffer({ proposalId: OID, outputs: outputsFor(offer) });
  check(`floor 0, ${label}, forged claim: FILL_LEGACY_SUNSET (${r?.code ?? r?.error ?? "signed"})`, r?.ok === false && r?.code === "FILL_LEGACY_SUNSET");
  check(`...and nothing was submitted (${s.submits.length})`, s.submits.length === 0);
}

// 4. An honest tip past the anchor with floor 0, and a deflated tip with a floor past the sunset: still refused.
for (const [label, tip, floor] of [["honest tip past the anchor, floor 0", SPV_NEWEST + 5_000, 0], ["deflated tip 58,000, floor 60,050", 58_000, 60_050]]) {
  const { w, addr } = await freshWallet(`pw-honest-${tip}-12345`, { floor });
  const offer = openOffer(addr, 99_999);
  const s = mkStub({ offer, tip });
  const r = await w.fillOffer({ proposalId: OID, outputs: outputsFor(offer) });
  check(`${label}: FILL_LEGACY_SUNSET (${r?.code ?? "signed"})`, r?.code === "FILL_LEGACY_SUNSET" && s.submits.length === 0);
}

// 5. Exempt lanes, signed as before with floor 0: a taker-bound CSD offer and an honest token-want offer, at a served
//    tip below the sunset and at an honest tip.
for (const tip of [50_000, SPV_NEWEST + 5_000]) {
  {
    const { w, addr } = await freshWallet(`pw-taker-${tip}-12345`, { taker: true });
    const offer = { id: OID, seller: SELLER, give: { ticker: "TKN", amount: "5" }, want: { value: "5000000", payto: PAYTO }, status: "open", expiresEpoch: 9e15, height: 47_000, feeBps: 150, taker: addr };
    const s = mkStub({ offer, tip });
    const r = await w.fillOffer({ proposalId: OID, outputs: outputsFor(offer) });
    check(`exempt: taker-bound CSD fill at served tip ${fmt(tip)} is signed (${r?.error ?? "ok"})`, r?.ok === true && s.submits.length === 1);
  }
  {
    const st = memoryStore(); const w = new Wallet(st); await w.create(`pw-token-${tip}-12345`);
    const offer = { id: OID, seller: SELLER, give: { ticker: "TKN", amount: "5" }, want: { ticker: "PAY", amount: "7" }, status: "open", expiresEpoch: 9e15, height: 47_000, feeBps: 150 };
    w.provenPaytoForTest = () => ({ payto: PAYTO, seller: SELLER, expiresEpoch: 9e15, height: 47_000, terms: { height: 47_000, feeBps: 150, value: undefined, taker: undefined, bid: undefined, giveTicker: "TKN", giveAmount: "5", giveName: undefined, wantType: "token", wantTicker: "PAY", wantAmount: "7" }, wantTicker: "PAY", wantAmount: "7" });
    const s = mkStub({ offer, tip });
    const r = await w.fillOffer({ proposalId: OID, outputs: [], tokenQuote: { ticker: "PAY", amount: "7", fee: "1", total: "8", giveTicker: "TKN", giveAmount: "5" } });
    check(`exempt: token-want fill at served tip ${fmt(tip)} is signed (${r?.error ?? r?.code ?? "ok"})`, r?.ok === true && s.submits.length === 1);
  }
}

// 6. The expiry check at the bound, on the offer-id CSD lane that remains (taker-bound). An offer whose proven expiry
//    is below the anchor is refused with a served tip below it and floor 0, and the copy states a lower bound; an
//    offer that expires after the anchor is signed at an honest tip.
const epochBefore = Math.floor(SPV_NEWEST / EPOCH_LEN) - 2;
const expBefore = offerExpiryHeightOf(epochBefore, 47_000);
check(`fixture: the early offer expires below the anchor (${fmt(expBefore)}) and after a served tip of 50,000`, expBefore < SPV_NEWEST && expBefore - 1 >= 50_000 + 4);
for (const [label, tip] of [["served tip 50,000", 50_000], ["no served tip", null]]) {
  const { w, addr } = await freshWallet(`pw-expired-${tip}-12345`, { taker: true, expiresEpoch: epochBefore });
  const offer = { id: OID, seller: SELLER, give: { ticker: "TKN", amount: "5" }, want: { value: "5000000", payto: PAYTO }, status: "open", expiresEpoch: epochBefore, height: 47_000, feeBps: 150, taker: addr };
  const s = mkStub({ offer, tip });
  const r = await w.fillOffer({ proposalId: OID, outputs: outputsFor(offer) });
  check(`expiry: ${label}, floor 0, offer expired before the anchor: FILL_UNSAFE (${r?.code ?? "signed"})`, r?.ok === false && r?.code === "FILL_UNSAFE" && /expires at block/.test(String(r?.error)));
  check(`...the copy says "at or past block ${fmt(SPV_NEWEST)}"`, String(r?.error).includes(`the chain is at or past block ${fmt(SPV_NEWEST)}`));
  check(`...and nothing was submitted (${s.submits.length})`, s.submits.length === 0);
}
{
  const honestTip = SPV_NEWEST + 1_000;
  const epochAfter = Math.floor(honestTip / EPOCH_LEN) + 10;
  const expAfter = offerExpiryHeightOf(epochAfter, 47_000);
  check(`fixture: the live offer's last block is past the honest tip plus the margin (${fmt(expAfter)})`, expAfter - 1 >= honestTip + 4);
  const { w, addr } = await freshWallet("pw-live-12345", { taker: true, expiresEpoch: epochAfter });
  const offer = { id: OID, seller: SELLER, give: { ticker: "TKN", amount: "5" }, want: { value: "5000000", payto: PAYTO }, status: "open", expiresEpoch: epochAfter, height: 47_000, feeBps: 150, taker: addr };
  const s = mkStub({ offer, tip: honestTip });
  const r = await w.fillOffer({ proposalId: OID, outputs: outputsFor(offer) });
  check(`expiry: honest tip, floor 0, offer that expires after the anchor is signed (${r?.error ?? "ok"})`, r?.ok === true && s.submits.length === 1);
}

// 7. Below V22 the bundle caps an offer's life, so a taker-bound CSD offer anchored at 40,500 with a far expires_epoch
//    expires at its capped height while its proposal stays valid: the node would admit the fill and the resolver refuse
//    it. A served tip under the capped expiry with floor 0, and a failed tip read with floor 0, are both refused.
{
  const H = 40_500;
  const capped = offerExpiryHeightOf(9e15, H);
  check(`fixture: an offer anchored at ${fmt(H)} (below V22 ${fmt(V22_HEIGHT)}) with a far expiry is capped at ${fmt(capped)}, below the anchor`, H < V22_HEIGHT && capped < SPV_NEWEST);
  for (const [label, tip] of [[`served tip ${fmt(capped - 100)}`, capped - 100], ["no served tip", null]]) {
    const { w, addr } = await freshWallet(`pw-capped-${tip}-12345`, { taker: true, height: H });
    const offer = { id: OID, seller: SELLER, give: { ticker: "TKN", amount: "5" }, want: { value: "5000000", payto: PAYTO }, status: "open", expiresEpoch: 9e15, height: H, feeBps: 150, taker: addr };
    const s = mkStub({ offer, tip });
    const r = await w.fillOffer({ proposalId: OID, outputs: outputsFor(offer) });
    check(`capped expiry: ${label}, floor 0: FILL_UNSAFE (${r?.code ?? "signed"})`, r?.ok === false && r?.code === "FILL_UNSAFE" && /expires at block/.test(String(r?.error)));
    check(`...and nothing was submitted (${s.submits.length})`, s.submits.length === 0);
  }
}

globalThis.fetch = origFetch;
done("fill-legacy-sunset");
