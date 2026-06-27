// NAME-2 PoC — attack the clarvis UNION (verifyNameUnion). Reuses real signed txs + synthetic PoW blocks.
import { verifyNameUnion } from "../src/core/namespv.ts";
import { buildNameClaim, buildNameSet, TREASURY_ADDR } from "../src/core/cairnx.ts";
import { signSighash, buildScriptSig, addrFromPriv } from "../src/core/csdtx.ts";
import { txid as ctxid, sighash as vSighash, merkleRoot, rpcTxToTx } from "../src/vendor/cairnx-spv.js";

const CAIRNX_DOMAIN = "cairnx:v1";
const REG_FEE = 1000_000_000;
const keyA = "0x"+"11".repeat(32), keyEvil = "0x"+"77".repeat(32);
const A = addrFromPriv(keyA).toLowerCase(), EVIL = addrFromPriv(keyEvil).toLowerCase();
const TARGET = "0x"+"cd".repeat(20);          // honest winner addr
const ATTACKER = "0x"+"ee".repeat(20);        // attacker payout addr
const PREVOUTS = new Map(); let seq=0;
function pick(b){return {uri:b.uri,payloadHash:b.payloadHash};}
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
// fake fetch returning a name-history JSON per-base
function mkFetch(byBase){return async(url)=>{const base=Object.keys(byBase).find(b=>String(url).startsWith(b));const spec=base?byBase[base]:undefined;
  if(!spec) return {status:0,ok:false,async json(){return{}}};
  if(spec==="throw") throw new Error("network blocked (CSP / MITM drop)");
  if(spec.status&&spec.status!==200) return {status:spec.status,ok:false,async json(){return{ok:false,error:String(spec.status)};}};
  return {status:200,ok:true,async json(){return spec;}};};}

// === World: ATTACKER actually registered+nset `alice`→ATTACKER on-chain (real, signed, mined, fee-paid).
//     (In the real misroute the honest WINNING claim is also on-chain but WITHHELD by the apex.)
const NAME="alice";
const evilClaim=proposeTx({...pick(buildNameClaim({name:NAME})),priv:keyEvil,outputs:feeOut()});
const evilNset=proposeTx({...pick(buildNameSet({name:NAME,addr:ATTACKER})),priv:keyEvil});
const {blocks,hints}=world([{height:33700,tx:evilClaim},{height:33710,tx:evilNset}]);
const evilHistory={ok:true,events:hints,resolve:{addr:ATTACKER,owner:EVIL,via:"nset"},scopedReplaySufficient:true};
const PRIM="https://cairn-substrate.com/trade/api";
const CLAR="https://clarvis.cairn-substrate.com/trade/api";
const sources=[{label:"primary",base:PRIM},{label:"clarvis",base:CLAR}];

console.log("NAME-2 union attacks (verifyNameUnion against REAL signed records):\n");

// SCENARIO C — apex serves the SAME (real, signed, fee-paid but possibly LOSING/incomplete) records from
// BOTH hostnames. One apex/CDN/operator forges "2 independent sources".
{
  const r=await verifyNameUnion(NAME,sources,source(blocks,33800),mkFetch({[PRIM]:evilHistory,[CLAR]:evilHistory}));
  console.log("[C] both sources show identical apex-served records:");
  console.log("    verified=%s addr=%s sources=%s agreed=%s disagree=%s",r.verified,r.addr,r.sources,r.agreed,r.disagree);
  console.log("    -> badge: %s\n", r.verified&&r.sources>=2&&!r.disagree ? 'STRONG "2 name servers agree" (post-fix: no longer claims independence)' : 'caution');
}

// SCENARIO B — clarvis (the 2nd source) is COMPROMISED and poisons the union with ONE bogus hint
// (height above tip). Primary is honest. Whole verification fails closed: a 2nd-source compromise alone
// VETOes verification of any name -> downgrade to "unverified, confirm address yourself".
{
  const poison={ok:true,events:[...hints,{txid:"0x"+"ab".repeat(32),height:999999,pos:0,kind:"name"}],resolve:{addr:ATTACKER,owner:EVIL,via:"nset"}};
  const r=await verifyNameUnion(NAME,sources,source(blocks,33800),mkFetch({[PRIM]:evilHistory,[CLAR]:poison}));
  console.log("[B] clarvis injects one bogus hint (height 999999):");
  console.log("    verified=%s reason=%j sources=%s",r.verified,r.reason,r.sources);
  console.log("    -> 2nd-source compromise alone STRIPS the green badge (DoS downgrade)\n");
}

// SCENARIO A — clarvis blocked at network layer (distinct SNI clarvis.cairn-substrate.com). fetch throws.
// Union silently degrades to single-source verified (caution badge), without compromising clarvis at all.
{
  const r=await verifyNameUnion(NAME,sources,source(blocks,33800),mkFetch({[PRIM]:evilHistory,[CLAR]:"throw"}));
  console.log("[A] clarvis network-blocked (CSP/MITM drop), primary only:");
  console.log("    verified=%s addr=%s sources=%s -> single-source caution\n",r.verified,r.addr,r.sources);
}

// SCENARIO D — user (or a setApi attacker) points tradeApi at clarvis base: de-dup collapses union to 1.
{
  const r=await verifyNameUnion(NAME,[{label:"primary",base:CLAR},{label:"clarvis",base:CLAR}],source(blocks,33800),mkFetch({[CLAR]:evilHistory}));
  console.log("[D] both sources same base (de-dup): sources=%s (silent collapse to one)\n",r.sources);
}
