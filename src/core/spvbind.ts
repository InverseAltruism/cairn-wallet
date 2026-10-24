// spvbind.ts; the SPV primitives the name verifier (namespv.ts) and the fill boundary (fillspv.ts) share: the
// block bind (csd-light bindBlockBody), the author bind (csd-crypto authorOf), signer recovery, the coinbase test
// and the mapping from a bound tx to a resolver event.
// Each caller keeps its own failure contract (namespv returns a reason, fillspv throws), so the bind returns its
// refusal and the caller turns it into that contract.
import { sighash, recoverSigner as recoverSignerFromScriptSig, authorOf, bindBlockBody, paidToFromOutputs, type BlockHeader, type ProvenAttest, type ProvenPropose, type Tx } from "../vendor/cairnx-spv.js";

// The all-zeros coinbase outpoint (consensus): a coinbase tx is never a signed cairnx record, so a record whose
// authenticating input looks like one has no prevout owner to bind against. Kept local because the vendored
// bundle does not export its own `isCoinbaseInput`.
const COINBASE_TXID = "0x" + "00".repeat(32);
const isCoinbaseInput = (i: { prevTxid: string; vout: number }) =>
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

/** Reads the scriptPubkey of a spent output, bound to its txid; null when it cannot be proven. */
export interface PrevoutReader {
  prevoutScriptPubkey(prevTxid: string, vout: number): Promise<string | null>;
}

export type SignerBind = { ok: true; signer: string } | { ok: false; kind: "unsigned" | "no-input" | "not-owner" };

/**
 * The tx's author: csd-crypto `authorOf`, the owner of the coin input 0 spends when input 0's scriptSig is that
 * owner's valid signature. The merkle root commits the body but not the scriptSig and the sighash is public, so a
 * block-body provider could splice in a foreign valid signature to re-attribute a record; the coin owner cannot be
 * spliced (test/namespv-fillspv-parity.test.mjs). An unsigned tx and a coinbase or missing input are refused before
 * the prevout read. Each caller maps the refusal to its own contract.
 */
export async function bindSigner(tx: Tx, src: PrevoutReader): Promise<SignerBind> {
  // A key that signed sighash(tx), not yet bound to the coin; authorOf replaces it with the coin's owner or null.
  let signer = recoverSigner(tx);
  if (!signer) return { ok: false, kind: "unsigned" };
  const in0 = tx.inputs?.[0];
  if (!in0 || isCoinbaseInput(in0)) return { ok: false, kind: "no-input" };
  signer = authorOf(tx, await src.prevoutScriptPubkey(String(in0.prevTxid), Number(in0.vout))); // MUTATE_SPV_PREVOUT_BIND
  if (!signer) return { ok: false, kind: "not-owner" };
  return { ok: true, signer };
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

/** The block read the bind needs: the PoW-verified header's merkle root for `height` and the node's `/block`
 *  response body as text (bindBlockBody parses it exactly). */
export interface BlockReader {
  blockAt(height: number): Promise<{ merkle: string; body: string }>;
  bodySource?: string;
}

export type BlockBind =
  | { ok: true; ids: string[]; rebuilt: Tx[] }
  | { ok: false; kind: "duplicate-txid" | "body-mismatch"; reason: string };

/**
 * Fetch a block and bind it with csd-light `bindBlockBody`: every tx rebuilt from the exactly parsed body, a
 * repeated txid refused before the merkle compare (test/merkle-dup-txid.test.mjs), and the txids required to hash
 * to the verified root, so a lying node cannot omit, alter or add a committed body. A failed read or a body that
 * does not decode throws; a body that fails the bind is returned as a refusal.
 */
export async function bindBlock(src: BlockReader, height: number): Promise<BlockBind> {
  const { merkle, body } = await src.blockAt(height);
  // bindBlockBody reads `height` and `header.merkle` of the verified header (csd-light 0.1.25 bind.ts); the
  // header store keeps no chainwork, so the other fields are placeholders.
  const b = bindBlockBody(body, { height, hash: "", header: { merkle } as BlockHeader, chainwork: 0n });
  if (b.ok) return { ok: true, ids: b.txs.map((t) => t.txid), rebuilt: b.txs.map((t) => t.tx) };
  if (b.kind === "malformed") throw new Error(b.reason);
  const reason = b.kind === "body-mismatch" ? bodyMismatchReason(height, src.bodySource) : b.reason;
  return { ok: false, kind: b.kind, reason };
}
