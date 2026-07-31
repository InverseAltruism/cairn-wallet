// Pure clear-signing formatters for the approval window — NO DOM / chrome, so they're unit-testable
// (the high-stakes "what am I signing?" layer). approve.ts imports these and only owns the DOM glue.
import { decodeCairnxRecord, CAIRNX_DOMAIN, CAIRNX_PROPOSE_FEE, nameRegFee, buildFeeHeight, feePricingTip, formatUnits, TREASURY_ADDR, V25_HEIGHT, V28_HEIGHT, CLAIM_WINDOW_BLOCKS_V20, FEE_BPS_V16, CONF_TOKEN_FILL, finalizeWinnerCheck } from "../core/cairnx.js";
// the v2.5 registration-window constants are vendored but not re-exported by core/cairnx.ts — take
// them straight from the bundle (same reviewed bytes the resolver replays; typed in cairnx-spv.d.ts)

// WYSIWYS-BIDI-1: neutralize Unicode bidi-override + zero-width / BOM controls BEFORE HTML-escaping, so a
// dApp can't visually REORDER or HIDE characters in a displayed field (making a name/address/memo read
// differently than the bytes that get signed). Rendered as a visible \uXXXX token — NOT silently stripped —
// so the user SEES that something is off. Applied inside escapeHtml so EVERY displayed field is covered;
// addresses/hashes/amounts are regex-constrained and never contain these, so honest fields are unaffected.
// bidi overrides/isolates (U+202A–202E, U+2066–2069, U+200E/200F, U+061C) + zero-width/BOM (U+200B–200D, U+FEFF)
const CONTROL_CHARS = /[\u202A-\u202E\u2066-\u2069\u200B-\u200F\u061C\uFEFF]/g;
const neutralizeControls = (s: string): string =>
  s.replace(CONTROL_CHARS, (c) => `\\u${c.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")}`);
export const escapeHtml = (s: string): string =>
  neutralizeControls(String(s)).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

// The SINGLE source of truth for "addresses this account has previously PAID" — used by the first-time /
// address-poisoning (look-alike) check on EVERY send surface (CSD send, token send, dApp send/fillOffer/
// propose-with-outputs). Previously three copies of this filter had drifted (send-only vs send|tokenSend vs
// send|fillOffer), so the same recipient could be flagged first-time on one path and silent on another
// (audit NSPV-POISON-FILTERS). Returns lower-cased addresses; callers compare case-insensitively.
export function paidRecipients(history: unknown): string[] {
  return (Array.isArray(history) ? history : [])
    .filter((t: any) => t && (t.type === "send" || t.type === "tokenSend" || t.type === "fillOffer"))
    .map((t: any) => String(t.to || "").toLowerCase())
    .filter(Boolean);
}

// Surface a fee in CSD and flag an unusually large one so a phishing site can't slip a huge fee past
// a user skimming the dialog. propose min is 0.25 CSD; >5 CSD is odd.
const FEE_WARN = 5 * 1e8;

// Coerce a base-unit value for DISPLAY: a malicious/garbage value renders "invalid amount", never
// "NaN CSD" — which a user skimming the clear-signing dialog might approve as a meaningless amount. C-WL5
export function fmtCsd(raw: any): string { const n = Number(raw); return Number.isFinite(n) ? `${n / 1e8} CSD` : "invalid amount"; }
// BigInt-safe variant for canonical record amounts (offer/bid `value` is a base-unit STRING up to
// 2^96): Number() would lose precision above 2^53, so format the exact integer via BigInt. C-WL5
export function fmtCsdBig(raw: any): string {
  let v: bigint;
  try { v = BigInt(String(raw)); } catch { return "invalid amount"; }
  if (v < 0n) return "invalid amount";
  const frac = (v % 100000000n).toString().padStart(8, "0").replace(/0+$/, "");
  return `${(v / 100000000n).toString()}${frac ? "." + frac : ""} CSD`;
}
// Finite base-unit number for sums / balance-after math (garbage → 0; the tx won't build anyway —
// node.send/sendMany hard-reject non-numeric amounts, so this only keeps the DISPLAY sane).
export function baseVal(raw: any): number { const n = Number(raw); return Number.isFinite(n) ? n : 0; }
// Locale-grouped base-units → CSD display (max 4 fraction digits, NO unit suffix) — the one format
// the popup + approval window share for balance / balance-after lines. fmtCsd above stays the
// exact-value formatter for amounts/fees; this one is for at-a-glance balances.
export function fmtBalance(base: number): string { return (base / 1e8).toLocaleString(undefined, { maximumFractionDigits: 4 }); }
// The zero address is the un-spendable burn sink (and, on an nset, the V23 "un-point" sentinel).
// 0x-OPTIONAL by design: resolver/record fields can carry bare-hex, and the stricter 0x-required
// variant that lived in popup.ts silently missed those. One test, one threat model (3 former sites).
export const isZeroAddr = (a: unknown): boolean => /^(0x)?0{40}$/i.test(String(a ?? ""));

// M15 / WYSIWYS-TRUNC-2 (B5i): capped-and-LOUD truncation for dApp-supplied FREE TEXT (uri, ids, claim
// text). Unbounded text under the sticky Approve button can scroll the money rows and the cost line out
// of view, turning the clear-sign into a rubber stamp. Same posture as renderOutputs (WYSIWYS-TRUNC-1):
// never a quiet ellipsis - the marker states the cap AND the real length, so a hidden tail is impossible
// to miss. Truncate-then-escape (the established idiom: a control char can never split mid-entity).
// dApp-text allowlist/reputation machinery was considered and DECLINED (Plan 71 section 8, decline 7).
export function truncLoud(s: unknown, cap: number): string {
  const str = String(s ?? "");
  if (str.length <= cap) return escapeHtml(str);
  return `${escapeHtml(str.slice(0, cap))}<b class="err"> [truncated: showing the first ${cap} of ${str.length} characters]</b>`;
}

// G9 (B8w): the display cap for on-chain DOMAIN fields tracks the node's consensus byte cap
// (MAX_DOMAIN_BYTES = 128; csd-sdk codec params + node params). A valid domain is <= 128 UTF-8 bytes, so
// it is at most 128 characters, and this char cap therefore never loudly-truncates a valid domain (the
// old 64 clipped legitimate 65-to-128-byte domains). Single-sourced so the two domain describe() sites
// cannot drift; the uri cap stays the literal 512 at its own site (MAX_URI_BYTES) for the same reason.
const DOMAIN_CAP = 128;

// W8 + F12 (B5g): token amounts on the popup's own send surfaces render BOTH scales, single-sourced here.
// The human-scaled number rides resolver-served `decimals` (untrusted: a decimals lie rescales it by up to
// 10^8, and the balance guard compares against the SAME resolver's `available`, so it is no backstop),
// while the base-unit integer is the value that actually gets SIGNED. Neither scale may appear alone:
// human-only can hide a rescale, base-only mismatches the "5 TOK" idiom every other panel uses (F12).
export function tokenAmountBothScales(base: unknown, decimals: unknown, ticker: unknown): string {
  return `${formatUnits(base, decimals)} ${String(ticker)} = ${String(base)} base units`;
}

// M3 (B5g): the token-fill debit preview is a RESOLVER-SERVED number (wallet.ts tokenFillQuote re-reads
// the same single offer service that shaped the fill; no SPV, no second source). The copy must therefore
// ATTRIBUTE the number to the offer service, never assert it as a first-person debit ("You will pay").
// Re-framing only, by decision: a second price source for a display string was DECLINED as
// disproportionate (Plan 71 section 8, decline 6); the real number is bound at the fund boundary.
export function tokenQuoteHtml(q: any): string {
  if (!(q && q.ok)) return `<b class="err">⚠ could not compute the token debit (${escapeHtml(String(q?.error || "offer unavailable"))}). Do NOT approve unless you have verified the exact token + amount on the site/explorer.</b>`;
  return `<b>Per the offer service, filling this debits ${escapeHtml(String(q.total))} base units of ${escapeHtml(String(q.ticker))}</b> <span class="dim">(${escapeHtml(String(q.amount))} ask + ${escapeHtml(String(q.fee))} fee${q.estimated ? ", estimated" : ""})</span> - the wallet cannot verify this number; confirm the token + amount on the site/explorer before approving.`;
}

// M14 (B5h): a revealClaim PUBLISHES the decrypted preimage of an earlier sealed commit - the user must
// see WHICH secret goes public, not 18 characters of txid. The record comes from the wallet's own
// sealedClaims store (already in READ_ONLY_METHODS; a local, vault-decrypted read - no network). Pure
// over the looked-up record so it is unit-testable; approve.ts wires the live lookup (fillRevealPreview).
export function revealPreviewHtml(rec: { domain?: unknown; claim?: unknown; failed?: boolean } | null | undefined): string {
  if (rec && rec.failed === true) return `<b class="err">⚠ could not load the sealed claim for preview - approving still PUBLISHES whatever this txid seals. Only approve if you know which claim it is.</b>`;
  if (!rec) return `<b class="err">⚠ the active account holds NO sealed claim with this txid - there is nothing to reveal here, and approving will fail without publishing anything. If you expected a reveal, check you are on the account that sealed it.</b>`;
  const domain = `domain: <code>${escapeHtml(String(rec.domain ?? "csd:sealed"))}</code>`;
  if (typeof rec.claim !== "string") return `${domain}<br><b class="err">⚠ the sealed text could not be decrypted for preview - approving still PUBLISHES it. Only approve if you know which claim this txid seals.</b>`;
  return `approving makes this PUBLIC:<br>${domain}<br>claim: <code>${truncLoud(rec.claim, 300)}</code>`;
}

// WYSIWYS-TRUNC-1: render value outputs for clear-sign. Caps visible rows so the fee/total/buttons can't be
// scrolled out of the window, but makes truncation LOUD and discloses the HIDDEN recipients' TOTAL — a dApp
// must never be able to hide where funds go behind a quiet "…and N more". Single source for the three
// fund-moving describe() branches (send / fillOffer / propose-with-outputs), so the rendering can't drift.
export function renderOutputs(outs: any[], shown = 12): string {
  const list = Array.isArray(outs) ? outs : [];
  const rows = list.slice(0, shown).map((o: any) => `→ <code>${escapeHtml(String(o.to))}</code> &nbsp;<b>${fmtCsd(o.value)}</b>`).join("<br>");
  if (list.length <= shown) return rows;
  const hidden = list.slice(shown);
  const hiddenTotal = hidden.reduce((a: number, o: any) => a + baseVal(o.value), 0);
  return rows + `<br><b class="err">⚠ ${hidden.length} more recipient(s) NOT shown here — ${fmtCsd(hiddenTotal)} to addresses you cannot see. Only approve if you fully trust this site.</b>`;
}

export function feeLine(raw: number, fallback = 0): string {
  const fee = Number(raw || fallback);
  if (!Number.isFinite(fee)) return `fee: <span class="err">invalid amount</span>`;
  const warn = fee > FEE_WARN ? ` <span class="err">⚠ unusually large fee</span>` : "";
  return `fee: ${fee / 1e8} CSD${warn}`;
}

// A propose's dApp-supplied `expiresEpoch` IS signed (csdtx.ts u64) but was never shown — a site could
// commit a record that stays claimable for years past what the user expects. Render it humanized: an
// epoch = 30 blocks ≈ 60 min, so 24 epochs ≈ 1 day. When the current epoch is known (approve.ts fills
// it from the node tip) we show the remaining window from NOW and WARN past a year-plus horizon
// (mirrors the FEE_WARN pattern); otherwise we show the raw epoch alone (the exact signed value).
const EXPIRY_WARN_EPOCHS = 100000; // epochs past current ≈ >11 years — unusually long for a propose
function humanEpochs(epochs: number): string {
  const days = epochs * 30 * 120 / 86400; // 30 blocks/epoch · 120s/block / 86400s/day = epochs/24
  if (days < 1) return `~${Math.max(1, Math.round(days * 24))} h`;
  if (days < 365) return `~${Math.round(days)} day(s)`;
  return `~${(days / 365).toFixed(1)} year(s)`;
}
export function expiryLine(expiresEpoch: unknown, currentEpoch?: unknown): string {
  if (expiresEpoch === undefined || expiresEpoch === null) return "";
  const e = Number(expiresEpoch);
  if (!Number.isFinite(e) || !Number.isInteger(e) || e < 0) return `expires: <span class="err">invalid epoch</span>`;
  const cur = Number(currentEpoch);
  if (Number.isFinite(cur) && Number.isInteger(cur) && cur >= 0) {
    const left = e - cur;
    const warn = left > EXPIRY_WARN_EPOCHS ? ` <span class="err">⚠ unusually long claim window</span>` : "";
    if (left <= 0) return `expires: epoch ${e} <span class="err">(already past — this record would be a no-op)</span>`;
    return `expires: epoch ${e} (in ${humanEpochs(left)}, current epoch ${cur})${warn}`;
  }
  return `expires: epoch ${e}`;
}

// ── CairnX clear-signing: structured rendering of cairnx:v1 records ──────────
// A cairnx propose's `uri` IS the action (token transfer, offer, name claim…). Showing it
// as a raw JSON blob makes users rubber-stamp; decode it and show the fields instead —
// for BOTH wallet-initiated and dApp-initiated proposes. decodeCairnxRecord only returns
// a record that is canonical + hash-committed + schema-valid (anything else is a resolver
// no-op), so what we render is exactly what the convention will execute. Unknown/invalid
// shapes return null → the caller falls back to the raw uri.
// Token amounts are shown in BASE UNITS (decimals are resolver state — the offline
// approval window can't trust a site-supplied value), explicitly labeled as such.
const esc = (v: unknown) => escapeHtml(String(v));
const baseAmt = (v: unknown) => `<b>${esc(v)}</b> <span class="dim">base units</span>`;
function sideStr(s: any): string {
  if (s && typeof s === "object" && "name" in s) return `name <code>${esc(s.name)}.csd</code>`;
  if (s && typeof s === "object" && "value" in s) return fmtCsdBig(s.value);
  return `${baseAmt(s?.amount)} of <b>${esc(s?.ticker)}</b>`;
}
export function cairnxDescribe(uri: unknown, payloadHash?: unknown): string | null {
  const r = decodeCairnxRecord(uri, payloadHash);
  if (!r) return null;
  const memo = r.memo !== undefined ? `<br>memo: <code>${esc(r.memo)}</code>` : "";
  switch (r.t) {
    case "transfer":
      return `<b>CairnX token transfer</b><br>token: <b>${esc(r.ticker)}</b><br>amount: ${baseAmt(r.amount)}<br>to: <code>${esc(r.to)}</code>${memo}`;
    case "deploy": {
      const limit = r.mint === "open" ? ` · mint limit ${esc(r.mintLimit)}/tx` : "";
      // N22 counter-case (B5g): THIS record's decimals are part of the signed bytes (schema: integer 0..8),
      // so scaling the supply by them is proven-value-derived - the one token surface where a human scale
      // cannot be lied into existence. Everywhere else decimals are resolver state and base units stay
      // the authoritative render.
      const supplyHuman = ` (= ${esc(formatUnits(r.supply, r.decimals))} at ${esc(r.decimals)} decimals)`;
      return `<b>CairnX token deploy</b><br>ticker: <b>${esc(r.ticker)}</b>${r.name !== undefined ? ` (${esc(r.name)})` : ""}<br>supply: ${baseAmt(r.supply)}${supplyHuman} · decimals: ${esc(r.decimals)}<br>minting: ${esc(r.mint)}${limit}`;
    }
    case "mint":
      return `<b>CairnX token mint</b><br>token: <b>${esc(r.ticker)}</b><br>amount: ${r.amount !== undefined ? baseAmt(r.amount) : `<span class="dim">default lot</span>`}`;
    case "offer": {
      const extras = (r.min !== undefined ? `<br>partial fills from: ${baseAmt(r.min)}` : "")
        + (r.taker !== undefined ? `<br>only fillable by: <code>${esc(r.taker)}</code>` : "")
        + (r.bid !== undefined ? `<br>accepts bid: <code>${esc(r.bid)}</code>` : "")
        + ((r.want as any)?.payto !== undefined ? `<br>paid to: <code>${esc((r.want as any).payto)}</code>` : "");
      return `<b>CairnX offer</b> — escrows what you give until filled/cancelled<br>give: ${sideStr(r.give)}<br>want: ${sideStr(r.want)}${extras}${memo}`;
    }
    case "bid":
      return `<b>CairnX bid</b><br>bidding: ${sideStr(r.give)}<br>for: ${sideStr(r.want)}${memo}`;
    case "ocancel": {
      const scope = r.ticker !== undefined ? `your open <b>${esc(r.ticker)}</b> offers` : r.name !== undefined ? `your open offers for <code>${esc(r.name)}.csd</code>` : `<b>ALL</b> your open offers`;
      return `<b>CairnX cancel offers</b><br>cancels ${scope} (escrow returns to you)`;
    }
    case "ncommit":
      // step titles mirror the site's flow language (① commit ② reserve ③ finalize & pay), so the
      // approval window and the page can never disagree about where the user is in the journey.
      return `<b>.csd registration — step 1 of 3 (commit)</b> — a sealed, front-run-proof claim (revealed next)<br>commit: <code>${esc(r.commit)}</code>`;
    case "name":
      return `<b>${r.salt !== undefined ? ".csd registration — step 2 of 3 (reserve, free)" : ".csd name claim"}</b><br>name: <code>${esc(r.name)}.csd</code>${r.salt !== undefined ? `<br><span class="dim">reveals a prior commit</span>` : ""}<br><span class="dim">at the v2.5 upgrade this reveal is free (reserves the name); the registration fee is charged at the final step, and only if you win — so a lost race never charges the fee.</span>`;
    case "nfinalize":
      return `<b>.csd registration — step 3 of 3 (finalize &amp; pay)</b><br>name: <code>${esc(r.name)}.csd</code><br>completes your reservation and pays the fee shown below (the registration fee, or the decaying recapture premium for a lapsed name). Only the winner of the name pays; charged once — a lost race is never charged.`;
    case "nxfer":
      return `<b>.csd name transfer</b><br>name: <code>${esc(r.name)}.csd</code><br>to: <code>${esc(r.to)}</code>`;
    case "nset": {
      // QA #4: a zero-address nset is the V23 "un-point" sentinel, NOT a send to 0x0 — render the clear
      // semantics so the clear-sign is honest. The wallet can't know the landing height at sign time, so
      // state both effects + the backstop (sends to a 0x0-resolving name are hard-refused regardless).
      if (isZeroAddr(r.addr)) {
        return `<b>.csd un-point (clear address record)</b><br>clears the resolver record on <code>${esc(r.name)}.csd</code> — at the V23 upgrade it falls back to its owner and drops out of your primary name. <span class="dim">Before V23 it would set the literal zero address; either way the wallet refuses any send to a 0x0-resolving name.</span>`;
      }
      return `<b>.csd name → address record</b><br><code>${esc(r.name)}.csd</code> resolves to <code>${esc(r.addr)}</code>`;
    }
    case "nrenew":
      return `<b>.csd name renewal</b><br>extends the lease on <code>${esc(r.name)}.csd</code>`;
    case "nprofile": {
      // v1.9 ENS-class identity (doc 36). COSMETIC profile — does NOT change where funds go. Show every
      // key/value being set (escaped + truncated), "clears it" for an empty map, and WARN if a cosmetic
      // field is named like an address (a dApp could try to dress a profile value up as a send target).
      const pm = (r.p && typeof r.p === "object" ? r.p : {}) as Record<string, unknown>;
      const keys = Object.keys(pm);
      if (!keys.length) return `<b>.csd profile</b> — <b>clears</b> the identity profile on <code>${esc(r.name)}.csd</code><br><span class="dim">cosmetic only · does not change where funds go</span>`;
      const rows = keys.map((k) => `${esc(k)}: <code>${esc(String((pm as Record<string, unknown>)[k]).slice(0, 120))}</code>`).join("<br>");
      // defense-in-depth (Gate-3 INFO): warn on a reserved key NAME *or* any value that LOOKS like an
      // address (0x+40hex under ANY key) — a dApp must not be able to dress a cosmetic profile field up as
      // a send target. (Funds can never route through the profile regardless — this is purely to alert the user.)
      const flagKey = keys.find((k) => k === "addr" || k === "address" || k === "coin" || /0x[0-9a-fA-F]{40}/.test(String((pm as Record<string, unknown>)[k])));
      const warn = flagKey ? `<br><b class="err">⚠ this profile's “${esc(flagKey)}” field is cosmetic text, NOT a send address. Funds always go to the name's verified record, never the profile.</b>` : "";
      return `<b>.csd identity profile</b> — cosmetic metadata on <code>${esc(r.name)}.csd</code> (does NOT change where funds go)<br>${rows}${warn}`;
    }
    case "tmeta":
      return `<b>CairnX token metadata</b> (issuer-only)<br>token: <b>${esc(r.ticker)}</b><br>content: <code>${esc(r.hash)}</code>`;
    case "fclaim":
      // B5h (audit LOW): the v2.8 open-lane claim. Without this case a live V28 reservation fell through
      // to the raw canonical-JSON fallback - the rubber-stamp failure mode this function exists to
      // prevent. Payment-free like the legacy claim; the hold rides the carrying Propose's expiry
      // (surfaced by the expiry line below the record).
      return `<b>Reserve an open offer</b> - v2.8 open-lane claim. This <b>moves no money</b>: it reserves the offer so only you can fill it while the hold lasts (the hold rides this proposal's expiry, shown below); you pay only when you complete the purchase.<br>offer: <code>${esc(r.offer)}</code>`;
    default:
      return null;
  }
}

export function describe(r: any): string {
  const p = r.params || {};
  if (r.method === "connect" || r.method === "getAddress" || r.method === "requestPermissions") return "<b>Connect</b> — grant this site permission to see your address (no transaction, no funds move).";
  if (r.method === "signin") return "<b>Sign in with CSD</b> — prove your address (no transaction, no funds move).";
  // Audience-bound SIWC. The audience is the REAL requesting site (origin), bound into the signed
  // message; show it prominently so the user sees exactly which site they authenticate to. If the
  // page declared a different domain than its origin, warn — the wallet will refuse it.
  if (r.method === "signinWithCsd") {
    const aud = (() => { try { return new URL(String(r.origin)).host; } catch { return String(r.origin || "this site"); } })();
    const nonce = String(p.nonce ?? "");
    const nshort = nonce.length > 16 ? nonce.slice(0, 8) + "…" + nonce.slice(-4) : nonce;
    const stmt = p.statement != null && String(p.statement) !== "" ? `<br>“${escapeHtml(String(p.statement))}”` : "";
    const expS = Math.min(3600, Math.max(60, Math.floor(Number(p.expirationSecs) || 600)));
    const mism = p.domain !== undefined && String(p.domain) !== aud
      ? `<br><b class="err">⚠ this page asked to sign in as “${escapeHtml(String(p.domain))}”, but you are on “${escapeHtml(aud)}” — sign-in will be refused.</b>` : "";
    // Surface the rest of the SIGNED message the site controls — previously hidden (audit SIWC-RESOURCES,
    // SIWC-URI): a dApp can embed claims (e.g. resources) the user would otherwise sign blind.
    const uriLine = p.uri != null && String(p.uri) !== "" ? `<br><span class="dim">uri: ${escapeHtml(String(p.uri))}</span>` : "";
    const resList = Array.isArray(p.resources) && p.resources.length
      ? `<br><span class="dim">resources (${p.resources.length}): ${p.resources.slice(0, 10).map((x: any) => escapeHtml(String(x).slice(0, 256))).join(" · ")}</span>` : "";
    const reqLine = p.requestId != null && String(p.requestId) !== "" ? `<br><span class="dim">request id: ${escapeHtml(String(p.requestId))}</span>` : "";
    const nbfLine = p.notBeforeSecs != null && Number(p.notBeforeSecs) > 0 ? `<br><span class="dim">not valid before: ~${Math.floor(Number(p.notBeforeSecs))}s from now</span>` : "";
    return `<b>Sign in to <code>${escapeHtml(aud)}</code></b> — prove your address to this site. <b>No transaction, no funds move.</b>${stmt}`
      + `<br><span class="dim">audience: ${escapeHtml(aud)} · nonce ${escapeHtml(nshort)} · expires in ~${expS}s</span>${uriLine}${resList}${reqLine}${nbfLine}${mism}`;
  }
  // Clear-signing: show EVERYTHING the site controls and the chain will commit —
  // not just domain+fee. payloadHash/uri are dApp-supplied and were previously hidden.
  if (r.method === "propose") {
    // A proposal MAY carry value outputs (e.g. a CairnX protocol fee to its treasury). The wallet
    // cannot verify a recipient is a "legit fee" — so these are shown NEUTRALLY as funds leaving
    // the wallet, capped + truncated, with the SAME first-time/look-alike (address-poisoning)
    // warning as Send (#send-warn, populated by approve.ts). This defeats a malicious site that
    // tries to disguise a payout to itself as a "fee".
    const outs = Array.isArray(p.outputs) ? p.outputs : [];
    const total = outs.reduce((a: number, o: any) => a + baseVal(o.value), 0);
    const rows = renderOutputs(outs);
    const xfer = (outs.length
      ? `<br><b>⚠ this proposal also transfers funds OUT of your wallet:</b><br>${rows}<br>total out: <b>${fmtCsd(total)}</b>`
      : "")
      + `<div id="send-warn" class="err" style="margin-top:8px" hidden></div>`;   // NXFER-POISON-DROP: the poisoning mount renders even when a cairnx repoint (nxfer/nset) carries no CSD outputs
    // cairnx:v1 proposes are ACTIONS (token transfer / offer / name claim…): decode the
    // record and clear-sign its fields instead of a raw JSON blob. Falls through to the
    // raw uri for anything that doesn't decode (which the resolver would no-op anyway).
    // The dApp-supplied expiry is part of the signed bytes — surface it humanized in BOTH branches.
    const exp = p.expiresEpoch !== undefined ? `<br>${expiryLine(p.expiresEpoch, r.currentEpoch)}` : "";
    if (String(p.domain) === CAIRNX_DOMAIN) {
      const cx = cairnxDescribe(p.uri, p.payloadHash);
      if (cx) {
        // CLEARSIGN-FEE-1: a dApp-built .csd registration/renewal that UNDERPAYS the length-graded fee is a
        // silent fund-loss-with-no-benefit (the fee leaves the wallet, but the resolver no-ops the underpaid
        // record so the name is NOT registered/renewed). Warn loudly when the treasury fee output is below the
        // current price. The wallet's OWN Renew button always prices correctly (WL-FEE-FREEZE-1); this guards
        // the third-party-built path. Needs the live tip (threaded from approve.ts); skipped when offline.
        let feeWarn = "";
        const rec = decodeCairnxRecord(p.uri, p.payloadHash);
        // under v2.5 the `name` reveal is PAYMENT-FREE (the fee moves to `nfinalize`), so the fee-bearing record
        // is nrenew, nfinalize, or a PRE-v2.5 `name`. An underpaid nfinalize burns exactly like an underpaid
        // pre-v2.5 registration (the fee leaves, the name is not registered), so it gets the same loud warning.
        // M11 (B5b): the review-side tip is clamped with the PoW-backed floor via the ONE shared helper
        // (cairnx.ts feePricingTip) — the same clamp the build sites apply — so a deflating RPC cannot
        // price a cheaper tier here while silencing this very warning. Floor-only (tip read failed but a
        // floor exists) still arms the warning; both absent keeps today's skip-when-offline behavior.
        const tipNow = r.currentTip != null || Number(r.tipFloor) > 0 ? feePricingTip(r.currentTip, r.tipFloor) : null;
        const feeBearing = !!rec && typeof rec.name === "string" && tipNow != null &&
          (rec.t === "nrenew" || rec.t === "nfinalize" || (rec.t === "name" && tipNow < V25_HEIGHT));
        if (feeBearing && rec) {
          try {
            const paid = outs.filter((o: any) => String(o.to).toLowerCase() === String(TREASURY_ADDR).toLowerCase())
              .reduce((a: number, o: any) => a + baseVal(o.value), 0);
            const need = Number(nameRegFee(rec.name as string, buildFeeHeight(tipNow!)));
            const noun = rec.t === "nrenew" ? "renewal" : "registration";
            const verb = rec.t === "nrenew" ? "renewed" : "registered";
            if (need > 0 && paid < need) feeWarn = `<br><b class="err">⚠ the ${noun} fee here (${fmtCsd(paid)}) is BELOW the current price (${fmtCsd(need)}). If you sign this, the fee LEAVES your wallet but the name is NOT ${verb} — an underpaid record is rejected on-chain. Use the wallet's own button (it prices this correctly).</b>`;
          } catch { /* tip/fee unavailable → no warning */ }
        }
        // The decoded record (cx) is schema-BOUNDED text (regex-constrained tickers/names/addresses,
        // memo <= 64, profile values sliced), so it cannot scroll the money rows away; the hash echo is
        // capped anyway (a decoded record implies a canonical 66-char hash, so the cap is inert here).
        return `${cx}<br><span class="dim">anchored as a cairnx:v1 proposal</span><br>${feeLine(p.fee, 1000000)}`
          + `<br>payload hash: <code>${truncLoud(String(p.payloadHash || "(none)"), 80)}</code>${exp}${xfer}${feeWarn}`;
      }
    }
    // M15 (B5i): the raw (non-cairnx) branch renders dApp-supplied free text. Money rows FIRST (the fee
    // and any funds leaving the wallet), THEN the capped-and-loud domain/hash/uri - unbounded text under
    // the sticky Approve button must never be able to scroll what-this-costs out of view. The uri cap is
    // 512 (the node's own on-chain uri cap), so no VALID record's uri is ever cut; only oversized text
    // the chain would reject anyway gets the loud marker.
    return `<b>Post a proposal</b><br>${feeLine(p.fee, 1000000)}${exp}${xfer}`
      + `<br>domain: <code>${truncLoud(String(p.domain), DOMAIN_CAP)}</code>`
      + `<br>payload hash: <code>${truncLoud(String(p.payloadHash || "(none)"), 80)}</code>`
      + `<br>uri: <code>${truncLoud(String(p.uri || "(none)"), 512)}</code>`;
  }
  // score/confidence are serialized as u32 (>>>0); display the SAME value that will be
  // signed so a negative/oversized input can't show one thing and commit another.
  if (r.method === "attest") {
    const score = Number(p.score) >>> 0, conf = Number(p.confidence) >>> 0;
    // CairnX v1.7: score 50 / confidence 0 is a claim-to-fill RESERVATION on an open CSD offer - a
    // payment-free attest (the attest method carries NO value outputs) that reserves the offer so only
    // the claimer can fill it for the legacy claim window (CLAIM_WINDOW_BLOCKS_V20 = 40 blocks; the copy
    // said "~15" for weeks, an audit LOW). From V28 the chain REJECTS every new legacy SCORE_CLAIM, so
    // when the PoW-backed floor proves the gate has passed, WARN that this is a guaranteed on-chain
    // no-op that still costs the network fee (warn, never block - the floor is threaded by approve.ts
    // from the wallet store, a local read, no added network dependency; when it is absent or below the
    // gate the warning stays silent, which is exactly today's behavior).
    if (score === 50 && conf === 0) {
      const v28warn = (Number(r.tipFloor) || 0) >= V28_HEIGHT
        ? `<br><b class="err">⚠ the chain has passed the v2.8 upgrade (block ${V28_HEIGHT}): this legacy reservation type is REJECTED on-chain, so approving would be a no-op that still costs the network fee. Use the site's current buy flow instead.</b>`
        : "";
      return `<b>Reserve an open offer</b> - v1.7 claim-to-fill. This <b>moves no money</b>: it reserves the offer so only you can fill it for ~${CLAIM_WINDOW_BLOCKS_V20} blocks; you pay only when you complete the purchase.<br>offer: <code>${truncLoud(String(p.proposalId || "(none)"), 80)}</code><br>${feeLine(p.fee)} · score 50 (claim) · no payment${v28warn}`;
    }
    // CairnX v1.2: confidence 1 000 000 is the TOKEN-PRICED-FILL marker. A bare Attest carrying
    // it is BYTE-IDENTICAL to a fillOffer with empty outputs (the resolver cannot tell them
    // apart), so it can debit the user's CairnX token balance with NO visible output. Treat the
    // reserved value the same on EITHER path — never let a dApp route a token spend through the
    // unwarned attest method (security review HIGH-1, 2026-06-12). The fee rate renders from the
    // imported FEE_BPS_V16 (150 bps = 1.5%); the string said "1%" for weeks, an audit LOW.
    const tokenFill = conf === CONF_TOKEN_FILL
      ? `<br><b class="err">⚠ TOKEN-PRICED FILL: approving SPENDS TOKENS from your CairnX balance</b> - if this attests an open offer, the convention debits its asking amount + ${FEE_BPS_V16 / 100}% protocol fee (computed below when available). Only approve if you intend to BUY from this offer; verify its price on the site/explorer first.<div id="token-sim" class="req" style="margin-top:6px" hidden></div>`
      : "";
    return `<b>Support / review</b><br>target: <code>${truncLoud(String(p.proposalId || "(none)"), 80)}</code>${tokenFill}<br>${feeLine(p.fee)} · score ${score} · confidence ${conf}`;
  }
  if (r.method === "sealClaim") {
    // Show the actual claim TEXT being committed: sealClaim hashes {domain,claim,nonce} into the on-chain
    // payloadHash, so a dApp-supplied `claim` is what the user's key commits to - it must be visible, not
    // hidden behind "domain + fee" (audit SEAL-1). The salt (nonce) stays local and is only published on
    // reveal. M15 (B5i): the fee row renders ABOVE the dApp-supplied claim text, and the text is
    // capped-and-LOUD (truncLoud) instead of a quiet ellipsis.
    const claim = p.claim != null ? String(p.claim) : "";
    const claimLine = claim ? `<br>claim: <code>${truncLoud(claim, 200)}</code>` : "";
    return `<b>Seal a claim</b> - commit a hidden claim on-chain (reveal later).<br>domain: <code>${truncLoud(String(p.domain || "csd:sealed"), DOMAIN_CAP)}</code><br>${feeLine(p.fee, CAIRNX_PROPOSE_FEE)} · the salt stays in your wallet (the claim is published only when you reveal)${claimLine}`;
  }
  // M14 (B5h): a reveal PUBLISHES a secret - show the FULL seal txid (18 characters invited approving the
  // wrong reveal) and mount #reveal-preview, which approve.ts fills with the domain + claim text from the
  // wallet's own sealedClaims store (a READ_ONLY local read), so the user sees WHICH secret goes public.
  if (r.method === "revealClaim") return `<b>Reveal a sealed claim</b> - publish the sealed text; it becomes public + provably committed earlier.<br>seal tx: <code>${truncLoud(String(r.params || ""), 80)}</code><div id="reveal-preview" class="req" style="margin-top:6px" hidden></div>`;
  // Send is the only dApp method that MOVES funds to a page-chosen recipient, so we
  // clear-sign the FULL (untruncated) recipient address(es) + each amount + total + fee.
  // #send-warn is populated async by fillSendWarning (first-time / address-poisoning).
  if (r.method === "send") {
    const outs = Array.isArray(p.outputs) ? p.outputs : [{ to: p.to, value: p.amount }];
    const total = outs.reduce((a: number, o: any) => a + baseVal(o.value), 0);
    const rows = renderOutputs(outs); // capped+LOUD-on-truncation, single-sourced (WYSIWYS-TRUNC-1)
    const totalLine = outs.length > 1 ? `<br>total: <b>${fmtCsd(total)}</b> to ${outs.length} recipients` : "";
    return `<b>Send CSD</b><br>${rows}<br>${feeLine(p.fee, 1000000)}${totalLine}<div id="send-warn" class="err" style="margin-top:8px" hidden></div>`;
  }
  // Atomic fill (CairnX DvP): an Attest AND payment outputs in ONE tx. Funds move to a
  // page-chosen recipient, so this clear-signs like send — full recipients + amounts +
  // total + fee — PLUS the offer (proposal) id the attest commits to. What the user
  // receives in return is convention-level (token semantics) and is the SITE's claim,
  // not something the wallet can verify — so we sign only what is cryptographically true.
  if (r.method === "fillOffer") {
    const outs = Array.isArray(p.outputs) ? p.outputs : [];
    const total = outs.reduce((a: number, o: any) => a + baseVal(o.value), 0);
    const rows = renderOutputs(outs); // capped+LOUD-on-truncation, single-sourced (WYSIWYS-TRUNC-1)
    const totalLine = outs.length > 1 ? `<br>total: <b>${fmtCsd(total)}</b> to ${outs.length} recipients` : "";
    // CairnX v1.2: confidence 1 000 000 is the TOKEN-PRICED-FILL marker — approving it lets the
    // convention debit the user's CairnX token balance (offer ask + the FEE_BPS_V16 protocol fee) with
    // NO CSD output visible here. The wallet can't see which token/how much (resolver-level), so it must
    // say so loudly: an outputs-free fill would otherwise clear-sign as "free". Fee rate rendered from
    // the imported FEE_BPS_V16 (150 bps = 1.5%); the string said "1%" for weeks, an audit LOW.
    const tokenFill = (Number(p.confidence ?? 100) >>> 0) === CONF_TOKEN_FILL
      ? `<br><b class="err">⚠ TOKEN-PRICED FILL: approving SPENDS TOKENS from your CairnX balance</b> - the offer's asking amount + ${FEE_BPS_V16 / 100}% protocol fee, debited by the trading convention (computed below when available). Verify the offer's price on the site/explorer before approving.<div id="token-sim" class="req" style="margin-top:6px" hidden></div>`
      : "";
    return `<b>Fill offer</b> — pay + attest in ONE atomic transaction<br>`
      + `offer: <code>${truncLoud(String(p.proposalId || "(none)"), 80)}</code>${tokenFill}<br>${rows}<br>`
      + `${feeLine(p.fee, 5000000)} · score ${(Number(p.score ?? 100) >>> 0)} · confidence ${(Number(p.confidence ?? 100) >>> 0)}${totalLine}`
      + `<div id="send-warn" class="err" style="margin-top:8px" hidden></div>`;
  }
  return `<b>${escapeHtml(r.method)}</b>`;
}

// Base units that will LEAVE the wallet if this request is approved (for balance-after).
export function debitOf(r: any): number {
  const p = r.params || {};
  if (r.method === "send" || r.method === "fillOffer") {
    const outs = Array.isArray(p.outputs) ? p.outputs : [{ value: p.amount }];
    const total = outs.reduce((a: number, o: any) => a + baseVal(o.value), 0);
    return total + baseVal(p.fee || (r.method === "fillOffer" ? 5_000_000 : 1_000_000));
  }
  if (r.method === "connect" || r.method === "getAddress" || r.method === "requestPermissions" || r.method === "signin" || r.method === "signinWithCsd") return 0;
  // a propose may carry protocol-fee outputs (CairnX deploy / name registration) → count them
  const outs = r.method === "propose" && Array.isArray(p.outputs) ? p.outputs.reduce((a: number, o: any) => a + baseVal(o.value), 0) : 0;
  return outs + baseVal(p.fee || (r.method === "sealClaim" ? CAIRNX_PROPOSE_FEE : 0));
}

// Address-poisoning lookalike: an attacker seeds your history with an address sharing the head+tail
// you eyeball but differing in the middle. Flag a recipient matching a previously-seen address on
// first 8 + last 4 hex but not identical.
export function lookalikeOf(to: string, known: string[]): string | null {
  const t = to.toLowerCase(), head = t.slice(0, 8), tail = t.slice(-4);
  for (const k of known) { const a = k.toLowerCase(); if (a !== t && a.slice(0, 8) === head && a.slice(-4) === tail) return k; }
  return null;
}

// NXFER-POISON-DROP (Part B) — pure poisoning/first-time warning computation (approve.ts owns only the DOM
// read + mount). The first-time check keys on `known` (paid recipients PLUS the wallet's OWN account
// addresses), NOT paidRecipients alone: the site pre-fills an nset with the user's own address ("set as
// primary" right after registration), so keying on sends-only would warn every new name-holder about THEIR
// OWN address on an operation that sends nothing. An exact own address is suppressed; a LOOK-ALIKE of one of
// yours still fires (lookalikeOf runs against `known` and short-circuits before the first-time check); a
// genuinely-new external recipient is in neither set and still warns.
export function sendWarnings(recipients: string[], sentTo: string[], ownAddrs: string[]): string[] {
  const known = [...sentTo, ...ownAddrs];
  const warns: string[] = [];
  for (const raw of recipients) {
    const to = String(raw || "");
    if (to.toLowerCase() === TREASURY_ADDR) continue;          // fixed protocol sink, never a user recipient
    const tag = `<code>${escapeHtml(to.slice(0, 10))}…${escapeHtml(to.slice(-6))}</code>`;
    const la = lookalikeOf(to, known);
    if (la) warns.push(`⚠ <b>Possible address-poisoning:</b> ${tag} resembles <code>${escapeHtml(la.slice(0, 10))}…${escapeHtml(la.slice(-6))}</code> you've seen before but is NOT identical. Verify every character — payments are irreversible.`);
    else if (!known.some((a) => a.toLowerCase() === to.toLowerCase())) warns.push(`⚠ First time sending to ${tag} — verify every character. Payments are irreversible.`);
  }
  return warns;
}

// XREPO-1. Sending to "<name>.csd" resolves the address through a configurable / MITM-able name service.
// The wallet now SPV-verifies that mapping against a PoW header chain it checks itself (core/namespv.ts),
// so the banner is VERIFIED-AWARE: when the chain backs the address it says so (and notes the honest
// residual — a former owner could still show a stale-but-real mapping); when it could NOT be verified
// (resolver offline, service not yet upgraded, or a proven mismatch already refused upstream) it carries
// the original strong caution. Either way the resolved FULL address stays the unmissable thing the user
// confirms. (The name is regex-constrained at resolution, but escape it anyway — defense in depth.)
export function nameCautionHtml(name: string, verified?: boolean, info?: { sources?: number; agreed?: number; disagree?: boolean; soleSource?: boolean; viaFill?: boolean }): string {
  const n = escapeHtml(String(name));
  // Checked BEFORE the verified branch (and independent of `verified`) so a viaFill name can NEVER render a
  // green badge — defense-in-depth even though the verifier already forces viaFill ⇒ verified:false.
  if (info?.viaFill) {
    // NSPV-CLAIMCAP-1 (H1): the records ARE chain-backed, but ownership was set by an on-chain offer FILL
    // whose validity depends on state OUTSIDE this name's history (an open-lane claim cap that is global over
    // all offers, or a name-for-token buyer's global balance) — a name-scoped SPV proof provably cannot
    // reconstruct it, and a second source runs the same scoped selector. So this is NOT shown as verified.
    return `⚠ <b><code>${n}.csd</code> was acquired by an on-chain purchase (offer fill).</b> The wallet SPV-verified the records, but ownership set by a fill can hinge on chain state <b>outside</b> this name's own history, which a name-scoped proof cannot verify — so the address is <b>not</b> shown as chain-verified. Confirm the <b>To</b> address out-of-band before sending.`;
  }
  if (verified) {
    // NS-1: only ONE source solo-recovered the winner (the union failed) — a lone, possibly-hostile source
    // alone decided the target, NOT independently corroborated. Checked BEFORE disagree/≥2-agree so it can
    // never read as "servers agree". The address shown is still the chain-PROVEN winner (never the served
    // one); this only stops the badge from asserting multi-source verification (mitigation by disclosure).
    if (info?.soleSource) {
      return `⚠ <b><code>${n}.csd</code>: only ONE name source could prove this address.</b> The wallet SPV-verified the records, but a single source (which could be hostile or stale) alone decided the address and it is <b>not</b> independently corroborated. Confirm the <b>To</b> address out-of-band before sending.`;
    }
    // A source's stated claim disagreed with the SPV-proven union winner (NSPV-COMPLETE-1): one resolver may
    // be hostile/stale. The address shown IS the chain-proven winner across all sources, but flag it loudly.
    if (info?.disagree) {
      return `⚠ <b><code>${n}.csd</code> — sources DISAGREE.</b> The wallet SPV-verified the records, but one name source's answer did <b>not</b> match what the chain proves across the others — a source may be hostile or stale. The <b>To</b> address shown is the chain-proven winner, but <b>double-check it out-of-band</b> before any sizable send.`;
    }
    // ≥2 sources agreed on the SPV-verified mapping. HONESTY (2026-06-27 red-team): the two sources
    // (cairn-substrate.com + clarvis) are currently CO-LOCATED on one operator/apex (live DNS confirmed), so
    // this is NOT yet independence-backed. Against record WITHHOLDING the residual is the same as the 1-source
    // case until a genuinely independent second source exists, so do NOT claim "independent" / "compromise all
    // of them" here. See docs/security/cairn-wallet-redteam-2026-06-27.md and docs/handoffs/38.
    if ((info?.sources ?? 1) >= 2) {
      return `✓ <b><code>${n}.csd</code> — chain-backed, ${info!.sources} name servers agree.</b> The wallet SPV-verified that this address is backed by signed, mined records. Those name servers currently share one operator, so they do not yet rule out that operator hiding a later transfer or competing claim. For any sizable send, confirm the full <b>To</b> address out-of-band.`;
    }
    // Single usable source (the other was unreachable) — the honest withholding caveat still applies.
    return `<b><code>${n}.csd</code> — chain-backed (1 source).</b> The wallet SPV-verified that this address is backed by signed, mined records — but only one name source answered, and a single source could still <b>hide</b> a later transfer or a competing claim. For any sizable send, confirm the full <b>To</b> address out-of-band.`;
  }
  return `⚠ <b>Sending to <code>${n}.csd</code> — verify the full address below.</b> The address was supplied by the name service and could <b>not</b> be verified on-chain right now; a malicious or intercepted server could substitute it. Confirm the <b>To</b> address is the correct owner of <code>${n}.csd</code> before sending.`;
}

// XREPO-1 confirm-time guard. A name recipient is re-resolved at sign-time and the send is REFUSED
// unless the service still returns EXACTLY the address the user reviewed. Fail-closed on any error /
// lapse / shape change / network failure (a name that no longer resolves to the reviewed address must
// never be signed silently). Pure over the re-resolution RESULT so it's unit-testable; the popup wires
// the live `resolveName` call. NOTE: this stops a server that re-points the name BETWEEN review and
// confirm — it does NOT defend against a server that is CONSISTENTLY hostile (returns the same attacker
// address both times). Closing that requires the light client (the real fix; see the SPV name-verify path).
export function reresolveUnchanged(reviewed: string, re: { ok?: boolean; addr?: unknown; verified?: boolean } | null | undefined, reviewedVerified?: boolean): boolean {
  if (!(re && re.ok && typeof re.addr === "string" && (re.addr as string).toLowerCase() === reviewed.toLowerCase())) return false;
  // L7 (CONFIRMGUARD): also refuse a verification-status REGRESSION. If the name was chain-verified at
  // review but the confirm-time re-resolution can no longer verify it (even at the SAME address), a source
  // may have gone hostile/stale or a competing claim appeared between the two reads — re-review, don't sign.
  if (reviewedVerified === true && re.verified === false) return false;
  return true;
}

// ── nfinalize finalize-window gate (Plan 63 carry-over; the approve-path backstop for the C1 burn class) ──
// An `nfinalize` pays the registration fee (or recapture premium) for a reservation the signer holds.
// The resolver only credits it while the reservation is still THE SIGNER'S and inside its finalize
// window — a displaced or too-late finalize is no-oped on-chain AFTER the fee output left the wallet
// (fee burned, no name). The site's register flow already carries this guard (the register-names.mjs
// C1 winner re-check); this is the wallet-side backstop for any dApp-built nfinalize reaching the
// approval window. Pure over the fetched /cairnx/name/:name result + tip so it is unit-testable;
// approve.ts wires the live fetch. FAIL-OPEN by design: an unreachable name service / tip WARNS but
// never blocks — approval must not gain a hard network dependency (same posture as the
// CLEARSIGN-FEE-1 offline skip above). A clean 404 is NOT a fetch failure: it is a definitive
// "no reservation" (wallet.fillOffer's 404-vs-5xx asymmetry) and refuses.
export type NameFetchResult =
  | { failed: true }                                        // 5xx / timeout / garbled — NOT definitive
  | { failed?: false; record: Record<string, any> | null }; // null = clean 404 (name unknown to the resolver)
export function nfinalizeApproveGate(fetched: NameFetchResult, me: string, tip: number | null): { block: boolean; note: string | null } {
  if (fetched.failed || tip == null || !Number.isFinite(tip)) {
    return { block: false, note: "could not verify this name reservation is still finalizable (name service or chain tip unreachable) — an expired or displaced reservation would burn the fee without registering the name. Approve only if the site shows your registration at the finalize step." };
  }
  const rec = fetched.record;
  // v2.6 recapture: the reservation on a LAPSED name lives OUTSIDE canonical state (served as
  // `.recapture` beside the stale lapsed record) — winner-check the live reservation, never the
  // lapsed record itself; a lapsed record with NO reservation means there is nothing to finalize.
  const resv: Record<string, any> | null = rec == null ? null
    : rec.pending === true ? rec
    : rec.recapture && typeof rec.recapture === "object" ? { ...rec.recapture, pending: true }
    : rec.expired === true ? null
    : rec;
  // the vendored C1 check (exists / owner / pending / displacement) — and, since cairnx-core 0.1.36
  // (Plans/68 B2), BOTH finalize-window sides when a tip is passed: the freeze/too-early half the old
  // local check missed (a pre-freeze finalize is rejected by the resolver AFTER the fee moved — the
  // same burn as too-late) and the expiry half that used to live in a hand-rolled windowEnd formula
  // here. The helper derives the window purely from the passed commit height (= effectiveHeight)
  // against the shared FINALIZE_TIP_MARGIN band, so wallet and site refuse on identical heights for an
  // HONEST record. TRUST SCOPE (be honest, per the SDK docstring): the wallet passes the reservation's
  // OWN effectiveHeight as the commit height (it has no independent commit height and no SPV on this
  // record), which makes the displacement guard a tautology — so this gate protects against an
  // honest-but-stale resolver and displacement races, NOT against a Byzantine resolver that lies about
  // effectiveHeight to widen the window. That closure is registration-state SPV, the same resolver-trust
  // residual the fill path documents; this gate is best-effort within that posture, and it fails OPEN on
  // transport so it never adds a hard network dependency.
  const w = finalizeWinnerCheck(resv as any, me, Number(resv?.effectiveHeight), tip);
  if (!w.safe) return { block: true, note: `refusing to approve — ${w.reason}.` };
  return { block: false, note: null };
}

// ── nrenew / nset approve gate (Plans/68 B2, the renew/set-primary wiring) ───────────────────────
// Both records ride a fee (nrenew the treasury renewal fee, nset the 0.25 CSD anchor) that BURNS when
// the resolver no-ops the record. Same posture as nfinalizeApproveGate: pure over the fetched record,
// FAIL-OPEN on transport (warn, never block — the F-FINALIZE non-goal), BLOCK only on a definitive
// on-chain no-op. Definitive cases (BLOCK): a clean 404 (nothing to renew / point), and for nset an owner
// mismatch (only the owner's nset counts). For nrenew the fee-burning shapes only WARN (NRENEW-REJECT-AFTER-
// FEE) — a pending (not-yet-finalized) reservation, and a grace-period NON-owner renewal (in-grace renewal is
// owner-only) — because the resolver state may be stale and the grace boundary is the resolver's call, so
// uncertainty must never decline a legit owner renewal (warn over block per the standing rule).
export function nameActApproveGate(kind: "nrenew" | "nset", fetched: NameFetchResult, me: string): { block: boolean; note: string | null } {
  if (fetched.failed) {
    return { block: false, note: `could not verify this ${kind === "nrenew" ? "renewal" : "name record"} against the name service (unreachable) — a no-op ${kind === "nrenew" ? "renewal burns the renewal fee" : "record burns the anchor fee"}. Approve only if the site shows the action as available.` };
  }
  const rec = fetched.record;
  if (rec == null) {
    return { block: true, note: kind === "nrenew"
      ? "refusing to approve — this name is not registered, so the renewal would be ignored on-chain and the fee burned."
      : "refusing to approve — this name is not registered, so the record would be ignored on-chain and the anchor fee spent for nothing." };
  }
  if (kind === "nset" && typeof rec.owner === "string" && rec.owner.toLowerCase() !== me.toLowerCase()) {
    return { block: true, note: "refusing to approve — this name is owned by a different address, so the resolver would ignore this record and the anchor fee would be spent for nothing. If you just bought it, wait for the purchase to settle and re-open." };
  }
  // NRENEW-REJECT-AFTER-FEE: an nrenew the resolver will no-op AFTER the fee output moves burns the renewal
  // fee. WARN, never hard-block (the resolver state may be stale; warn over block per the standing rule).
  if (kind === "nrenew" && rec.pending === true) {
    // a pending reservation is not a finalized registration — a renewal is ignored on-chain and the fee burned.
    return { block: false, note: "this name is a pending reservation, not a finalized registration — a renewal would be ignored on-chain and the fee burned. Finalize the registration first before renewing." };
  }
  if (kind === "nrenew" && rec.expired === true) {
    // in-grace renewal is legal ONLY for the current owner; a grace-period NON-owner nrenew is a no-op that
    // burns the fee (past grace the name must be recaptured, not renewed).
    const notOwner = typeof rec.owner === "string" && rec.owner.toLowerCase() !== me.toLowerCase();
    return { block: false, note: notOwner
      ? "this name has LAPSED and is owned by a different address — in the grace period only the owner can renew it, so the renewal fee would be burned; past grace it must be recaptured, not renewed. Verify on the site before approving."
      : "this name appears LAPSED. A renewal is only honored within its grace period; past that the fee is burned. Verify on the site before approving." };
  }
  return { block: false, note: null };
}

// Cost summary line from the request's own params (no network).
export function costLine(r: any): string {
  if (r.method === "connect" || r.method === "getAddress" || r.method === "requestPermissions" || r.method === "signin" || r.method === "signinWithCsd") return "no funds move — this only proves your address to the site.";
  if (r.method === "send") { const fee = baseVal(r.params?.fee || 1_000_000); const sent = debitOf(r) - fee; return `cost: ${fmtCsd(sent)} sent + ${fmtCsd(fee)} network fee.`; }
  if (r.method === "fillOffer") {
    const fee = baseVal(r.params?.fee || 5_000_000); const sent = debitOf(r) - fee;
    const tok = (Number(r.params?.confidence ?? 100) >>> 0) === CONF_TOKEN_FILL ? " PLUS tokens debited from your CairnX balance per the offer's terms" : "";
    return `cost: ${fmtCsd(sent)} paid to the seller + ${fmtCsd(fee)} network fee${tok} — atomic with the fill.`;
  }
  if (r.method === "propose") {
    const outs = Array.isArray(r.params?.outputs) ? r.params.outputs : [];
    const out = outs.reduce((a: number, o: any) => a + baseVal(o.value), 0);
    const fee = baseVal(r.params?.fee || 1_000_000);
    return out ? `cost: ${fmtCsd(out)} transferred out of your wallet + ${fmtCsd(fee)} network fee.` : `cost: ${fmtCsd(fee)} network fee (paid to miners).`;
  }
  if (r.method === "attest") {
    const fee = baseVal(r.params?.fee || 5_000_000);
    const tok = (Number(r.params?.confidence ?? 100) >>> 0) === CONF_TOKEN_FILL
      ? ` PLUS tokens debited from your CairnX balance IF this attests an open offer (its ask + ${FEE_BPS_V16 / 100}%)` : "";
    return `cost: ${fmtCsd(fee)} network fee${tok}.`;
  }
  const fee = baseVal(r.params?.fee || (r.method === "sealClaim" ? CAIRNX_PROPOSE_FEE : 0));
  return `cost: ${fmtCsd(fee)} network fee (paid to miners), + a tiny chain fee.`;
}
