// _check.ts — the shared pass/fail runner for the wallet's tsx test files. Centralizes the
// count-print-and-exit boilerplate that each file used to hand-roll, so a test can't silently "pass"
// by forgetting to wire its tally into the process exit code (npm test is a tsx &&-chain — a non-zero
// exit is what stops the chain). `check(name, cond)` records + prints one result and returns cond (so a
// caller can branch on it); `done(label?)` prints the tally and exits non-zero on any failure.
declare const process: { exit(code: number): void };

export interface Checker {
  check(name: string, cond: boolean): boolean;
  done(label?: string): never;
  readonly pass: number;
  readonly fail: number;
}

export function checker(title?: string): Checker {
  let pass = 0, fail = 0;
  if (title) console.log(title);
  return {
    check(name: string, cond: boolean): boolean {
      if (cond) { pass++; console.log("  ✓ " + name); }
      else { fail++; console.log("  ✗ " + name); }
      return cond;
    },
    done(label?: string): never {
      console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed${label ? " (" + label + ")" : ""}`);
      process.exit(fail === 0 ? 0 : 1);
      throw new Error("unreachable"); // satisfies the `never` return after process.exit
    },
    get pass() { return pass; },
    get fail() { return fail; },
  };
}
