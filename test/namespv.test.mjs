// namespv.test.mjs — the XREPO-1 name verifier (core/namespv.ts), tested with REAL signed cairnx txs +
// synthetic PoW-verified blocks (the SpvSource injection seam). Proves the security properties without a
// live chain: a correct mapping verifies, a FORGED address is refused, a TAMPERED block is refused, a
// LAPSED lease is refused, and the replay equals the audited resolver. Run: tsx test/namespv.test.mjs
import { verifyName } from "../src/core/namespv.ts";
import { buildNameClaim, buildNameSet, buildNameXfer, TREASURY_ADDR } from "../src/core/cairnx.ts";
import { signSighash, buildScriptSig, addrFromPriv } from "../src/core/csdtx.ts";
import { txid as ctxid, sighash as vSighash, merkleRoot, rpcTxToTx, resolve } from "../src/vendor/cairnx-spv.js";

let pass = 0, fail = 0;
const ok = (n, c) => { c ? pass++ : fail++; console.log(`  ${c ? "✓" : "✗"} ${n}`); };

const CAIRNX_DOMAIN = "cairnx:v1";
const REG_FEE = 1000_000_000;                 // 10 CSD — generously above any nameRegFee (overpay is accepted)
const keyA = "0x" + "11".repeat(32), keyB = "0x" + "22".repeat(32);
const A = addrFromPriv(keyA).toLowerCase(), B = addrFromPriv(keyB).toLowerCase();
const TARGET = "0x" + "cd".repeat(20), ATTACKER = "0x" + "ee".repeat(20);

// Build a SIGNED Propose tx in node-JSON (RpcTxJson) shape — exactly what SpvSource.blockAt returns.
function proposeTx({ uri, payloadHash, expiresEpoch = 9_999_999, priv, outputs = [] }) {
  // codec Tx (camel) — one dummy input (its prevout is irrelevant to name replay), app + fee outputs
  const tx = {
    version: 1, locktime: 0,
    inputs: [{ prevTxid: "0x" + "00".repeat(32), vout: 0, scriptSig: "0x" }],
    outputs: outputs.map((o) => ({ value: o.value, scriptPubkey: o.to })),
    app: { type: "Propose", domain: CAIRNX_DOMAIN, payloadHash, uri, expiresEpoch },
  };
  const { sig64, pub33 } = signSighash(vSighash(tx), priv);   // sign the VENDORED sighash → verifyDigest accepts
  tx.inputs[0].scriptSig = buildScriptSig(sig64, pub33);
  // → RpcTxJson (snake_case), the shape the node/block endpoint serves
  return {
    version: 1, locktime: 0,
    inputs: [{ prev_txid: "0x" + "00".repeat(32), vout: 0, script_sig: tx.inputs[0].scriptSig }],
    outputs: outputs.map((o) => ({ value: o.value, script_pubkey: o.to })),
    app: { type: "Propose", domain: CAIRNX_DOMAIN, payload_hash: payloadHash, uri, expires_epoch: expiresEpoch },
  };
}
const feeOut = (v = REG_FEE) => [{ to: TREASURY_ADDR, value: v }];

// A synthetic SpvSource: blocks keyed by height, each merkle root computed over its txs (so the verifier's
// merkle-bind genuinely passes), tip fixed. `tamperMerkle` flips one block's root to simulate a lying node.
function source(blocks, tip, tamperMerkle = null) {
  return {
    async prepare() { return { verifiedTip: tip, nodeTip: tip }; },
    async blockAt(height) {
      const txs = blocks.get(height);
      if (!txs) throw new Error(`no verified header at ${height}`);
      let merkle = merkleRoot(txs.map((t) => ctxid(rpcTxToTx(t))));
      if (tamperMerkle === height) merkle = "0x" + "ff".repeat(32);
      return { merkle, txs };
    },
  };
}
// place txs into blocks at given heights, return {blocks, hints} (hints = txid+height+pos per placed tx)
function world(placements) {
  const blocks = new Map(), hints = [];
  for (const { height, tx } of placements) {
    const arr = blocks.get(height) ?? blocks.set(height, []).get(height);
    const pos = arr.length; arr.push(tx);
    hints.push({ txid: ctxid(rpcTxToTx(tx)), height, pos });
  }
  return { blocks, hints };
}

const NAME = "alice";
const claimTx = proposeTx({ ...pick(buildNameClaim({ name: NAME })), priv: keyA, outputs: feeOut() });
const nsetTx = proposeTx({ ...pick(buildNameSet({ name: NAME, addr: TARGET })), priv: keyA });
function pick(b) { return { uri: b.uri, payloadHash: b.payloadHash }; }

console.log("XREPO-1 name verifier (real signed txs + synthetic PoW-verified blocks):");

// 1. HAPPY PATH — A registers alice, sets addr=TARGET; resolver claims TARGET ⇒ verified
{
  const { blocks, hints } = world([{ height: 33700, tx: claimTx }, { height: 33710, tx: nsetTx }]);
  const r = await verifyName(NAME, { addr: TARGET, owner: A, via: "nset" }, hints, source(blocks, 33800));
  ok("correct mapping verifies", r.verified === true && r.addr === TARGET && r.owner === A && r.via === "nset");
  ok("reports a sane confirmation depth", typeof r.depth === "number" && r.depth >= 90);
  ok('scope is the honest "as-shown" label', r.scope === "as-shown");
}

// 2. FORGED ADDRESS — resolver claims ATTACKER but the chain says TARGET ⇒ REFUSED
{
  const { blocks, hints } = world([{ height: 33700, tx: claimTx }, { height: 33710, tx: nsetTx }]);
  const r = await verifyName(NAME, { addr: ATTACKER, owner: A }, hints, source(blocks, 33800));
  ok("forged resolver address is REFUSED (not silently sent)", r.verified === false && /does NOT match|hostile/i.test(r.reason));
}

// 3. TAMPERED BLOCK — node serves a tx-set that doesn't hash to the (claimed) verified merkle root ⇒ REFUSED
{
  const { blocks, hints } = world([{ height: 33700, tx: claimTx }, { height: 33710, tx: nsetTx }]);
  const r = await verifyName(NAME, { addr: TARGET, owner: A }, hints, source(blocks, 33800, 33710));
  ok("tampered block (merkle mismatch) is REFUSED", r.verified === false && /merkle/i.test(r.reason));
}

// 4. WITHHELD/MISSING record — a hint points at a block that doesn't contain it ⇒ REFUSED (fail-closed)
{
  const { blocks } = world([{ height: 33700, tx: claimTx }]);
  const bogus = [{ txid: "0x" + "ab".repeat(32), height: 33700, pos: 9 }];
  const r = await verifyName(NAME, { addr: TARGET, owner: A }, bogus, source(blocks, 33800));
  ok("a hint not present in the verified block is REFUSED", r.verified === false && /not in verified block/i.test(r.reason));
}

// 5. NAME TRANSFERRED — A registers, transfers to B, B sets addr; resolver claims B's addr ⇒ verified to B
{
  const xferTx = proposeTx({ ...pick(buildNameXfer({ name: NAME, to: B })), priv: keyA });
  const nsetB = proposeTx({ ...pick(buildNameSet({ name: NAME, addr: TARGET })), priv: keyB });
  const { blocks, hints } = world([
    { height: 33700, tx: claimTx }, { height: 33710, tx: xferTx }, { height: 33720, tx: nsetB },
  ]);
  const r = await verifyName(NAME, { addr: TARGET, owner: B }, hints, source(blocks, 33800));
  ok("after transfer, ownership verifies to the NEW owner", r.verified === true && r.owner === B && r.addr === TARGET);
  // and the OLD owner can't be claimed
  const r2 = await verifyName(NAME, { addr: TARGET, owner: A }, hints, source(blocks, 33800));
  // owner mismatch doesn't change addr (addr is what we send to); but if a server claimed a STALE addr it'd fail:
  const staleAddr = "0x" + "99".repeat(20);
  const r3 = await verifyName(NAME, { addr: staleAddr, owner: A }, hints, source(blocks, 33800));
  ok("a stale/forged addr after transfer is REFUSED", r3.verified === false);
}

// 6. UNAUTHENTICATED signer — corrupt the scriptSig so the signature can't authenticate ⇒ REFUSED
{
  const badTx = JSON.parse(JSON.stringify(claimTx));
  badTx.inputs[0].script_sig = "0x40" + "00".repeat(64) + "21" + "00".repeat(33); // well-formed shape, invalid sig
  const { blocks, hints } = world([{ height: 33700, tx: badTx }]);
  const r = await verifyName(NAME, { addr: TARGET, owner: A }, hints, source(blocks, 33800));
  ok("a record with an unverifiable signature is REFUSED", r.verified === false);
}

// 7. REPLAY EQUIVALENCE — the verifier's resolve() over reconstructed events equals a direct resolve()
{
  const events = [claimTx, nsetTx].map((t, i) => {
    const tx = rpcTxToTx(t);
    return { kind: "propose", id: ctxid(tx).toLowerCase(), proposer: A, uri: tx.app.uri, payloadHash: String(tx.app.payloadHash).toLowerCase(), expiresEpoch: Number(tx.app.expiresEpoch), height: 33700 + i * 10, pos: 0, paidTo: i === 0 ? { [TREASURY_ADDR]: String(REG_FEE) } : {} };
  });
  const direct = resolve(events, 33800).names[NAME];
  ok("direct resolve() establishes the name (sanity for the oracle)", direct && direct.owner === A && direct.addr === TARGET);
}

// 8. LAPSED lease claim from the resolver ⇒ REFUSED before any SPV work
{
  const r = await verifyName(NAME, { addr: TARGET, owner: A, lapsed: true }, [{ txid: "0x" + "aa".repeat(32), height: 33700, pos: 0 }], source(new Map(), 33800));
  ok("a resolver-reported lapsed lease is REFUSED up front", r.verified === false && /lapsed/i.test(r.reason));
}

console.log(`\nnamespv: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
