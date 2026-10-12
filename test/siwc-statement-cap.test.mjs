// SIWC `statement` is capped at 256 characters, like requestId and each resources entry.
//
// The statement is signed into the credential and shown in the approval window; with no cap a dApp could
// push the signed resources and requestId lines below the fold of the approval card. It is refused, not
// truncated, because truncating only the signed copy would break what-you-see-is-what-you-sign.
//   RED-FIRST: delete the `statement.length > 256` check in signInWithCsd and (1) fails (a 257-character
//   statement is signed).
//   PAIRED HONEST PATH: (2) background resolvePending calls signInWithCsd(p.params, p.origin); with that
//   shape a 256-character statement, a typical short one, and no statement all sign and verify.
//
// Run: node --import tsx test/siwc-statement-cap.test.mjs   (offline)
import assert from "node:assert/strict";
import { Wallet } from "../src/core/wallet.js";
import { memoryStore } from "../src/core/storage.js";
import { siwcDigest } from "../src/core/siwc.js";
import { verifySig } from "../src/core/csdtx.js";

const ORIGIN = "https://casino.example";
const NONCE = "abc123def456";
const w = new Wallet(memoryStore());
await w.create("correct horse battery staple");

console.log("(1) a statement over 256 characters is refused");
await assert.rejects(w.signInWithCsd({ nonce: NONCE, statement: "x".repeat(257) }, ORIGIN), /sign-in: statement exceeds 256 chars/);
await assert.rejects(w.signInWithCsd({ nonce: NONCE, statement: "Sign in. " + "y".repeat(5000) }, ORIGIN), /statement exceeds 256 chars/);
console.log("  ok");

console.log("(2) paired: statements up to 256 characters, and none at all, still sign");
for (const statement of ["z".repeat(256), "Sign in to CSD Casino.", undefined]) {
  const r = await w.signInWithCsd({ nonce: NONCE, statement }, ORIGIN);
  assert.ok(verifySig(r.sig64, r.pub33, siwcDigest(r.message)), "the credential verifies");
  if (statement) assert.ok(r.message.includes("\n\n" + statement + "\n\n"), "the full statement is signed, untruncated");
}
console.log("  ok");

console.log("\nsiwc-statement-cap: all assertions passed");
