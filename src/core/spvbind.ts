// spvbind.ts; the SPV primitives the name verifier (namespv.ts) and the fill boundary (fillspv.ts) share: the
// full-block merkle bind, signer recovery, the coinbase test and the mapping from a bound tx to a resolver event.
// Each caller keeps its own failure contract (namespv returns a reason, fillspv throws), so the bind returns its
// refusal and the caller turns it into that contract.
import { rpcTxToTx, txid as ctxid, sighash, merkleRoot, recoverSigner as recoverSignerFromScriptSig, paidToFromOutputs, type ProvenAttest, type ProvenPropose, type RpcTxJson, type Tx } from "../vendor/cairnx-spv.js";

// The all-zeros coinbase outpoint (consensus): a coinbase tx is never a signed cairnx record, so a record whose
// authenticating input looks like one has no prevout owner to bind against. Kept local because the vendored
// bundle does not export its own `isCoinbaseInput`.
const COINBASE_TXID = "0x" + "00".repeat(32);
export const isCoinbaseInput = (i: { prevTxid: string; vout: number }) =>
  String(i.prevTxid).toLowerCase() === COINBASE_TXID && Number(i.vout) === 0xffffffff;

// outputs to the resolver's `paidTo` (addr to summed value). The aggregation is the vendored paidToFromOutputs,
// the sink the cairnx scanner and resolver use; what stays here is SPV-specific: raw outputs carry a scriptPubkey,
// not an addr, so the 40-hex address is extracted and codec number|bigint values are coerced to number (a value
// past 2^53 coerces non-safe and the sink skips it).
export function outputsToPaidTo(outputs: Tx["outputs"]): Record<string, string> {
  const decoded: { addr: string; value: number }[] = [];
  for (const o of outputs) {
    const a = String(o.scriptPubkey ?? "").toLowerCase().replace(/^0x/, "");
    if (!/^[0-9a-f]{40}$/.test(a)) continue;
    decoded.push({ addr: "0x" + a, value: Number(o.value) });
  }
  return paidToFromOutputs(decoded);
}

/** The signer of a tx's first input, authenticated against sighash(tx) (the merkle root commits the body but not
 *  the scriptSig); null on any malformed frame or bad signature, sighash included, rather than a throw. */
export function recoverSigner(tx: Tx): string | null {
  const ss = tx.inputs?.[0]?.scriptSig;
  if (typeof ss !== "string") return null;
  try { return recoverSignerFromScriptSig(ss, sighash(tx)); }
  catch { return null; }
}

export type ChainEvent = Omit<ProvenPropose, "depth"> | Omit<ProvenAttest, "depth">;

// A resolver ChainEvent from a merkle-bound tx whose `signer` the caller has already authenticated and bound to
// the coin it spends; null for a tx with no cairnx app payload. The field shapes mirror the cairnx scanner
// (cairnx repo src/scan.ts) so resolve() builds the same state from either feed; test/namespv.test.mjs replays
// them through the vendored resolver.
export function toChainEvent(tx: Tx, id: string, height: number, pos: number, signer: string): ChainEvent | null {
  if (!tx.app || tx.app.type === "None") return null;
  const paidTo = outputsToPaidTo(tx.outputs);
  if (tx.app.type === "Propose") {
    return { kind: "propose", id: id.toLowerCase(), proposer: signer, uri: tx.app.uri, payloadHash: String(tx.app.payloadHash).toLowerCase(), expiresEpoch: Number(tx.app.expiresEpoch), height, pos, paidTo };
  }
  const conf = Number(tx.app.confidence);
  return { kind: "attest", txid: id.toLowerCase(), proposalId: String(tx.app.proposalId).toLowerCase(), attester: signer, score: Number(tx.app.score), confidence: Number.isSafeInteger(conf) && conf >= 0 ? conf : 0, height, pos, paidTo };
}

/** The refusal for a block body whose transactions do not hash to the verified header's merkle root. */
export function bodyMismatchReason(height: number, bodySource: string | undefined): string {
  return bodySource
    ? `block ${height} from ${bodySource} does not match its verified merkle root: that RPC may be on another chain, or the read was altered`
    : `block ${height} does not match its verified merkle root (tampered read path)`;
}

/** Thrown for a block body that does not match its verified header; `bodySource` is the RPC that served it and
 *  `headerSource` the API the header came from, both as the source was built (not the current settings). */
export class BodyMismatchError extends Error {
  constructor(readonly height: number, readonly bodySource: string | undefined, readonly headerSource?: string) {
    super(bodyMismatchReason(height, bodySource));
    this.name = "BodyMismatchError";
  }
}

/** The block read the bind needs: the PoW-verified merkle root for `height` and that block's node-JSON txs. */
export interface BlockReader {
  blockAt(height: number): Promise<{ merkle: string; txs: RpcTxJson[] }>;
  bodySource?: string;
}

export type BlockBind =
  | { ok: true; ids: string[]; rebuilt: Tx[] }
  | { ok: false; kind: "duplicate-txid" | "body-mismatch"; reason: string };

/**
 * Fetch a block, rebuild every tx and require merkleRoot(txids) to equal the PoW-verified header's root, so a
 * lying node cannot omit, alter or add a committed body. A failed read or an undecodable tx throws, as blockAt
 * and rpcTxToTx do; a body that fails the bind is returned as a refusal.
 */
export async function bindBlock(src: BlockReader, height: number): Promise<BlockBind> {
  const { merkle, txs } = await src.blockAt(height);
  // A plain or coinbase tx may carry no `app`; default it to {None} before decode so a node cannot omit `app` on
  // one filler tx to make rpcTxToTx throw. A None tx still has a real txid.
  const rebuilt = txs.map((t) => rpcTxToTx(t.app ? t : { ...t, app: { type: "None" } }));
  const ids = rebuilt.map(ctxid);
  // CVE-2012-2459: merkleRoot self-pairs an odd final row, so a body whose last tx is duplicated hashes to the
  // honest root. A real block holds no duplicate txid, so refuse one before the root compare
  // (test/merkle-dup-txid.test.mjs).
  if (new Set(ids.map((x) => x.toLowerCase())).size !== ids.length)
    return { ok: false, kind: "duplicate-txid", reason: `block ${height} has a duplicate txid (malleated read path, CVE-2012-2459)` };
  if (String(merkleRoot(ids)).toLowerCase() !== String(merkle).toLowerCase())
    return { ok: false, kind: "body-mismatch", reason: bodyMismatchReason(height, src.bodySource) };
  return { ok: true, ids, rebuilt };
}
