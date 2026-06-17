// Wallet SIWC tests: (1) the vendored builder/digest are BYTE-IDENTICAL to the canonical
// @inversealtruism/csd-siwc (pinned message + digest computed from that package), (2) sign/verify
// round-trips, (3) the digest is disjoint from the tx sighash + legacy login digest, and
// (4) wallet.signInWithCsd() binds the attested origin and enforces domain/uri/nonce.
import { buildSiwcMessage, siwcDigest, CSD_CHAIN_MAINNET, originToDomain, type SiwcFields } from "../src/core/siwc.js";
import { signSighash, verifySig, loginDigest, serialize, sighash as txSighash, type Tx } from "../src/core/csdtx.js";
import { Wallet } from "../src/core/wallet.js";
import { memoryStore } from "../src/core/storage.js";
import { describe, costLine, debitOf } from "../src/popup/clearsign.js";
import { sha256 } from "@noble/hashes/sha256";
import { utf8ToBytes, bytesToHex, concatBytes } from "@noble/hashes/utils";

declare const process: { exit(code: number): void };
declare const Buffer: any;
let pass = 0, fail = 0;
const check = (n: string, c: boolean) => { c ? (pass++, console.log("  ✅ " + n)) : (fail++, console.log("  ❌ " + n)); };

// ── Pins computed from @inversealtruism/csd-siwc (csd-sdk/packages/siwc) — the lockstep anchor ──
const PIN_CHAIN = "csd:00000052c2821f71b19c3d79dfabfb12";
const PIN_DIGEST = "0x1dfa101e711457832ac2fe576cdfc42fa89585efc84e7e0ebc6b41347d81dbd9";
const PIN_MSG_B64 = "Y2FzaW5vLmV4YW1wbGUgd2FudHMgeW91IHRvIHNpZ24gaW4gd2l0aCB5b3VyIENvbXB1dGUgU3Vic3RyYXRlIGFjY291bnQ6CjB4YWJhYmFiYWJhYmFiYWJhYmFiYWJhYmFiYWJhYmFiYWJhYmFiYWJhYgoKU2lnbiBpbiB0byBDU0QgQ2FzaW5vLgoKVVJJOiBodHRwczovL2Nhc2luby5leGFtcGxlL2xvZ2luClZlcnNpb246IDEKQ2hhaW4gSUQ6IGNzZDowMDAwMDA1MmMyODIxZjcxYjE5YzNkNzlkZmFiZmIxMgpOb25jZTogYWJjMTIzZGVmNDU2Cklzc3VlZCBBdDogMjAyNi0wNi0xN1QxMjowMDowMFoKRXhwaXJhdGlvbiBUaW1lOiAyMDI2LTA2LTE3VDEyOjEwOjAwWg==";
const PIN_MSG = Buffer.from(PIN_MSG_B64, "base64").toString("utf8");

const PIN_FIELDS: SiwcFields = {
  domain: "casino.example", account: "0x" + "ab".repeat(20), statement: "Sign in to CSD Casino.",
  uri: "https://casino.example/login", version: "1", chainId: CSD_CHAIN_MAINNET,
  nonce: "abc123def456", issuedAt: "2026-06-17T12:00:00Z", expirationTime: "2026-06-17T12:10:00Z",
};

const taggedHash = (tag: string, msg: Uint8Array) => { const t = sha256(utf8ToBytes(tag)); return sha256(concatBytes(t, t, msg)); };
const sha256d = (b: Uint8Array) => sha256(sha256(b));

async function main() {
  console.log("=== lockstep with @inversealtruism/csd-siwc (byte-identical) ===");
  check("CSD_CHAIN_MAINNET matches the canonical package", CSD_CHAIN_MAINNET === PIN_CHAIN);
  check("buildSiwcMessage reproduces the canonical message BYTES", buildSiwcMessage(PIN_FIELDS) === PIN_MSG);
  check("siwcDigest reproduces the canonical DIGEST", siwcDigest(PIN_MSG) === PIN_DIGEST);

  console.log("=== sign / verify + digest domain-separation ===");
  const PRIV = "0x" + "42".repeat(32);
  const { sig64, pub33 } = signSighash(siwcDigest(PIN_MSG), PRIV);
  check("a wallet-signed SIWC digest verifies", verifySig(sig64, pub33, siwcDigest(PIN_MSG)));
  const txStyle = "0x" + bytesToHex(sha256d(taggedHash("CSD_SIG_V1", utf8ToBytes(PIN_MSG))));
  check("SIWC digest != tx-sighash-tag digest over the same bytes", siwcDigest(PIN_MSG) !== txStyle);
  check("SIWC digest != legacy login digest", siwcDigest(PIN_MSG) !== loginDigest(PIN_FIELDS.nonce));
  // a real tx sighash can never collide with the SIWC digest (different tag + bincode preimage)
  const tx: Tx = { version: 1, locktime: 0, app: { type: "None" }, inputs: [{ prevTxid: "0x" + "11".repeat(32), vout: 0, scriptSig: "0x" }], outputs: [{ value: 1, scriptPubkey: "0x" + "cc".repeat(20) }] };
  check("SIWC digest != an actual tx sighash", siwcDigest(PIN_MSG) !== txSighash(tx));
  void serialize;

  console.log("=== wallet.signInWithCsd binds the attested origin ===");
  const w = new Wallet(memoryStore());
  await w.create("correct horse battery staple");
  const addr = (await w.status()).addr!;
  const r = await w.signInWithCsd({ nonce: "abc123def456", statement: "Sign in to CSD Casino." }, "https://casino.example");
  check("returns the active account", r.account === addr);
  check("signature verifies over the returned message digest", verifySig(r.sig64, r.pub33, siwcDigest(r.message)));
  check("message binds the requesting site's domain (from origin)", r.message.startsWith("casino.example wants you to sign in with your Compute Substrate account:\n"));
  check("message carries the server nonce + mainnet chain id", r.message.includes("\nNonce: abc123def456\n") && r.message.includes("\nChain ID: " + PIN_CHAIN + "\n"));
  check("default uri is the origin root", r.message.includes("\nURI: https://casino.example/\n"));

  console.log("=== signInWithCsd fail-closed enforcement ===");
  const rejects = async (fn: () => Promise<unknown>) => { try { await fn(); return false; } catch { return true; } };
  check("declared domain != real origin → refused", await rejects(() => w.signInWithCsd({ nonce: "abc123def456", domain: "bank.example" }, "https://casino.example")));
  check("uri on a different host → refused", await rejects(() => w.signInWithCsd({ nonce: "abc123def456", uri: "https://evil.example/x" }, "https://casino.example")));
  check("too-short / missing nonce → refused", await rejects(() => w.signInWithCsd({ nonce: "short" }, "https://casino.example")) && await rejects(() => w.signInWithCsd({}, "https://casino.example")));
  check("unknown/opaque origin → refused", await rejects(() => w.signInWithCsd({ nonce: "abc123def456" }, "unknown")));
  check("originToDomain extracts host[:port] and rejects junk", originToDomain("https://casino.example:8443") === "casino.example:8443" && originToDomain("unknown") === null);

  console.log("=== clear-sign rendering (the audience is shown, no funds move) ===");
  const req = { method: "signinWithCsd", origin: "https://casino.example", params: { nonce: "abc123def456", statement: "Sign in to CSD Casino.", expirationSecs: 600 } };
  const desc = describe(req);
  check("describe shows the audience site", desc.includes("Sign in to") && desc.includes("casino.example"));
  check("describe states no funds move", desc.includes("No transaction, no funds move"));
  check("describe surfaces the statement", desc.includes("Sign in to CSD Casino."));
  check("debitOf is 0 for signinWithCsd", debitOf(req) === 0);
  check("costLine says no funds move", /no funds move/i.test(costLine(req)));
  check("describe RED-WARNS on a declared-domain mismatch", describe({ method: "signinWithCsd", origin: "https://casino.example", params: { nonce: "abc123def456", domain: "bank.example" } }).includes("will be refused"));

  console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
main();
