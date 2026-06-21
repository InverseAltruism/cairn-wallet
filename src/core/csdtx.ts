// CSD consensus tx codec + signing — BROWSER-SAFE twin of cairn's server-side
// txcodec.ts/sig.ts (no node:crypto, no Buffer). Same FROZEN scheme:
//   txid    = sha256d(bincode(stripped_tx))
//   sighash = sha256d(tagged_hash("CSD_SIG_V1", bincode(stripped_tx)||CHAIN_ID_HASH))
//   sig     = secp256k1 compact-64, LOW-S; addr = hash160(pub33)
// Validated against the consensus golden vectors + a real on-chain signature
// (test/selftest.ts) — the same external oracles used server-side.
import { sha256 } from "@noble/hashes/sha256";
import { ripemd160 } from "@noble/hashes/ripemd160";
import { bytesToHex, hexToBytes, concatBytes, utf8ToBytes } from "@noble/hashes/utils";
import { secp256k1 } from "@noble/curves/secp256k1";

export const CHAIN_ID_HASH = hexToBytes("1b17c7b04d05394674ca2c8e24f7433e251a1973cac2000c7b60966546e0b875");

const strip = (h: string) => (h.startsWith("0x") ? h.slice(2) : h);
const hb = (h: string) => hexToBytes(strip(h));
// Fixed-width field decode that rejects a wrong byte length (consensus uses [u8;32]/[u8;20]).
// Defense-in-depth parity with the cairn csdcore codec; the wallet only ever feeds
// regex-validated 20-byte addresses + computed 32-byte hashes here, so this never fires in
// normal use — it just guarantees the serializer can never silently truncate a field.
const hbFixed = (h: string, n: number): Uint8Array => { const b = hb(h); if (b.length !== n) throw new Error(`expected a ${n}-byte field, got ${b.length} bytes`); return b; };
const hx = (b: Uint8Array) => "0x" + bytesToHex(b);
const sha256d = (b: Uint8Array) => sha256(sha256(b));
export function hash160(pub: Uint8Array): string { return "0x" + bytesToHex(ripemd160(sha256(pub))); }

function u32(n: number): Uint8Array { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n >>> 0, true); return b; }
function u64(n: number | bigint): Uint8Array { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(n), true); return b; }
function lenBytes(b: Uint8Array): Uint8Array { return concatBytes(u64(b.length), b); }

export type App =
  | { type: "None" }
  | { type: "Propose"; domain: string; payloadHash: string; uri: string; expiresEpoch: number | bigint }
  | { type: "Attest"; proposalId: string; score: number; confidence: number };
export interface TxInput { prevTxid: string; vout: number; scriptSig: string }
export interface TxOutput { value: number | bigint; scriptPubkey: string }
export interface Tx { version: number; inputs: TxInput[]; outputs: TxOutput[]; locktime: number; app: App }

function serializeApp(app: App): Uint8Array {
  if (app.type === "None") return u32(0);
  if (app.type === "Propose") return concatBytes(u32(1), lenBytes(utf8ToBytes(app.domain)), hbFixed(app.payloadHash, 32), lenBytes(utf8ToBytes(app.uri)), u64(app.expiresEpoch));
  return concatBytes(u32(2), hbFixed(app.proposalId, 32), u32(app.score), u32(app.confidence));
}

export function serialize(tx: Tx): Uint8Array {
  const parts: Uint8Array[] = [u32(tx.version), u64(tx.inputs.length)];
  for (const i of tx.inputs) parts.push(hbFixed(i.prevTxid, 32), u32(i.vout), lenBytes(hb(i.scriptSig)));
  parts.push(u64(tx.outputs.length));
  for (const o of tx.outputs) parts.push(u64(o.value), hbFixed(o.scriptPubkey, 20));
  parts.push(u32(tx.locktime), serializeApp(tx.app));
  return concatBytes(...parts);
}

const COINBASE = "0x" + "00".repeat(32);
const stripped = (tx: Tx): Tx => ({ ...tx, inputs: tx.inputs.map((i) => (i.prevTxid === COINBASE && i.vout === 0xffffffff) ? i : { ...i, scriptSig: "0x" }) });
export function txid(tx: Tx): string { return hx(sha256d(serialize(stripped(tx)))); }
function taggedHash(tag: string, msg: Uint8Array): Uint8Array { const t = sha256(utf8ToBytes(tag)); return sha256(concatBytes(t, t, msg)); }
export function sighash(tx: Tx): string { return hx(sha256d(taggedHash("CSD_SIG_V1", concatBytes(serialize(stripped(tx)), CHAIN_ID_HASH)))); }

// ─── signing (secp256k1, compact-64, LOW-S) ──────────────────────────────────
export function pubFromPriv(priv: string): string { return "0x" + bytesToHex(secp256k1.getPublicKey(hb(priv), true)); }
export function addrFromPriv(priv: string): string { return hash160(secp256k1.getPublicKey(hb(priv), true)); }
export function addrFromPub(pub: string): string { return hash160(hb(pub)); }
export function signSighash(sighashHex: string, priv: string): { sig64: string; pub33: string } {
  // L11 (SIGLEN): enforce a 32-byte digest (parity with verifyDigest/verifySig's length checks). All callers
  // already pass a 32-byte tx sighash / login / SIWC digest; this guarantees the signer can never be handed a
  // truncated or over-long value to sign over (a latent footgun if a future caller drifts).
  if (!/^0x[0-9a-fA-F]{64}$/.test(sighashHex)) throw new Error("sighash must be a 32-byte 0x-hex digest");
  const sig = secp256k1.sign(hb(sighashHex), hb(priv), { lowS: true });
  return { sig64: "0x" + bytesToHex(sig.toCompactRawBytes()), pub33: pubFromPriv(priv) };
}
export function verifySig(sig64: string, pub33: string, sighashHex: string): boolean {
  const s = hb(sig64), p = hb(pub33);
  if (s.length !== 64 || p.length !== 33) return false;
  try { if (secp256k1.Signature.fromCompact(s).hasHighS()) return false; return secp256k1.verify(s, hb(sighashHex), p, { lowS: true }); } catch { return false; }
}
export function buildScriptSig(sig64: string, pub33: string): string { return "0x40" + strip(sig64) + "21" + strip(pub33); }
export function bytesArr(hex: string): number[] { return Array.from(hb(hex)); }

// Cairn off-chain content commitment (matches the board/server item.ts): sorted-key
// compact JSON, single sha256. Lets the wallet post to Cairn with the right hash.
export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(stableStringify).join(",") + "]";
  const o = v as Record<string, unknown>;
  return "{" + Object.keys(o).sort().map((k) => JSON.stringify(k) + ":" + stableStringify(o[k])).join(",") + "}";
}
export function cairnPayloadHash(content: unknown): string {
  return "0x" + bytesToHex(sha256(utf8ToBytes(stableStringify(content))));
}

// "Sign in with CSD" digest — single sha256("cairn-login:"+nonce), the SAME scheme
// the server uses (auth.ts loginDigest). The wallet derives this LOCALLY from the
// nonce and signs only this; it never signs a 32-byte value handed to it by the
// server. A login digest (single sha256) is structurally disjoint from a tx sighash
// (sha256d of a tagged hash), so a malicious/MITM'd API cannot coax a spend
// signature out of the sign-in flow.
export function loginDigest(nonce: string): string {
  return "0x" + bytesToHex(sha256(utf8ToBytes("cairn-login:" + nonce)));
}
