// The wallet's epoch math uses the vendored consensus EPOCH_LEN, not a local copy of the number.
//
// wallet.ts carried `const BLOCKS_PER_EPOCH = 30` with a comment saying the vendored .d.ts did not export
// EPOCH_LEN. It does (src/vendor/cairnx-spv.d.ts, generated from cairnx-core), so the local twin is removed.
//   RED-FIRST: (1) fails on any wallet.ts that declares its own blocks-per-epoch constant.
//   EQUIVALENCE (the change must not move any number): (2) EPOCH_LEN is 30 and wallet.epoch() returns
//   floor(tip / 30) from a mocked /tip; every expiresEpoch in wallet.ts uses the same floor(tip / EPOCH_LEN).
//
// Run: node --import tsx test/epoch-len-vendored.test.mjs   (offline)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { EPOCH_LEN } from "../src/vendor/cairnx-spv.js";
import { Wallet } from "../src/core/wallet.js";
import { memoryStore } from "../src/core/storage.js";

const src = readFileSync(new URL("../src/core/wallet.ts", import.meta.url), "utf8");
const dts = readFileSync(new URL("../src/vendor/cairnx-spv.d.ts", import.meta.url), "utf8");

console.log("(1) wallet.ts imports EPOCH_LEN from the vendored bundle and declares no local copy");
// The .d.ts is generated: it re-exports cairnx-core whole, whose own declarations export EPOCH_LEN.
assert.match(dts, /^export \* from "@inversealtruism\/cairnx-core";$/m, "the vendored .d.ts re-exports cairnx-core");
const coreDts = readFileSync(new URL("../node_modules/@inversealtruism/cairnx-core/dist/index.d.ts", import.meta.url), "utf8");
assert.match(coreDts, /\bEPOCH_LEN\b[^;]*from '@inversealtruism\/csd-codec'/, "cairnx-core exports EPOCH_LEN (from csd-codec)");
assert.match(src, /import \{[^}]*\bEPOCH_LEN\b[^}]*\} from "\.\.\/vendor\/cairnx-spv\.js";/, "wallet.ts imports it");
assert.doesNotMatch(src, /BLOCKS_PER_EPOCH/, "no BLOCKS_PER_EPOCH twin");
assert.doesNotMatch(src, /const\s+\w*EPOCH\w*\s*=\s*30\s*;/, "no local 30-block epoch literal");
console.log("  ok");

console.log("(2) equivalence: the epoch numbers are unchanged");
assert.equal(EPOCH_LEN, 30, "the consensus epoch length is 30 blocks");
const TIP = 65_437;
globalThis.fetch = async (url) => {
  if (String(url).endsWith("/tip")) return { ok: true, status: 200, json: async () => ({ height: TIP }) };
  return { ok: false, status: 404, json: async () => ({}) };
};
const w = new Wallet(memoryStore());
await w.create("correct horse battery staple");
assert.equal(await w.epoch(), Math.floor(TIP / 30), "epoch() = floor(tip / 30)");
assert.equal(await w.epoch(), 2181);
console.log("  ok");

console.log("\nepoch-len-vendored: all assertions passed");
