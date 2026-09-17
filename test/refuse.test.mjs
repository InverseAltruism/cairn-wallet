// refuse() is the single {ok:false, sighashMatch:false} SubmitResult helper (0.2.70).
import { refuse } from "../src/core/refuse.ts";

let pass = 0, fail = 0;
const ok = (n, c) => { c ? (pass++, console.log("  ✓ " + n)) : (fail++, console.error("  ✗ " + n)); };

const r = refuse("FILL_UNSAFE", "nope");
ok("ok is false", r.ok === false);
ok("sighashMatch is false (dApp-visible vestige)", r.sighashMatch === false);
ok("code is the machine contract", r.code === "FILL_UNSAFE");
ok("error is the UX string", r.error === "nope");
ok("shape has no extra keys", Object.keys(r).sort().join(",") === "code,error,ok,sighashMatch");

console.log(`\nrefuse: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
