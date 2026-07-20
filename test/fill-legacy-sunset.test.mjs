// W5 (B5b, REBIND): the LEGACY-SUNSET arithmetic refuse on the open-CSD legacy fill lane.
//
// At V28 an offer carrying an fclaim grant is unfillable by its offer id (resolve.ts:182 enforces it
// with no liveness condition), and the last possible legacy grant (V28-1) has a hold ending at
// V28 + CLAIM_WINDOW_BLOCKS_V20 + CLAIM_FILL_GRACE_BLOCKS - 1 = 60,044. So at/above 60,045 EVERY
// offer-id fill of an open CSD offer is rejected on-chain after the payment moved. The W5 attack:
// a hostile resolver serves the offer truthfully except omitting `claimTxid` while forging
// `claimedBy`, steering a genuine holder into the legacy lane and a burned payment. The guard
// refuses by ARITHMETIC over the floor-clamped tip - nothing SERVED is consulted - so no forgery
// shape survives it, and a DEFLATED tip cannot disarm it once the PoW-backed floor (M9/B5a) has
// seen the band.
//
// THE HEADLINE ASSERTION (strategy decline 1): the guard ACCEPTS at 60,010. A flat cut at V28_HEIGHT
// re-creates the over-refusal of the honored pre-V28 sunset that the 0.2.62 release gate deliberately
// removed - if someone "simplifies" the band to a flat cut, the 60,010 and 60,044 cases go RED.
//
// Run: node --import tsx test/fill-legacy-sunset.test.mjs   (offline)
import { Wallet } from "../src/core/wallet.js";
import { memoryStore } from "../src/core/storage.js";
import { requiredFillOutputs } from "../src/core/cairnx.js";
import { V28_HEIGHT, CLAIM_WINDOW_BLOCKS_V20, CLAIM_FILL_GRACE_BLOCKS } from "../src/vendor/cairnx-spv.js";
import { mkCoin, txReply } from "./_coin.js";

let pass = 0, fail = 0;
const check = (n, c) => { c ? (pass++, console.log("  ✓ " + n)) : (fail++, console.error("  ✗ " + n)); };
const origFetch = globalThis.fetch;

const SUNSET = V28_HEIGHT + CLAIM_WINDOW_BLOCKS_V20 + CLAIM_FILL_GRACE_BLOCKS;
check(`sanity: the sunset boundary derives to 60,045 from the vendored gates (got ${SUNSET})`, SUNSET === 60_045);

const coin = mkCoin(100_000_002);
const served = [coin];
const OID = "0x" + "5e".repeat(32);
const PAYTO = "0x" + "ce".repeat(20);

function mkStub({ offerReply, tip }) {
  const stats = { submits: [] };
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes("/tx/submit")) { stats.submits.push(1); return { ok: true, status: 200, json: async () => ({ ok: true, txid: "0x" + "aa".repeat(32) }) }; }
    if (u.match(/\/utxos\//)) return { ok: true, status: 200, json: async () => ({ confirmed_balance: coin.coin.value, utxos: [coin.coin] }) };
    if (u.endsWith("/tip")) return { ok: true, status: 200, json: async () => ({ height: tip }) };
    if (u.includes("/cairnx/offer/")) return offerReply();
    const t = txReply(u, served);
    if (t) return t;
    return { ok: false, status: 404, json: async () => ({}) };
  };
  return stats;
}

// An OPEN CSD offer (taker undefined = the open lane; CSD want = the whole-payment-loss lane), with the
// buyer holding a live legacy claim per the SERVED fields (the legacy lane's own gate) and claimTxid
// ABSENT (the W5 omission - also keeps the Correction-1 mirror out of the way).
const openOffer = (me, claimUntil) => ({
  id: OID, seller: "0x" + "cd".repeat(20), give: { ticker: "TKN", amount: "5" },
  want: { value: "5000000", payto: PAYTO },
  status: "open", expiresEpoch: 9e15, height: 47_000, feeBps: 150,
  claimedBy: me, claimUntilHeight: claimUntil,
});
const provenOpenTerms = { height: 47_000, feeBps: 150, value: "5000000", taker: undefined, bid: undefined, giveTicker: "TKN", giveAmount: "5", giveName: undefined, wantType: "csd" };   // B7e: give matches openOffer's give (give leg passes)

async function freshWallet(pw, floor = 0) {
  const st = memoryStore();
  const w = new Wallet(st);
  const { addr } = await w.create(pw);
  if (floor > 0) await st.set("spvNodeTipFloor", floor);
  w.provenPaytoForTest = () => ({ payto: PAYTO, seller: "0x" + "cd".repeat(20), terms: provenOpenTerms });
  return { w, addr };
}

console.log("W5 (B5b) - legacy-sunset arithmetic refuse:");

// 1. HEADLINE: in-band legacy fill ACCEPTS at 60,010 (the honored pre-V28 sunset; flat-cut mutation reds this).
{
  const { w, addr } = await freshWallet("pw-band-12345");
  const offer = openOffer(addr, 60_030);
  const outputs = requiredFillOutputs(offer, 5_000_000n).map(({ to, value }) => ({ to, value: Number(value) }));
  const s = mkStub({ offerReply: () => ({ ok: true, status: 200, json: async () => offer }), tip: 60_010 });
  const r = await w.fillOffer({ proposalId: OID, outputs });
  check(`HEADLINE: legacy open-CSD fill ACCEPTS at 60,010 (${r?.error ?? "ok"})`, r?.ok === true && s.submits.length === 1);
}

// 2. Boundary: 60,044 (the last in-band height) still ACCEPTS.
{
  const { w, addr } = await freshWallet("pw-edge-12345");
  const offer = openOffer(addr, 60_044);
  const outputs = requiredFillOutputs(offer, 5_000_000n).map(({ to, value }) => ({ to, value: Number(value) }));
  const s = mkStub({ offerReply: () => ({ ok: true, status: 200, json: async () => offer }), tip: 60_044 });
  const r = await w.fillOffer({ proposalId: OID, outputs });
  check(`boundary: still accepts at 60,044 (${r?.error ?? "ok"})`, r?.ok === true && s.submits.length === 1);
}

// 3. At the boundary: 60,045 REFUSES with FILL_LEGACY_SUNSET - even with PRISTINE forged claim fields
//    served (claimedBy = me, generous claimUntilHeight): the guard reads nothing served (the W5 repro).
{
  const { w, addr } = await freshWallet("pw-sunset-12345");
  const offer = openOffer(addr, 99_999);        // forged "live" claim state - must not matter
  const outputs = requiredFillOutputs(offer, 5_000_000n).map(({ to, value }) => ({ to, value: Number(value) }));
  const s = mkStub({ offerReply: () => ({ ok: true, status: 200, json: async () => offer }), tip: 60_045 });
  const r = await w.fillOffer({ proposalId: OID, outputs });
  check(`60,045 refuses with FILL_LEGACY_SUNSET regardless of served claim fields (${r?.code})`, r?.ok === false && r?.code === "FILL_LEGACY_SUNSET");
  check("...and nothing was submitted (the payment did not burn)", s.submits.length === 0);
}

// 4. THE W5 DISARM ATTEMPT: a hostile RPC DEFLATES the tip (58,000) but the PoW-backed floor has seen
//    60,050 - the clamp arms the guard anyway (M9/B5a is the hard prerequisite; this is why).
{
  const { w, addr } = await freshWallet("pw-deflate-12345", 60_050);
  const offer = openOffer(addr, 99_999);
  const outputs = requiredFillOutputs(offer, 5_000_000n).map(({ to, value }) => ({ to, value: Number(value) }));
  const s = mkStub({ offerReply: () => ({ ok: true, status: 200, json: async () => offer }), tip: 58_000 });
  const r = await w.fillOffer({ proposalId: OID, outputs });
  check(`deflated tip (58,000) with floor 60,050 still refuses (${r?.code})`, r?.ok === false && r?.code === "FILL_LEGACY_SUNSET");
  check("...and nothing was submitted", s.submits.length === 0);
}

// 5. EXEMPT: a TAKER-BOUND offer past the sunset is NOT sunset-refused (its fields are bound on that
//    lane; taker-bound fills never routed through the open-lane claim machinery). Full accept control.
{
  const st = memoryStore(); const w = new Wallet(st); const { addr } = await w.create("pw-taker-12345");
  const offer = {
    id: OID, seller: "0x" + "cd".repeat(20), give: { ticker: "TKN", amount: "5" },
    want: { value: "5000000", payto: PAYTO }, status: "open", expiresEpoch: 9e15, height: 47_000, feeBps: 150, taker: addr,
  };
  w.provenPaytoForTest = () => ({ payto: PAYTO, seller: "0x" + "cd".repeat(20), terms: { ...provenOpenTerms, taker: String(addr).toLowerCase() } });
  const outputs = requiredFillOutputs(offer, 5_000_000n).map(({ to, value }) => ({ to, value: Number(value) }));
  const s = mkStub({ offerReply: () => ({ ok: true, status: 200, json: async () => offer }), tip: 60_050 });
  const r = await w.fillOffer({ proposalId: OID, outputs });
  check(`exempt: taker-bound fill past the sunset still ACCEPTS (${r?.error ?? "ok"})`, r?.ok === true && s.submits.length === 1);
}

// 6. EXEMPT: a TOKEN-want offer past the sunset never returns FILL_LEGACY_SUNSET (the token lane has
//    its own binds; whatever it returns, it is not this guard).
{
  const st = memoryStore(); const w = new Wallet(st); const { addr } = await w.create("pw-token-12345");
  const offer = {
    id: OID, seller: "0x" + "cd".repeat(20), give: { ticker: "TKN", amount: "5" },
    want: { ticker: "PAY", amount: "7" }, status: "open", expiresEpoch: 9e15, height: 47_000, feeBps: 150,
  };
  w.provenPaytoForTest = () => ({ payto: PAYTO, seller: "0x" + "cd".repeat(20), terms: { height: 47_000, feeBps: 150, value: undefined, taker: undefined, bid: undefined } });
  const s = mkStub({ offerReply: () => ({ ok: true, status: 200, json: async () => offer }), tip: 60_050 });
  const r = await w.fillOffer({ proposalId: OID, outputs: [] });
  check(`exempt: token-want past the sunset is not sunset-refused (got ${r?.code ?? "ok"})`, r?.code !== "FILL_LEGACY_SUNSET");
}

globalThis.fetch = origFetch;
console.log(`\nfill-legacy-sunset: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
