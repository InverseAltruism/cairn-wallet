// AW-1 (Plan 75 P75-7): the anti-click-through button disable must be SPLIT above the pre-paint await.
//
// approve.ts render() sets `current`/`renderedId` to the NEW request (line "renderedId = current.id"), THEN
// awaits up to three bounded pre-paint RPCs (~2.5s), THEN paints and disables the buttons. A click landing in
// the [renderedId set -> paint] window resolves the NEW request (resolve() reads the module-level `current`)
// against the OLD paint. The fix disables BOTH buttons the instant a new request is detected — BEFORE the
// pre-paint await — via a split disableButtons(); armButtons() keeps only the 700ms RE-ENABLE timer, fired
// AFTER the paint (hoisting armButtons ENTIRE would start that timer during the await, re-relocating the window).
//
// approve.ts is DOM/timing glue with no suite harness; adding jsdom for one function is over-engineering on a
// fund path, so this is a SOURCE-STRUCTURE pin in the repo's established idiom (cf. namespv-floor.test.mjs /
// pentest.ts), each with a NON-VACUITY control proving the predicate discriminates (not merely that a token
// exists). RED-FIRST: against the pre-fix approve.ts (disable only inside armButtons, after the await) the
// ordering pin reds; against a variant with no paint try/catch the reset pin reds.
//
// Run: node --import tsx test/approve-clickthrough-guard.test.mjs   (offline)
import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
const ok = (n, c) => { c ? (pass++, console.log("  ✓ " + n)) : (fail++, console.error("  ✗ " + n)); };

const src = readFileSync(new URL("../src/popup/approve.ts", import.meta.url), "utf8");
// Slice render() from its declaration to the next top-level function.
const rStart = src.indexOf("async function render()");
const rEnd = (() => { const m = src.slice(rStart + 1).search(/\n(async )?function /); return m < 0 ? src.length : rStart + 1 + m; })();
const render = src.slice(rStart, rEnd);
ok("render() body located", rStart > 0 && rEnd > rStart);
// The ordering region: everything AFTER `renderedId = current.id` (so the earlier renderedId lines don't skew indexOf).
const region = render.slice(render.indexOf("renderedId = current.id"));

console.log("AW-1 - anti-click-through disable is split above the pre-paint await:\n");

// (1) ORDERING PIN: disableButtons() is called BEFORE the pre-paint await AND before the first branch that
// leads into it — so a click during the await hits already-disabled buttons.
const iDisable = region.indexOf("disableButtons()");
const iAwait = region.indexOf("await Promise.all");
const iPropose = region.indexOf('current.method === "propose"');
ok("disableButtons() is called before the pre-paint `await Promise.all`", iDisable >= 0 && iAwait >= 0 && iDisable < iAwait);
ok("disableButtons() is called before the propose pre-paint branch", iDisable >= 0 && iPropose >= 0 && iDisable < iPropose);
// NON-VACUITY control: the SAME predicate must be FALSE for the disarm shape (disable AFTER the await), proving
// the pin discriminates ordering rather than merely detecting that the token exists.
{
  const disarm = `renderedId = current.id;\n  const [e,t,f] = await Promise.all([]);\n  disableButtons();\n  if (current.method === "propose") {}`;
  const di = disarm.indexOf("disableButtons()"), ai = disarm.indexOf("await Promise.all");
  ok("MUT control: the ordering pin REDS on the disarm shape (disableButtons AFTER the await)", !(di >= 0 && ai >= 0 && di < ai));
}

// (2) armButtons() is NOT hoisted WHOLE above the await (its 700ms re-enable timer must not start during the
// ~2.5s await, which would re-enable the buttons before the new request paints). Its render call site sits AFTER.
const iArm = render.indexOf("armButtons()");
ok("armButtons()'s render call site is AFTER the pre-paint await (re-enable timer starts post-paint)", iArm >= 0 && iArm > render.indexOf("await Promise.all"));

// (3) PAINT-THROW RESET: a describe()/paint throw must reset renderedId (else `if (renderedId === current.id) return`
// leaves the request permanently unpaintable AND unapprovable — disableButtons ran, armButtons did not).
const RESET = /catch[^{]*\{[^}]*renderedId = null/;
ok("a paint-throw catch resets renderedId = null (request stays retryable)", RESET.test(render));
// NON-VACUITY control: the regex must FAIL on a catch that does NOT reset renderedId.
ok("MUT control: the reset pin REDS on a catch lacking the reset", !RESET.test("try { paint(); } catch (e) { console.warn(e); throw e; }"));

// (4) disableButtons is a real split function (not folded back into armButtons).
ok("disableButtons() is defined as its own function (split from armButtons)", /function disableButtons\(\)/.test(src));
// and armButtons still owns the re-enable timer (700ms) that this split deliberately keeps post-paint.
ok("armButtons() still owns the 700ms re-enable timer", /function armButtons\(\)[\s\S]*setTimeout\([\s\S]*700\)/.test(src));

console.log(`\napprove-clickthrough-guard: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
