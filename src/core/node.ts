// Talks to a CSD node (reads + non-custodial submit) and the Cairn API (sign-in).
// Browser fetch. The non-custodial flow: coin-select → node /tx/template → sign the
// signing_hash LOCALLY → set script_sig → node /tx/submit. The private key only ever
// lives in the wallet; nothing here sends it anywhere.
import { signSighash, buildScriptSig, addrFromPriv, sighash as codecSighash, txid as codecTxid, loginDigest, bytesArr, type App, type Tx } from "./csdtx.js";

const strip = (h: string) => (h.startsWith("0x") ? h.slice(2) : h);

async function get(rpc: string, path: string): Promise<any> {
  const r = await fetch(`${rpc}${path}`); if (!r.ok) throw new Error(`${path} -> ${r.status}`); return r.json();
}
// Symmetric with get(): a POST must NEVER throw out of the caller after a tx is already signed —
// otherwise a non-JSON 4xx/5xx (e.g. an HTML error page from a proxy) on /tx/submit would surface as an
// uncaught rejection AFTER signing, leaving send/sendMany/fillOffer/propose with an ambiguous outcome
// (audit VAL-2). Read the body as text, parse if we can, and return a structured {ok:false,err} on any
// non-2xx / network error / unparseable body. Every caller already reads {ok,txid,err}, so a 2xx JSON
// body is returned unchanged — this only converts the failure path from "throw" to "fail-closed value".
async function post(rpc: string, path: string, body: unknown): Promise<any> {
  let r: Response;
  try { r = await fetch(`${rpc}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); }
  catch { return { ok: false, err: `${path} -> network error` }; }
  // Symmetric with get(): never let a non-JSON 4xx/5xx (e.g. an HTML proxy error page) throw out of a
  // caller AFTER a tx is already signed — parse defensively and return a structured {ok:false,err} on any
  // non-2xx or unparseable body (audit VAL-2). A 2xx JSON body is returned unchanged; every caller reads
  // {ok,txid,err}, so this only converts the failure path from "throw" to a fail-closed value.
  let j: any;
  try { j = await r.json(); } catch { j = undefined; }
  if (!r.ok) return { ok: false, err: (j && (j.err ?? j.error)) || `${path} -> ${r.status}` };
  if (j === undefined) return { ok: false, err: `${path} -> non-JSON response` };
  return j;
}

export async function tip(rpc: string): Promise<number> { return Number((await get(rpc, "/tip")).height ?? 0); }
export async function getProposal(rpc: string, txid: string): Promise<any | null> {
  try { const j = await get(rpc, `/proposal/${txid}`); return j?.proposal ?? (j?.payload_hash ? j : null); } catch { return null; }
}
export async function balance(rpc: string, addr: string): Promise<{ confirmed: number; utxos: any[] }> {
  const j = await get(rpc, `/utxos/${addr}?available=true`);
  return { confirmed: Number(j.confirmed_balance ?? 0), utxos: j.utxos ?? [] };
}

function appToJson(app: App): unknown {
  if (app.type === "None") return "None";
  if (app.type === "Propose") return { Propose: { domain: app.domain, payload_hash: bytesArr(app.payloadHash), uri: app.uri, expires_epoch: Number(app.expiresEpoch) } };
  return { Attest: { proposal_id: bytesArr(app.proposalId), score: app.score, confidence: app.confidence } };
}
function txToNodeJson(tx: Tx): any {
  return {
    version: tx.version, locktime: tx.locktime, app: appToJson(tx.app),
    inputs: tx.inputs.map((i) => ({ prevout: { txid: bytesArr(i.prevTxid), vout: i.vout }, script_sig: bytesArr(i.scriptSig) })),
    outputs: tx.outputs.map((o) => ({ value: Number(o.value), script_pubkey: bytesArr(o.scriptPubkey) })),
  };
}

// Map a node-JSON tx body (from /tx or /block) back into our codec Tx so we can recompute its txid.
function nodeTxToTx(j: any): Tx {
  const a = j.app || {};
  const app: App = a.type === "Propose"
    ? { type: "Propose", domain: a.domain, payloadHash: a.payload_hash, uri: a.uri, expiresEpoch: a.expires_epoch }
    : a.type === "Attest"
      ? { type: "Attest", proposalId: a.proposal_id, score: a.score, confidence: a.confidence }
      : { type: "None" };
  return {
    version: j.version, locktime: j.locktime, app,
    inputs: (j.inputs || []).map((i: any) => ({ prevTxid: i.prev_txid, vout: i.vout, scriptSig: i.script_sig })),
    outputs: (j.outputs || []).map((o: any) => ({ value: o.value, scriptPubkey: o.script_pubkey })),
  };
}

// Confirm the REAL on-chain value of each selected input by fetching its source tx and
// RECOMPUTING its txid with our consensus-exact codec. A CSD fee is implicit (Σin − Σout,
// uncapped by consensus), so if the wallet trusted a hostile /utxos `value` it could compute
// too-small a change and silently burn the difference as fee (audit TXB-1). The source tx's
// txid commits to its output values, so a hostile RPC cannot serve a fake body whose recomputed
// txid still matches the prevout — any tamper is detected and the send is refused (fail-closed).
async function verifyInputValues(rpc: string, inputs: { txid: string; vout: number }[]): Promise<{ ok: boolean; total: number }> {
  // Each input is verified INDEPENDENTLY (fetch its source tx, recompute the consensus txid, require it to
  // match the prevout, then read the committed output value), so the per-input `/tx` fetches run in PARALLEL
  // — an N-input send is one round-trip's latency, not N sequential ones (matters for a wallet whose UTXO set
  // got fragmented into many small coins). The browser's per-host connection cap bounds concurrency; the input
  // set is already capped at MAX_TX_INPUTS. Verification + fail-closed semantics are UNCHANGED: a per-input
  // checker returns the verified value or `null`, and ANY null (unfetchable / forged body / txid mismatch /
  // missing or out-of-range output) makes the whole call fail closed — never a partial trust (audit TXB-1).
  const verifyOne = async (i: { txid: string; vout: number }): Promise<number | null> => {
    let body: any;
    try { body = (await get(rpc, `/tx/${i.txid}`))?.tx; } catch { return null; }
    if (!body) return null;
    let tx: Tx, recomputed: string;
    // robustness nit (audit D): codecTxid itself can throw on a malformed body, so decode AND
    // recompute inside one try — any failure is a fail-closed reject, never an uncaught throw.
    try { tx = nodeTxToTx(body); recomputed = codecTxid(tx); } catch { return null; }
    if (recomputed.toLowerCase() !== String(i.txid).toLowerCase()) return null; // forged source body
    const out = tx.outputs[i.vout];
    if (!out) return null;
    const v = Number(out.value);
    if (!Number.isFinite(v) || v <= 0 || !Number.isSafeInteger(v)) return null;
    return v;
  };
  const values = await Promise.all(inputs.map(verifyOne));
  // Fold the verified values in input order: any failed input fails the whole call closed, and the running
  // sum must stay in the safe-integer range so a hostile RPC can't push it past 2^53 (parity with the prior
  // sequential checks — addition is commutative, so the parallel fetch doesn't change the result).
  let total = 0;
  for (const v of values) {
    if (v === null) return { ok: false, total: 0 };
    total += v;
    if (!Number.isSafeInteger(total)) return { ok: false, total: 0 };
  }
  return { ok: true, total };
}

// Outpoints RESERVED by a deferred (signed-but-not-yet-broadcast) tx — excluded from every coin
// selection so a later send/fill can't double-spend an input and silently invalidate the held tx.
// Single writer: the background SW mirrors the deferred-finalize store into this set on every change
// and on service-worker startup. Empty set = zero effect on any existing path.
let RESERVED_OUTPOINTS = new Set<string>();
export function setReservedOutpoints(s: Set<string>) { RESERVED_OUTPOINTS = s; }

// Coin selection (REPORTED values, to pick which outpoints) THEN chain-verified totals (REAL
// values, to compute change). Returns the verified input set + real total, or an error string.
async function selectVerified(rpc: string, addr: string, need: number): Promise<{ inputs: SelectedInput[]; total: number } | { error: string }> {
  const { utxos } = await balance(rpc, addr);
  const spendable = RESERVED_OUTPOINTS.size ? utxos.filter((u: { txid: string; vout: number }) => !RESERVED_OUTPOINTS.has(`${u.txid}:${u.vout}`)) : utxos;
  const sel = selectInputs(spendable, need);
  if (!sel) return { error: "insufficient confirmed balance" };
  const ver = await verifyInputValues(rpc, sel.inputs);
  if (!ver.ok) return { error: "could not verify selected inputs against the chain (refusing to risk a burned fee)" };
  if (ver.total < need || !Number.isSafeInteger(ver.total) || !Number.isSafeInteger(ver.total - need)) return { error: "insufficient confirmed balance" };
  return { inputs: sel.inputs, total: ver.total };
}

export interface SubmitResult {
  ok: boolean; txid?: string; error?: string; sighashMatch: boolean;
  // present ONLY on a build-only assembly (deferred finalize): the fully SIGNED tx in node wire
  // format, ready for a later POST /tx/submit, plus the outpoints it spends (reserved until then).
  built?: { txJson: unknown; outpoints: string[] };
}

interface SelectedInput { txid: string; vout: number; value: number }
interface Selection { inputs: SelectedInput[]; total: number }

// Greedy multi-input coin selection covering `need` (= amount + fee). Largest-first
// so we reach the target with the fewest inputs; prefers spending mature non-coinbase
// coins, only dipping into coinbase outputs if the spendable set can't cover `need`.
// Returns null if even the whole confirmed balance is short. The CSD sighash blanks
// ALL inputs (see csdtx.ts `stripped`), so one signature covers every input — and
// since all of a wallet's inputs are from one address/key, we sign once and apply the
// same scriptSig to each. `total` is summed in the safe-integer range (guarded below).
const MAX_TX_INPUTS = 512; // consensus cap (params/mod.rs) — refuse locally with a clear error
// Defense-in-depth absolute fee cap (NETNEW-NO-MAX-FEE-CAP-1). A legitimate CSD miner fee is well under 1 CSD;
// the clear-sign window already WARNs above 5 CSD. Hard-refuse an absurd caller/dApp-supplied fee at the single
// chokepoint every value tx routes through, so a compromised UI can't steer a user PAST the visible warning
// into burning a huge fee. 100 CSD is ~100× any real fee — no legitimate flow approaches it.
const MAX_FEE = 100 * 1e8; // base units (100 CSD)
export function selectInputs(utxos: any[], need: number): Selection | null {
  // Default a missing `confirmations` to 0 (UNCONFIRMED), never 1 — a hostile/buggy RPC
  // must not be able to make an immature/absent coin look spendable by omitting the field.
  // Dedupe by outpoint (txid:vout) and drop non-positive values so a malicious RPC can't
  // inflate the input count with duplicates/dust or feed a negative value into selection.
  const seen = new Set<string>();
  const confirmed = utxos.filter((x: any) => {
    // Number.isFinite so confirmations:"abc"→NaN / "1e9999"→Infinity (NaN<1 and Infinity<1 are both
    // false) can't slip an unconfirmed/immature coin past the maturity gate — lockstep with csd-tx (audit L4).
    const c = Number(x.confirmations ?? 0);
    if (!Number.isFinite(c) || c < 1) return false;
    const v = Number(x.value);
    if (!Number.isFinite(v) || v <= 0 || !Number.isSafeInteger(v)) return false;
    const key = `${String(x.txid).toLowerCase()}:${Number(x.vout)}`; // case-normalize hex so a hostile RPC can't bypass dedupe with mixed case
    if (seen.has(key)) return false; seen.add(key);
    return true;
  });
  const byValDesc = (a: any, b: any) => Number(b.value) - Number(a.value);
  const take = (pool: any[]): Selection | null => {
    const inputs: SelectedInput[] = [];
    let total = 0;
    for (const x of [...pool].sort(byValDesc)) {
      const v = Number(x.value);
      total += v;
      // Refuse magnitudes that lose precision (a hostile RPC can't push the running
      // sum past 2^53 and slip a mis-signed value through) — bail before it matters.
      if (!Number.isSafeInteger(total)) return null;
      inputs.push({ txid: x.txid, vout: Number(x.vout), value: v });
      // Refuse a tx that would exceed the consensus input cap (e.g. a dust-flood RPC)
      // rather than building one the node will reject — surfaces as "insufficient" upstream.
      if (inputs.length > MAX_TX_INPUTS) return null;
      if (total >= need) return { inputs, total };
    }
    return null;
  };
  // try non-coinbase only first; fall back to the full confirmed set if needed
  return take(confirmed.filter((x: any) => !x.coinbase)) ?? take(confirmed);
}

// Build the FULL tx locally (we set the app ourselves), sign OUR OWN codec sighash,
// and submit. We never sign a hash a server handed us — so a malicious or MITM'd RPC
// cannot trick the wallet into signing a different transaction; the node re-derives
// the same sighash and would reject any tampering anyway.
// Sign every input with the one whole-tx sighash and submit. All inputs are blanked
// in the sighash and all belong to this account's single key, so one signature is
// reused across them. Returns sighashMatch:true because WE computed the sighash.
function signTxLocal(tx: Tx, priv: string): Tx {
  const { sig64, pub33 } = signSighash(codecSighash(tx), priv);
  const scriptSig = buildScriptSig(sig64, pub33);
  for (const i of tx.inputs) i.scriptSig = scriptSig;
  return tx;
}
// Broadcast an ALREADY-SIGNED tx (node wire format). Used by the deferred-finalize engine, which signs
// at approval time and submits later; adds no signing authority (the signature already exists).
export async function submitRawTx(rpc: string, txJson: unknown): Promise<SubmitResult> {
  const sub = await post(rpc, "/tx/submit", { tx: txJson });
  return { ok: !!sub.ok, txid: sub.txid, error: sub.err ?? (sub.ok ? undefined : "submit rejected"), sighashMatch: true };
}
async function signAndSubmit(rpc: string, tx: Tx, priv: string): Promise<SubmitResult> {
  return submitRawTx(rpc, txToNodeJson(signTxLocal(tx, priv)));
}

// Shared assembly tail for every value-moving tx (send / sendMany / fillOffer / buildSignSubmit).
// The CALLER validates its own payment outputs + fee (caps, address shape, safe-integer sums); this
// selects inputs from CHAIN-VERIFIED utxos, returns change ONLY to the wallet's own address (never a
// caller-chosen one), refuses an empty output set, then signs + submits. Single-sourcing it keeps
// that security posture — "inputs internal, change to self" — in ONE audited place. `outputs` are the
// payment outputs BEFORE change; `emptyError` is the message if nothing (incl. change) would be paid.
async function assembleValueTx(
  rpc: string,
  outputs: { value: number; scriptPubkey: string }[],
  fee: number,
  app: App,
  priv: string,
  emptyError = "tx would have no outputs",
  buildOnly = false,   // sign but do NOT broadcast: returns { built } for the deferred-finalize engine
): Promise<SubmitResult> {
  // Reject a zero (or negative) fee at the SINGLE place every value tx is assembled — send, sendMany,
  // propose, attest and fillOffer all route through here. The node enforces a minimum feerate, so a
  // zero-fee tx is built and signed but then silently dropped by the mempool; surface it as a clear
  // error up front instead (audit FEE-FLOOR). Non-negative integer / safe-integer checks stay with the
  // callers that own the fee value.
  if (!(fee > 0)) return { ok: false, error: "fee must be positive (the node enforces a minimum fee)", sighashMatch: false };
  if (fee > MAX_FEE) return { ok: false, error: `fee exceeds the ${MAX_FEE / 1e8} CSD safety cap — refusing (a legitimate fee is well under 1 CSD)`, sighashMatch: false };
  // Refuse the zero address at the SINGLE place every value tx is assembled — send, sendMany,
  // propose, attest, fillOffer and buildSignSubmit all route through here. A payment to 0x000…0 is an
  // irrecoverable burn; the popup send form already blocks it, but the dApp send/sendMany/fillOffer paths
  // bypass that form, so the universal backstop lives here (audit M1 / V23 nset-clear burn class). The
  // node accepts a zero-address output, so this MUST be caught client-side. Change is always to self.
  for (const o of outputs) {
    if (/^(0x)?0{40}$/i.test(o.scriptPubkey)) return { ok: false, error: "refusing to send to the zero address (0x000…0) — these funds would be unrecoverable", sighashMatch: false };   // (0x)? so the guard matches whether or not the caller carries the codec prefix (QA #3)
  }
  const addr = addrFromPriv(priv);
  const need = outputs.reduce((s, o) => s + o.value, 0) + fee;
  const sv = await selectVerified(rpc, addr, need);
  if ("error" in sv) return { ok: false, error: sv.error, sighashMatch: false };
  const outs = [...outputs];
  const change = sv.total - need; // CHAIN-VERIFIED input total, not the RPC's report
  if (change > 0) outs.push({ value: change, scriptPubkey: addr }); // change back to self
  if (outs.length === 0) return { ok: false, error: emptyError, sighashMatch: false };
  const tx: Tx = { version: 1, locktime: 0, app, inputs: sv.inputs.map((i) => ({ prevTxid: i.txid, vout: i.vout, scriptSig: "0x" })), outputs: outs };
  if (buildOnly) {
    const signed = signTxLocal(tx, priv);
    return { ok: true, sighashMatch: true, built: { txJson: txToNodeJson(signed), outpoints: sv.inputs.map((i) => `${i.txid}:${i.vout}`) } };
  }
  return signAndSubmit(rpc, tx, priv);
}

// `payouts` are optional value outputs carried in the SAME tx as the app payload (e.g. a
// CairnX protocol fee to the treasury on a deploy / name registration). Same posture as
// send/fillOffer: each recipient validated, sums safe-integer-guarded, inputs selected
// internally, change ONLY to the wallet's own address; a dApp can't pick UTXOs or redirect change.
async function buildSignSubmit(rpc: string, app: App, fee: number, priv: string, payouts: { to: string; value: number }[] = [], buildOnly = false): Promise<SubmitResult> {
  if (!Number.isSafeInteger(fee) || fee < 0) return { ok: false, error: "fee out of safe integer range", sighashMatch: false };
  // Cap the value outputs a Propose may carry (normally one protocol-fee output). Prevents a
  // hostile dApp from flooding the clear-signing window with hundreds of disguised payments.
  if (payouts.length > 8) return { ok: false, error: "too many outputs on a proposal (max 8)", sighashMatch: false };
  let sumOut = 0;
  for (const o of payouts) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(String(o.to))) return { ok: false, error: "each recipient must be a 0x… 20-byte address", sighashMatch: false };
    const v = Number(o.value);
    if (!(v > 0) || !Number.isSafeInteger(v)) return { ok: false, error: "each amount must be a positive safe integer", sighashMatch: false };
    sumOut += v;
    if (!Number.isSafeInteger(sumOut)) return { ok: false, error: "outputs exceed the safe integer range", sighashMatch: false };
  }
  const outputs = payouts.map((o) => ({ value: Number(o.value), scriptPubkey: String(o.to) }));
  return assembleValueTx(rpc, outputs, fee, app, priv, undefined, buildOnly);
}

export function propose(rpc: string, p: { domain: string; payloadHash: string; uri: string; expiresEpoch: number; fee: number; outputs?: { to: string; value: number }[] }, priv: string): Promise<SubmitResult> {
  // Validate the dApp-supplied payloadHash shape up front (parity with fillOffer's proposalId guard) so a
  // malformed value fails closed with a clear error instead of throwing a cryptic codec error deep inside
  // bytesArr() AFTER the SafeInteger checks pass (audit VAL-3). A real cairnx payloadHash is sha256 = 0x+64hex.
  if (!/^0x[0-9a-fA-F]{64}$/.test(String(p.payloadHash))) {
    return Promise.resolve({ ok: false, error: "payloadHash must be a 0x… 32-byte hash", sighashMatch: false });
  }
  // Validate expiresEpoch up front: a negative/fractional/>2^53 value would otherwise wrap or throw
  // inside u64() serialization, committing signed bytes (e.g. 0xFFFF…FF "never expires") that don't
  // match the dApp's intent. Same SafeInteger posture as amounts/fee. (redteam LOW-1)
  if (!Number.isSafeInteger(p.expiresEpoch) || p.expiresEpoch < 0) {
    return Promise.resolve({ ok: false, error: "expiresEpoch must be a non-negative safe integer", sighashMatch: false });
  }
  return buildSignSubmit(rpc, { type: "Propose", domain: p.domain, payloadHash: p.payloadHash, uri: p.uri, expiresEpoch: p.expiresEpoch }, p.fee, priv, Array.isArray(p.outputs) ? p.outputs : []);
}
// Build + sign a Propose WITHOUT broadcasting (the deferred-finalize path): same validations, same
// "inputs internal, change to self" posture; returns { built: { txJson, outpoints } } for a later
// submitRawTx. The tx is a normal signed propose — deferral changes WHEN it is sent, never WHAT.
export function proposeBuild(rpc: string, p: { domain: string; payloadHash: string; uri: string; expiresEpoch: number; fee: number; outputs?: { to: string; value: number }[] }, priv: string): Promise<SubmitResult> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(String(p.payloadHash))) {
    return Promise.resolve({ ok: false, error: "payloadHash must be a 0x… 32-byte hash", sighashMatch: false });
  }
  if (!Number.isSafeInteger(p.expiresEpoch) || p.expiresEpoch < 0) {
    return Promise.resolve({ ok: false, error: "expiresEpoch must be a non-negative safe integer", sighashMatch: false });
  }
  return buildSignSubmit(rpc, { type: "Propose", domain: p.domain, payloadHash: p.payloadHash, uri: p.uri, expiresEpoch: p.expiresEpoch }, p.fee, priv, Array.isArray(p.outputs) ? p.outputs : [], true);
}
export function attest(rpc: string, p: { proposalId: string; score: number; confidence: number; fee: number }, priv: string): Promise<SubmitResult> {
  // Validate the proposalId shape up front (parity with fillOffer) so a malformed dApp-supplied value fails
  // closed instead of throwing a cryptic codec error inside bytesArr() (audit VAL-3). A proposalId is a txid.
  if (!/^0x[0-9a-fA-F]{64}$/.test(String(p.proposalId))) {
    return Promise.resolve({ ok: false, error: "proposalId must be a 0x… 32-byte txid", sighashMatch: false });
  }
  // Clamp to u32 here (parity with fillOffer) so the signed bytes equal the displayed score/confidence.
  return buildSignSubmit(rpc, { type: "Attest", proposalId: p.proposalId, score: p.score >>> 0, confidence: p.confidence >>> 0 }, p.fee, priv);
}

// Plain CSD transfer (app:None). Built + signed entirely client-side — sighash via
// our golden-vector-validated codec, so no node template is needed; /tx/submit
// validates the signature against the node's own (identical) sighash.
export async function send(rpc: string, p: { to: string; amount: number; fee: number }, priv: string): Promise<SubmitResult> {
  if (!/^0x[0-9a-fA-F]{40}$/.test(p.to)) return { ok: false, error: "recipient must be a 0x… 20-byte address", sighashMatch: false };
  if (!(p.amount > 0)) return { ok: false, error: "amount must be positive", sighashMatch: false };
  // CSD amounts are integer base units carried as JS numbers. Above 2^53 a Number
  // silently loses precision, so the value you sign could differ from what you meant.
  // Refuse anything outside the exactly-representable range (well above total supply).
  if (!Number.isSafeInteger(p.amount) || !Number.isSafeInteger(p.fee) || p.fee < 0 || !Number.isSafeInteger(p.amount + p.fee))
    return { ok: false, error: "amount/fee exceed the safe integer range", sighashMatch: false };
  const outputs = [{ value: p.amount, scriptPubkey: p.to }];
  return assembleValueTx(rpc, outputs, p.fee, { type: "None" }, priv);
}

// Multi-output transfer (app:None). Same single-key / single-signature model as
// send(): every recipient is validated, the sum of all outputs + fee is safe-integer
// guarded, inputs are selected INTERNALLY (never supplied by a caller/dApp), and the
// change always returns to this account's own address. Used by the Console's send card
// for 1→many payments; send() above is the single-recipient convenience wrapper.
export async function sendMany(rpc: string, p: { outputs: { to: string; value: number }[]; fee: number }, priv: string): Promise<SubmitResult> {
  const outs = Array.isArray(p.outputs) ? p.outputs : [];
  if (outs.length < 1) return { ok: false, error: "at least one output required", sighashMatch: false };
  if (outs.length > 500) return { ok: false, error: "too many outputs (max 500)", sighashMatch: false };
  let sumOut = 0;
  for (const o of outs) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(String(o.to))) return { ok: false, error: "each recipient must be a 0x… 20-byte address", sighashMatch: false };
    const v = Number(o.value);
    if (!(v > 0)) return { ok: false, error: "each amount must be positive", sighashMatch: false };
    if (!Number.isSafeInteger(v)) return { ok: false, error: "an amount exceeds the safe integer range", sighashMatch: false };
    sumOut += v;
    if (!Number.isSafeInteger(sumOut)) return { ok: false, error: "total outputs exceed the safe integer range", sighashMatch: false };
  }
  if (!Number.isSafeInteger(p.fee) || p.fee < 0 || !Number.isSafeInteger(sumOut + p.fee))
    return { ok: false, error: "amount/fee exceed the safe integer range", sighashMatch: false };
  const outputs = outs.map((o) => ({ value: Number(o.value), scriptPubkey: String(o.to) }));
  return assembleValueTx(rpc, outputs, p.fee, { type: "None" }, priv);
}

// Fill an on-chain offer (CairnX-style atomic delivery-versus-payment): ONE transaction
// that carries an Attest app payload AND payment outputs. Same trust posture as sendMany —
// recipients validated, sums safe-integer guarded, inputs selected INTERNALLY, change only
// ever returns to this account's own address. The attest fee floor (0.05 CSD) applies.
export async function fillOffer(
  rpc: string,
  p: { proposalId: string; score: number; confidence: number; outputs: { to: string; value: number }[]; fee: number },
  priv: string,
): Promise<SubmitResult> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(String(p.proposalId))) return { ok: false, error: "proposalId must be a 0x… 32-byte txid", sighashMatch: false };
  const outs = Array.isArray(p.outputs) ? p.outputs : [];
  // outs MAY be empty: a CairnX v1.2 token-priced fill pays in tokens (resolver-debited,
  // marked by confidence=1e6) and carries no CSD payment — the tx is attest + change only.
  if (outs.length > 100) return { ok: false, error: "too many outputs (max 100)", sighashMatch: false };
  let sumOut = 0;
  for (const o of outs) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(String(o.to))) return { ok: false, error: "each recipient must be a 0x… 20-byte address", sighashMatch: false };
    const v = Number(o.value);
    if (!(v > 0)) return { ok: false, error: "each amount must be positive", sighashMatch: false };
    if (!Number.isSafeInteger(v)) return { ok: false, error: "an amount exceeds the safe integer range", sighashMatch: false };
    sumOut += v;
    if (!Number.isSafeInteger(sumOut)) return { ok: false, error: "total outputs exceed the safe integer range", sighashMatch: false };
  }
  if (!Number.isSafeInteger(p.fee) || p.fee < 0 || !Number.isSafeInteger(sumOut + p.fee))
    return { ok: false, error: "amount/fee exceed the safe integer range", sighashMatch: false };
  const outputs = outs.map((o) => ({ value: Number(o.value), scriptPubkey: String(o.to) }));
  return assembleValueTx(rpc, outputs, p.fee, { type: "Attest", proposalId: p.proposalId, score: p.score >>> 0, confidence: p.confidence >>> 0 }, priv, "tx would have no outputs — add a payment or leave change");
}

// Register a Cairn item's off-chain content (hash-verified by the server).
export function registerContent(apiBase: string, content: any, txid: string): Promise<any> {
  return fetch(`${apiBase}/api/content`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...content, txid }) }).then((r) => r.json()).catch((e) => ({ ok: false, error: String(e) }));
}

// Sign in with CSD against the Cairn API: fetch nonce, sign its digest locally, verify.
export async function signIn(apiBase: string, priv: string): Promise<{ ok: boolean; addr?: string; session?: string; error?: string }> {
  const n = await post(apiBase, "/auth/nonce", {});
  if (!n?.ok || !n.nonce) return { ok: false, error: "could not get nonce" };
  // Derive the digest LOCALLY from the nonce — never sign the server's `digest`
  // field. Otherwise a malicious/MITM'd API could return a tx sighash and harvest a
  // valid spend signature from the login flow (see test/poc-signin-oracle.ts).
  const { sig64, pub33 } = signSighash(loginDigest(String(n.nonce)), priv);
  const v = await post(apiBase, "/auth/verify", { nonce: n.nonce, pub33, sig64 });
  // Normalize the failure shape to this function's declared `error` key — post() returns {ok:false,err}
  // on a non-2xx body (VAL-2), and this legacy path's callers read `.error`.
  return v?.ok ? v : { ok: false, error: v?.error ?? v?.err ?? "sign-in failed" };
}
