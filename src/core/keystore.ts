// Encrypted-at-rest vault. The private key is sealed with AES-256-GCM under a key
// derived from the user's password via PBKDF2-SHA256 (250k iters). Wrong password →
// GCM authentication fails → decrypt throws (no oracle, no partial plaintext).
// WebCrypto (crypto.subtle) — available in both the browser and Node 22 (so it's
// unit-tested in Node against the same code path).
import { bytesToHex, hexToBytes, randomBytes, utf8ToBytes } from "@noble/hashes/utils";

const SUBTLE = (globalThis.crypto as Crypto).subtle;
const PBKDF2_ITERS = 250_000;
// WebCrypto's BufferSource type is stricter than @noble's Uint8Array<ArrayBufferLike>;
// the bytes are identical at runtime, so cast at the boundary.
const bs = (u: Uint8Array): BufferSource => u as unknown as BufferSource;

export interface Vault { v: 1; iter: number; salt: string; iv: string; ct: string }

async function deriveKey(password: string, salt: Uint8Array, iter: number): Promise<CryptoKey> {
  const base = await SUBTLE.importKey("raw", bs(utf8ToBytes(password)), "PBKDF2", false, ["deriveKey"]);
  return SUBTLE.deriveKey(
    { name: "PBKDF2", salt: bs(salt), iterations: iter, hash: "SHA-256" },
    base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"],
  );
}

export async function seal(plaintext: string, password: string): Promise<Vault> {
  if (!password) throw new Error("password required");
  const salt = randomBytes(16), iv = randomBytes(12);
  const key = await deriveKey(password, salt, PBKDF2_ITERS);
  const ct = new Uint8Array(await SUBTLE.encrypt({ name: "AES-GCM", iv: bs(iv) }, key, bs(utf8ToBytes(plaintext))));
  return { v: 1, iter: PBKDF2_ITERS, salt: bytesToHex(salt), iv: bytesToHex(iv), ct: bytesToHex(ct) };
}

// Throws "bad password" if the password is wrong (GCM tag mismatch) or vault corrupt.
export async function open(vault: Vault, password: string): Promise<string> {
  const key = await deriveKey(password, hexToBytes(vault.salt), vault.iter);
  try {
    const pt = await SUBTLE.decrypt({ name: "AES-GCM", iv: bs(hexToBytes(vault.iv)) }, key, bs(hexToBytes(vault.ct)));
    return new TextDecoder().decode(pt);
  } catch { throw new Error("bad password"); }
}
