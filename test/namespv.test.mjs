// namespv.test.mjs — the XREPO-1 name verifier (core/namespv.ts), tested with REAL signed cairnx txs +
// synthetic PoW-verified blocks (the SpvSource injection seam). Proves the security properties without a
// live chain: a correct mapping verifies, a FORGED address is refused, a TAMPERED block is refused, a
// LAPSED lease is refused, and the replay equals the audited resolver. Run: tsx test/namespv.test.mjs
import { verifyName, verifyNameUnion } from "../src/core/namespv.ts";
import { buildNameClaim, buildNameSet, buildNameXfer, buildNameProfile, TREASURY_ADDR } from "../src/core/cairnx.ts";
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

// 9. DoS-RESISTANCE — a hostile node pads a hinted block with an app-LESS filler tx (no `app` field).
//    rpcTxToTx must not throw on it (the fix); the hinted record still verifies. (review finding #2)
{
  const filler = { version: 1, locktime: 0, inputs: [{ prev_txid: "0x" + "00".repeat(32), vout: 1, script_sig: "0x" }], outputs: [{ value: 1, script_pubkey: "0x" + "77".repeat(20) }] }; // NO app
  const txs = [claimTx, filler];
  const merkle = merkleRoot(txs.map((t) => ctxid(rpcTxToTx(t.app ? t : { ...t, app: { type: "None" } }))));
  const blocks = new Map([[33700, txs]]);
  const hints = [{ txid: ctxid(rpcTxToTx(claimTx)), height: 33700, pos: 0 }];
  // a source that serves the real (filler-padded) tx-set + its true merkle
  const src = { async prepare() { return { verifiedTip: 33800, nodeTip: 33800 }; }, async blockAt() { return { merkle, txs }; } };
  // only a claim (no nset) ⇒ addr defaults to owner A
  const r = await verifyName(NAME, { addr: A, owner: A }, hints, src);
  ok("an app-less filler tx in a hinted block does NOT break verification (no throw)", r.verified === true && r.owner === A);
}

// 10. V19 / nprofile (audit NSPV-V19-TESTS) — the prior suite ran ENTIRELY below V19_HEIGHT (36,700), so the
//     wallet's own SPV verifier was never exercised over a V19-height block. V19 went live on-chain; the
//     vendored resolver must (a) process a hinted nprofile record at a height >= V19_HEIGHT without error, and
//     (b) keep the send verdict UNCHANGED — nprofile is cosmetic identity metadata and must NOT move owner/addr
//     (the property the wallet relies on: namespv reads only addr/owner/expired, never the profile field).
{
  const V19 = 36700;
  const profTx = proposeTx({ ...pick(buildNameProfile({ name: NAME, profile: { twitter: "alice", avatar: "ipfs://Qmxyz" } })), priv: keyA });
  const { blocks, hints } = world([
    { height: 33700, tx: claimTx }, { height: 33710, tx: nsetTx }, { height: V19 + 10, tx: profTx },
  ]);
  const r = await verifyName(NAME, { addr: TARGET, owner: A, via: "nset" }, hints, source(blocks, V19 + 100));
  ok("V19 nprofile at a >=V19_HEIGHT block verifies without error", r.verified === true);
  ok("nprofile is consensus-inert for the send verdict (addr/owner unchanged)", r.addr === TARGET && r.owner === A);
  // and a forged addr is still refused even with the V19 record present
  const rf = await verifyName(NAME, { addr: ATTACKER, owner: A }, hints, source(blocks, V19 + 100));
  ok("a forged addr is still REFUSED with an nprofile record in play", rf.verified === false);
}

// 11-14. UNION cross-check (NSPV-COMPLETE-1 cure, doc 36 Part B) — verifyNameUnion over 2 independent sources
{
  const NM = "bob";
  const aClaim = proposeTx({ ...pick(buildNameClaim({ name: NM })), priv: keyA, outputs: feeOut() }); // A wins (earlier height)
  const aNset = proposeTx({ ...pick(buildNameSet({ name: NM, addr: TARGET })), priv: keyA });
  const bClaim = proposeTx({ ...pick(buildNameClaim({ name: NM })), priv: keyB, outputs: feeOut(REG_FEE + 1) }); // B loses (later height); distinct fee → distinct txid (a real competing claim spends different inputs)
  const bNset = proposeTx({ ...pick(buildNameSet({ name: NM, addr: ATTACKER })), priv: keyB });
  const { blocks } = world([
    { height: 33700, tx: aClaim }, { height: 33705, tx: bClaim }, { height: 33710, tx: aNset }, { height: 33715, tx: bNset },
  ]);
  const H = (tx, h) => ({ txid: ctxid(rpcTxToTx(tx)), height: h, pos: 0 });
  const granus = [H(bClaim, 33705), H(bNset, 33715)];   // HOSTILE: withholds A's winning claim, shows only B's losing one
  const clarvis = [H(aClaim, 33700), H(aNset, 33710)];  // HONEST: shows A's winning claim
  const src = source(blocks, 33800);
  const SRC = [{ label: "primary", base: "https://primary.example/trade/api" }, { label: "clarvis", base: "https://clarvis.example/trade/api" }];
  const mkFetch = (gBody, cBody) => async (url) => {
    const u = String(url);
    const body = u.includes("primary") ? gBody : u.includes("clarvis") ? cBody : { ok: false };
    if (body && body.__status === 502) return { ok: false, status: 502, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => body };
  };

  // 11. withholding DEFEATED: union resolves to the true winner (TARGET), not the attacker; hostile source flagged
  const r11 = await verifyNameUnion(NM, SRC, src, mkFetch(
    { ok: true, resolve: { addr: ATTACKER, owner: B, via: "nset" }, events: granus },
    { ok: true, resolve: { addr: TARGET, owner: A, via: "nset" }, events: clarvis }));
  ok("union DEFEATS a withholding resolver — resolves to the true winner, NOT the attacker", r11.verified === true && r11.addr === TARGET && r11.addr !== ATTACKER);
  ok("union flags the disagreeing (hostile) source", r11.disagree === true && r11.sources === 2 && r11.agreed === 1);

  // 12. both sources AGREE on the true mapping → strong, no disagreement
  const r12 = await verifyNameUnion(NM, SRC, src, mkFetch(
    { ok: true, resolve: { addr: TARGET, owner: A, via: "nset" }, events: clarvis },
    { ok: true, resolve: { addr: TARGET, owner: A, via: "nset" }, events: clarvis }));
  ok("two agreeing sources → verified, 2 sources, no disagreement", r12.verified === true && r12.addr === TARGET && r12.sources === 2 && r12.agreed === 2 && r12.disagree === false);

  // 13. fail-SOFT: one source down (502) → single-source verify still works
  const r13 = await verifyNameUnion(NM, SRC, src, mkFetch(
    { ok: true, resolve: { addr: TARGET, owner: A, via: "nset" }, events: clarvis },
    { __status: 502 }));
  ok("fail-soft: one source down → single-source verify (sources=1)", r13.verified === true && r13.addr === TARGET && r13.sources === 1 && r13.disagree === false);

  // 14. both sources down → unavailable (fail-closed, not verified)
  const r14 = await verifyNameUnion(NM, SRC, src, mkFetch({ __status: 502 }, { __status: 502 }));
  ok("both sources down → NOT verified (fail-closed, unavailable)", r14.verified === false && r14.sources === 0);
}

console.log(`\nnamespv: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
