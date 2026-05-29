// Talks to a CSD node (reads + non-custodial submit) and the Cairn API (sign-in).
// Browser fetch. The non-custodial flow: coin-select → node /tx/template → sign the
// signing_hash LOCALLY → set script_sig → node /tx/submit. The private key only ever
// lives in the wallet; nothing here sends it anywhere.
import { signSighash, buildScriptSig, addrFromPriv, sighash as codecSighash, bytesArr, type App, type Tx } from "./csdtx.js";

const strip = (h: string) => (h.startsWith("0x") ? h.slice(2) : h);

async function get(rpc: string, path: string): Promise<any> {
  const r = await fetch(`${rpc}${path}`); if (!r.ok) throw new Error(`${path} -> ${r.status}`); return r.json();
}
async function post(rpc: string, path: string, body: unknown): Promise<any> {
  const r = await fetch(`${rpc}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return r.json();
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

export interface SubmitResult { ok: boolean; txid?: string; error?: string; sighashMatch: boolean }

async function buildSignSubmit(rpc: string, templatePath: string, extra: Record<string, unknown>, app: App, fee: number, priv: string): Promise<SubmitResult> {
  const addr = addrFromPriv(priv);
  const { utxos } = await balance(rpc, addr);
  const cand = utxos.filter((x: any) => Number(x.value) > fee && Number(x.confirmations ?? 1) >= 1 && !x.coinbase).sort((a: any, b: any) => Number(a.value) - Number(b.value));
  const inp = cand[0] ?? utxos.find((y: any) => Number(y.value) > fee);
  if (!inp) return { ok: false, error: "no confirmed input greater than fee", sighashMatch: false };
  const baseTx: Tx = { version: 1, locktime: 0, app: { type: "None" }, inputs: [{ prevTxid: inp.txid, vout: Number(inp.vout), scriptSig: "0x" }], outputs: [{ value: Number(inp.value) - fee, scriptPubkey: addr }] };
  const tmpl = await post(rpc, templatePath, { tx: txToNodeJson(baseTx), ...extra });
  if (!tmpl.ok || !tmpl.signing_hash || String(tmpl.signing_hash).startsWith("err")) return { ok: false, error: `template: ${tmpl.signing_hash ?? "failed"}`, sighashMatch: false };
  const sighashMatch = codecSighash({ ...baseTx, app }).toLowerCase() === String(tmpl.signing_hash).toLowerCase();
  const { sig64, pub33 } = signSighash(tmpl.signing_hash, priv);
  const signedTx = tmpl.unsigned_tx;
  signedTx.inputs[0].script_sig = bytesArr(buildScriptSig(sig64, pub33));
  const sub = await post(rpc, "/tx/submit", { tx: signedTx });
  return { ok: !!sub.ok, txid: sub.txid, error: sub.err ?? undefined, sighashMatch };
}

export function propose(rpc: string, p: { domain: string; payloadHash: string; uri: string; expiresEpoch: number; fee: number }, priv: string): Promise<SubmitResult> {
  return buildSignSubmit(rpc, "/tx/template/propose", { domain: p.domain, payload_hash: p.payloadHash, uri: p.uri, expires_epoch: p.expiresEpoch }, { type: "Propose", ...p }, p.fee, priv);
}
export function attest(rpc: string, p: { proposalId: string; score: number; confidence: number; fee: number }, priv: string): Promise<SubmitResult> {
  return buildSignSubmit(rpc, "/tx/template/attest", { proposal_id: p.proposalId, score: p.score, confidence: p.confidence }, { type: "Attest", ...p }, p.fee, priv);
}

// Plain CSD transfer (app:None). Built + signed entirely client-side — sighash via
// our golden-vector-validated codec, so no node template is needed; /tx/submit
// validates the signature against the node's own (identical) sighash.
export async function send(rpc: string, p: { to: string; amount: number; fee: number }, priv: string): Promise<SubmitResult> {
  if (!/^0x[0-9a-fA-F]{40}$/.test(p.to)) return { ok: false, error: "recipient must be a 0x… 20-byte address", sighashMatch: false };
  if (!(p.amount > 0)) return { ok: false, error: "amount must be positive", sighashMatch: false };
  const addr = addrFromPriv(priv);
  const need = p.amount + p.fee;
  const { utxos } = await balance(rpc, addr);
  const cand = utxos.filter((x: any) => Number(x.value) >= need && Number(x.confirmations ?? 1) >= 1).sort((a: any, b: any) => Number(a.value) - Number(b.value));
  const inp = cand[0];
  if (!inp) return { ok: false, error: "no single confirmed coin covers amount + fee (consolidate first)", sighashMatch: false };
  const change = Number(inp.value) - p.amount - p.fee;
  const outputs = [{ value: p.amount, scriptPubkey: p.to }];
  if (change > 0) outputs.push({ value: change, scriptPubkey: addr });
  const tx: Tx = { version: 1, locktime: 0, app: { type: "None" }, inputs: [{ prevTxid: inp.txid, vout: Number(inp.vout), scriptSig: "0x" }], outputs };
  const { sig64, pub33 } = signSighash(codecSighash(tx), priv);
  tx.inputs[0].scriptSig = buildScriptSig(sig64, pub33);
  const sub = await post(rpc, "/tx/submit", { tx: txToNodeJson(tx) });
  return { ok: !!sub.ok, txid: sub.txid, error: sub.err ?? (sub.ok ? undefined : "submit rejected"), sighashMatch: true };
}

// Register a Cairn item's off-chain content (hash-verified by the server).
export function registerContent(apiBase: string, content: any, txid: string): Promise<any> {
  return fetch(`${apiBase}/api/content`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...content, txid }) }).then((r) => r.json()).catch((e) => ({ ok: false, error: String(e) }));
}

// Sign in with CSD against the Cairn API: fetch nonce, sign its digest locally, verify.
export async function signIn(apiBase: string, priv: string): Promise<{ ok: boolean; addr?: string; session?: string; error?: string }> {
  const n = await post(apiBase, "/auth/nonce", {});
  if (!n?.ok) return { ok: false, error: "could not get nonce" };
  const { sig64, pub33 } = signSighash(n.digest, priv);
  return post(apiBase, "/auth/verify", { nonce: n.nonce, pub33, sig64 });
}
