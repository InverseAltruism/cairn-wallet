// Seals: a MAC per verified 4,096-header chunk above the release table, under a key derived from the unlocked vault
// key, so a later restore can trust chunks this wallet verified before. A list verifies only as one chain from the
// table hash: each message carries the top of the entry below it. Nothing here reads or writes the store; the
// record is stored in the header store's `meta` (StoreWrite.seals). Design: cairn
// docs/Plans/91-evidence/wallet-wl2-design-2026-11-22.md, sections 2 and 3.
import { hmac } from "@noble/hashes/hmac";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from "@noble/hashes/utils";
import { chunkOf, MAX_CHUNK } from "./headerstore.js";
import { exportKeyRaw } from "./keystore.js";

declare const sealKeyBrand: unique symbol;
/** The 32-byte seal key; only `sealKeyGetter` makes one. */
export type SealKey = Uint8Array & { readonly [sealKeyBrand]: true };

/** The release table's newest entry, which every message names and the first entry's prevTop is. */
export interface SealTable { newest: number; newestHash: string }
/** Stored form: `top` 0x-hex, `work` decimal (chainwork at the top, from the light client's seed below `newest`), `mac` hex. */
export interface SealEntry { k: number; top: string; work: string; mac: string }
/** The `meta` record: entries contiguous from chunkOf(newest) + 1, ascending. */
export interface SealRecord { v: 1; newest: number; list: SealEntry[] }
/** A chunk to seal, or a sealed chunk whose MAC held. */
export interface SealedChunk { k: number; top: string; work: bigint }

const MSG_TAG = utf8ToBytes("cairn-wallet/spv-seal/v1");
const MSG_BYTES = 145;
const WORK_MAX = (1n << 128n) - 1n;
const HASH_RE = /^0x[0-9a-f]{64}$/;
const MAC_RE = /^[0-9a-f]{64}$/;
const WORK_RE = /^(0|[1-9][0-9]{0,38})$/;

/**
 * The key getter: K = HMAC-SHA256(raw vault key, the fixed label), derived from the current vault key at each call
 * and held by no one here, so a lock (which clears the vault key) clears it. Null while locked, or when the vault key
 * changed during the derivation.
 */
export function sealKeyGetter(vaultKey: () => CryptoKey | null): () => Promise<SealKey | null> {
  return async () => {
    const vk = vaultKey();
    if (!vk) return null;
    const raw = hexToBytes(await exportKeyRaw(vk));
    if (vaultKey() !== vk) return null;
    return hmac(sha256, raw, utf8ToBytes("cairn-wallet/spv-seal-key/v1")) as SealKey;
  };
}

const u32be = (n: number): Uint8Array => {
  if (!Number.isSafeInteger(n) || n < 0 || n > 0xffffffff) throw new RangeError(`seal message: ${n} is not a u32`);
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n);
  return b;
};
const hash32 = (h: string): Uint8Array => {
  if (!HASH_RE.test(h)) throw new TypeError(`seal message: ${h} is not a 0x-prefixed lowercase 32-byte hash`);
  return hexToBytes(h.slice(2));
};
const u128be = (w: bigint): Uint8Array => {
  if (w < 0n || w > WORK_MAX) throw new RangeError("seal message: work outside 0..2^128-1");
  const b = new Uint8Array(16);
  for (let i = 15, x = w; i >= 0; i--, x >>= 8n) b[i] = Number(x & 0xffn);
  return b;
};

/** The 145 signed bytes: tag || 0x00 || u32be k || prevTop || top || u128be work || u32be newest || newestHash. */
export function sealMessage(k: number, prevTop: string, top: string, work: bigint, table: SealTable): Uint8Array {
  const m = concatBytes(MSG_TAG, new Uint8Array([0]), u32be(k), hash32(prevTop), hash32(top), u128be(work), u32be(table.newest), hash32(table.newestHash));
  if (m.length !== MSG_BYTES) throw new Error(`seal message is ${m.length} bytes, not ${MSG_BYTES}`);
  return m;
}

const macHex = (key: SealKey, msg: Uint8Array): string => bytesToHex(hmac(sha256, key, msg));

/** The record sealing `chunks`, which must run contiguous and ascending from chunkOf(table.newest) + 1. */
export function sealRecord(key: SealKey, table: SealTable, chunks: readonly SealedChunk[]): SealRecord {
  let prevTop = table.newestHash, next = chunkOf(table.newest) + 1;
  const list = chunks.map((c) => {
    if (c.k !== next++) throw new RangeError(`sealRecord: chunk ${c.k} out of order (expected ${next - 1})`);
    const mac = macHex(key, sealMessage(c.k, prevTop, c.top, c.work, table));
    prevTop = c.top;
    return { k: c.k, top: c.top, work: c.work.toString(), mac };
  });
  return { v: 1, newest: table.newest, list };
}

/**
 * The sealed chunks of a stored record, when it is well formed for `table` and every entry's MAC holds under `key`
 * with prevTop read from the entry below it (the table hash for the first). Else null: the caller ignores the whole
 * list and verifies as without seals. A stored value is validated before it reaches the message, so only a malformed
 * `table` throws.
 */
export function checkSeals(key: SealKey, raw: unknown, table: SealTable): SealedChunk[] | null {
  const r = raw as SealRecord | null;
  if (!r || typeof r !== "object" || r.v !== 1 || r.newest !== table.newest || !Array.isArray(r.list)) return null;
  const first = chunkOf(table.newest) + 1;
  if (r.list.length > MAX_CHUNK - first + 1) return null;
  const out: SealedChunk[] = [];
  let prevTop = table.newestHash;
  for (let i = 0; i < r.list.length; i++) {
    const e = r.list[i] as SealEntry | null;
    if (!e || typeof e !== "object" || e.k !== first + i || typeof e.top !== "string" || !HASH_RE.test(e.top)) return null;
    if (typeof e.work !== "string" || !WORK_RE.test(e.work) || typeof e.mac !== "string" || !MAC_RE.test(e.mac)) return null;
    const work = BigInt(e.work);
    if (work > WORK_MAX) return null;
    if (macHex(key, sealMessage(e.k, prevTop, e.top, work, table)) !== e.mac) return null; // MUTATE_SEAL_MAC
    out.push({ k: e.k, top: e.top, work });
    prevTop = e.top;
  }
  return out;
}
