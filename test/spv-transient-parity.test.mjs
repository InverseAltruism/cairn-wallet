// SPV transient-vs-STRUCTURAL classifier REFUSAL-PARITY vectors (Plan 75-A section 7.3),
// cairn-wallet copy = isTransientSyncError in src/core/namespv.ts.
//
// The classifier is hand-maintained in THREE places: cairn-sdk/src/index.ts (spvIsTransient), this
// repo's src/core/namespv.ts (isTransientSyncError), and cairn/public/trade/swapguard.js (the inline
// regex in ensureSyncedTo). They were ported by hand from one another and have already diverged.
//
// Mechanism (exactly as 7.3 mandates): ONE committed JSON vector file, DUPLICATED byte-for-byte into
// each repo (a cross-repo checkout does not exist in CI, the MF-27 lesson), and each repo's test
// asserts BOTH
//   (a) sha256(vectors.json) == the pinned constant, so a DRIFTED COPY of the vector file reds, and
//   (b) the LOCAL twin classifies every vector the way the vector file says.
// This pins test DATA across repos. It is deliberately NOT a cross-repo byte-identity test on the
// implementations: three models vetoed that.
//
// Why this matters, in money terms: transient means KEEP the verified header cache and fail closed;
// structural means WIPE it and cold-reseed from the baked checkpoint. Calling a transport blip
// structural is the DOS-HDR-3 reseed storm (one 429 nuked the cache and could never recover inside
// the rate-limit window). Calling a chain fault transient wedges the client on an orphaned tip.
//
// This twin EXPORTS its classifier, so this file calls the live function, not a copy of its regex.
//
// Mutations executed at authoring (observed RED, restored):
//   - narrow `50[0-9]` to `502|503` in the isTransientSyncError regex in src/core/namespv.ts (the exact
//     drift swapguard.js still carries) -> SPV-6 goes RED, 8 passed / 2 failed.
//   - flip one byte of test/vectors/spv-transient-parity.vectors.json -> the sha pin goes RED.
// Recorded because it is instructive: dropping `non-dense` does NOT red SPV-5, because that producer
// string also matches the `headers` alternative. SPV-5 pins the beyond-tip CLASSIFICATION, not that one
// keyword, and SPV-6 is the vector that isolates the 5xx range.
//
// Run: npx tsx test/spv-transient-parity.test.mjs
import { isTransientSyncError } from "../src/core/namespv.ts";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

let pass = 0, fail = 0;
// Vacuous-assertion guard: throw if a function is passed as the condition (always truthy).
const ok = (n, c) => {
  if (typeof c === "function") throw new Error(`vacuous assertion (function passed as cond): ${n}`);
  c ? (pass++, console.log("  ✅ " + n)) : (fail++, console.log("  ❌ " + n));
};

// (a) THE VECTOR-FILE PIN. Identical constant in all three repos: whichever copy drifts, that repo reds.
const VECTORS_SHA256 = "013a9b54ac694a202338af680dc66b5e38d3cbe9cf3c18d318ac44a627061cc4";
const VECTORS_PATH = new URL("./vectors/spv-transient-parity.vectors.json", import.meta.url);
const EXPECTED_LEGS = 7;

console.log("=== (a) the committed vector file is the one this repo was pinned against ===");
const raw = readFileSync(VECTORS_PATH);
const got = createHash("sha256").update(raw).digest("hex");
ok(`sha256(spv-transient-parity.vectors.json) == the pinned constant (got ${got.slice(0, 16)}...)`, got === VECTORS_SHA256);
const V = JSON.parse(raw.toString("utf8"));
ok("the vector file is the spv-transient-classifier family at the pinned revision",
  V.family === "spv-transient-classifier" && V.revision === 1);

console.log("=== (b) the LOCAL twin classifies every vector as the corpus says ===");
let legs = 0;
for (const v of V.vectors) {
  legs++;
  const cls = isTransientSyncError(v.message) ? "transient" : "structural";
  ok(`${v.id} ${v.class.toUpperCase()}: ${v.label} [${JSON.stringify(v.message)} -> ${cls}]`, cls === v.class);
}

console.log("=== the corpus was actually exercised (a gate that runs nothing is not a gate) ===");
ok(`executed exactly the pinned number of vectors (${EXPECTED_LEGS}, got ${legs})`, legs === EXPECTED_LEGS);

console.log(`\nspv transient-parity: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
