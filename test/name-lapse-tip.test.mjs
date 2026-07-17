// WALLET-LAPSE-TIP-1 (Plan 70 R2): a name lease-LAPSE verdict was trusted single-source on the (untrusted)
// node tip — a fresh install + MITM inflating the tip could assert a FALSE lapse and hard-block a legit send.
// The fix extends the two-source-union posture to the lapse/tip: a lapse is CONFIDENT (`lapsed:true`, a
// "refusing" reason) only when corroborated — either ≥2 independent name sources served the events that
// establish the lease, OR the persisted monotonic tip floor (a tip trusted across PRIOR sessions) is also
// past expiry. An uncorroborated single-source lapse DEGRADES TO CAUTION (verified=false, lapsed !== true, a
// "may have lapsed … confirm out-of-band" reason). Never a false green; never a hard block on a legit send.
//
// MUTATION CONTRACT — fails if any of these regress:
//   * single-source verifyName of a genuine lapse becomes a confident lapse again (Case 1: lapsed===true).
//   * a persisted-floor-corroborated single-source lapse stops being confident (Case 2: lapsed!==true).
//   * a two-source-confirmed lapse stops being confident (Case 3: lapsed!==true).
//   * a single usable union source stops degrading to caution (Case 4: lapsed===true).
// Run: tsx test/name-lapse-tip.test.mjs
import { verifyName, verifyNameUnion } from "../src/core/namespv.ts";
import { checker } from "./_check.ts";
import { buildNameClaim, buildNameSet, addrFromPriv, proposeTx, world, source, feeOut, pick, mkFetch } from "./_spvrig.ts";

const { check, done } = checker("WALLET-LAPSE-TIP-1 (lease-lapse single-source tip):");

const keyA = "0x" + "11".repeat(32);
const A = addrFromPriv(keyA).toLowerCase();
const TARGET = "0x" + "cd".repeat(20);
const NAME = "alice";

// alice.csd: claim @33700, nset→TARGET @33710. claim epoch=floor(33700/30)=1123; lapses at height >~318090.
const claimTx = proposeTx({ ...pick(buildNameClaim({ name: NAME })), priv: keyA, outputs: feeOut() });
const nsetTx = proposeTx({ ...pick(buildNameSet({ name: NAME, addr: TARGET })), priv: keyA });
const { blocks, hints } = world([{ height: 33700, tx: claimTx }, { height: 33710, tx: nsetTx }]);

const CLAIM = { addr: TARGET, owner: A, via: "nset" };
const REAL_TIP = 320_000;   // honest chain tip — alice.csd lease lapsed long ago
const VERIFIED = 33_722;    // the PoW-verified tip in production is always ~maxEventHeight+CONF_BUFFER

// production-shaped source: verifiedTip pinned near the records, nodeTip = the (untrusted) reported tip.
const srcNoFloor = (nodeTip) => source(blocks, nodeTip, { verifiedTip: VERIFIED, nodeTip });
const srcWithFloor = (nodeTip, floorTip) => source(blocks, nodeTip, { verifiedTip: VERIFIED, nodeTip, floorTip });

// ── Case 1: SINGLE-source lapse, no floor corroboration → CAUTION (not a confident lapse) ──
{
  const r = await verifyName(NAME, CLAIM, hints, srcNoFloor(REAL_TIP));
  console.log("[1] single-source, no floor: verified=%s lapsed=%s reason=%j", r.verified, r.lapsed, r.reason);
  check("[1] single-source lapse DEGRADES TO CAUTION (verified=false, lapsed !== true)", r.verified === false && r.lapsed !== true);
  check("[1] the caution reason says the tip could not be independently confirmed", /only one name source|confirm out-of-band/i.test(r.reason || ""));
}

// ── Case 2: SINGLE-source lapse, but the PERSISTED FLOOR is also past expiry → CONFIDENT lapse ──
{
  const r = await verifyName(NAME, CLAIM, hints, srcWithFloor(REAL_TIP, REAL_TIP));
  console.log("[2] single-source, floor corroborates: verified=%s lapsed=%s reason=%j", r.verified, r.lapsed, r.reason);
  check("[2] a floor-corroborated lapse is CONFIDENT (verified=false, lapsed===true)", r.verified === false && r.lapsed === true);
  check("[2] the confident-lapse reason refuses the send", /lapsed[\s\S]*refusing|refusing[\s\S]*lapsed/i.test(r.reason || ""));
}

// ── Case 3: TWO independent sources both serve the events → CONFIDENT lapse ──
{
  const PRIM = "https://cairn-substrate.com/trade/api";
  const CLAR = "https://clarvis.cairn-substrate.com/trade/api";
  const sources = [{ label: "primary", base: PRIM }, { label: "clarvis", base: CLAR }];
  const history = { ok: true, events: hints, resolve: { addr: TARGET, owner: A, via: "nset" }, scopedReplaySufficient: true };
  const r = await verifyNameUnion(NAME, sources, srcNoFloor(REAL_TIP), mkFetch({ [PRIM]: history, [CLAR]: history }));
  console.log("[3] two sources, lapse: verified=%s lapsed=%s sources=%s", r.verified, r.lapsed, r.sources);
  check("[3] a two-source-confirmed lapse SHOWS LAPSED (verified=false, lapsed===true, sources===2)", r.verified === false && r.lapsed === true && r.sources === 2);
}

// ── Case 4: only ONE usable union source (clarvis network-blocked) + no floor → CAUTION ──
{
  const PRIM = "https://cairn-substrate.com/trade/api";
  const CLAR = "https://clarvis.cairn-substrate.com/trade/api";
  const sources = [{ label: "primary", base: PRIM }, { label: "clarvis", base: CLAR }];
  const history = { ok: true, events: hints, resolve: { addr: TARGET, owner: A, via: "nset" }, scopedReplaySufficient: true };
  const r = await verifyNameUnion(NAME, sources, srcNoFloor(REAL_TIP), mkFetch({ [PRIM]: history, [CLAR]: "throw" }));
  console.log("[4] one usable source, lapse: verified=%s lapsed=%s sources=%s", r.verified, r.lapsed, r.sources);
  check("[4] a lone usable source with an uncorroborated lapse DEGRADES TO CAUTION (lapsed !== true, sources===1)", r.verified === false && r.lapsed !== true && r.sources === 1);
}

// ── Control: a NON-lapsed name (deflated/low tip) still verifies clean — the caution path never over-warns ──
{
  const r = await verifyName(NAME, CLAIM, hints, srcNoFloor(VERIFIED)); // nodeTip == verifiedTip → not yet lapsed
  console.log("[C] not-yet-lapsed control: verified=%s addr=%s", r.verified, r.addr);
  check("[C] a name that is NOT lapsed verifies clean (no spurious lapse caution)", r.verified === true && r.addr === TARGET && r.lapsed !== true);
}

done("name-lapse-tip");
