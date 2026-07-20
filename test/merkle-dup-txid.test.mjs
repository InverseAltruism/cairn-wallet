// M7 / F11 (B5e, REBIND, CVE-2012-2459): a block-body merkle bind must reject a DUPLICATED txid.
//
// merkleRoot self-pairs an odd final row, so merkleRoot([a,b,c]) == merkleRoot([a,b,c,c]). An honest
// 3-tx block commits root R; a hostile read path can serve the 4-tx body [a,b,c,c], which hashes to the
// SAME R and so passes a naive root compare while smuggling a duplicated tx into the verified set. A real
// block can never contain a duplicate txid. Both wallet merkle binds - fillspv.ts bindBlock (M7) and
// namespv.ts replayName's inline bind (F11, the second site) - now reject `new Set(ids).size !== ids.length`
// BEFORE the root compare.
//
// This test proves (1) the CVE precondition is real (the malleated 4-tx root == the honest 3-tx root),
// and (2) the dedup is the SOLE rejecter (an honest control passes; removing the guard makes the malleated
// body pass the root compare).
//
// MUTATION CONTRACT: deleting either `new Set(ids)...` line makes its malleated case pass (no throw / ok).
//
// Run: node --import tsx test/merkle-dup-txid.test.mjs   (offline)
import { provenOfferPayto } from "../src/core/fillspv.ts";
import { verifyName } from "../src/core/namespv.ts";
import { buildNameClaim, buildNameSet } from "../src/core/cairnx.ts";
import { proposeTx, addrFromPriv, world, source, pick, merkleRoot, ctxid, rpcTxToTx, feeOut, prevoutFor } from "./_spvrig.ts";
import { offer } from "../src/vendor/cairnx-spv.js";

let pass = 0, fail = 0;
const check = (n, c) => { c ? (pass++, console.log("  ✓ " + n)) : (fail++, console.error("  ✗ " + n)); };

// Wrap any honest SpvSource so that blockAt(target) DUPLICATES the last tx while returning the HONEST
// (pre-duplication) merkle root - the faithful CVE-2012-2459 relay: the PoW header commits the honest
// root R, and the served 4-tx body [.,.,c,c] also hashes to R.
function malleateLastTx(src, target) {
  return {
    prepare: (...a) => src.prepare(...a),
    prevoutScriptPubkey: (...a) => src.prevoutScriptPubkey(...a),
    async blockAt(height) {
      const b = await src.blockAt(height);
      if (height !== target) return b;
      const honestMerkle = b.merkle;                       // root over the honest (un-duplicated) tx list
      const txs = [...b.txs, b.txs[b.txs.length - 1]];      // duplicate the last tx
      return { merkle: honestMerkle, txs };
    },
  };
}

console.log("M7/F11 (B5e) - CVE-2012-2459 duplicate-txid rejection:");

// ── the CVE precondition, proven arithmetically (so the test can't silently prove nothing) ──────────
{
  const ids = ["0x" + "11".repeat(32), "0x" + "22".repeat(32), "0x" + "33".repeat(32)];
  const dup = [...ids, ids[ids.length - 1]];
  check("CVE precondition: merkleRoot([a,b,c]) == merkleRoot([a,b,c,c])", merkleRoot(ids) === merkleRoot(dup));
}

// ── F11: the namespv (name-verify) merkle bind ──────────────────────────────────────────────────────
{
  const keyA = "0x" + "11".repeat(32);
  const A = addrFromPriv(keyA).toLowerCase();
  const TARGET = "0x" + "cd".repeat(20);
  const NAME = "alice";
  // Put THREE txs in the record's block so the honest set is odd (the self-pairing case the CVE needs).
  const claimTx = proposeTx({ ...pick(buildNameClaim({ name: NAME })), priv: keyA, outputs: feeOut() });
  const nsetTx = proposeTx({ ...pick(buildNameSet({ name: NAME, addr: TARGET })), priv: keyA });
  const fillerTx = proposeTx({ ...pick(buildNameSet({ name: "bob", addr: TARGET })), priv: keyA });
  const { blocks, hints } = world([{ height: 33700, tx: claimTx }, { height: 33700, tx: nsetTx }, { height: 33700, tx: fillerTx }]);
  const CLAIM = { addr: TARGET, owner: A, via: "nset" };
  const honestSrc = source(blocks, 33_722, { verifiedTip: 33_722, nodeTip: 33_722 });

  const okr = await verifyName(NAME, CLAIM, hints, honestSrc);
  check(`F11 control: honest 3-tx block verifies (${okr.reason ?? "verified"})`, okr.verified === true);

  const malSrc = malleateLastTx(honestSrc, 33700);
  const badr = await verifyName(NAME, CLAIM, hints, malSrc);
  check(`F11: a duplicated-txid block is REFUSED (${badr.reason ?? "?"})`, badr.verified === false && /duplicate txid|CVE-2012-2459/i.test(badr.reason || ""));
}

// ── M7: the fillspv (offer-payment) merkle bind, via the exported provenOfferPayto ──────────────────
{
  const sellerKey = "0x" + "5e".repeat(32);
  const seller = addrFromPriv(sellerKey).toLowerCase();
  const offTx = proposeTx({ ...pick(offer({ give: { ticker: "AAA", amount: "10" }, want: { value: "5000000", payto: seller } })), priv: sellerKey, expiresEpoch: 9e9 });
  // filler txs so the offer's block is odd (3 txs) - the self-pairing case.
  const f1 = proposeTx({ ...pick(offer({ give: { ticker: "BBB", amount: "1" }, want: { value: "1", payto: seller } })), priv: sellerKey, expiresEpoch: 9e9 });
  const f2 = proposeTx({ ...pick(offer({ give: { ticker: "CCC", amount: "1" }, want: { value: "1", payto: seller } })), priv: sellerKey, expiresEpoch: 9e9 });
  const OID = ctxid(rpcTxToTx(offTx)).toLowerCase();
  const H = 47_000;
  const blocks = new Map([[H, [offTx, f1, f2]]]);
  const honestSrc = {
    async prepare() { return { verifiedTip: H + 10, nodeTip: H + 10 }; },
    async blockAt(height) { const txs = blocks.get(height); return { merkle: merkleRoot(txs.map((t) => ctxid(rpcTxToTx(t.app ? t : { ...t, app: { type: "None" } })))), txs }; },
    async prevoutScriptPubkey(prevTxid) { return prevoutFor(prevTxid); },
  };

  const okp = await provenOfferPayto({ rpcBase: "http://x", headersBase: "http://x", spvSource: honestSrc, offerId: OID, offerHeight: H });
  check(`M7 control: honest offer block proves the payto (${okp?.seller ?? "null"})`, okp !== null && okp.seller === seller && okp.payto === seller);

  const malp = await provenOfferPayto({ rpcBase: "http://x", headersBase: "http://x", spvSource: malleateLastTx(honestSrc, H), offerId: OID, offerHeight: H });
  check("M7: a duplicated-txid offer block fails CLOSED (null - bindBlock threw on the dup, caught)", malp === null);
}

console.log(`\nmerkle-dup-txid: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
