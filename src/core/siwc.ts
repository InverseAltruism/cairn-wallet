// Vendored "Sign in with CSD" (SIWC) message builder + digest. The wallet builds + signs the SIWC
// message LOCALLY (the dApp's own server verifies it); this file MUST stay byte-for-byte in lockstep
// with @inversealtruism/csd-siwc (csd-sdk/packages/siwc) — the SIWC_TAG, HEADER_SUFFIX,
// CSD_CHAIN_MAINNET, the exact line layout, and the digest. A drift would make a wallet-produced
// sign-in fail relying-party verification (or, worse, a cross-language fork). Guarded by test/siwc.ts.
//
//   digest = sha256d( tagged_hash("CSD-SIWC-v1", utf8(message)) )   — disjoint from the tx sighash
//   (tag "CSD_SIG_V1") AND the legacy login digest (single sha256 of "cairn-login:") → a sign-in
//   signature can never be replayed as a transaction or a legacy login.
import { sha256 } from "@noble/hashes/sha256";
import { utf8ToBytes, bytesToHex, concatBytes } from "@noble/hashes/utils";

export const SIWC_TAG = "CSD-SIWC-v1";
export const SIWC_VERSION = "1";
const HEADER_SUFFIX = " wants you to sign in with your Compute Substrate account:";
// CAIP-2 mainnet id = "csd:" + genesis hash first 16 bytes. MUST equal csd-siwc CSD_CHAIN_MAINNET
// (genesis 0x00000052c2821f71b19c3d79dfabfb12d4076ba15d83b47d008e582aad6c0d52).
export const CSD_CHAIN_MAINNET = "csd:00000052c2821f71b19c3d79dfabfb12";

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const NONCE_RE = /^[A-Za-z0-9]{8,}$/;
const hasLF = (s: string) => s.includes("\n") || s.includes("\r");

export interface SiwcFields {
  domain: string; account: string; statement?: string; uri: string; version: string;
  chainId: string; nonce: string; issuedAt: string; expirationTime?: string;
  notBefore?: string; requestId?: string; resources?: string[];
}

/** Build the canonical SIWC message (the exact bytes that get signed). Mirrors csd-siwc exactly. */
export function buildSiwcMessage(f: SiwcFields): string {
  if (!f.domain || hasLF(f.domain)) throw new Error("siwc: bad domain");
  if (!ADDR_RE.test(f.account)) throw new Error("siwc: bad account");
  if (!f.uri || hasLF(f.uri)) throw new Error("siwc: bad uri");
  if (f.version !== SIWC_VERSION) throw new Error("siwc: bad version");
  if (!f.chainId || hasLF(f.chainId)) throw new Error("siwc: bad chainId");
  if (!NONCE_RE.test(f.nonce)) throw new Error("siwc: nonce must be >=8 alphanumeric");
  if (!f.issuedAt || hasLF(f.issuedAt)) throw new Error("siwc: bad issuedAt");
  const stmt = f.statement != null && f.statement !== "" ? f.statement : undefined;
  if (stmt !== undefined && hasLF(stmt)) throw new Error("siwc: statement must be one line");
  for (const v of [f.expirationTime, f.notBefore, f.requestId]) if (v !== undefined && hasLF(v)) throw new Error("siwc: newline in field");
  if (f.resources) for (const r of f.resources) if (hasLF(r)) throw new Error("siwc: newline in resource");

  const lines: string[] = [f.domain + HEADER_SUFFIX, f.account, ""];
  if (stmt !== undefined) lines.push(stmt);
  lines.push("");
  lines.push("URI: " + f.uri);
  lines.push("Version: " + f.version);
  lines.push("Chain ID: " + f.chainId);
  lines.push("Nonce: " + f.nonce);
  lines.push("Issued At: " + f.issuedAt);
  if (f.expirationTime !== undefined) lines.push("Expiration Time: " + f.expirationTime);
  if (f.notBefore !== undefined) lines.push("Not Before: " + f.notBefore);
  if (f.requestId !== undefined) lines.push("Request ID: " + f.requestId);
  if (f.resources !== undefined) { lines.push("Resources:"); for (const r of f.resources) lines.push("- " + r); }
  return lines.join("\n");
}

const taggedHash = (tag: string, msg: Uint8Array): Uint8Array => { const t = sha256(utf8ToBytes(tag)); return sha256(concatBytes(t, t, msg)); };
const sha256d = (b: Uint8Array): Uint8Array => sha256(sha256(b));

/** The SIWC auth digest (0x-hex). Domain-separated from the tx sighash + legacy login digest. */
export function siwcDigest(message: string): string {
  return "0x" + bytesToHex(sha256d(taggedHash(SIWC_TAG, utf8ToBytes(message))));
}

/** host[:port] from a browser origin string; null if not a usable web origin (opaque/"null"/unknown). */
export function originToDomain(origin: string): string | null {
  if (!origin || origin === "unknown") return null;
  try { const u = new URL(origin); return u.host || null; } catch { return null; }
}

/** Format a ms-epoch as RFC3339 UTC, second precision (e.g. "2026-06-17T12:34:56Z"). */
export function rfc3339(ms: number): string { return new Date(ms).toISOString().replace(/\.\d+Z$/, "Z"); }
