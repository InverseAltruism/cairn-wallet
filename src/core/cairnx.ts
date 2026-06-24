// CairnX v1 convention — the wallet's build/decode/display surface.
//
// ★ CONSENSUS RULES ARE IMPORTED, NOT RE-TYPED (shared-core de-dup, cairn docs/Plans/46). The constants,
// fee/name math, canonical-JSON, the §4 regexes and the parse/validate gate now come from the vendored
// cairnx-core bundle (src/vendor/cairnx-spv.js — the SAME deterministic, audited, integrity-pinned esbuild
// of @inversealtruism/cairnx-core that namespv.ts already uses for `resolve`). This file no longer keeps a
// second hand-typed copy of any consensus value — that was the riskiest UNGUARDED mirror (its V16/V18/fee
// constants sat outside param-drift and could drift silently). What stays here is the WALLET's app-layer:
// the on-device record BUILDERS (so record-building is never fetched from the network — a compromised API
// can't change what we sign), the clear-sign decode WRAPPER over the canonical parseRecord, the
// decimals-aware display (formatUnits/parseUnits), and the §9.4 write-path profile guard. Fixture-tested
// byte-for-byte against cairnx-core in test/cairnx.ts. (csdtx.ts remains the DELIBERATE MV3 tx-codec twin;
// cairnx is imported because its canonical source is the very bundle we already ship.)
import { utf8ToBytes } from "@noble/hashes/utils";
import {
  // constants
  DOMAIN, MIN_FEE_PROPOSE, TREASURY_ADDR,
  FEE_BPS, FEE_BPS_V16, REBATE_BPS, REBATE_FLAT, V16_HEIGHT, V18_HEIGHT,
  NAME_RE, PKEY, RESERVED_NAMES, TICKER_RE, ADDR_RE, AMOUNT_RE, SALT_RE,
  MAX_AMOUNT, MAX_RECORD_BYTES, PROFILE_MAX_KEYS, PROFILE_MAX_VALUE_BYTES,
  // functions
  canonicalJson, payloadHash, tradeFee, makerRebate, nameRegFee, parseRecord, nameCommit,
} from "../vendor/cairnx-spv.js";

// ── app constants (re-exported under the wallet's historical names) ───────────
export const CAIRNX_DOMAIN = DOMAIN;                 // "cairnx:v1"
export const CAIRNX_PROPOSE_FEE = MIN_FEE_PROPOSE;   // 0.25 CSD — the convention's anchor fee floor
export { TREASURY_ADDR, FEE_BPS, FEE_BPS_V16, REBATE_BPS, REBATE_FLAT, V16_HEIGHT, V18_HEIGHT, NAME_RE, canonicalJson };
// v1.6 fee/rebate: the offer RECORD schema is unchanged, so the decode gates are already v1.6-complete; these
// just compute the fee/rebate for clear-sign display. Byte-identical to cairnx-core (callers pass bigint).
export const cairnxTradeFee = tradeFee;
export const cairnxMakerRebate = makerRebate;
export const cairnxPayloadHash = (record: unknown): string => payloadHash(record);
export { nameRegFee };
// V18-1 build heuristic (app-side, NOT a resolver rule): a renewal fee built just below V18 but mined at/
// after it underpays → reject + treasury-fee forfeit. Within a small margin below the gate, price the BUILD
// at V18 (overpay always accepted). Mirrors helpers.js buildFeeHeight.
export const buildFeeHeight = (tip: number): number => (tip < V18_HEIGHT && tip >= V18_HEIGHT - 5) ? V18_HEIGHT : tip;

// Single source of truth for the .csd name syntax. `isPlainName` is the syntax-only check used before a name
// reaches a URL (NO reserved-name check — that is the registrar's, not the parser's).
export const isPlainName = (n: unknown): n is string => typeof n === "string" && NAME_RE.test(n);
// PROFILE_RESERVED_KEYS is the WALLET app-layer guard (decision §9.4): a profile is cosmetic and must NEVER
// carry a send target, so the BUILDER refuses these keys. (The resolver/decode stay semantics-agnostic.)
const PROFILE_RESERVED_KEYS = new Set(["addr", "address", "coin"]);

// ── thin §4 validators (wrappers over the IMPORTED regexes/limits — used by the on-device builders) ──
const parseAmount = (s: unknown, allowZero = false): bigint | null => {
  if (typeof s !== "string" || !AMOUNT_RE.test(s)) return null;
  const v = BigInt(s);
  if (v > MAX_AMOUNT || (v === 0n && !allowZero)) return null;
  return v;
};
const isTicker = (t: unknown): t is string => typeof t === "string" && TICKER_RE.test(t);
const isAddr = (a: unknown): a is string => typeof a === "string" && ADDR_RE.test(a);
const isName = (n: unknown): n is string => typeof n === "string" && NAME_RE.test(n) && !RESERVED_NAMES.has(n);
const isSalt = (s: unknown): s is string => typeof s === "string" && SALT_RE.test(s);

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
/** Front-run-proof commit hash — the canonical cairnx-core nameCommit (binds name+salt+lowercased owner). */
export const nameCommitHash = (name: string, salt: string, owner: string): string => nameCommit(name, salt, owner);
export function buildNameCommit(p: { name: string; salt: string; owner: string }): BuiltCairnxRecord {
  if (!isName(p.name)) throw new Error("invalid name (lowercase a-z 0-9 hyphen, 1-32, not reserved)");
  if (!isSalt(p.salt)) throw new Error("invalid salt");
  if (!isAddr(String(p.owner).toLowerCase())) throw new Error("owner must be a 0x… address");
  return buildNameRecord({ v: 1, t: "ncommit", commit: nameCommitHash(p.name, p.salt, p.owner) });
}
export function buildNameClaim(p: { name: string; salt?: string }): BuiltCairnxRecord {
  if (!isName(p.name)) throw new Error("invalid name (lowercase a-z 0-9 hyphen, 1-32, not reserved)");
  if (p.salt !== undefined && !isSalt(p.salt)) throw new Error("invalid salt");
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
// (the WRITE path) enforces the app-layer invariant (decision §9.4): reject addr/address/coin keys. Charset +
// caps mirror the resolver (imported PKEY / PROFILE_MAX_*); an empty map clears the profile.
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

// ── decimals-aware display/entry (app-layer; BigInt throughout — never floats) ─
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
// THE canonical parse/validate gate (cairnx-core parseRecord) — returns the parsed record ONLY when it
// would actually take effect on-chain (canonical JSON, payload-hash commitment, §4 schema, the
// lone-surrogate/decoy-key determinism gates), else null → the approval window falls back to the raw uri.
// "Invalid is a no-op" must hold for display too, or a dApp could show a structured record the resolver
// ignores. We import it (no second copy) and just keep the wallet's permissive signature (uri/hash may be
// any type from a dApp; both must be strings for the record to be real).
export function decodeCairnxRecord(uri: unknown, payloadHashHex?: unknown): Record<string, unknown> | null {
  if (typeof uri !== "string" || typeof payloadHashHex !== "string") return null;
  return parseRecord(uri, payloadHashHex) as Record<string, unknown> | null;
}
