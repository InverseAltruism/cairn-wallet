// _spvrig.ts — the shared SPV name-verifier test rig. Builds REAL signed cairnx txs, places them in
// synthetic PoW-verified blocks, and exposes the SpvSource seam that core/namespv.ts consumes, plus a
// per-base fetch mock for the multi-source union path. Extracted 2026-07-06 from namespv.test.mjs and the
// name2/name4/name5 PoCs, which had each hand-rolled a near-identical copy of this exact scaffolding.
//
// Per-caller knobs stay EXPLICIT so no test loses its distinct case: proposeTx takes an optional
// prevScriptPubkey (H3 scriptSig-substitution) and expiresEpoch; source() takes optional tamperMerkle /
// verifiedTip / nodeTip (merkle-tamper and tip-deflation scenarios). The prevout-ownership registry is
// module-scoped — each tsx test file is its own process, so the registry is naturally isolated per file.
import { buildNameClaim, buildNameSet, buildNameXfer, buildNameProfile, TREASURY_ADDR } from "../src/core/cairnx.js";
import { signSighash, buildScriptSig, addrFromPriv } from "../src/core/csdtx.js";
import { txid as ctxid, sighash as vSighash, merkleRoot, rpcTxToTx, resolve, type RpcTxJson } from "../src/vendor/cairnx-spv.js";

// Re-export the building blocks so a test imports its whole rig surface from here (one import line).
export { buildNameClaim, buildNameSet, buildNameXfer, buildNameProfile, TREASURY_ADDR } from "../src/core/cairnx.js";
export { signSighash, buildScriptSig, addrFromPriv } from "../src/core/csdtx.js";
export { txid as ctxid, sighash as vSighash, merkleRoot, rpcTxToTx, resolve } from "../src/vendor/cairnx-spv.js";

export const CAIRNX_DOMAIN = "cairnx:v1";
export const REG_FEE = 1000_000_000; // 10 CSD — generously above any nameRegFee (overpay is accepted)

export interface Hint { txid: string; height: number; pos: number; kind?: string }
export interface Placement { height: number; tx: RpcTxJson }
interface Built { uri: string; payloadHash: string }
interface Output { to: string; value: number }

// prevTxid(lowercase) -> 0x scriptPubkey of that outpoint (the H3 prevout-ownership oracle)
const PREVOUTS = new Map<string, string>();
let _utxoSeq = 0;
export const prevoutFor = (t: unknown): string | null => PREVOUTS.get(String(t).toLowerCase()) ?? null;

export const pick = (b: Built): Built => ({ uri: b.uri, payloadHash: b.payloadHash });
export const feeOut = (v: number = REG_FEE): Output[] => [{ to: TREASURY_ADDR, value: v }];

// Build a SIGNED Propose tx in node-JSON (RpcTxJson) shape — exactly what SpvSource.blockAt returns. Each
// tx references a UNIQUE prevout whose scriptPubkey is registered here; by default the signer spends their
// OWN coin (the honest case), and `prevScriptPubkey` overrides it to simulate a swapped scriptSig.
export function proposeTx(p: { uri: string; payloadHash: string; expiresEpoch?: number; priv: string; outputs?: Output[]; prevScriptPubkey?: string; domain?: string }): RpcTxJson {
  const { uri, payloadHash, expiresEpoch = 9_999_999, priv, outputs = [], prevScriptPubkey, domain = CAIRNX_DOMAIN } = p;
  const prevTxid = "0x" + (++_utxoSeq).toString(16).padStart(64, "0"); // a unique, real-looking prevout per tx
  PREVOUTS.set(prevTxid.toLowerCase(), String(prevScriptPubkey ?? addrFromPriv(priv)).toLowerCase());
  const tx = {
    version: 1, locktime: 0,
    inputs: [{ prevTxid, vout: 0, scriptSig: "0x" }],
    outputs: outputs.map((o) => ({ value: o.value, scriptPubkey: o.to })),
    app: { type: "Propose" as const, domain, payloadHash, uri, expiresEpoch },
  };
  const { sig64, pub33 } = signSighash(vSighash(tx as any), priv); // sign the VENDORED sighash → verifyDigest accepts
  tx.inputs[0].scriptSig = buildScriptSig(sig64, pub33);
  return {
    version: 1, locktime: 0,
    inputs: [{ prev_txid: prevTxid, vout: 0, script_sig: tx.inputs[0].scriptSig }],
    outputs: outputs.map((o) => ({ value: o.value, script_pubkey: o.to })),
    app: { type: "Propose", domain, payload_hash: payloadHash, uri, expires_epoch: expiresEpoch },
  } as unknown as RpcTxJson;
}

// Build a SIGNED Attest tx in node-JSON (RpcTxJson) shape — for the fill / legacy-claim scan scenarios.
// Registers its prevout like proposeTx so prevoutFor()/source() resolve the spent-coin owner (H3 bind); by
// default the signer spends their OWN coin, and `prevScriptPubkey` overrides it to simulate a swapped scriptSig.
export function attestTx(p: { proposalId: string; score: number; confidence?: number; priv: string; outputs?: Output[]; prevScriptPubkey?: string }): RpcTxJson {
  const { proposalId, score, confidence = 0, priv, outputs = [], prevScriptPubkey } = p;
  const prevTxid = "0x" + (++_utxoSeq).toString(16).padStart(64, "0");
  PREVOUTS.set(prevTxid.toLowerCase(), String(prevScriptPubkey ?? addrFromPriv(priv)).toLowerCase());
  const tx = {
    version: 1, locktime: 0,
    inputs: [{ prevTxid, vout: 0, scriptSig: "0x" }],
    outputs: outputs.map((o) => ({ value: o.value, scriptPubkey: o.to })),
    app: { type: "Attest" as const, proposalId, score, confidence },
  };
  const { sig64, pub33 } = signSighash(vSighash(tx as any), priv);
  tx.inputs[0].scriptSig = buildScriptSig(sig64, pub33);
  return {
    version: 1, locktime: 0,
    inputs: [{ prev_txid: prevTxid, vout: 0, script_sig: tx.inputs[0].scriptSig }],
    outputs: outputs.map((o) => ({ value: o.value, script_pubkey: o.to })),
    app: { type: "Attest", proposal_id: proposalId, score, confidence },
  } as unknown as RpcTxJson;
}

// place txs into blocks at given heights; return {blocks, hints} (hints = txid+height+pos per placed tx)
export function world(placements: Placement[]): { blocks: Map<number, RpcTxJson[]>; hints: Hint[] } {
  const blocks = new Map<number, RpcTxJson[]>(), hints: Hint[] = [];
  for (const { height, tx } of placements) {
    const arr = blocks.get(height) ?? blocks.set(height, []).get(height)!;
    const pos = arr.length; arr.push(tx);
    hints.push({ txid: ctxid(rpcTxToTx(tx)), height, pos, kind: "name" });
  }
  return { blocks, hints };
}

// A synthetic SpvSource: blocks keyed by height, each merkle root computed over its txs (so the verifier's
// merkle-bind genuinely passes), tip fixed. `tamperMerkle` flips one block's root to simulate a lying node;
// `verifiedTip`/`nodeTip` decouple the PoW-verified tip from the (untrusted) node-reported tip (the NAME-4
// tip-deflation case: verifiedTip pinned near the records while nodeTip varies).
export function source(
  blocks: Map<number, RpcTxJson[]>,
  tip: number,
  opts: { tamperMerkle?: number | null; verifiedTip?: number; nodeTip?: number; floorTip?: number } = {},
): {
  prepare(): Promise<{ verifiedTip: number; nodeTip: number; floorTip?: number }>;
  blockAt(height: number): Promise<{ merkle: string; txs: RpcTxJson[] }>;
  prevoutScriptPubkey(prevTxid: string): Promise<string | null>;
} {
  // floorTip (WALLET-LAPSE-TIP-1): the persisted, trusted-across-sessions tip high-water used ONLY to
  // corroborate a lease-lapse verdict. Omitted ⇒ uncorroborated (a single-source lapse degrades to caution).
  const { tamperMerkle = null, verifiedTip = tip, nodeTip = tip, floorTip } = opts;
  return {
    async prepare() { return { verifiedTip, nodeTip, ...(floorTip !== undefined ? { floorTip } : {}) }; },
    async blockAt(height: number) {
      const txs = blocks.get(height);
      if (!txs) throw new Error(`no verified header at ${height}`);
      let merkle = merkleRoot(txs.map((t) => ctxid(rpcTxToTx(t))));
      if (tamperMerkle === height) merkle = "0x" + "ff".repeat(32);
      return { merkle, txs };
    },
    async prevoutScriptPubkey(prevTxid: string) { return prevoutFor(prevTxid); }, // H3 prevout-ownership oracle
  };
}

// Per-base name-history fetch mock for the union path. `byBase` maps a resolver base URL to the JSON body
// it serves; a spec of "throw" simulates a network-layer block (CSP/MITM drop), and a body carrying
// `__status: <non-200>` simulates that HTTP status (e.g. {__status:502} down, {__status:404} unregistered).
export function mkFetch(byBase: Record<string, unknown>): (url: string) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }> {
  return async (url: string) => {
    const u = String(url);
    const base = Object.keys(byBase).find((b) => u.startsWith(b));
    const spec = base ? byBase[base] : undefined;
    if (spec === undefined) return { status: 0, ok: false, async json() { return {}; } };
    if (spec === "throw") throw new Error("network blocked (CSP / MITM drop)");
    const status = spec && typeof spec === "object" ? (spec as { __status?: number }).__status : undefined;
    if (status && status !== 200) return { status, ok: false, async json() { return { ok: false, error: String(status) }; } };
    return { status: 200, ok: true, async json() { return spec; } };
  };
}
