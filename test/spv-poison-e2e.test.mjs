// M1 e2e (Fable M1 QC): the "SPV poison" claim, end to end. A Propose carrying an UNBOUNDED u64
// expires_epoch (2^53+1) is consensus-valid bytes. Pre-M1, a plain JSON.parse of the block body
// rounded the value, the codec's u64() threw on the non-safe-integer, and the whole block's
// txid/merkle bind bricked every scan lane that crossed it. Post-M1 the wallet's SPV reads parse
// through parseSpvJson (the source-preserving reviver), the txid recompute is EXACT, the bind
// holds, and the poison record reaches resolve() as a consensus no-op.
//
// Legs: (3) the reviver path binds exactly; (4) RED-FIRST control — the plain-parse path throws;
// (5) resolve() denies the record (no state created). Hermetic: real signed tx, synthetic wire text.
//
// Run: node --import tsx test/spv-poison-e2e.test.mjs   (offline)
import { addrFromPriv, signSighash, buildScriptSig, ctxid, vSighash, rpcTxToTx, resolve, TREASURY_ADDR, REG_FEE } from "./_spvrig.ts";
import { offer, V28_HEIGHT } from "../src/vendor/cairnx-spv.js";
import { parseSpvJson } from "../src/core/node.ts";
import { checker } from "./_check.ts";

const { check, done } = checker("spv-poison-e2e");

const priv = "0x" + "77".repeat(32);
const signer = addrFromPriv(priv).toLowerCase();
const POISON = 9007199254740993n; // 2^53 + 1 — an unbounded-u64 expiry (NOT a safe integer)

// 1. Build + sign the poison Propose (the codec's u64 accepts a BigInt — the bytes are valid).
//    The record is an OFFER — the real attack's target class (the fill lane): resolve()'s offer
//    branch is the one that denies "expiresEpoch out of safe-integer range".
const rec = offer({ give: { ticker: "AAA", amount: "10" }, want: { value: "5000000", payto: signer } });
const coreTx = {
  version: 1, locktime: 0,
  inputs: [{ prevTxid: "0x" + "42".repeat(32), vout: 0, scriptSig: "0x" }],
  outputs: [{ value: REG_FEE, scriptPubkey: TREASURY_ADDR }],
  app: { type: "Propose", domain: "cairnx:v1", payloadHash: rec.payloadHash, uri: rec.uri, expiresEpoch: POISON },
};
const { sig64, pub33 } = signSighash(vSighash(coreTx), priv);
coreTx.inputs[0].scriptSig = buildScriptSig(sig64, pub33);
const onChainTxid = ctxid(coreTx);

// 2. Simulate the WIRE: the node serves the block body as JSON TEXT carrying the full u64 decimal.
//    (JSON.stringify can't emit a BigInt literal, so route through a sentinel and unwrap to the raw
//    decimal — exactly what the node's serializer emits for a u64.)
const nodeJsonTx = {
  version: 1, locktime: 0,
  inputs: [{ prev_txid: "0x" + "42".repeat(32), vout: 0, script_sig: coreTx.inputs[0].scriptSig }],
  outputs: [{ value: REG_FEE, script_pubkey: TREASURY_ADDR }],
  app: { type: "Propose", domain: "cairnx:v1", payload_hash: rec.payloadHash, uri: rec.uri, expires_epoch: POISON },
};
const wire = JSON.stringify({ txs: [nodeJsonTx] }, (k, v) => typeof v === "bigint" ? `@@BIG:${v}` : v).replace(/"@@BIG:(-?\d+)"/g, "$1");

// 3. THE FIX: the reviver path preserves the exact value → txid recompute matches on-chain → bind holds.
const parsed = parseSpvJson(wire);
check("the reviver preserves the poison expiry as an exact BigInt", parsed.txs[0].app.expires_epoch === POISON);
check("the poison tx's txid recomputes EXACTLY (the block's merkle bind holds)", ctxid(rpcTxToTx(parsed.txs[0])) === onChainTxid);

// 4. RED-FIRST control: a plain JSON.parse rounds the value → the codec u64 throws → the bind bricks.
let bricked = false;
try { ctxid(rpcTxToTx(JSON.parse(wire).txs[0])); } catch { bricked = true; }
check("RED control: plain parse rounds → u64 throws (the pre-M1 brick)", bricked);

// 5. The record reaches resolve() as a CONSENSUS NO-OP: toChainEvent's Number(...) conversion yields
//    the rounded non-safe-integer, which resolve()'s offer branch denies ("expiresEpoch out of
//    safe-integer range") — the offer is never created.
const ev = { kind: "propose", id: onChainTxid.toLowerCase(), proposer: signer, uri: rec.uri, payloadHash: String(rec.payloadHash).toLowerCase(), expiresEpoch: Number(parsed.txs[0].app.expires_epoch), height: V28_HEIGHT, pos: 0, paidTo: {} };
const st = resolve([ev], V28_HEIGHT + 100);
check("resolve() denies the poison record — the offer is never created (consensus no-op)", st.offers[onChainTxid.toLowerCase()] === undefined);

done();
