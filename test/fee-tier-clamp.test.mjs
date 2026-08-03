// M11 (B5b, REBIND): name-fee pricing is floor-CLAMPED, identically at build time and review time.
//
// The fee tier was priced from `node.tip(rpc)`, an unvalidated read of the hostile proxy. A reported
// tip below V24 makes the wallet build a treasury output at an obsolete cheaper tier, which the
// resolver rejects - the fee LEAVES the wallet and the lease is NOT renewed (a burn) - while the same
// deflated tip simultaneously silences the CLEARSIGN-FEE-1 underpayment warning (the review side used
// the same raw read). Fix: ONE shared helper, feePricingTip(rawTip, floor) = max(raw, PoW-backed
// floor), used by BOTH wallet build sites AND the clearsign review warning, so the two sides can never
// disagree (a clamp on one side only manufactures spurious FEE_CHANGED refusals at a fee-gate
// boundary). Expected values are computed THROUGH the vendored nameRegFee/buildFeeHeight - no fee
// tier is re-declared here.
//
// Run: node --import tsx test/fee-tier-clamp.test.mjs   (offline)
import { readFileSync } from "node:fs";
import { Wallet } from "../src/core/wallet.js";
import { memoryStore } from "../src/core/storage.js";
import { feePricingTip, nameRegFee, buildFeeHeight, buildNameRenew, CAIRNX_DOMAIN, TREASURY_ADDR } from "../src/core/cairnx.js";
import { describe } from "../src/popup/clearsign.js";
import { mkCoin, txReply } from "./_coin.js";

let pass = 0, fail = 0;
const check = (n, c) => { c ? (pass++, console.log("  ✓ " + n)) : (fail++, console.error("  ✗ " + n)); };
const origFetch = globalThis.fetch;

console.log("M11 (B5b) - floor-clamped name-fee pricing:");

// ── the shared helper's clamp semantics ────────────────────────────────────────────────────────────
check("deflated raw tip clamps UP to the floor", feePricingTip(40_000, 47_000) === 47_000);
check("honest raw tip above the floor wins", feePricingTip(50_000, 47_000) === 50_000);
check("no floor (fresh install) leaves the raw tip", feePricingTip(40_000, 0) === 40_000);
check("null/failed tip read falls back to the floor alone", feePricingTip(null, 47_000) === 47_000);
// W5 (Q-02): "no usable tip at all" is now NULL, not 0. See the W5 block below for why 0 is a fund-loss
// path at both kinds of call site; the callers' offline-skip behavior is unchanged because null is the
// value they skip on.
check("both absent -> null (no usable tip; callers skip)", feePricingTip(null, 0) === null);

// ── build side: cairnxNameRenewFee prices from the clamped tip ─────────────────────────────────────
// V24 (46,400) is the length-graded fee gate. A deflated tip (40,000) prices the obsolete pre-V24
// tier; with the PoW floor at 47,000 the wallet must price the V24 tier instead. Both expectations
// derive through the VENDORED functions.
const NAME = "gm";   // short name: the V24 tier differs sharply from pre-V24 (that difference is the burn)
const feeAtFloor = Number(nameRegFee(NAME, buildFeeHeight(47_000)));
const feeDeflated = Number(nameRegFee(NAME, buildFeeHeight(40_000)));
check("sanity: the deflated tier differs from the V24 tier (else this test proves nothing)", feeAtFloor !== feeDeflated);

function tipStub(height) {
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.endsWith("/tip")) return { ok: true, status: 200, json: async () => ({ height }) };
    return { ok: false, status: 404, json: async () => ({}) };
  };
}

{
  const st = memoryStore(); const w = new Wallet(st); await w.create("pw-clamp-12345");
  await st.set("spvNodeTipFloor", 47_000);
  tipStub(40_000);
  const got = await w.cairnxNameRenewFee(NAME);
  check(`deflated RPC tip + floor 47,000 prices the V24 tier (got ${got}, want ${feeAtFloor})`, got === feeAtFloor);
  check("...and NOT the obsolete pre-V24 tier (the burn the clamp closes)", got !== feeDeflated);
}
{
  const st = memoryStore(); const w = new Wallet(st); await w.create("pw-fresh-12345");
  tipStub(40_000); // fresh install: no floor -> raw tip governs (stated coverage limit, fail-open-safe)
  const got = await w.cairnxNameRenewFee(NAME);
  check("fresh install (floor 0) keeps pricing from the raw tip (no behavior change)", got === feeDeflated);
}

// ── review side: the clearsign fee warning prices from the SAME clamped tip ────────────────────────
// A deflated currentTip with the floor present must still price V24 and therefore WARN on a V18-tier
// payment - pre-fix, the deflated tip silenced exactly this warning.
{
  const ren = buildNameRenew({ name: NAME });
  const mk = (treasuryVal, currentTip, tipFloor) => describe({ method: "propose", currentTip, tipFloor,
    params: { domain: CAIRNX_DOMAIN, uri: ren.uri, payloadHash: ren.payloadHash, fee: 25000000, expiresEpoch: 2000, outputs: [{ to: TREASURY_ADDR, value: treasuryVal }] } });
  check("review: deflated tip + floor 47,000 WARNS on an underpaying pre-V24-tier payment", /BELOW the current price/.test(mk(feeDeflated, 40_000, 47_000)));
  check("review: paying the V24 tier under the same deflated tip does NOT warn", !/BELOW the current price/.test(mk(feeAtFloor, 40_000, 47_000)));
  check("review: floor-only (tip read failed) still arms the warning", /BELOW the current price/.test(mk(feeDeflated, undefined, 47_000)));
  check("review: fully offline (no tip, no floor) still skips the check (no false warning)", !/BELOW the current price/.test(mk(feeDeflated, undefined, 0)));
}

// ── source pins: ONE helper at every pricing site (build AND review) ───────────────────────────────
const wsrc = readFileSync(new URL("../src/core/wallet.ts", import.meta.url), "utf8");
const csrc = readFileSync(new URL("../src/popup/clearsign.ts", import.meta.url), "utf8");
const wCalls = (wsrc.match(/buildFeeHeight\(/g) || []).length;
const wClamped = (wsrc.match(/buildFeeHeight\(feePricingTip\(/g) || []).length;
const wClampedVar = (wsrc.match(/= feePricingTip\(/g) || []).length;
check(`wallet.ts: every buildFeeHeight call prices a feePricingTip-clamped tip (${wClamped}+${wClampedVar} of ${wCalls})`, wCalls >= 2 && wClamped + wClampedVar >= wCalls);
check("clearsign.ts: the review tip is the shared feePricingTip clamp", /feePricingTip\(r\.currentTip, r\.tipFloor\)/.test(csrc));
check("clearsign.ts: no raw currentTip reaches buildFeeHeight", !/buildFeeHeight\(\s*Number\(r\.currentTip/.test(csrc));

// ══ W5 (Q-02): a served non-integer or oversize tip must not silently disarm the fee guards ═══════════
//
// The defect: feePricingTip guarded with Number.isFinite, not Number.isSafeInteger. A hostile or broken
// /tip answering 65100.5 or 1e16 is finite, so it reached the vendored buildFeeHeight, which throws
// RangeError, which clearsign.ts swallows in a bare catch: the CLEARSIGN-FEE-1 underpayment warning went
// silently ABSENT on a third-party-built nrenew/nfinalize.
//
// THE TRAP, and it is the whole item: normalizing to 0 is WORSE than the bug, in two places.
//   review side: tipNow 0 keeps feeBearing true, prices the CHEAPEST tier, paid < need is false, and the
//                dialog affirmatively shows NO warning on a genuinely underpaid record.
//   build side:  buildFeeHeight(0) does NOT throw, it returns 0, so the wallet's OWN Renew button would
//                build an underpaid record and BURN the fee. Today a non-integer tip makes buildFeeHeight
//                throw (fails closed); the ONLY input whose behavior changes is "no usable tip at all",
//                where refusing beats burning. That refusal IS UX-6's refusal, and the happy-path below
//                is the proof the honest path is untouched.
console.log("\nW5 (Q-02) - a non-integer / oversize served tip cannot disarm the fee guards:");
check("a fractional served tip is not a height -> null", feePricingTip(65100.5, 0) === null);
check("...and it is NOT normalized to 0 (0 prices the cheapest tier and burns the fee)", feePricingTip(65100.5, 0) !== 0);
check("an oversize served tip (1e16, past 2^53) -> null", feePricingTip(1e16, 0) === null);
check("...and NOT 0", feePricingTip(1e16, 0) !== 0);
check("a fractional tip with a usable PoW floor still prices from the floor (no availability loss)", feePricingTip(65100.5, 47_000) === 47_000);
check("NaN / garbage tip with no floor -> null", feePricingTip("abc", 0) === null && feePricingTip(Number.NaN, undefined) === null);
check("a negative tip is not a height -> null", feePricingTip(-1, 0) === null);

// The BUILD site is where the trap bites: with a degenerate tip and no floor, the wallet's own Renew
// button must REFUSE, not price the cheapest tier and sign an underpaid treasury output.
{
  const st = memoryStore(); const w = new Wallet(st); await w.create("pw-degen-12345");
  // FUNDED on purpose: under the norm-to-0 mutation this wallet has more than enough to pay a
  // cheapest-tier treasury output, so "nothing was broadcast" is the BURN, seen, not an artifact of an
  // empty wallet refusing for an unrelated reason.
  const dcoins = [mkCoin(500_00000000)];
  const submits = [];
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.includes("/tx/submit")) { submits.push(JSON.parse(init?.body ?? "{}")); return { ok: true, status: 200, json: async () => ({ ok: true, txid: "0x" + "aa".repeat(32) }) }; }
    if (u.endsWith("/tip")) return { ok: true, status: 200, json: async () => ({ height: 0 }) };   // degenerate: no usable height
    if (u.includes("/utxos/")) return { ok: true, status: 200, json: async () => ({ confirmed_balance: dcoins.reduce((s, c) => s + c.coin.value, 0), utxos: dcoins.map((c) => c.coin) }) };
    const t = txReply(u, dcoins);
    if (t) return t;
    return { ok: false, status: 404, json: async () => ({}) };
  };
  let threwFee = false;
  try { await w.cairnxNameRenewFee(NAME); } catch { threwFee = true; }
  check("build: cairnxNameRenewFee REFUSES to quote a fee with no usable tip (pre-fix it quoted the cheapest tier)", threwFee);
  let threwRenew = false;
  try { await w.cairnxNameRenew(NAME); } catch { threwRenew = true; }
  check("build: cairnxNameRenew REFUSES to sign with no usable tip (pre-fix it BUILT an underpaid record)", threwRenew);
  check("build: ...and nothing was broadcast, so no fee was burned", submits.length === 0);
}

// ── W5 PAIRED HAPPY-PATH: production's exact shape, a fresh install at the live tip ────────────────────
// floor 0 is the fresh-install shape (no PoW floor persisted yet). The fee must be priced through the
// vendored functions exactly as before the fix, and the wallet's own Renew must sign that exact value.
console.log("\nPAIRED HAPPY-PATH (W5): fresh install, live tip 67,500, floor 0:");
{
  const LIVE_TIP = 67_500;
  const expectFee = Number(nameRegFee(NAME, buildFeeHeight(LIVE_TIP)));
  check("the clamp is a pass-through at a healthy live tip", feePricingTip(LIVE_TIP, 0) === LIVE_TIP);
  const st = memoryStore(); const w = new Wallet(st); await w.create("pw-live-tip-12345");
  const coins = [mkCoin(30_00000000)];   // funds the 15 CSD lease + the 0.25 CSD anchor
  const submits = [];
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.includes("/tx/submit")) { submits.push(JSON.parse(init?.body ?? "{}")); return { ok: true, status: 200, json: async () => ({ ok: true, txid: "0x" + "aa".repeat(32) }) }; }
    if (u.endsWith("/tip")) return { ok: true, status: 200, json: async () => ({ height: LIVE_TIP }) };
    if (u.includes("/utxos/")) return { ok: true, status: 200, json: async () => ({ confirmed_balance: coins.reduce((s, c) => s + c.coin.value, 0), utxos: coins.map((c) => c.coin) }) };
    const t = txReply(u, coins);
    if (t) return t;
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const quoted = await w.cairnxNameRenewFee(NAME);
  check(`the Renew button prices the real tier, unchanged (got ${quoted}, want ${expectFee})`, quoted === expectFee);
  const r = await w.cairnxNameRenew(NAME);
  check(`...and signs it (${r?.error ?? "ok"})`, r?.ok === true && submits.length === 1);
  const hex = (b) => "0x" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  const paid = (submits[0]?.tx?.outputs ?? [])
    .filter((o) => hex(o.script_pubkey).toLowerCase() === TREASURY_ADDR.toLowerCase())
    .reduce((a, o) => a + Number(o.value), 0);
  check(`...paying EXACTLY the quoted fee to the treasury (${paid} == ${expectFee})`, paid === expectFee);
}
// and the review side still warns on an underpaid third-party record at the same live tip.
{
  const LIVE_TIP = 67_500;
  const ren = buildNameRenew({ name: NAME });
  const mk = (treasuryVal) => describe({ method: "propose", currentTip: LIVE_TIP, tipFloor: 0,
    params: { domain: CAIRNX_DOMAIN, uri: ren.uri, payloadHash: ren.payloadHash, fee: 25000000, expiresEpoch: 2000, outputs: [{ to: TREASURY_ADDR, value: treasuryVal }] } });
  const need = Number(nameRegFee(NAME, buildFeeHeight(LIVE_TIP)));
  check("review: an underpaid third-party nrenew at the live tip still WARNS", /BELOW the current price/.test(mk(need - 1)));
  check("review: a correctly paid one does NOT warn", !/BELOW the current price/.test(mk(need)));
  // and the disarming input is now inert: a fractional served tip cannot silence the warning by throwing.
  const mkTip = (treasuryVal, tip, floor) => describe({ method: "propose", currentTip: tip, tipFloor: floor,
    params: { domain: CAIRNX_DOMAIN, uri: ren.uri, payloadHash: ren.payloadHash, fee: 25000000, expiresEpoch: 2000, outputs: [{ to: TREASURY_ADDR, value: treasuryVal }] } });
  check("review: a fractional served tip WITH a PoW floor still warns (the floor governs)", /BELOW the current price/.test(mkTip(need - 1, 65100.5, LIVE_TIP)));
  check("review: a fractional served tip with NO floor skips rather than showing a false clean bill", !/BELOW the current price/.test(mkTip(need - 1, 65100.5, 0)));
}

globalThis.fetch = origFetch;
console.log(`\nfee-tier-clamp: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
