// The shared pass/fail helper for wallet test files. `check(name, cond)` records and prints one result
// and returns cond; `done(label?)` prints the tally and exits non-zero on any failure.
//
// Tripwire: `cond` must be the evaluated condition. A function (`check("x", () => a === b)`) or a
// promise (an un-awaited async predicate) is always truthy, so a bare helper counts it as a pass no
// matter what it would evaluate to. Both throw here, which fails the file.

export function checker(title) {
  let pass = 0, fail = 0;
  if (title) console.log(title);
  return {
    check(name, cond) {
      if (typeof cond === "function") throw new TypeError(`check(${JSON.stringify(name)}): got a function; pass the evaluated condition`);
      if (cond != null && typeof cond.then === "function") throw new TypeError(`check(${JSON.stringify(name)}): got a promise; await it first`);
      if (cond) { pass++; console.log("  ✓ " + name); }
      else { fail++; console.log("  ✗ " + name); }
      return cond;
    },
    done(label) {
      console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed${label ? " (" + label + ")" : ""}`);
      process.exit(fail === 0 ? 0 : 1);
      throw new Error("unreachable");
    },
    get pass() { return pass; },
    get fail() { return fail; },
  };
}
