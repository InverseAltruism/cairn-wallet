// Encrypted-at-rest vault. The private key is sealed with AES-256-GCM under a key
// derived from the user's password via PBKDF2-SHA256 (600k iters, per OWASP 2023).
// Wrong password → GCM authentication fails → decrypt throws (no oracle, no partial
// plaintext). The per-vault iteration count is stored in the vault, so raising this
// only affects NEW vaults — existing ones still open at their original count.
// WebCrypto (crypto.subtle) — available in both the browser and Node 22 (so it's
// unit-tested in Node against the same code path).
import { bytesToHex, hexToBytes, randomBytes, utf8ToBytes } from "@noble/hashes/utils";

const SUBTLE = (globalThis.crypto as Crypto).subtle;
const PBKDF2_ITERS = 600_000;
// Floor-clamp on OPEN: refuse to derive a key from a vault claiming an absurdly low
// iteration count. Defeats a stored-params downgrade attack and guards against a
// corrupted/forged vault weakening the KDF. Legitimate vaults are ≥600k.
const MIN_ITERS = 100_000;
// Ceiling on OPEN: a vault (which an attacker who can write chrome.storage controls) must
// not be able to set a huge iteration count that hangs the service worker in PBKDF2. Far
// above any legitimate value (600k); ~50× headroom for future KDF strengthening.
const MAX_ITERS = 30_000_000;
// WebCrypto's BufferSource type is stricter than @noble's Uint8Array<ArrayBufferLike>;
// the bytes are identical at runtime, so cast at the boundary.
const bs = (u: Uint8Array): BufferSource => u as unknown as BufferSource;

export interface Vault { v: 1; iter: number; salt: string; iv: string; ct: string }

async function deriveKey(password: string, salt: Uint8Array, iter: number): Promise<CryptoKey> {
  const base = await SUBTLE.importKey("raw", bs(utf8ToBytes(password)), "PBKDF2", false, ["deriveKey"]);
  return SUBTLE.deriveKey(
    { name: "PBKDF2", salt: bs(salt), iterations: iter, hash: "SHA-256" },
    // extractable:true so the unlocked key can be raw-exported into chrome.storage.session
    // (in-RAM, extension-only, cleared on lock / idle / browser close) and re-imported after an
    // MV3 service-worker restart — otherwise every SW idle-kill would force a fresh password.
    // The raw key never touches disk; the at-rest vault stays AES-GCM encrypted.
    base, { name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"],
  );
}

// Raw-export / re-import the derived AES-GCM key for the session-persist path (above). Round-trips
// the 32 key bytes as hex through chrome.storage.session only.
export async function exportKeyRaw(key: CryptoKey): Promise<string> {
  return bytesToHex(new Uint8Array(await SUBTLE.exportKey("raw", key)));
}
export async function importKeyRaw(hex: string): Promise<CryptoKey> {
  return SUBTLE.importKey("raw", bs(hexToBytes(hex)), { name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
}

// Derive the AES-GCM key from a password + the vault's own salt. The wallet holds
// the returned key in memory WHILE UNLOCKED so it can re-seal a multi-account vault
// on changes (add/remove/rename) WITHOUT retaining the password. The key is bound to
// the salt, so re-sealing keeps the same salt and only rolls the IV.
export async function deriveVaultKey(password: string, saltHex: string, iter: number): Promise<CryptoKey> {
  // Lower floor defeats a stored-params downgrade; UPPER clamp stops an attacker who can
  // write chrome.storage from setting iter huge (e.g. 1e12) to hang unlock/export in PBKDF2.
  if (!Number.isInteger(iter) || iter < MIN_ITERS || iter > MAX_ITERS) throw new Error("vault KDF iteration count out of range");
  let salt: Uint8Array;
  try { salt = hexToBytes(saltHex); } catch { throw new Error("bad password"); } // corrupt salt → uniform error, no raw decode leak
  return deriveKey(password, salt, iter);
}

// Encrypt with an already-derived key + existing salt, rolling a FRESH random IV
// every time (AES-GCM nonce reuse under the same key would be catastrophic).
export async function sealWith(plaintext: string, key: CryptoKey, saltHex: string, iter: number): Promise<Vault> {
  const iv = randomBytes(12);
  const ct = new Uint8Array(await SUBTLE.encrypt({ name: "AES-GCM", iv: bs(iv) }, key, bs(utf8ToBytes(plaintext))));
  return { v: 1, iter, salt: saltHex, iv: bytesToHex(iv), ct: bytesToHex(ct) };
}

// Decrypt with an already-derived key. Throws "bad password" on tag mismatch/corrupt.
export async function openWith(vault: Vault, key: CryptoKey): Promise<string> {
  try {
    const pt = await SUBTLE.decrypt({ name: "AES-GCM", iv: bs(hexToBytes(vault.iv)) }, key, bs(hexToBytes(vault.ct)));
    return new TextDecoder().decode(pt);
  } catch { throw new Error("bad password"); }
}

// Fresh vault from a password (generates the salt). Returns the derived key too so
// the caller can keep re-sealing without re-prompting.
export async function sealNew(plaintext: string, password: string): Promise<{ vault: Vault; key: CryptoKey }> {
  if (!password) throw new Error("password required");
  const salt = randomBytes(16);
  const key = await deriveKey(password, salt, PBKDF2_ITERS);
  const vault = await sealWith(plaintext, key, bytesToHex(salt), PBKDF2_ITERS);
  return { vault, key };
}

export async function seal(plaintext: string, password: string): Promise<Vault> {
  return (await sealNew(plaintext, password)).vault;
}

// Throws "bad password" if the password is wrong (GCM tag mismatch) or vault corrupt.
export async function open(vault: Vault, password: string): Promise<string> {
  return openWith(vault, await deriveVaultKey(password, vault.salt, vault.iter));
}
