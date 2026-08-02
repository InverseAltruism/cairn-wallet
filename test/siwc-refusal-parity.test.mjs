// SIWC REFUSAL-PARITY vectors (Plan 75-A section 7.3), cairn-wallet copy = the BUILDER twin.
//
// The SIWC byte contract is hand-maintained in THREE places: csd-sdk/packages/siwc/src/index.ts,
// cairn/src/lib/siwc.ts and this repo's src/core/siwc.ts. Nothing forced the three to refuse the same
// inputs, so a guard added to one copy could sit missing in another for a release cycle.
//
// Mechanism (exactly as 7.3 mandates): ONE committed JSON vector file, DUPLICATED byte-for-byte into
// each repo (a cross-repo checkout does not exist in CI, the MF-27 lesson), and each repo's test
// asserts BOTH
//   (a) sha256(vectors.json) == the pinned constant, so a DRIFTED COPY of the vector file reds, and
//   (b) the LOCAL twin refuses every refusal vector and accepts every acceptance vector.
// This pins test DATA across repos. It is deliberately NOT a cross-repo byte-identity test on the
// implementations: three models vetoed that.
//
// SURFACE: this twin is a BUILDER. The wallet builds and signs the SIWC message locally and the dApp's
// OWN server verifies it, so src/core/siwc.ts has no parseSiwcMessage / verifySiwc. Every verify-surface
// leg is therefore skipped, and the skipped ids are PINNED below: adding a verify vector upstream reds
// this file until a human decides whether the wallet now needs that surface. It never silently drops.
//
// KNOWN RED (the finding this file makes mechanical, Plan 75-A section 7.3): the wallet builder has
// hasLF but NOT hasLoneSurrogate, so SIWC-R1 build FAILS here while it passes in the other two copies.
// A lone surrogate is mapped to U+FFFD by utf8ToBytes, so the wallet will happily SIGN a message whose
// digest collides with a different message, and whose bytes the canonical verifier then refuses as
// malformed. The fix is to port hasLoneSurrogate + the assertField shape from csd-siwc; this test goes
// green the moment that lands and must NOT be relaxed to make it green sooner.
//
// Mutations executed at authoring (observed RED, restored):
//   - flip one byte of test/vectors/siwc-refusal-parity.vectors.json -> the sha pin goes RED.
//   - drop the newline class from hasLF in src/core/siwc.ts -> the SIWC-R2 build leg goes RED.
//
// Run: npx tsx test/siwc-refusal-parity.test.mjs
import { buildSiwcMessage, siwcDigest } from "../src/core/siwc.ts";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

let pass = 0, fail = 0;
// Vacuous-assertion guard: throw if a function is passed as the condition (always truthy).
const ok = (n, c) => {
  if (typeof c === "function") throw new Error(`vacuous assertion (function passed as cond): ${n}`);
  c ? (pass++, console.log("  ✅ " + n)) : (fail++, console.log("  ❌ " + n));
};

// (a) THE VECTOR-FILE PIN. Identical constant in all three repos: whichever copy drifts, that repo reds.
const VECTORS_SHA256 = "d8c0f4ee8106cc567bbda0aa6cb1874b6a1ffda52bae089dbac43399c9cac593";
const VECTORS_PATH = new URL("./vectors/siwc-refusal-parity.vectors.json", import.meta.url);

// Builder only: no verifier in this twin, by design.
const LOCAL_SURFACES = ["build"];
// The exact number of vector legs this twin must execute (4 build legs of the 5 vectors).
const EXPECTED_LEGS = 4;
// SIWC-R3 is an out-of-range TIME, refused by the verifier; the builder deliberately does not
// range-check time values, so this twin cannot carry that leg at all.
const EXPECTED_SKIPPED = ["SIWC-R3"];

console.log("=== (a) the committed vector file is the one this repo was pinned against ===");
const raw = readFileSync(VECTORS_PATH);
const got = createHash("sha256").update(raw).digest("hex");
ok(`sha256(siwc-refusal-parity.vectors.json) == the pinned constant (got ${got.slice(0, 16)}...)`, got === VECTORS_SHA256);
const V = JSON.parse(raw.toString("utf8"));
ok("the vector file is the siwc family at the pinned revision", V.family === "siwc" && V.revision === 1);

console.log("=== (b) the LOCAL twin refuses every refusal vector and accepts every acceptance vector ===");
let legs = 0;
const skipped = [];
for (const v of V.vectors) {
  let ran = false;
  if (v.build && LOCAL_SURFACES.includes("build")) {
    ran = true; legs++;
    if (v.kind === "refusal") {
      let threw = false, why = "";
      try { buildSiwcMessage(v.build.fields); } catch (e) { threw = true; why = String(e?.message); }
      ok(`${v.id} build REFUSES: ${v.label}${threw ? ` [${why}]` : ""}`, threw);
    } else {
      let m = null, d = null, err = "";
      try { m = buildSiwcMessage(v.build.fields); d = siwcDigest(m); } catch (e) { err = String(e?.message); }
      ok(`${v.id} build ACCEPTS and reproduces the pinned canonical bytes + digest: ${v.label}${err ? ` [threw ${err}]` : ""}`,
        m === v.build.message && d === v.build.digest);
    }
  }
  if (!ran) skipped.push(v.id);
}

console.log("=== the corpus was actually exercised (a gate that runs nothing is not a gate) ===");
ok(`executed exactly the pinned number of vector legs (${EXPECTED_LEGS}, got ${legs})`, legs === EXPECTED_LEGS);
ok(`skipped exactly the pinned vector ids (${JSON.stringify(EXPECTED_SKIPPED)}, got ${JSON.stringify(skipped)})`,
  JSON.stringify(skipped) === JSON.stringify(EXPECTED_SKIPPED));

console.log(`\nsiwc refusal-parity: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
