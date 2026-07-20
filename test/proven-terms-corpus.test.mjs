// B4a (REBIND W2) corpus + source pins: fillspv's ProvenOfferTerms production is SINGLE-SOURCED in
// the vendored cairnx-core `provenOfferTerms`.
//
// 1. CORPUS EQUIVALENCE (the refactor's oracle, frozen at authoring): the fixture holds every real
//    on-chain offer record (55, spanning pre-V16..V24+) plus labeled synthetic envelope variants,
//    each with the terms the OLD hand-built producers computed - proven byte-identical to canonical
//    at generation time (0 divergences over 68 entries). This test pins canonical == fixture
//    forever, so any future semantic drift of the vendored producer against the historical wallet
//    semantics goes red here before it ships.
// 2. SOURCE PINS (the pentest.ts idiom): a re-introduced EQUIVALENT hand copy is invisible to a
//    value-equality corpus, so the source itself is pinned - no local feeBpsAt declaration, no
//    object-literal terms construction, exactly two provenOfferTerms call sites (fclaim + legacy).
//
// Mutations executed at authoring (observed RED, restored): re-add a local feeBpsAt declaration ->
// pin 2 red; re-inline a hand-built terms literal at the fclaim producer -> pins 3+4 red; pass
// offerEv.height+1 into the fclaim producer call -> fill-fclaim-preflight terms/height binds red.
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { provenOfferTerms } from "../src/vendor/cairnx-spv.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, fail = 0;
const ok = (n, c) => {
  if (typeof c === "function") throw new Error(`vacuous assertion (function passed as cond): ${n}`);
  c ? (pass++, console.log("  ✅ " + n)) : (fail++, console.log("  ❌ " + n));
};

// ── 1. corpus equivalence ──
const corpus = JSON.parse(readFileSync(join(ROOT, "test/fixtures/proven-terms-corpus.json"), "utf8"));
ok(`corpus loaded with the full population (68 entries: 55 real + 13 synthetic)`,
  corpus.length === 68 && corpus.filter((e) => e.source === "real").length === 55);
let mismatches = 0;
for (const e of corpus) {
  const got = provenOfferTerms(e.rec, e.height);
  if (JSON.stringify(got) !== JSON.stringify(e.terms)) { mismatches++; console.log(`    MISMATCH ${e.id}: got ${JSON.stringify(got)} want ${JSON.stringify(e.terms)}`); }
}
ok("canonical provenOfferTerms matches the frozen historical semantics for EVERY corpus entry", mismatches === 0);

// ── 2. source pins on src/core/fillspv.ts ──
const src = readFileSync(join(ROOT, "src/core/fillspv.ts"), "utf8");
ok("no local feeBpsAt DECLARATION in fillspv.ts (re-export pointer only)",
  !/const feeBpsAt\s*=|function feeBpsAt/.test(src) && /export \{ feeBpsAt, type ProvenOfferTerms \} from "\.\.\/vendor\/cairnx-spv\.js"/.test(src));
ok("no object-literal ProvenOfferTerms construction in fillspv.ts (no `feeBps:` field writes)",
  !/feeBps:\s*/.test(src.replace(/\/\/[^\n]*/g, "")));
ok("exactly two provenOfferTerms call sites (fclaim + legacy lanes)",
  (src.match(/provenOfferTerms\(/g) ?? []).length === 2);

console.log(`\nproven-terms-corpus: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
