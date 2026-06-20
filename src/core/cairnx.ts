// CairnX v1 convention — the wallet's OWN isolated copy (like csdtx.ts is for consensus).
// CairnX tokens/names are a deterministic convention over CSD Propose txs in domain
// "cairnx:v1": the tx `uri` is the canonical JSON of a record, `payload_hash` =
// sha256(uri). This module builds + decodes those records LOCALLY — record-building
// is never fetched from the network, so a compromised API can't change what we sign.
// Canonical-JSON + validation rules mirror @inversealtruism/cairnx-core (CONVENTION §3/§4)
// and are fixture-tested byte-for-byte against it (test/cairnx.ts).
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils";

export const CAIRNX_DOMAIN = "cairnx:v1";
export const CAIRNX_PROPOSE_FEE = 25_000_000; // 0.25 CSD — the convention's anchor fee floor
export const TREASURY_ADDR = "0x6b09ce74e6070ebc982ab0fb793a211c4d24f016"; // protocol fee sink (CONVENTION §10)
// v1.6 (cairn doc 24): treasury trade fee 1%→1.5% on offers created at/after V16_HEIGHT, and a maker
// rebate (flat 0.25 CSD + 0.5%, taker→maker) rides bid-answered whole fills. Both are RESOLVER-DERIVED
// (from the offer's creation height + bid link) — the offer RECORD schema is UNCHANGED, so the
// decodeCairnxRecord OFFER_KEYS/gates below are already v1.6-complete and need no change. These helpers
// let the wallet compute the fee/rebate for clear-sign display. Mirror @inversealtruism/cairnx-core.
export const FEE_BPS = 100, FEE_BPS_V16 = 150, REBATE_BPS = 50;
export const REBATE_FLAT = 25_000_000n; // 0.25 CSD
export const V16_HEIGHT = 33_600;       // ACTIVATION — must match cairnx-core types.ts
export const cairnxTradeFee = (want: bigint, bps: number = FEE_BPS): bigint => (want * BigInt(bps) + 9999n) / 10000n;
export const cairnxMakerRebate = (value: bigint): bigint => REBATE_FLAT + (value * BigInt(REBATE_BPS) + 9999n) / 10000n;

// CONVENTION §4 field shapes
const TICKER_RE = /^[A-Z][A-Z0-9]{2,11}$/;
const ADDR_RE = /^0x[0-9a-f]{40}$/;          // records carry LOWERCASE addresses only
const AMOUNT_RE = /^(0|[1-9][0-9]*)$/;       // decimal string, no leading zeros
const HASH_RE = /^0x[0-9a-f]{64}$/;
const NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
// v1.9 ENS-class identity (doc 36). Mirror cairnx-core: PKEY = NAME_RE + "." (ASCII → sort-invariant);
// string-only values ≤256 B; ≤16 keys. PROFILE_RESERVED_KEYS is the WALLET app-layer guard (decision
// §9.4): a profile is cosmetic and must NEVER carry a send target, so the BUILDER refuses these keys.
// (The resolver + decode stay semantics-agnostic — they'd store/render any charset-valid key — so the
// protection lives on the write path here + a clear-sign warning + the UI.)
const PKEY = /^[a-z0-9](?:[a-z0-9.-]{0,30}[a-z0-9])?$/;
const PROFILE_MAX_KEYS = 16, PROFILE_MAX_VALUE_BYTES = 256;
const PROFILE_RESERVED_KEYS = new Set(["addr", "address", "coin"]);
const RESERVED_NAMES = new Set(["csd", "treasury", "admin", "official", "root", "www", "support"]);
const MAX_AMOUNT = (1n << 96n) - 1n;
const MAX_RECORD_BYTES = 512;                // consensus MAX_URI_BYTES
// MUST equal the resolver/codec depth cap (@inversealtruism/csd-codec content.ts) so canonicalJson is
// byte-identical to what the resolver computes. A smaller cap here would make the wallet show RAW for a
// deeply-nested-but-valid record the resolver still executes (audit DEPTH-1/DET-1). 512-byte records
// can't actually nest this deep; the cap is purely a stack-overflow guard, matched across implementations.
const MAX_DEPTH = 256;

// Canonical JSON (csd-codec semantics): sorted keys, no whitespace, undefined dropped,
// depth-capped. Byte-identical to the resolver's form — required for the hash commitment.
export function canonicalJson(v: unknown, depth = 0): string {
  if (depth > MAX_DEPTH) throw new Error("canonicalJson: max nesting depth exceeded");
  if (v === null || typeof v !== "object") { if (v === undefined) return "null"; return JSON.stringify(v); }
  if (Array.isArray(v)) return "[" + v.map((x) => canonicalJson(x, depth + 1)).join(",") + "]";
  const o = v as Record<string, unknown>;
  return "{" + Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => JSON.stringify(k) + ":" + canonicalJson(o[k], depth + 1)).join(",") + "}";
}
export function cairnxPayloadHash(record: unknown): string {
  return "0x" + bytesToHex(sha256(utf8ToBytes(canonicalJson(record))));
}

// True iff a JS string is well-formed UTF-16 (no lone/unpaired surrogate). A lone surrogate has NO
// valid UTF-8 encoding, so its canonical form is UNDEFINABLE across languages: V8 escapes it to ASCII
// `\uXXXX` and accepts, while a raw-UTF-8 resolver (Rust/Python/Go) rejects/mangles it — a consensus
// fork on identical chain bytes. The resolver treats such records as no-ops; mirror that here so the
// wallet never renders a structured action the resolver will ignore. Native primitive where present
// (Node ≥20 / modern V8), manual surrogate scan otherwise. Mirrors cairnx-core records.ts.
function strWellFormed(s: string): boolean {
  const wf = (String.prototype as { isWellFormed?: (this: string) => boolean }).isWellFormed;
  if (typeof wf === "function") return wf.call(s);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {                 // high surrogate: must be followed by a low one
      const n = s.charCodeAt(i + 1);
      if (!(n >= 0xdc00 && n <= 0xdfff)) return false;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {          // lone low surrogate
      return false;
    }
  }
  return true;
}
/** Recursively reject any non-well-formed UTF-16 string anywhere in a decoded record (keys + values). */
function isWellFormedDeep(v: unknown): boolean {
  if (typeof v === "string") return strWellFormed(v);
  if (Array.isArray(v)) return v.every(isWellFormedDeep);
  if (v && typeof v === "object") {
    for (const [k, val] of Object.entries(v)) {
      if (!strWellFormed(k)) return false;
      if (!isWellFormedDeep(val)) return false;
    }
  }
  return true;
}

const parseAmount = (s: unknown, allowZero = false): bigint | null => {
  if (typeof s !== "string" || !AMOUNT_RE.test(s)) return null;
  const v = BigInt(s);
  if (v > MAX_AMOUNT || (v === 0n && !allowZero)) return null;
  return v;
};
const isTicker = (t: unknown): t is string => typeof t === "string" && TICKER_RE.test(t);
const isAddr = (a: unknown): a is string => typeof a === "string" && ADDR_RE.test(a);
const isHash = (h: unknown): h is string => typeof h === "string" && HASH_RE.test(h);
const isName = (n: unknown): n is string => typeof n === "string" && NAME_RE.test(n) && !RESERVED_NAMES.has(n);

// Exact-key allowlists for value-bearing records — MUST match cairnx-core records.ts (v0.1.6, audit M1):
// a decoy extra key (esp. an astral-range key) canonicalizes to different bytes across languages → a
// cross-language fork. Rejecting unknown keys makes such a record a no-op everywhere, and keeps the
// wallet's clear-sign decode in lockstep with what the resolver actually executes.
const onlyKeys = (r: Record<string, unknown>, allowed: ReadonlySet<string>): boolean => Object.keys(r).every((k) => allowed.has(k));
const DEPLOY_KEYS = new Set(["v", "t", "ticker", "name", "decimals", "supply", "mint", "mintLimit"]);
const MINT_KEYS = new Set(["v", "t", "ticker", "amount"]);
const TRANSFER_KEYS = new Set(["v", "t", "ticker", "to", "amount", "memo", "ts"]);
const OFFER_KEYS = new Set(["v", "t", "give", "want", "min", "bid", "taker", "memo", "ts"]);
const BID_KEYS = new Set(["v", "t", "want", "give", "memo", "ts"]);
const NAME_KEYS = new Set(["v", "t", "name", "salt"]);
const NPROFILE_KEYS = new Set(["v", "t", "name", "p"]);

// ── token transfer (the record the wallet's send-token flow signs) ───────────
// uri is EXACTLY {"amount":"<baseUnits>","t":"transfer","ticker":"<TICKER>","to":"<0xaddr>","v":1}
// (canonical key order falls out of canonicalJson). Throws on anything invalid.
export function buildTransfer(p: { ticker: string; amount: string; to: string }): { record: Record<string, unknown>; uri: string; payloadHash: string } {
  const to = String(p.to || "").toLowerCase();
  if (!isTicker(p.ticker)) throw new Error("invalid ticker (A-Z0-9, 3-12 chars, starts with a letter)");
  if (!isAddr(to)) throw new Error("recipient must be a 0x… 20-byte address");
  if (parseAmount(p.amount) === null) throw new Error("amount must be a positive integer of base units");
  const record = { v: 1, t: "transfer", ticker: p.ticker, amount: p.amount, to };
  const uri = canonicalJson(record);
  if (utf8ToBytes(uri).length > MAX_RECORD_BYTES) throw new Error("record too large");
  return { record, uri, payloadHash: cairnxPayloadHash(record) };
}

// ── .csd name records (built + validated ON-DEVICE, like buildTransfer) ───────
export interface BuiltCairnxRecord { record: Record<string, unknown>; uri: string; payloadHash: string }
function buildNameRecord(record: Record<string, unknown>): BuiltCairnxRecord {
  const uri = canonicalJson(record);
  if (utf8ToBytes(uri).length > MAX_RECORD_BYTES) throw new Error("record too large");
  return { record, uri, payloadHash: cairnxPayloadHash(record) };
}
/** name registration / renewal fee by length (base units) — mirrors cairnx-core types.ts, height-gated.
 *  v1.8 (≥ V18_HEIGHT): ≤4 chars = 6.7 CSD premium, ≥5 chars = 3 CSD flat. Below it: the original curve.
 *  `height` is the anchor height (the renewal's expected block). MUST match the resolver mirror exactly. */
export const V18_HEIGHT = 40_000;
// V18-1: a renewal fee built just below V18 but mined at/after it underpays → reject + treasury-fee forfeit.
// Within a small margin below the gate, price the BUILD at V18 (overpay always accepted). Mirrors helpers.js.
export const buildFeeHeight = (tip: number): number => (tip < V18_HEIGHT && tip >= V18_HEIGHT - 5) ? V18_HEIGHT : tip;
export function nameRegFee(name: string, height: number): bigint {
  if (height >= V18_HEIGHT) return name.length <= 4 ? 670_000_000n : 300_000_000n;
  const n = name.length;
  if (n <= 3) return 500_000_000n; if (n === 4) return 200_000_000n; if (n === 5) return 100_000_000n;
  if (n <= 9) return 50_000_000n; return 10_000_000n;
}
/** Front-run-proof commit hash (mirrors cairnx-core nameCommit): binds name+salt+lowercased owner. */
export function nameCommitHash(name: string, salt: string, owner: string): string {
  return cairnxPayloadHash({ t: "cairnx:name:commit:v1", name, salt, owner: String(owner).toLowerCase() });
}
export function buildNameCommit(p: { name: string; salt: string; owner: string }): BuiltCairnxRecord {
  if (!isName(p.name)) throw new Error("invalid name (lowercase a-z 0-9 hyphen, 1-32, not reserved)");
  if (!/^[0-9a-fA-F]{16,128}$/.test(p.salt)) throw new Error("invalid salt");
  if (!isAddr(String(p.owner).toLowerCase())) throw new Error("owner must be a 0x… address");
  return buildNameRecord({ v: 1, t: "ncommit", commit: nameCommitHash(p.name, p.salt, p.owner) });
}
export function buildNameClaim(p: { name: string; salt?: string }): BuiltCairnxRecord {
  if (!isName(p.name)) throw new Error("invalid name (lowercase a-z 0-9 hyphen, 1-32, not reserved)");
  if (p.salt !== undefined && !/^[0-9a-fA-F]{16,128}$/.test(p.salt)) throw new Error("invalid salt");
  return buildNameRecord(p.salt ? { v: 1, t: "name", name: p.name, salt: p.salt } : { v: 1, t: "name", name: p.name });
}
export const buildNameReveal = (p: { name: string; salt: string }): BuiltCairnxRecord => buildNameClaim(p);
export function buildNameRenew(p: { name: string }): BuiltCairnxRecord {
  if (!isName(p.name)) throw new Error("invalid name");
  return buildNameRecord({ v: 1, t: "nrenew", name: p.name });
}
export function buildNameSet(p: { name: string; addr: string }): BuiltCairnxRecord {
  if (!isName(p.name)) throw new Error("invalid name");
  const addr = String(p.addr || "").toLowerCase();
  if (!isAddr(addr)) throw new Error("address must be a 0x… 20-byte address");
  return buildNameRecord({ v: 1, t: "nset", name: p.name, addr });
}
export function buildNameXfer(p: { name: string; to: string }): BuiltCairnxRecord {
  if (!isName(p.name)) throw new Error("invalid name");
  const to = String(p.to || "").toLowerCase();
  if (!isAddr(to)) throw new Error("recipient must be a 0x… 20-byte address");
  return buildNameRecord({ v: 1, t: "nxfer", name: p.name, to });
}
// v1.9 ENS-class identity profile (doc 36). INERT cosmetic metadata — NEVER a send target. The builder
// (the WRITE path) enforces the app-layer invariant (decision §9.4): reject addr/address/coin keys so a
// profile can't be confused for a send address. Charset + caps mirror the resolver; an empty map clears.
export function buildNameProfile(p: { name: string; profile: Record<string, string> }): BuiltCairnxRecord {
  if (!isName(p.name)) throw new Error("invalid name");
  const map = p.profile;
  if (!map || typeof map !== "object" || Array.isArray(map)) throw new Error("profile must be an object");
  const keys = Object.keys(map);
  if (keys.length > PROFILE_MAX_KEYS) throw new Error(`too many profile keys (max ${PROFILE_MAX_KEYS})`);
  for (const k of keys) {
    if (PROFILE_RESERVED_KEYS.has(k)) throw new Error(`profile key "${k}" is not allowed — addresses live in the name record (set-address), not the cosmetic profile`);
    if (!PKEY.test(k)) throw new Error(`invalid profile key "${k}" (lowercase a-z 0-9 . - , 1-32, alnum start/end)`);
    const val = map[k];
    if (typeof val !== "string") throw new Error(`profile value for "${k}" must be a string`);
    if (utf8ToBytes(val).length > PROFILE_MAX_VALUE_BYTES) throw new Error(`profile value for "${k}" too long (max ${PROFILE_MAX_VALUE_BYTES} bytes)`);
  }
  return buildNameRecord({ v: 1, t: "nprofile", name: p.name, p: map });
}

// ── decimals-aware display/entry ─────────────────────────────────────────────
// Token amounts are integer base-unit strings; display = baseUnits / 10^decimals.
// BigInt throughout — never floats — so 8-decimal amounts round-trip exactly.
export function formatUnits(base: unknown, decimals: unknown): string {
  let v: bigint;
  try { v = BigInt(String(base)); } catch { return "?"; }
  if (v < 0n) return "?";
  const d = typeof decimals === "number" && Number.isInteger(decimals) && decimals >= 0 && decimals <= 8 ? decimals : 0;
  if (d === 0) return v.toString();
  const scale = 10n ** BigInt(d);
  const whole = v / scale, frac = v % scale;
  if (frac === 0n) return whole.toString();
  return whole.toString() + "." + frac.toString().padStart(d, "0").replace(/0+$/, "");
}
// Human "1.5" + decimals → base-unit string ("150000000"), or null when the input
// isn't a clean decimal / has more fractional digits than the token allows / overflows.
export function parseUnits(human: string, decimals: number): string | null {
  if (typeof human !== "string") return null;
  const m = /^(\d+)(?:\.(\d+))?$/.exec(human.trim());
  if (!m) return null;
  const d = Number.isInteger(decimals) && decimals >= 0 && decimals <= 8 ? decimals : 0;
  const frac = m[2] ?? "";
  if (frac.length > d) return null; // more precision than the token has
  const v = BigInt(m[1]) * 10n ** BigInt(d) + BigInt(frac.padEnd(d, "0") || "0");
  if (v > MAX_AMOUNT) return null;
  return v.toString();
}

// ── generic record decode (clear-signing) ────────────────────────────────────
// Returns the parsed record ONLY when it would actually take effect on-chain:
// canonical JSON (so the resolver parses the SAME object we display), the
// payload-hash commitment holds (when given), and the §4 schema validates.
// Anything else returns null → the approval window falls back to the raw uri.
// This mirrors cairnx-core parseRecord; "invalid is a no-op" must hold for display
// too, or a dApp could show a structured record the resolver will ignore.
export function decodeCairnxRecord(uri: unknown, payloadHashHex?: unknown): Record<string, unknown> | null {
  if (typeof uri !== "string" || utf8ToBytes(uri).length > MAX_RECORD_BYTES) return null;
  let obj: unknown;
  try { obj = JSON.parse(uri); } catch { return null; }
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) return null;
  try {
    if (canonicalJson(obj) !== uri) return null;
    // the resolver requires the payload-hash commitment — a propose without one (or with a
    // mismatch) can never execute, so it must show RAW, not a convincing structured render
    if (typeof payloadHashHex !== "string" || cairnxPayloadHash(obj).toLowerCase() !== payloadHashHex.toLowerCase()) return null;
  } catch { return null; }
  // Determinism gate (mirrors the resolver): a record carrying any non-well-formed UTF-16 string
  // (lone surrogate) is canonically undefinable across languages → an invalid no-op everywhere. Show
  // it RAW, never a structured render. Runs AFTER the canonical gate (the uri is pure-ASCII `\uXXXX`;
  // the surrogate only exists in the parsed obj).
  if (!isWellFormedDeep(obj)) return null;
  const r = obj as Record<string, unknown>;
  if (r.v !== 1 || typeof r.t !== "string") return null;
  switch (r.t) {
    case "deploy": {
      if (!onlyKeys(r, DEPLOY_KEYS)) return null;
      if (!isTicker(r.ticker)) return null;
      if (r.name !== undefined && (typeof r.name !== "string" || r.name.length > 32)) return null;
      if (typeof r.decimals !== "number" || !Number.isInteger(r.decimals) || r.decimals < 0 || r.decimals > 8) return null;
      if (parseAmount(r.supply) === null) return null;
      if (r.mint !== "open" && r.mint !== "issuer") return null;
      if (r.mint === "open" && parseAmount(r.mintLimit) === null) return null;
      if (r.mint === "issuer" && r.mintLimit !== undefined) return null;
      return r;
    }
    case "mint": {
      if (!onlyKeys(r, MINT_KEYS)) return null;
      if (!isTicker(r.ticker)) return null;
      if (r.amount !== undefined && parseAmount(r.amount) === null) return null;
      return r;
    }
    case "transfer": {
      if (!onlyKeys(r, TRANSFER_KEYS)) return null;
      if (!isTicker(r.ticker) || !isAddr(r.to) || parseAmount(r.amount) === null) return null;
      if (r.memo !== undefined && (typeof r.memo !== "string" || r.memo.length > 64)) return null;
      if (r.ts !== undefined && (typeof r.ts !== "number" || !Number.isSafeInteger(r.ts))) return null;
      return r;
    }
    case "offer": {
      if (!onlyKeys(r, OFFER_KEYS)) return null;
      const g = r.give as Record<string, unknown> | undefined;
      const w = r.want as Record<string, unknown> | undefined;
      if (!g || !w || typeof g !== "object" || Array.isArray(g) || typeof w !== "object" || Array.isArray(w)) return null;
      const gKeys = Object.keys(g).sort().join(",");
      if (gKeys === "amount,ticker") { if (!isTicker(g.ticker) || parseAmount(g.amount) === null) return null; }
      else if (gKeys === "name") { if (!isName(g.name)) return null; }
      else return null;
      const wKeys = Object.keys(w).filter((k) => k !== "payto").sort().join(",");
      if (wKeys === "value") { if (parseAmount(w.value, true) === null) return null; }
      else if (wKeys === "amount,ticker") {
        if (!isTicker(w.ticker) || parseAmount(w.amount, true) === null) return null;
        if (gKeys === "amount,ticker" && w.ticker === g.ticker) return null;
        if (r.min !== undefined) return null;
      } else return null;
      if (w.payto !== undefined && !isAddr(w.payto)) return null;
      if (r.min !== undefined) {
        if (gKeys !== "amount,ticker" || wKeys !== "value") return null;
        const mn = parseAmount(r.min);
        if (mn === null || mn > parseAmount(w.value, true)!) return null;
      }
      if (r.bid !== undefined && !isHash(r.bid)) return null;
      if (r.taker !== undefined && !isAddr(r.taker)) return null;
      if (r.memo !== undefined && (typeof r.memo !== "string" || r.memo.length > 64)) return null;
      if (r.ts !== undefined && (typeof r.ts !== "number" || !Number.isSafeInteger(r.ts))) return null;
      return r;
    }
    case "ocancel": {
      if (r.ticker !== undefined && r.name !== undefined) return null;
      if (r.ticker !== undefined && !isTicker(r.ticker)) return null;
      if (r.name !== undefined && !isName(r.name)) return null;
      if (Object.keys(r).length !== 2 + (r.ticker !== undefined ? 1 : 0) + (r.name !== undefined ? 1 : 0)) return null;
      return r;
    }
    case "bid": {
      if (!onlyKeys(r, BID_KEYS)) return null;
      const w = r.want as Record<string, unknown> | undefined;
      const g = r.give as Record<string, unknown> | undefined;
      if (!w || !g || typeof w !== "object" || Array.isArray(w) || typeof g !== "object" || Array.isArray(g)) return null;
      const wKeys = Object.keys(w).sort().join(",");
      if (wKeys === "amount,ticker") { if (!isTicker(w.ticker) || parseAmount(w.amount) === null) return null; }
      else if (wKeys === "name") { if (!isName(w.name)) return null; }
      else return null;
      if (Object.keys(g).sort().join(",") !== "value" || parseAmount(g.value) === null) return null;
      if (r.memo !== undefined && (typeof r.memo !== "string" || r.memo.length > 64)) return null;
      if (r.ts !== undefined && (typeof r.ts !== "number" || !Number.isSafeInteger(r.ts))) return null;
      return r;
    }
    case "ncommit": {
      if (!isHash(r.commit) || Object.keys(r).length !== 3) return null;
      return r;
    }
    case "name": {
      // Lockstep with cairnx-core: close the last astral-key determinism fork on the value-bearing
      // `name` record (audit M1 / FORK-1). Keeps the wallet's clear-sign decode byte-identical to the
      // canonical resolver — without this, the wallet would render/accept a name record the resolver rejects.
      if (!onlyKeys(r, NAME_KEYS)) return null;
      if (!isName(r.name)) return null;
      if (r.salt !== undefined && (typeof r.salt !== "string" || !/^[0-9a-fA-F]{16,128}$/.test(r.salt))) return null;
      return r;
    }
    case "nxfer": {
      if (!isName(r.name) || !isAddr(r.to) || Object.keys(r).length !== 4) return null;
      return r;
    }
    case "nset": {
      if (!isName(r.name) || !isAddr(r.addr) || Object.keys(r).length !== 4) return null;
      return r;
    }
    case "nrenew": {
      if (!isName(r.name) || Object.keys(r).length !== 3) return null;
      return r;
    }
    case "nprofile": {
      // v1.9 ENS-class identity (doc 36) — lockstep with cairnx-core parseRecord. SHAPE-only validation
      // (semantics-agnostic, like the resolver) so the clear-sign render matches exactly what the resolver
      // executes. The addr/address/coin key BLOCK is on the WRITE path (buildNameProfile) + a clear-sign
      // warning; decode must mirror the resolver, which stores any charset-valid key.
      if (!onlyKeys(r, NPROFILE_KEYS)) return null;
      if (!isName(r.name)) return null;
      const pm = r.p as Record<string, unknown> | undefined;
      if (!pm || typeof pm !== "object" || Array.isArray(pm)) return null;
      const pk = Object.keys(pm);
      if (pk.length > PROFILE_MAX_KEYS) return null;
      for (const k of pk) {
        if (!PKEY.test(k)) return null;
        const val = pm[k];
        if (typeof val !== "string") return null;
        if (utf8ToBytes(val).length > PROFILE_MAX_VALUE_BYTES) return null;
      }
      return r;
    }
    case "tmeta": {
      if (!isTicker(r.ticker)) return null;
      if (typeof r.hash !== "string" || !HASH_RE.test(r.hash)) return null;
      if (Object.keys(r).length !== 4) return null;
      return r;
    }
    default:
      return null; // unknown t — show raw, never a structured guess
  }
}
