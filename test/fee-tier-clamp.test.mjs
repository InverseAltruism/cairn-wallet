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

let pass = 0, fail = 0;
const check = (n, c) => { c ? (pass++, console.log("  ✓ " + n)) : (fail++, console.error("  ✗ " + n)); };
const origFetch = globalThis.fetch;

console.log("M11 (B5b) - floor-clamped name-fee pricing:");

// ── the shared helper's clamp semantics ────────────────────────────────────────────────────────────
check("deflated raw tip clamps UP to the floor", feePricingTip(40_000, 47_000) === 47_000);
check("honest raw tip above the floor wins", feePricingTip(50_000, 47_000) === 50_000);
check("no floor (fresh install) leaves the raw tip", feePricingTip(40_000, 0) === 40_000);
check("null/failed tip read falls back to the floor alone", feePricingTip(null, 47_000) === 47_000);
check("both absent -> 0 (callers keep their offline-skip behavior)", feePricingTip(null, 0) === 0);

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

globalThis.fetch = origFetch;
console.log(`\nfee-tier-clamp: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
