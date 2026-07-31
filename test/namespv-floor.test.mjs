// M9 (B5a, REBIND): the persisted lapse floor must be PoW-CLAMPED and SYNC-GATED.
// Before this batch, liveSpvSource.prepare() persisted the RAW unauthenticated client.tip().height as an
// unbounded monotonic high-water BEFORE any sync ran, so one hostile inflated read became a permanent lie
// driving every later lease-expiry epoch and every guard clamped by the floor (W5 legacy-sunset, M11 fee
// tier). The fix routes every advance through the pure floorAdvance(seenFloor, nodeTip, verifiedTip)
// (clamp: never above verifiedTip + FLOOR_SLACK) and moves the advance AFTER the serialized LC.sync, so a
// failed/lying sync advances nothing.
//
// Two halves, per the campaign's use-site rule (N24 class):
//   (1) BEHAVIORAL units on the exported floorAdvance primitive.
//   (2) SOURCE pins that prepare() actually uses it, after the sync, with the old raw-persist gone —
//       liveSpvSource builds its own vendored LightClient against real mainnet PoW (no injection seam;
//       adding one to a fund path is forbidden over-engineering), so the wiring is pinned at the source
//       in the repo's own idiom (cf. test/pentest.ts, test/spv-serializer.test.mjs).
//
// Run: node --import tsx test/namespv-floor.test.mjs   (offline)
import { readFileSync } from "node:fs";
import { floorAdvance, FLOOR_SLACK } from "../src/core/namespv.ts";

let pass = 0, fail = 0;
const ok = (name, cond) => {
  if (typeof cond === "function") throw new Error(`ok("${name}") given a FUNCTION - evaluate it (vacuous-assertion guard)`);
  cond ? pass++ : fail++; console.log(`  ${cond ? "✓" : "✗"} ${name}`);
};

console.log("floorAdvance (M9/B5a PoW-clamped sync-gated lapse floor):");

// ── (1) behavioral units on the primitive ──────────────────────────────────────────────────────────
// Honest advance: a served tip within PoW evidence + slack advances the floor to the tip exactly.
ok("honest tip within slack advances to the tip", floorAdvance(100, 33722 + 3, 33722) === 33725);
// THE CLAMP (the batch's headline): a hostile inflated tip is capped at verifiedTip + FLOOR_SLACK.
ok("inflated tip clamps to verifiedTip + FLOOR_SLACK", floorAdvance(100, 1_000_000_000, 33722) === 33722 + FLOOR_SLACK);
// Monotonic: a candidate below the current floor never regresses it.
ok("deflated tip never regresses the floor", floorAdvance(50_000, 40_000, 60_000) === 50_000);
ok("clamped candidate below the floor keeps the floor", floorAdvance(50_000, 1_000_000_000, 30_000) === 50_000);
// Degenerate inputs fail safe (keep the floor).
ok("NaN tip keeps the floor", floorAdvance(123, NaN, 33722) === 123);
ok("NaN verifiedTip clamps to slack alone (never NaN)", floorAdvance(0, 500, NaN) === Math.min(500, FLOOR_SLACK));
ok("FLOOR_SLACK is a small positive cushion (not a disarmed clamp)", Number.isFinite(FLOOR_SLACK) && FLOOR_SLACK > 0 && FLOOR_SLACK <= 64);

// ── (2) source pins: the primitive is APPLIED in prepare(), sync-gated, and the old line is gone ───
const src = readFileSync(new URL("../src/core/namespv.ts", import.meta.url), "utf8");
const pStart = src.indexOf("async prepare(maxEventHeight");
const pEnd = src.indexOf("async blockAt(", pStart);
ok("prepare() body located", pStart > 0 && pEnd > pStart);
const prep = src.slice(pStart, pEnd);

// The advance goes through the ONE clamped primitive, exactly once.
ok("prepare() advances the floor via floorAdvance, exactly once", (prep.match(/floorAdvance\(/g) || []).length === 1);
// SYNC-GATED: the advance sits AFTER the serialized sync (a throw skips it).
ok("the floorAdvance call sits AFTER the serializeSync block", prep.indexOf("floorAdvance(") > prep.indexOf("serializeSync("));
// The persist writes the clamped value, once, after the advance.
ok("prepare() persists the floor exactly once", (prep.match(/opts\.floor\.set\(/g) || []).length === 1);
ok("the persist sits AFTER the clamped advance", prep.indexOf("opts.floor.set(") > prep.indexOf("floorAdvance("));
// THE OLD DEFECT SHAPE IS GONE: no raw `seenFloor = nodeTip` assignment anywhere in prepare().
const RAW_PERSIST = /seenFloor\s*=\s*nodeTip\b/;
ok("the raw-tip floor assignment (the M9 defect) is gone from prepare()", !RAW_PERSIST.test(prep));

// TSA-4 (Plan 75 P75-7): pin the floorAdvance ARGUMENT ORDER at the call site. floorAdvance(seenFloor, nodeTip,
// verifiedTip) clamps the advance to verifiedTip + FLOOR_SLACK (PoW evidence). Swapping the 3rd arg to nodeTip
// (floorAdvance(seenFloor, nodeTip, nodeTip)) re-arms the hostile-INFLATABLE floor while every behavioral unit
// above still passes, so the call site itself must be pinned — with a NON-VACUITY control proving the regex
// rejects the disarm shape (not merely that a floorAdvance call exists).
const CALL = /floorAdvance\(\s*seenFloor\s*,\s*nodeTip\s*,\s*verifiedTip\s*\)/;
ok("the floorAdvance call site passes verifiedTip (not nodeTip) as the PoW-clamp arg", CALL.test(prep));
ok("MUT control: the pin REDS on the disarm shape (verifiedTip replaced by nodeTip)", !CALL.test("const cand = floorAdvance(seenFloor, nodeTip, nodeTip);"));

// Inline MUT fixture: the pre-fix line, verbatim shape - proves the detector regex is non-vacuous
// (reintroducing the old persist-at-read line would trip RAW_PERSIST).
const OLD_LINE = "if (Number.isFinite(nodeTip) && nodeTip > seenFloor) { seenFloor = nodeTip; if (opts.floor) { try { await opts.floor.set(seenFloor); } catch { } } }";
ok("MUT fixture: the detector REDS on the pre-fix raw-persist line", RAW_PERSIST.test(OLD_LINE));

console.log(`\nnamespv-floor: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
