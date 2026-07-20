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
  FEE_BPS, FEE_BPS_V16, REBATE_BPS, REBATE_FLAT, V16_HEIGHT, V18_HEIGHT, V25_HEIGHT, V28_HEIGHT,
  CLAIM_WINDOW_BLOCKS_V20, CLAIM_FILL_GRACE_BLOCKS,
  NAME_RE, PKEY, RESERVED_NAMES, TICKER_RE, ADDR_RE, SALT_RE,
  MAX_AMOUNT, MAX_RECORD_BYTES, PROFILE_MAX_KEYS, PROFILE_MAX_VALUE_BYTES,
  // functions
  canonicalJson, payloadHash, tradeFee, nameRegFee, parseRecord,
  parseAmount as parseAmountCanonical,
  // Tier 1 pre-flight value-safety surface (deep-review 2026-07-03), re-exported under the wallet surface.
  // WHO CALLS WHAT (honestly): fillIsSafe + requiredFillOutputs → the wallet's fillOffer preflight
  // (wallet.ts fillOfferPreflight); finalizeWinnerCheck → the approve-path nfinalize gate
  // (popup/clearsign.ts nfinalizeApproveGate, since the deferred-finalize gate); previewFill /
  // isOpenClaimLane / hasLiveClaim → test oracles + the CQ-1 identity-compare (test/cairnx.ts) that pins
  // them to the bundle (isOpenClaimLane/hasLiveClaim are also internal to the vendored fillIsSafe).
  previewFill, fillIsSafe, finalizeWinnerCheck, isOpenClaimLane, hasLiveClaim, requiredFillOutputs,
  // v2.8 open-lane (fclaim) fill fund boundary: the shared fail-closed grant-replay SPV surface the
  // fclaim-lane fillOffer preflight MUST clear before signing (wallet.ts fclaimLanePreflight).
  verifyFillSpv,
  // Plan 70 R2 Option B: the SINGLE fill-boundary term-mismatch verdict (wallet.ts provenTermsMismatch
  // delegates to it), single-sourced in cairnx-core to retire the R1 hand-copy.
  bindOfferTerms,
} from "../vendor/cairnx-spv.js";

// ── app constants (re-exported under the wallet's historical names) ───────────
export const CAIRNX_DOMAIN = DOMAIN;                 // "cairnx:v1"
export const CAIRNX_PROPOSE_FEE = MIN_FEE_PROPOSE;   // 0.25 CSD — the convention's anchor fee floor
export { TREASURY_ADDR, FEE_BPS, FEE_BPS_V16, REBATE_BPS, REBATE_FLAT, V16_HEIGHT, V18_HEIGHT, V25_HEIGHT, V28_HEIGHT, CLAIM_WINDOW_BLOCKS_V20, CLAIM_FILL_GRACE_BLOCKS, NAME_RE, canonicalJson };
// v1.6 fee: the offer RECORD schema is unchanged, so the decode gates are already v1.6-complete; this just
// computes the trade fee for clear-sign display. Byte-identical to cairnx-core (callers pass bigint). (The
// cairnxMakerRebate re-export was removed 2026-07-06 — it had zero callers anywhere; the rebate is computed
// inside the vendored requiredFillOutputs/previewFill, which is what the fillOffer preflight actually uses.)
export const cairnxTradeFee = tradeFee;
// Tier 1 pre-flight helpers, re-exported under the wallet surface (callers named in the import block above).
export { previewFill, fillIsSafe, finalizeWinnerCheck, isOpenClaimLane, hasLiveClaim, requiredFillOutputs, verifyFillSpv, bindOfferTerms };
export const cairnxPayloadHash = (record: unknown): string => payloadHash(record);
export { nameRegFee };
// buildFeeHeight (the approach-the-gate name-fee build heuristic) is VENDORED since cairnx-core 0.1.35 —
// the core owns the gate list, so a future fee tier (V28+) arrives by re-vendoring instead of a hand edit
// here + in the trade UI. A local copy of the gates + margin lived here until 2026-07-06.
export { buildFeeHeight } from "../vendor/cairnx-spv.js";
// M11 (B5b): ONE tip clamp for name-fee pricing, used at BUILD time (wallet.ts renew/renewFee) AND at
// REVIEW time (clearsign.ts fee warning) so the two sides can never disagree — a clamp applied at build
// but not review (or the reverse) manufactures spurious FEE_CHANGED refusals / false fee warnings at a
// fee-gate boundary. The raw tip is an unauthenticated RPC read a hostile proxy can DEFLATE so the wallet
// prices an obsolete cheaper tier: the resolver then rejects the record and the fee BURNS, while the
// deflated tip simultaneously silences the CLEARSIGN-FEE-1 underpayment warning. Clamp UP with the
// PoW-backed persisted floor (M9/B5a bounds its inflation to verifiedTip + slack); an over-tier fee only
// ever overpays (accepted on-chain), never burns. NOT consensus math — a policy compose over the vendored
// buildFeeHeight/nameRegFee, which stay the only fee authorities.
export function feePricingTip(rawTip: number | null | undefined, floor: number | null | undefined): number {
  const t = Number(rawTip), f = Number(floor);
  return Math.max(Number.isFinite(t) && t > 0 ? t : 0, Number.isFinite(f) && f > 0 ? f : 0);
}

// Single source of truth for the .csd name syntax. `isPlainName` is the syntax-only check used before a name
// reaches a URL (NO reserved-name check — that is the registrar's, not the parser's).
export const isPlainName = (n: unknown): n is string => typeof n === "string" && NAME_RE.test(n);
// PROFILE_RESERVED_KEYS is the WALLET app-layer guard (decision §9.4): a profile is cosmetic and must NEVER
// carry a send target, so the BUILDER refuses these keys. (The resolver/decode stay semantics-agnostic.)
const PROFILE_RESERVED_KEYS = new Set(["addr", "address", "coin"]);

// ── thin §4 validators (wrappers over the IMPORTED regexes/limits — used by the on-device builders) ──
// parseAmount is the vendored canonical one since B9 (semantics verified identical: AMOUNT_RE +
// MAX_AMOUNT + allowZero); only the option-object signature is adapted at this one seam.
const parseAmount = (s: unknown, allowZero = false): bigint | null => parseAmountCanonical(s, { allowZero });
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
  // Defense-in-depth backstop at the record builder, parity with the CSD 0x0 burn-guard (node.ts
  // assembleValueTx) and the popup's resolveRecipient refusal: a token transfer to the zero address has
  // no key that can ever spend it (there are no protocol burn semantics), so it is an irrecoverable
  // loss. buildTransfer is popup-only (cairnxTransfer is not a dApp method) and the popup already
  // refuses 0x0 before reaching here, so this adds no friction to any legit flow; it just makes the
  // builder self-protecting against a future caller that skips the UI check. `to` is already lowercased
  // 0x+40hex here, so the exact form suffices.
  if (/^0x0{40}$/.test(to)) throw new Error("refusing to send tokens to the zero address — they would be unrecoverable");
  if (parseAmount(p.amount) === null) throw new Error("amount must be a positive integer of base units");
  const record = { v: 1, t: "transfer", ticker: p.ticker, amount: p.amount, to };
  const uri = canonicalJson(record);
  if (utf8ToBytes(uri).length > MAX_RECORD_BYTES) throw new Error("record too large");
  const ph = cairnxPayloadHash(record);
  // same pre-spend round-trip as buildNameRecord (see there): build-success must imply
  // resolver-acceptance on every fee-bearing record the wallet can anchor.
  if (parseRecord(uri, ph) === null) throw new Error("record fails the resolver's consensus validation (it would anchor the fee and then be ignored): check ticker/amount/recipient");
  return { record, uri, payloadHash: ph };
}

// ── .csd name records (built + validated ON-DEVICE, like buildTransfer) ───────
export interface BuiltCairnxRecord { record: Record<string, unknown>; uri: string; payloadHash: string }
function buildNameRecord(record: Record<string, unknown>): BuiltCairnxRecord {
  const uri = canonicalJson(record);
  if (utf8ToBytes(uri).length > MAX_RECORD_BYTES) throw new Error("record too large");
  const ph = cairnxPayloadHash(record);
  // Pre-spend ROUND-TRIP (Plan 56 A.4 finding 2 / Plan 57 B9): the resolver's parseRecord is the
  // consensus gate, and anything it rejects is NO-OPED on-chain AFTER the anchor fee was paid
  // (the Plan 55 fee-forfeit class: e.g. a profile value with a lone UTF-16 surrogate passed the
  // wallet's own key/length checks but fails the resolver's well-formed-UTF-16 rule). Running our
  // own output through the SAME vendored parser the SPV verifier replays makes build-success
  // imply resolver-acceptance. The SDK's builders are immune by construction (buildRecord
  // round-trips internally); the wallet's on-device twins get the same property here, at their
  // one chokepoint.
  if (parseRecord(uri, ph) === null) throw new Error("record fails the resolver's consensus validation (it would anchor the fee and then be ignored): check for unusual characters in values");
  return { record, uri, payloadHash: ph };
}
// NOTE (2026-07-06): buildNameCommit / nameCommitHash / buildNameReveal / buildNameFinalize were removed —
// they had ZERO callers anywhere in src/ or test/. The wallet's live name flows are renew/set/transfer/
// profile (below) + the on-website registration path; the on-device commit→reveal→finalize builders were
// never wired. Reintroduce them from cairnx-core (nameCommit + t:"ncommit"/"nfinalize" records) if the
// wallet ever grows an on-device registration flow.
export function buildNameClaim(p: { name: string; salt?: string }): BuiltCairnxRecord {
  if (!isName(p.name)) throw new Error("invalid name (lowercase a-z 0-9 hyphen, 1-32, not reserved)");
  if (p.salt !== undefined && !isSalt(p.salt)) throw new Error("invalid salt");
  return buildNameRecord(p.salt ? { v: 1, t: "name", name: p.name, salt: p.salt } : { v: 1, t: "name", name: p.name });
}
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
