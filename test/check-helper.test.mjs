// The shared check helper refuses a value that is always truthy without being evaluated: a function
// (`check("x", () => a === b)`) or a promise (an un-awaited async predicate). A bare `c ? pass++ : fail++`
// helper counts both as passes.
//   RED-FIRST: delete the `typeof cond === "function"` line in test/helpers/check.mjs and (1) fails; delete
//   the `.then` line and (2) fails.
//   PAIRED HONEST PATH: (3) a true condition counts a pass, a false one a failure, and check() returns the
//   condition unchanged, through both import paths.
// Run: node --import tsx test/check-helper.test.mjs   (offline)
import assert from "node:assert/strict";
import { checker } from "./helpers/check.mjs";
import { checker as legacyChecker } from "./_check.ts";

const quiet = (fn) => { const log = console.log; console.log = () => {}; try { return fn(); } finally { console.log = log; } };

// (1) a function, including one that would evaluate to false
{
  const c = checker();
  assert.throws(() => quiet(() => c.check("arrow-wrapped", () => false)), { name: "TypeError", message: /got a function/ });
  assert.throws(() => quiet(() => c.check("arrow-wrapped", () => true)), TypeError);
  assert.equal(c.pass, 0, "(1) nothing is counted as a pass");
  assert.equal(c.fail, 0);
  console.log("  ok (1) a function is refused");
}

// (2) a promise (an async predicate called but not awaited)
{
  const c = checker();
  assert.throws(() => quiet(() => c.check("unawaited", Promise.resolve(false))), { name: "TypeError", message: /got a promise/ });
  assert.equal(c.pass, 0, "(2) nothing is counted as a pass");
  console.log("  ok (2) a promise is refused");
}

// (3) the honest call shapes the suite uses: booleans and truthy values, from either import path
for (const [label, make] of [["helpers/check.mjs", checker], ["_check.ts", legacyChecker]]) {
  const c = make();
  const r1 = quiet(() => c.check("true", 1 === 1));
  const r2 = quiet(() => c.check("false", 1 === 2));
  const r3 = quiet(() => c.check("truthy object", { verified: true }));
  const r4 = quiet(() => c.check("null", null));
  assert.equal(r1, true);
  assert.equal(r2, false);
  assert.deepEqual(r3, { verified: true });
  assert.equal(r4, null);
  assert.equal(c.pass, 2, `(3) ${label}: two passes`);
  assert.equal(c.fail, 2, `(3) ${label}: two failures`);
  console.log(`  ok (3) ${label}: values are counted and returned unchanged`);
}

console.log("\ncheck-helper: all assertions passed");
