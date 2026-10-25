// Pure clear-signing formatters for the approval window and the popup's review: no DOM and no chrome, so they are
// unit-testable (the "what am I signing?" layer). approve.ts and popup.ts import these and own only the DOM glue.
import { decodeCairnxRecord, type TokenDisplayMeta, PINNED_TOKENS, displayDecimals, CAIRNX_DOMAIN, defaultFeeFor, nameRegFee, buildFeeHeight, feePricingTip, formatUnits, isTokenDecimals, csdBase, fmtCsd, fmtBalance, TREASURY_ADDR, V25_HEIGHT, V28_HEIGHT, CLAIM_WINDOW_BLOCKS_V20, FEE_BPS_V16, CONF_TOKEN_FILL, finalizeWinnerCheck } from "../core/cairnx.js";
import { EPOCH_LEN } from "../vendor/cairnx-spv.js";
import { offerFillTooLate } from "../core/fillpreflight.js";
import type { NameFetchResult } from "../core/namegate.js";
// the v2.5 registration-window constants are vendored but not re-exported by core/cairnx.ts; take
// them straight from the bundle (same reviewed bytes the resolver replays; typed in cairnx-spv.d.ts)

// WYSIWYS-BIDI-1: neutralize Unicode bidi-override + zero-width / BOM controls BEFORE HTML-escaping, so a
// dApp can't visually REORDER or HIDE characters in a displayed field (making a name/address/memo read
// differently than the bytes that get signed). Rendered as a visible \uXXXX token (NOT silently stripped),
// so the user SEES that something is off. Applied inside escapeHtml so EVERY displayed field is covered;
// addresses/hashes/amounts are regex-constrained and never contain these, so honest fields are unaffected.
// bidi overrides/isolates (U+202A–202E, U+2066–2069, U+200E/200F, U+061C) + zero-width/BOM (U+200B–200D, U+FEFF)
const CONTROL_CHARS = /[\u202A-\u202E\u2066-\u2069\u200B-\u200F\u061C\uFEFF]/g;
const neutralizeControls = (s: string): string =>
  s.replace(CONTROL_CHARS, (c) => `\\u${c.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")}`);
export const escapeHtml = (s: string): string =>
  neutralizeControls(String(s)).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

// An address cut to its head and tail, for a menu line; every review shows it in full.
export const short = (a: string) => a && a.length > 14 ? a.slice(0, 8) + "…" + a.slice(-4) : a;
// A whole address (0x and 40 hex digits) in groups of four for comparing by eye. The spans hold no spaces, so what a
// selection or Copy takes is the bare address (test/addr-group-chrome.test.mjs). Any other value is only escaped.
const WHOLE_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
export const groupedAddr = (a: string): string =>
  WHOLE_ADDRESS.test(a) ? (a.match(/^0x.{4}|.{4}/g) || []).map((g) => `<span>${escapeHtml(g)}</span>`).join("") : escapeHtml(a);

// A check row: positive, caution, or danger (a warning that stands against signing). The tint and the icon carry the
// tier; `html` is markup the caller escaped.
export type Tier = "ok" | "caution" | "danger";
export type Check = { tier: Tier; html: string };
const TIER_ICON: Record<Tier, string> = { ok: "i-shield-check", caution: "i-triangle-alert", danger: "i-octagon-alert" };
export const checkRow = (c: Check): string => `<div class="check ${c.tier}"><svg class="i" aria-hidden="true"><use href="icons.svg#${TIER_ICON[c.tier]}"/></svg><div>${c.html}</div></div>`;
const danger = (html: string): string => checkRow({ tier: "danger", html });
const caution = (html: string): string => checkRow({ tier: "caution", html });
// Label and value rows; labels are fixed copy, values are markup the caller escaped. `id` names the list for approve.ts.
// A recipient row carries its address in data-to (recipientKey), so the approval window can mark it when the warning box
// only counts.
type Row = [label: string, value: string, to?: string];
/** A recipient's key: its address in lower case with control characters made visible, as data-to reads back. */
export const recipientKey = (to: string): string => neutralizeControls(String(to).toLowerCase());
const rows = (list: Row[], id?: string): string => list.length
  ? `<dl class="kv"${id ? ` id="${id}"` : ""}>${list.map(([l, v, to]) => `<div${to !== undefined ? ` data-to="${escapeHtml(recipientKey(to))}"` : ""}><dt>${l}</dt><dd>${v}</dd></div>`).join("")}</dl>` : "";
const title = (html: string): string => `<div class="ap-title">${html}</div>`;
const lede = (html: string): string => `<p class="ap-lede">${html}</p>`;

// The SINGLE source of truth for "addresses this account has previously PAID", used by the first-time /
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
const FEE_WARN = 5n * 100_000_000n;

// The signer screens format CSD through core/cairnx.ts fmtCsd (exact, "invalid amount" on garbage) and
// balances through fmtBalance; both are re-exported here for the popup and the approval window.
export { fmtCsd, fmtBalance };
// Finite base-unit number for sums / balance-after math (garbage → 0; the tx won't build anyway:
// node.send/sendMany hard-reject non-numeric amounts, so this only keeps the DISPLAY sane).
export function baseVal(raw: any): number { const n = Number(raw); return Number.isFinite(n) ? n : 0; }
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
  if (!isTokenDecimals(decimals)) return `${String(base)} base units of ${String(ticker)}`;
  return `${formatUnits(base, decimals)} ${String(ticker)} = ${String(base)} base units`;
}

// M3 (B5g): the token-fill debit preview is a RESOLVER-SERVED number (wallet.ts tokenFillQuote re-reads
// the same single offer service that shaped the fill; no SPV, no second source). The copy must therefore
// ATTRIBUTE the number to the offer service, never assert it as a first-person debit ("You will pay").
// Re-framing only, by decision: a second price source for a display string was DECLINED as
// disproportionate (Plan 71 section 8, decline 6); the real number is bound at the fund boundary.
export function tokenQuoteHtml(q: any, tip?: unknown): string {
  if (!(q && q.ok)) return danger(`Could not compute the token debit (${escapeHtml(String(q?.error || "offer unavailable"))}). The wallet will not sign this fill until the amount can be shown; try again in a moment or reject.`);
  const amt = (base: unknown, served: unknown, tk: unknown, deployId: unknown) => {
    const b = String(base ?? "");
    const { decimals: dec, pinned } = displayDecimals(tk, served);
    const human = isTokenDecimals(dec) && /^\d+$/.test(b) ? formatUnits(b, dec) : null;
    if (human == null) return `<b>${escapeHtml(b)}</b> base units of <b>${escapeHtml(String(tk))}</b>`;
    return `<b>${escapeHtml(human)} ${escapeHtml(String(tk))}</b> <span class="dim">(${escapeHtml(b)} base units)</span>${unverifiedMark(tk, pinned, deployId)}`;
  };
  const giveBit = (q.giveTicker || q.giveName)
    ? ` You receive ${q.giveName ? `<b>${escapeHtml(String(q.giveName))}.csd</b>` : amt(q.giveAmount, q.giveDecimals, q.giveTicker, q.giveDeployId)}.`
    : "";
  const warn = [tickerWarning(q.ticker, q.wantDeployId), q.giveTicker ? tickerWarning(q.giveTicker, q.giveDeployId) : ""].filter(Boolean).join(" ");
  const exp = offerExpiryLine(q.expiresAt, tip);
  return `Filling this debits ${amt(q.total, q.wantDecimals, q.ticker, q.wantDeployId)} <span class="dim">(${escapeHtml(String(q.amount))} ask + ${escapeHtml(String(q.fee))} fee${q.estimated ? ", estimated" : ""})</span>.${giveBit} Quoted by the offer service; the wallet refuses to sign if the offer's on-chain record differs from what is shown here.${exp ? `<br>${exp}` : ""}${warn ? danger(warn) : ""}`;
}

// 0.2.71 (CX-16 item 3): the same look-alike rule as the site's verified-tokens.json. A warning, never a block.
const WELL_KNOWN = new Set(["BTC", "ETH", "USDT", "USDC", "SOL", "BNB", "XRP", "DOGE", "ADA", "TRX", "TON", "AVAX", "LINK", "DOT", "MATIC", "SHIB", "LTC", "BCH", "USD", "EUR", "ZEC", "CAD"]);
const CAIRN_DEPLOY_ID = PINNED_TOKENS.CAIRN!.deployId;
export function tickerWarning(ticker: unknown, deployId?: unknown): string {
  const t = String(ticker || "").toUpperCase();
  if (!t) return "";
  if (t === "CAIRN") {
    // Review D-1: an absent deploy id (the token read failed) must not read as verified.
    if (!deployId) return "Could not confirm this CAIRN is Cairn's token (its record did not load). Check the deployer before approving.";
    return String(deployId).toLowerCase() !== CAIRN_DEPLOY_ID ? "This CAIRN is not Cairn's token (different deploy). Check the deployer." : "";
  }
  if (WELL_KNOWN.has(t) || t.startsWith("CX") || t.includes("CAIRN")) return `${escapeHtml(t)} is a well-known or Cairn-like ticker that Cairn has not verified. Anyone can deploy any ticker. Check the deployer.`;
  return "";
}
// A human figure scaled by served decimals, on a token the wallet does not pin, gets this marker unless a
// look-alike warning already says the token is unverified.
function unverifiedMark(ticker: unknown, pinned: boolean, deployId: unknown): string {
  return pinned || tickerWarning(ticker, deployId) ? "" : ` <span class="dim">(unverified token)</span>`;
}

// M14 (B5h): a revealClaim PUBLISHES the decrypted preimage of an earlier sealed commit; the user must
// see WHICH secret goes public, not 18 characters of txid. The record comes from the wallet's own
// sealedClaims store (already in READ_ONLY_METHODS; a local, vault-decrypted read - no network). Pure
// over the looked-up record so it is unit-testable; approve.ts wires the live lookup (fillRevealPreview).
export function revealPreviewHtml(rec: { domain?: unknown; claim?: unknown; failed?: boolean } | null | undefined): string {
  if (rec && rec.failed === true) return danger(`Could not load the sealed claim for preview. Approving still <b>publishes</b> whatever this txid seals. Only approve if you know which claim it is.`);
  if (!rec) return danger(`The active account holds <b>no</b> sealed claim with this txid. There is nothing to reveal here, and approving will fail without publishing anything. If you expected a reveal, check you are on the account that sealed it.`);
  const domain: Row = ["Domain", `<code>${escapeHtml(String(rec.domain ?? "csd:sealed"))}</code>`];
  if (typeof rec.claim !== "string") return rows([domain]) + danger(`The sealed text could not be decrypted for preview. Approving still <b>publishes</b> it. Only approve if you know which claim this txid seals.`);
  return lede("Approving makes this <b>public</b>:") + rows([domain, ["Claim", `<code>${truncLoud(rec.claim, 300)}</code>`]]);
}

// The value outputs as rows, every one: each recipient whole, in groups of four, with its amount. Nothing is summarised
// away: the request scrolls, the line above the buttons counts the recipient rows below the fold, and the cost rows and
// the warnings render before this list (test/approve-layout-chrome.test.mjs). Single source for the three fund-moving
// describe() branches (send, fillOffer, propose with outputs).
function outputRows(outs: any[]): Row[] {
  return (Array.isArray(outs) ? outs : []).map((o: any): Row => ["To", `<code class="addr">${groupedAddr(String(o.to))}</code><b class="out-amt">${fmtCsd(o.value)}</b>`, String(o.to)]);
}

// The fee as a row value. `??` (not `||`): an explicit fee:0 must render as 0; the engine refuses it BAD_FEE, and
// the screen must show the refused value, not the table default.
export function feeValue(raw: number, fallback = 0): string {
  const fee = csdBase(raw ?? fallback);
  if (fee === null) return `<span class="err">invalid amount</span>`;
  const warn = fee > FEE_WARN ? ` <span class="err">⚠ unusually large fee</span>` : "";
  return `${fmtCsd(fee)}${warn}`;
}

// A propose's dApp-supplied `expiresEpoch` IS signed (csdtx.ts u64) but was never shown: a site could
// commit a record that stays claimable for years past what the user expects. Render it humanized: an
// epoch is EPOCH_LEN blocks (30, about 60 min), so 24 epochs are about 1 day. When the current epoch is known (approve.ts fills
// it from the node tip) we show the remaining window from NOW and WARN past a year-plus horizon
// (mirrors the FEE_WARN pattern); otherwise we show the raw epoch alone (the exact signed value).
const EXPIRY_WARN_EPOCHS = 100000; // epochs past current ≈ >11 years: unusually long for a propose
const BLOCK_SECS = 120; // target block time; not exported by the vendored bundle
// Time for a number of blocks at the target block time: minutes under an hour, then hours, days, years.
function humanBlocks(blocks: number): string {
  const secs = blocks * BLOCK_SECS;
  if (secs < 3600) return `~${Math.max(1, Math.round(secs / 60))} min`;
  const days = secs / 86400;
  if (days < 1) return `~${Math.round(days * 24)} h`;
  if (days < 365) return `~${Math.round(days)} day(s)`;
  return `~${(days / 365).toFixed(1)} year(s)`;
}
const humanEpochs = (epochs: number): string => humanBlocks(epochs * EPOCH_LEN);
/** The expiry as a row value; "" when the request carries none. */
export function expiryValue(expiresEpoch: unknown, currentEpoch?: unknown): string {
  if (expiresEpoch === undefined || expiresEpoch === null) return "";
  const e = Number(expiresEpoch);
  if (!Number.isFinite(e) || !Number.isInteger(e) || e < 0) return `<span class="err">invalid epoch</span>`;
  const cur = Number(currentEpoch);
  if (Number.isFinite(cur) && Number.isInteger(cur) && cur >= 0) {
    const left = e - cur;
    const warn = left > EXPIRY_WARN_EPOCHS ? ` <span class="err">⚠ unusually long claim window</span>` : "";
    if (left <= 0) return `epoch ${e} <span class="err">(already past: this record would be a no-op)</span>`;
    return `epoch ${e} (in ${humanEpochs(left)}, current epoch ${cur})${warn}`;
  }
  return `epoch ${e}`;
}

// ── CairnX clear-signing: structured rendering of cairnx:v1 records ──────────
// A cairnx propose's `uri` IS the action (token transfer, offer, name claim…). Showing it
// as a raw JSON blob makes users rubber-stamp; decode it and show the fields instead,
// for BOTH wallet-initiated and dApp-initiated proposes. decodeCairnxRecord only returns
// a record that is canonical + hash-committed + schema-valid (anything else is a resolver
// no-op), so what we render is exactly what the convention will execute. Unknown/invalid
// shapes return null → the caller falls back to the raw uri.
// Token amounts: the signed base units stay on screen. Served decimals (`meta`, display only) add a human
// scale beside them, so a wrong decimals value does not hide what is signed (test/clearsign-token-units).
// `meta` also carries the deploy id for tickerWarning.
const esc = (v: unknown) => escapeHtml(String(v));
const baseAmt = (v: unknown) => `<b>${esc(v)}</b> <span class="dim">base units</span>`;
// A token amount as a row value, and the look-alike warning for its ticker (a danger row the caller places).
function tokenAmt(amount: unknown, ticker: unknown, meta?: TokenDisplayMeta): { html: string; warn: string } {
  const m = meta?.[String(ticker)];
  const { decimals: dec, pinned } = displayDecimals(ticker, m?.decimals);
  const html = isTokenDecimals(dec)
    ? `<b>${esc(tokenAmountBothScales(amount, dec, ticker))}</b>${unverifiedMark(ticker, pinned, m?.deployId)}`
    : `${baseAmt(amount)} of <b>${esc(ticker)}</b>`;
  return { html, warn: meta ? tickerWarning(ticker, m?.deployId) : "" };
}
function sideStr(s: any, meta?: TokenDisplayMeta): { html: string; warn: string } {
  if (s && typeof s === "object" && "name" in s) return { html: `name <code>${esc(s.name)}.csd</code>`, warn: "" };
  if (s && typeof s === "object" && "value" in s) return { html: fmtCsd(s.value), warn: "" };
  return tokenAmt(s?.amount, s?.ticker, meta);
}
const warnRows = (...ws: string[]): string => ws.filter(Boolean).map((w) => danger(w)).join("");
/** Tickers whose amounts a cairnx record clear-signs (the approval window fetches their display meta). */
export function cairnxTokenTickers(uri: unknown, payloadHash?: unknown): string[] {
  const r = decodeCairnxRecord(uri, payloadHash) as any;
  if (!r) return [];
  const side = (x: any) => (x && typeof x === "object" && typeof x.ticker === "string" ? [x.ticker] : []);
  if (r.t === "transfer" || (r.t === "mint" && r.amount !== undefined)) return [String(r.ticker)];
  if (r.t === "offer" || r.t === "bid") return [...new Set([...side(r.give), ...side(r.want)])];
  return [];
}
// A decoded cairnx record in three parts, so the approval window can put what decides the signature above its buttons:
// `title`; `main`, the record's subject and its money rows (amounts, recipients, the name acted on) with their
// warnings; `notes`, the explanations and cosmetic fields, which describe() places after the cost and the outputs.
type CairnxParts = { title: string; main: string; notes: string };
const parts = (t: string, main: string, notes = ""): CairnxParts => ({ title: title(t), main, notes });
export function cairnxParts(uri: unknown, payloadHash?: unknown, meta?: TokenDisplayMeta): CairnxParts | null {
  const r = decodeCairnxRecord(uri, payloadHash);
  if (!r) return null;
  const memo: Row[] = r.memo !== undefined ? [["Memo", `<code>${esc(r.memo)}</code>`]] : [];
  const nameRow: Row = ["Name", `<code>${esc(r.name)}.csd</code>`];
  switch (r.t) {
    case "transfer": {
      const a = tokenAmt(r.amount, r.ticker, meta);
      return parts("CairnX token transfer", rows([["Token", `<b>${esc(r.ticker)}</b>`], ["Amount", a.html], ["To", `<code class="addr">${groupedAddr(String(r.to))}</code>`, String(r.to)], ...memo]) + warnRows(a.warn));
    }
    case "deploy": {
      const limit = r.mint === "open" ? ` · mint limit ${esc(r.mintLimit)}/tx` : "";
      // N22 counter-case (B5g): THIS record's decimals are part of the signed bytes (schema: integer 0..MAX_TOKEN_DECIMALS),
      // so scaling the supply by them is proven-value-derived: the one token surface where a human scale
      // cannot be lied into existence. Everywhere else decimals are resolver state and base units stay
      // the authoritative render.
      const supplyHuman = ` (= ${esc(formatUnits(r.supply, r.decimals))} at ${esc(r.decimals)} decimals)`;
      return parts("CairnX token deploy", rows([["Ticker", `<b>${esc(r.ticker)}</b>${r.name !== undefined ? ` (${esc(r.name)})` : ""}`], ["Supply", `${baseAmt(r.supply)}${supplyHuman}`], ["Decimals", esc(r.decimals)], ["Minting", `${esc(r.mint)}${limit}`]]));
    }
    case "mint": {
      const a = r.amount !== undefined ? tokenAmt(r.amount, r.ticker, meta) : { html: `<span class="dim">default lot</span>`, warn: "" };
      return parts("CairnX token mint", rows([["Token", `<b>${esc(r.ticker)}</b>`], ["Amount", a.html]]) + warnRows(a.warn));
    }
    case "offer": {
      const give = sideStr(r.give, meta), want = sideStr(r.want, meta);
      const extras: Row[] = [
        ...(r.min !== undefined ? [["Partial fills from", baseAmt(r.min)] as Row] : []),
        ...(r.taker !== undefined ? [["Only fillable by", `<code class="addr">${groupedAddr(String(r.taker))}</code>`] as Row] : []),
        ...(r.bid !== undefined ? [["Accepts bid", `<code>${esc(r.bid)}</code>`] as Row] : []),
        ...((r.want as any)?.payto !== undefined ? [["Paid to", `<code class="addr">${groupedAddr(String((r.want as any).payto))}</code>`, String((r.want as any).payto)] as Row] : []),
      ];
      return parts("CairnX offer", rows([["Give", give.html], ["Want", want.html], ...extras, ...memo]) + warnRows(give.warn, want.warn), lede("Escrows what you give until it is filled or cancelled."));
    }
    case "bid": {
      const give = sideStr(r.give, meta), want = sideStr(r.want, meta);
      return parts("CairnX bid", rows([["Bidding", give.html], ["For", want.html], ...memo]) + warnRows(give.warn, want.warn));
    }
    case "ocancel": {
      const scope = r.ticker !== undefined ? `your open <b>${esc(r.ticker)}</b> offers` : r.name !== undefined ? `your open offers for <code>${esc(r.name)}.csd</code>` : `<b>all</b> your open offers`;
      return parts("CairnX cancel offers", lede(`Cancels ${scope} (the escrow returns to you).`));
    }
    case "ncommit":
      // Step titles follow the site's flow (commit, reserve, finalize and pay), so the approval window and the page
      // agree about where the user is in the journey.
      return parts(".csd registration, step 1 of 3 (commit)", rows([["Commit", `<code>${esc(r.commit)}</code>`]]), lede("A sealed, front-run-proof claim, revealed next."));
    case "name":
      return parts(r.salt !== undefined ? ".csd registration, step 2 of 3 (reserve, free)" : ".csd name claim", rows([nameRow]),
        (r.salt !== undefined ? lede(`<span class="dim">Reveals a prior commit.</span>`) : "")
        + lede(`<span class="dim">At the v2.5 upgrade this reveal is free (it reserves the name). The registration fee is charged at the final step, and only if you win, so a lost race never charges the fee.</span>`));
    case "nfinalize":
      return parts(".csd registration, step 3 of 3 (finalize and pay)", rows([nameRow]),
        lede("Completes your reservation and pays the fee shown above (the registration fee, or the decaying recapture premium for a lapsed name). Only the winner of the name pays, and only once; a lost race is never charged."));
    case "nxfer":
      return parts(".csd name transfer", rows([nameRow, ["To", `<code class="addr">${groupedAddr(String(r.to))}</code>`, String(r.to)]]));
    case "nset": {
      // QA #4: a zero-address nset is the V23 "un-point" sentinel, not a send to 0x0. The wallet cannot know the
      // landing height at sign time, so it states both effects and the backstop (sends to a 0x0-resolving name are
      // refused regardless).
      if (isZeroAddr(r.addr)) {
        return parts(".csd un-point (clear address record)", lede(`Clears the resolver record on <code>${esc(r.name)}.csd</code>. At the V23 upgrade it falls back to its owner and drops out of your primary name.`),
          lede(`<span class="dim">Before V23 it would set the literal zero address; either way the wallet refuses any send to a 0x0-resolving name.</span>`));
      }
      return parts(".csd name → address record", rows([nameRow, ["Resolves to", `<code class="addr">${groupedAddr(String(r.addr))}</code>`, String(r.addr)]]));
    }
    case "nrenew":
      return parts(".csd name renewal", lede(`Extends the lease on <code>${esc(r.name)}.csd</code>.`));
    case "nprofile": {
      // v1.9 identity profile: cosmetic, it does not change where funds go. Every key and value being set is shown in
      // full (parseRecord caps a value at 256 bytes), an empty map clears it, and a field named or shaped like an
      // address is flagged (a dApp could try to dress a profile value up as a send target).
      const pm = (r.p && typeof r.p === "object" ? r.p : {}) as Record<string, unknown>;
      const keys = Object.keys(pm);
      if (!keys.length) return parts(".csd profile", lede(`<b>Clears</b> the identity profile on <code>${esc(r.name)}.csd</code>.`), lede(`<span class="dim">Cosmetic only; it does not change where funds go.</span>`));
      const flagKey = keys.find((k) => k === "addr" || k === "address" || k === "coin" || /0x[0-9a-fA-F]{40}/.test(String(pm[k])));
      const warn = flagKey ? danger(`This profile's “${esc(flagKey)}” field is cosmetic text, <b>not</b> a send address. Funds always go to the name's verified record, never the profile.`) : "";
      return parts(".csd identity profile", lede(`Cosmetic metadata on <code>${esc(r.name)}.csd</code>. It does <b>not</b> change where funds go.`) + warn,
        rows(keys.map((k) => [esc(k), `<code>${esc(String(pm[k]))}</code>`] as Row)));
    }
    case "tmeta":
      return parts("CairnX token metadata (issuer only)", rows([["Token", `<b>${esc(r.ticker)}</b>`], ["Content", `<code>${esc(r.hash)}</code>`]]));
    case "fclaim":
      // B5h: the v2.8 open-lane claim. Payment-free like the legacy claim; the hold rides the carrying propose's
      // expiry (the Expires row below the record).
      return parts("Reserve an open offer", rows([["Offer", `<code>${esc(r.offer)}</code>`]]),
        lede("v2.8 open-lane claim. This <b>moves no money</b>: it reserves the offer so only you can fill it while the hold lasts (the hold rides this proposal's expiry, shown below). You pay only when you complete the purchase."));
    default:
      return null;
  }
}
export function cairnxDescribe(uri: unknown, payloadHash?: unknown, meta?: TokenDisplayMeta): string | null {
  const x = cairnxParts(uri, payloadHash, meta);
  return x && x.title + x.main + x.notes;
}

// The mounts approve.ts fills after the paint: first-time and address-poisoning rows, the token debit quote, the
// listing a CSD fill buys, and the sealed text a reveal publishes.
const SEND_WARN = `<div id="send-warn" class="checks" hidden></div>`;
const TOKEN_SIM = `<div id="token-sim" class="ap-box" hidden></div>`;
const FILL_VIEW = `<div id="fill-view" class="ap-box" hidden></div>`;
const REVEAL_PREVIEW = `<div id="reveal-preview" class="ap-box" hidden></div>`;
const attestation = (score: number, conf: number) => `score ${score} · confidence ${conf}`;
export const FILL_PAYS = "One transaction pays the recipients above and records the fill. CairnX then delivers what you buy; if it refuses the fill, the payment is not returned.";
export const FILL_RECORDS = "One transaction records the fill.";

export function describe(r: any): string {
  const p = r.params || {};
  const cost = costBlock(r);
  if (r.method === "connect" || r.method === "getAddress" || r.method === "requestPermissions") return title("Connect") + lede("Grant this site permission to see your address. No transaction, no funds move.") + cost;
  if (r.method === "signin") return title("Sign in with CSD") + lede("Prove your address. No transaction, no funds move.") + cost;
  // Audience-bound SIWC. The audience is the real requesting site (origin), bound into the signed message; shown
  // prominently so the user sees which site they authenticate to. A page that declared a different domain than its
  // origin gets a warning: the wallet will refuse it.
  if (r.method === "signinWithCsd") {
    const aud = (() => { try { return new URL(String(r.origin)).host; } catch { return String(r.origin || "this site"); } })();
    const nonce = String(p.nonce ?? "");
    const nshort = nonce.length > 16 ? nonce.slice(0, 8) + "…" + nonce.slice(-4) : nonce;
    const stmt = p.statement != null && String(p.statement) !== "" ? lede(`“${escapeHtml(String(p.statement))}”`) : "";
    const expS = Math.min(3600, Math.max(60, Math.floor(Number(p.expirationSecs) || 600)));
    const mism = p.domain !== undefined && String(p.domain) !== aud
      ? danger(`This page asked to sign in as “${escapeHtml(String(p.domain))}”, but you are on “${escapeHtml(aud)}”: sign-in will be refused.`) : "";
    // The rest of the signed message the site controls (audit SIWC-RESOURCES, SIWC-URI): a dApp can embed claims
    // (resources) the user would otherwise sign blind.
    const extra: Row[] = [
      ...(p.uri != null && String(p.uri) !== "" ? [["URI", escapeHtml(String(p.uri))] as Row] : []),
      ...(Array.isArray(p.resources) && p.resources.length ? [[`Resources (${p.resources.length})`, p.resources.slice(0, 10).map((x: any) => escapeHtml(String(x).slice(0, 256))).join(" · ")] as Row] : []),
      ...(p.requestId != null && String(p.requestId) !== "" ? [["Request id", escapeHtml(String(p.requestId))] as Row] : []),
      ...(p.notBeforeSecs != null && Number(p.notBeforeSecs) > 0 ? [["Not valid before", `~${Math.floor(Number(p.notBeforeSecs))}s from now`] as Row] : []),
    ];
    return title(`Sign in to <code>${escapeHtml(aud)}</code>`) + lede("Prove your address to this site. <b>No transaction, no funds move.</b>") + mism + cost + stmt
      + rows([["Audience", escapeHtml(aud)], ["Nonce", `<code>${escapeHtml(nshort)}</code>`], ["Expires", `in ~${expS}s`], ...extra]);
  }
  // Clear-signing: show everything the site controls and the chain will commit, not just the domain and the fee.
  if (r.method === "propose") {
    // A proposal may carry value outputs (a CairnX protocol fee to its treasury, say). The wallet cannot verify that a
    // recipient is a legitimate fee, so they are shown neutrally as funds leaving the wallet, capped, with the same
    // first-time and look-alike warnings as a send (#send-warn, filled by approve.ts).
    const outs = Array.isArray(p.outputs) ? p.outputs : [];
    const total = outs.reduce((a: number, o: any) => a + baseVal(o.value), 0);
    // NXFER-POISON-DROP: the poisoning mount renders even when a cairnx repoint (nxfer, nset) carries no CSD outputs.
    const xfer = outs.length ? caution(`This proposal also transfers funds out of your wallet: <b>${fmtCsd(total)}</b> in total.`) : "";
    const outRows = rows(outputRows(outs));
    // The dApp-supplied expiry is part of the signed bytes: shown humanized in both branches.
    const exp: Row[] = p.expiresEpoch !== undefined ? [["Expires", expiryValue(p.expiresEpoch, r.currentEpoch)]] : [];
    if (String(p.domain) === CAIRNX_DOMAIN) {
      const cx = cairnxParts(p.uri, p.payloadHash, r.tokenMeta);
      if (cx) {
        // CLEARSIGN-FEE-1: a dApp-built .csd registration/renewal that UNDERPAYS the length-graded fee is a
        // silent fund-loss-with-no-benefit (the fee leaves the wallet, but the resolver no-ops the underpaid
        // record so the name is NOT registered/renewed). Warn loudly when the treasury fee output is below the
        // current price. The wallet's OWN Renew button always prices correctly (WL-FEE-FREEZE-1); this guards
        // the third-party-built path. Needs the live tip (threaded from approve.ts); skipped when offline.
        // under v2.5 the `name` reveal is PAYMENT-FREE (the fee moves to `nfinalize`), so the fee-bearing record
        // is nrenew, nfinalize, or a PRE-v2.5 `name`. An underpaid nfinalize burns exactly like an underpaid
        // pre-v2.5 registration (the fee leaves, the name is not registered), so it gets the same loud warning.
        // M11 (B5b): the review-side tip is clamped with the PoW-backed floor via the ONE shared helper
        // (cairnx.ts feePricingTip), the same clamp the build sites apply, so a deflating RPC cannot
        // price a cheaper tier here while silencing this very warning. Floor-only (tip read failed but a
        // floor exists) still arms the warning; both absent keeps today's skip-when-offline behavior.
        // W5 (Q-02): the outer "is there anything to price with" gate is GONE, because feePricingTip now
        // owns that question and answers it with null. It also answers null for a served tip that is
        // finite but not a height (65100.5, 1e16), which previously slipped through to buildFeeHeight and
        // threw into the bare catch below, silently disarming this very warning.
        const tipNow = feePricingTip(r.currentTip, r.tipFloor);
        const rec = decodeCairnxRecord(p.uri, p.payloadHash);
        const feeBearing = !!rec && typeof rec.name === "string" && tipNow != null &&
          (rec.t === "nrenew" || rec.t === "nfinalize" || (rec.t === "name" && tipNow < V25_HEIGHT));
        let feeWarn = "";
        if (feeBearing && rec) {
          try {
            const paid = outs.filter((o: any) => String(o.to).toLowerCase() === String(TREASURY_ADDR).toLowerCase())
              .reduce((a: number, o: any) => a + baseVal(o.value), 0);
            const need = Number(nameRegFee(rec.name as string, buildFeeHeight(tipNow!)));
            const noun = rec.t === "nrenew" ? "renewal" : "registration";
            const verb = rec.t === "nrenew" ? "renewed" : "registered";
            if (need > 0 && paid < need) feeWarn = danger(`The ${noun} fee here (${fmtCsd(paid)}) is below the current price (${fmtCsd(need)}). If you sign this, the fee <b>leaves</b> your wallet but the name is <b>not</b> ${verb}: an underpaid record is rejected on-chain. Use the wallet's own button (it prices this correctly).`);
          } catch { /* tip or fee unavailable: no warning */ }
        }
        // The decoded record is schema-bounded text (regex-constrained tickers, names and addresses, memo <= 64,
        // profile values capped), so it cannot scroll the money rows away; the hash echo is capped anyway.
        // Weight first (test/approve-layout-chrome.test.mjs): the cost rows, the warnings (approve.ts adds a name
        // action's verdict after #send-warn), the record's subject and money rows, the outputs; then the explanations,
        // the expiry and the hashes.
        return cx.title + cost + xfer + feeWarn + SEND_WARN + cx.main + outRows + cx.notes
          + rows([...exp, ["Payload hash", `<code>${truncLoud(String(p.payloadHash || "(none)"), 80)}</code>`], ["Anchored as", "a cairnx:v1 proposal"]]);
      }
    }
    // M15 (B5i): the raw branch renders dApp-supplied free text. Money rows first (the fee and any funds leaving the
    // wallet), then the capped and loud domain, hash and uri: unbounded text under the Approve button must never
    // scroll what this costs out of view. The uri cap is 512 (the node's own on-chain cap), so no valid record's uri
    // is cut; only oversized text the chain would reject anyway gets the marker.
    return title("Post a proposal") + cost + xfer + SEND_WARN + outRows
      + rows([...exp, ["Domain", `<code>${truncLoud(String(p.domain), DOMAIN_CAP)}</code>`], ["Payload hash", `<code>${truncLoud(String(p.payloadHash || "(none)"), 80)}</code>`], ["URI", `<code>${truncLoud(String(p.uri || "(none)"), 512)}</code>`]]);
  }
  // score and confidence are serialized as u32 (>>>0); the window shows the same value that is signed, so a negative
  // or oversized input cannot show one thing and commit another.
  if (r.method === "attest") {
    const score = Number(p.score) >>> 0, conf = Number(p.confidence) >>> 0;
    const target = `<code>${truncLoud(String(p.proposalId || "(none)"), 80)}</code>`;
    // CairnX v1.7: score 50 / confidence 0 is a claim-to-fill reservation on an open CSD offer, a payment-free attest
    // that reserves the offer for the legacy claim window (CLAIM_WINDOW_BLOCKS_V20). From V28 the chain rejects every
    // new legacy SCORE_CLAIM, so when the PoW-backed floor proves the gate has passed, warn that this is an on-chain
    // no-op that still costs the network fee (warn, never block; the floor is a local read threaded by approve.ts,
    // and when it is absent or below the gate the warning stays silent).
    if (score === 50 && conf === 0) {
      const v28warn = (Number(r.tipFloor) || 0) >= V28_HEIGHT
        ? danger(`The chain has passed the v2.8 upgrade (block ${V28_HEIGHT}): this legacy reservation type is <b>rejected</b> on-chain, so approving would be a no-op that still costs the network fee. Use the site's current buy flow instead.`)
        : "";
      return title("Reserve an open offer") + cost + v28warn + lede(`v1.7 claim-to-fill. This <b>moves no money</b>: it reserves the offer so only you can fill it for ~${CLAIM_WINDOW_BLOCKS_V20} blocks. You pay only when you complete the purchase.`)
        + rows([["Offer", target], ["Attestation", "score 50 (claim) · no payment"]]);
    }
    // CairnX v1.2: confidence 1,000,000 is the token-priced fill marker. A bare attest carrying it is byte-identical
    // to a fillOffer with empty outputs (the resolver cannot tell them apart), so it can debit the user's CairnX
    // token balance with no visible output: the same warning on either path. The rate renders from FEE_BPS_V16.
    const tokenFill = conf === CONF_TOKEN_FILL
      ? danger(`<b>Token-priced fill: approving spends tokens from your CairnX balance.</b> If this attests an open offer, the convention debits its asking amount + ${FEE_BPS_V16 / 100}% protocol fee (computed below when available). Only approve if you intend to buy from this offer; verify its price on the site or the explorer first.`) + TOKEN_SIM
      : "";
    return title("Support / review") + tokenFill + cost + rows([["Target", target], ["Attestation", attestation(score, conf)]]);
  }
  if (r.method === "sealClaim") {
    // The claim text being committed: sealClaim hashes {domain, claim, nonce} into the on-chain payloadHash, so a
    // dApp-supplied claim is what the key commits to (audit SEAL-1). The salt stays local until the reveal. M15
    // (B5i): the cost rows render above the dApp-supplied text, which is capped and loud.
    const claim = p.claim != null ? String(p.claim) : "";
    return title("Seal a claim") + lede("Commit a hidden claim on-chain, to reveal later. The salt stays in your wallet; the claim is published only when you reveal.") + cost
      + rows([["Domain", `<code>${truncLoud(String(p.domain || "csd:sealed"), DOMAIN_CAP)}</code>`], ...(claim ? [["Claim", `<code>${truncLoud(claim, 200)}</code>`] as Row] : [])]);
  }
  // M14 (B5h): a reveal publishes a secret. The full seal txid shows, and approve.ts fills #reveal-preview with the
  // domain and the claim text from the wallet's own sealed claims (a local read), so the user sees which secret.
  if (r.method === "revealClaim") return title("Reveal a sealed claim") + cost + REVEAL_PREVIEW + lede("Publish the sealed text; it becomes public and provably committed earlier.")
    + rows([["Seal tx", `<code>${truncLoud(String(r.params || ""), 80)}</code>`]]);
  // Send is the dApp method that moves funds to a page-chosen recipient: every recipient in full, each amount, the
  // total and the fee. #send-warn is filled by approve.ts (first-time and address-poisoning).
  if (r.method === "send") {
    const outs = Array.isArray(p.outputs) ? p.outputs : [{ to: p.to, value: p.amount }];
    const total = outs.reduce((a: number, o: any) => a + baseVal(o.value), 0);
    const hero = outs.length > 1 ? `${fmtCsd(total)} <span class="dim">to ${outs.length} recipients</span>` : fmtCsd(outs[0]?.value);
    return title("Send CSD") + `<div class="ap-amt">${hero}</div>` + cost + SEND_WARN + rows(outputRows(outs));
  }
  // Fill: an attest and payment outputs in one tx; CairnX applies the delivery afterwards and may refuse it, and a
  // refused CSD-paid fill keeps its payment, so the copy never calls it atomic. Funds move to a page-chosen recipient, so it
  // clear-signs like a send, plus the offer id the attest commits to. What the user receives is convention-level; a
  // CSD-paid fill paints it into #fill-view from the offer service's listing (fillViewHtml), attributed to it.
  if (r.method === "fillOffer") {
    const outs = Array.isArray(p.outputs) ? p.outputs : [];
    const total = outs.reduce((a: number, o: any) => a + baseVal(o.value), 0);
    const conf = Number(p.confidence ?? 100) >>> 0;
    // CairnX v1.2: the token-priced fill marker lets the convention debit the user's CairnX token balance (ask plus
    // the FEE_BPS_V16 protocol fee) with no CSD output visible here; an outputs-free fill would otherwise read free.
    const tokenFill = conf === CONF_TOKEN_FILL
      ? danger(`<b>Token-priced fill: approving spends tokens from your CairnX balance.</b> The trading convention debits the offer's asking amount + ${FEE_BPS_V16 / 100}% protocol fee (computed below when available). Verify the offer's price on the site or the explorer before approving.`) + TOKEN_SIM
      : "";
    // Weight first (test/approve-layout-chrome.test.mjs): the amount, the cost rows, the warnings, the listing (what the
    // fill buys) and the recipients, so a fill to many recipients keeps what it buys above the buttons; then the
    // explanation, the offer id and the attestation.
    return title("Fill offer") + (outs.length ? `<div class="ap-amt">${fmtCsd(total)}</div>` : "")
      + tokenFill + cost + SEND_WARN + (tokenFill ? "" : FILL_VIEW) + rows(outputRows(outs)) + lede(tokenFill ? FILL_RECORDS : FILL_PAYS)
      + rows([["Offer", `<code>${truncLoud(String(p.proposalId || "(none)"), 80)}</code>`], ["Attestation", attestation(Number(p.score ?? 100) >>> 0, conf)]]);
  }
  return title(escapeHtml(r.method)) + cost;
}

// The listed offer's expiry on a fill card, against the tip (the wallet's floor-clamped tip when approve.ts has it).
// Served by the offer service, so display only; the preflight decides on the proven record with the same
// offerFillTooLate, so the card names a refusal exactly when the wallet will make it.
export function offerExpiryLine(expiresAt: unknown, tip?: unknown): string {
  const h = Number(expiresAt);
  if (!Number.isSafeInteger(h) || h < 1) return "";
  const at = Number(tip);
  const block = h.toLocaleString("en-US");
  if (!Number.isSafeInteger(at) || at <= 0) return `Offer expires at block ${block}.`;
  const dist = h - at;   // blocks from the tip to the expiry block; the refusal itself is offerFillTooLate's
  if (dist <= 0) return `Offer expired at block ${block} <span class="err">(the wallet will refuse this fill)</span>.`;
  if (dist === 1) return `Offer expires at block ${block}, the next block <span class="err">(the wallet will refuse this fill)</span>.`;
  const where = `Offer expires at block ${block}, ${dist} blocks after the current tip`;
  if (offerFillTooLate(h, at)) return `${where} <span class="err">(too close to be mined in time: the wallet will refuse this fill)</span>.`;
  return `${where} (${humanBlocks(dist)}).`;
}

// #fill-view for a CSD-paid fill: the asset the offer service lists as received and the offer's expiry, then the listing
// id when the attested id is a reservation of it (the claim lane), which has no weight and goes last. Resolver-served,
// so attributed; a failed read says so.
export function fillViewHtml(view: { ok?: boolean; offerId?: string; giveTicker?: string; giveAmount?: string; giveName?: string; giveDecimals?: number; expiresAt?: number } | null | undefined, proposalId: string, tip?: unknown): string {
  if (!view || !view.ok) return danger(`Could not load this listing from the offer service, so what you receive is not shown here. Check the listing on the site before approving.`);
  const reserved = !!view.offerId && view.offerId.toLowerCase() !== String(proposalId).toLowerCase();
  const gets = view.giveName !== undefined ? `<b>${escapeHtml(view.giveName)}.csd</b>`
    : view.giveTicker !== undefined && view.giveAmount !== undefined
      ? `<b>${escapeHtml(tokenAmountBothScales(view.giveAmount, displayDecimals(view.giveTicker, view.giveDecimals).decimals, view.giveTicker))}</b>`
      : "";
  const exp = offerExpiryLine(view.expiresAt, tip);
  return (gets ? rows([["You receive", `${gets} <span class="dim">(as listed by the offer service)</span>`]]) : danger(`The offer service did not say what this listing gives. Check the listing on the site before approving.`))
    + (exp ? lede(exp) : "")
    + (reserved ? rows([["Listing", `<code>${escapeHtml(view.offerId!)}</code>`]]) + lede(`<span class="dim">The offer id below is your reservation of this listing.</span>`) : "");
}

// The line above the approval window's buttons while the request scrolls: how many recipient rows are not fully in
// view, or that something else is.
export function moreBelowText(recipients: number): string {
  if (recipients === 1) return "1 more recipient below: scroll to see it";
  if (recipients > 1) return `${recipients} more recipients below: scroll to see them`;
  return "More below: scroll to read the whole request";
}

// The approval window's buttons, and their labels in the reservation confirm step (RESERVATION_UNCONFIRMED).
export const APPROVE_LABELS = { approve: "Approve", reject: "Reject" } as const;
export const UNCONFIRMED_LABELS = { approve: "Sign anyway", reject: "Cancel" } as const;
// The line under the buttons: the latch while both wait, then what is below the fold (moreBelowText), then whether
// Approve is live. Approve held down after the latch has its reason on screen above, except a token quote still loading.
export const APPROVE_STATE = {
  arming: "Arming: both buttons wait 700 ms",
  ready: "Ready. Approve signs exactly what is shown.",
  readyUnconfirmed: "Ready. Read the warning above before you sign.",
  held: "Approve is off: see the warning above.",
  tokenWait: "Approve waits for the token amount.",
} as const;

// The confirm step: the second resolver (clarvis) has scanned past the reservation's proven height and does not know it.
export function reservationUnconfirmedHtml(u: { fclaimHeight: number; tipHeight: number }): string {
  const n = (v: number) => escapeHtml(Number.isSafeInteger(v) ? v.toLocaleString("en-US") : "?");
  return danger(`<b>The second source has no record of your reservation.</b><br>`
    + `The second source has read the chain to block ${n(u.tipHeight)} and does not know the reservation this wallet found at block ${n(u.fclaimHeight)}. `
    + `If the chain this wallet was shown is false, the reservation may have been rejected and this payment would be lost. `
    + `Check the offer and your reservation on the explorer before you sign.`);
}

// A signed reservation fill whose second-source record read had no answer when the preflight judged it: the check of
// the reservation against clarvis did not run. Shown under "sent"; null for any other value (the read answered).
export function secondSourceNote(state: unknown): string | null {
  const why = state === "pending" ? "had not answered yet" : state === "failed" ? "did not give a usable answer" : null;
  if (!why) return null;
  return `Second source not consulted: the second source (clarvis) ${why} when this fill was signed, so its check of your reservation did not run. Check on the explorer that the fill delivered.`;
}

// The box approve.ts places under the cost rows when the balance does not cover a request, and a name action's verdict
// box; one markup each for the window and the density probe that reserves their room before the paint.
export const balanceShortBox = (): string => `<div class="checks">${danger(escapeHtml(balanceShortNote("Reject this")))}</div>`;
export const nfinNoteBox = (g: { block: boolean; note: string }): string => `<div class="req" id="nfin-note">${checkRow({ tier: g.block ? "danger" : "caution", html: escapeHtml(g.note) })}</div>`;

// The balance-after is negative: the node's spendable balance (the sum of its available coins, the same
// coins the engine selects from) does not cover the debit, so signing could only end in INSUFFICIENT.
export function balanceShortNote(back: "Reject this" | "Go back"): string {
  return `Your spendable balance does not cover this request. A recent transaction may still hold some of your coins until it is mined. ${back}, and retry once that transaction is mined.`;
}

// Base units that will LEAVE the wallet if this request is approved (for balance-after).
export function debitOf(r: any): number {
  const p = r.params || {};
  if (r.method === "send" || r.method === "fillOffer") {
    const outs = Array.isArray(p.outputs) ? p.outputs : [{ value: p.amount }];
    const total = outs.reduce((a: number, o: any) => a + baseVal(o.value), 0);
    return total + baseVal(p.fee ?? defaultFeeFor(r.method));
  }
  if (r.method === "connect" || r.method === "getAddress" || r.method === "requestPermissions" || r.method === "signin" || r.method === "signinWithCsd") return 0;
  // a propose may carry protocol-fee outputs (CairnX deploy / name registration) → count them
  const outs = r.method === "propose" && Array.isArray(p.outputs) ? p.outputs.reduce((a: number, o: any) => a + baseVal(o.value), 0) : 0;
  return outs + baseVal(p.fee ?? defaultFeeFor(r.method));
}

// Address-poisoning lookalike: an attacker seeds your history with an address sharing the head+tail
// you eyeball but differing in the middle. Flag a recipient matching a previously-seen address on
// first 8 + last 4 hex but not identical.
export function lookalikeOf(to: string, known: string[]): string | null {
  const t = to.toLowerCase(), head = t.slice(0, 8), tail = t.slice(-4);
  for (const k of known) { const a = k.toLowerCase(); if (a !== t && a.slice(0, 8) === head && a.slice(-4) === tail) return k; }
  return null;
}

// NXFER-POISON-DROP (Part B): pure poisoning/first-time warning computation (approve.ts owns only the DOM
// read + mount). The first-time check keys on `known` (paid recipients PLUS the wallet's OWN account
// addresses), NOT paidRecipients alone: the site pre-fills an nset with the user's own address ("set as
// primary" right after registration), so keying on sends-only would warn every new name-holder about THEIR
// OWN address on an operation that sends nothing. An exact own address is suppressed; a LOOK-ALIKE of one of
// yours still fires (lookalikeOf runs against `known` and short-circuits before the first-time check); a
// genuinely-new external recipient is in neither set and still warns.
export function recipientStatus(to: string, sentTo: string[], ownAddrs: string[]): { firstTime: boolean; lookalike: string | null } {
  const known = [...sentTo, ...ownAddrs];
  return { lookalike: lookalikeOf(to, known), firstTime: !known.some((a) => a.toLowerCase() === to.toLowerCase()) };
}
// What the address receives decides the warning's wording: only a payment moves CSD, and a name record
// moves none. A bare string is a payment.
export type RecipientKind = "payment" | "token" | "name-point" | "name-transfer" | "proceeds";
const FIRST_TIME_LEAD: Record<RecipientKind, string> = {
  payment: "First time sending to", token: "First time sending tokens to", "name-point": "First time pointing a name at",
  "name-transfer": "First time transferring a name to", proceeds: "First time using this payout address:",
};
const WARN_TAIL: Record<RecipientKind, string> = {
  payment: "Payments are irreversible.", token: "Token transfers are irreversible.",
  "name-point": "Sends to this name will go to this address.", "name-transfer": "The new owner controls the name.",
  proceeds: "The sale proceeds will be paid to this address.",
};
/** The recipients a request's first-time and look-alike checks cover. Send, fillOffer and a propose with outputs move
 *  funds to dApp-chosen recipients (propose outputs could be a disguised payout, so they are covered too, and shown
 *  neutrally as funds leaving the wallet). A cairnx record adds the address it acts on. */
export function requestRecipients(r: any): { to: string; kind: RecipientKind }[] {
  if (r?.method !== "send" && r?.method !== "fillOffer" && r?.method !== "propose") return [];
  const p = r.params || {};
  const outs: { to: string; kind: RecipientKind }[] = (Array.isArray(p.outputs) ? p.outputs : (p.to ? [{ to: p.to }] : [])).map((o: any) => ({ to: String(o?.to || ""), kind: "payment" as const }));
  // A dApp-proposed CairnX token transfer carries its recipient in the decoded record's `to` (NOT a CSD
  // output), so the first-time / address-poisoning check would otherwise skip it (audit POPUP-1). Decode
  // the canonical+hash-committed record and include the token recipient in the same check.
  if (r.method === "propose" && String(p.domain) === CAIRNX_DOMAIN) {
    const rec = decodeCairnxRecord(p.uri, p.payloadHash);
    if (rec && rec.t === "transfer" && typeof rec.to === "string") outs.push({ to: rec.to, kind: "token" });
    // NSET-POISON-1: an nset re-points where a name RESOLVES (so future sends to it land there), and an
    // nxfer hands the name to a new owner; both carry an attacker-influenceable address that deserves the
    // same first-time / address-poisoning (look-alike) check as a transfer recipient.
    if (rec && rec.t === "nset" && typeof rec.addr === "string" && !isZeroAddr(rec.addr)) outs.push({ to: rec.addr, kind: "name-point" });   // QA #24: a V23 un-point (nset→0x0) is a sentinel, not a recipient; skip the poisoning check (0x0 sends are hard-blocked anyway)
    if (rec && rec.t === "nxfer" && typeof rec.to === "string") outs.push({ to: rec.to, kind: "name-transfer" });
    // M1 (deep-review 2026-07-03): an `offer` routes its SALE PROCEEDS to want.payto when it fills. A
    // bad-faith dApp can set payto to a look-alike of the user's OWN address, silently redirecting the
    // proceeds. The field is shown at clear-sign but had no automated look-alike flag; add it here so it
    // gets the same first-time / address-poisoning check as every other dApp-supplied recipient.
    if (rec && rec.t === "offer" && rec.want && typeof (rec.want as any).payto === "string") outs.push({ to: (rec.want as any).payto, kind: "proceeds" });
  }
  return outs;
}
// A recipient the first-time and look-alike checks flag: a look-alike of an address this wallet paid or holds is danger
// (the address-poisoning pattern), an address it has never used is caution. The wallet's own accounts and the treasury
// are never flagged.
export type Recipient = string | { to: string; kind: RecipientKind };
export type RecipientFlag = { to: string; kind: RecipientKind; tier: "danger" | "caution"; lookalike: string | null };
const recipientOf = (raw: Recipient): { to: string; kind: RecipientKind } => ({
  to: String((typeof raw === "string" ? raw : raw?.to) || ""),
  kind: typeof raw === "string" || !raw || !(raw.kind in WARN_TAIL) ? "payment" : raw.kind,
});
export function recipientFlags(recipients: Recipient[], sentTo: string[], ownAddrs: string[]): RecipientFlag[] {
  const flags: RecipientFlag[] = [];
  const seen = new Set<string>();
  for (const raw of recipients) {
    const { to, kind } = recipientOf(raw);
    if (to.toLowerCase() === TREASURY_ADDR) continue;          // fixed protocol sink, never a user recipient
    // one flag per address: a request paying one address twice is one new address, and each of its rows gets one mark
    if (seen.has(to.toLowerCase())) continue;
    seen.add(to.toLowerCase());
    const { lookalike, firstTime } = recipientStatus(to, sentTo, ownAddrs);
    if (lookalike) flags.push({ to, kind, tier: "danger", lookalike });
    else if (firstTime) flags.push({ to, kind, tier: "caution", lookalike: null });
  }
  return flags;
}
// Up to this many flagged recipients are each named in the warning box. Past it, each tier states how many and the
// approval window marks every flagged row (rowFlagHtml), so the box keeps a few lines above the buttons however many
// recipients a request carries (W-8: a site can send to hundreds).
export const NAMED_WARNINGS = 2;
const addrTag = (a: string) => `<code>${escapeHtml(a.slice(0, 10))}…${escapeHtml(a.slice(-6))}</code>`;
const tailsOf = (fs: RecipientFlag[]) => [...new Set(fs.map((f) => WARN_TAIL[f.kind]))].join(" ");
/** The warning box's rows for these flags: the danger row first, then the caution row. */
export function warningChecks(flags: RecipientFlag[]): Check[] {
  const named = flags.length <= NAMED_WARNINGS;
  const out: Check[] = [];
  for (const tier of ["danger", "caution"] as const) {
    const fs = flags.filter((f) => f.tier === tier);
    if (!fs.length) continue;
    const html = named
      ? fs.map((f) => f.tier === "danger"
        ? `<b>Possible address-poisoning:</b> ${addrTag(f.to)} resembles ${addrTag(f.lookalike ?? "")} you've seen before but is <b>not</b> identical. Verify every character. ${WARN_TAIL[f.kind]}`
        : `${FIRST_TIME_LEAD[f.kind]} ${addrTag(f.to)}. Verify every character. ${WARN_TAIL[f.kind]}`).join("<br>")
      : tier === "danger"
        ? (fs.length === 1
          ? `<b>Possible address-poisoning:</b> 1 of these addresses resembles one you've seen before but is <b>not</b> identical. It is marked in the list below. Verify every character. ${tailsOf(fs)}`
          : `<b>Possible address-poisoning:</b> ${fs.length} of these addresses resemble ones you've seen before but are <b>not</b> identical. Each is marked in the list below. Verify every character. ${tailsOf(fs)}`)
        : (fs.length === 1
          ? `1 of these addresses is new to this wallet. It is marked in the list below. Verify every character. ${tailsOf(fs)}`
          : `${fs.length} of these addresses are new to this wallet. Each is marked in the list below. Verify every character. ${tailsOf(fs)}`);
    out.push({ tier, html });
  }
  return out;
}
/** Whether the warning box only counts these flags, so the flagged rows carry the marks. */
export const warningsCounted = (flags: RecipientFlag[]): boolean => flags.length > NAMED_WARNINGS;
/** The mark on a flagged recipient row when the box only counts. */
export const rowFlagHtml = (tier: "danger" | "caution"): string => `<span class="row-flag ${tier}">${tier === "danger" ? "Look-alike" : "New"}</span>`;
export function sendWarnings(recipients: Recipient[], sentTo: string[], ownAddrs: string[]): Check[] {
  return warningChecks(recipientFlags(recipients, sentTo, ownAddrs));
}
// Every warning box these recipients can produce, whatever the history says: the approval window reserves the tallest
// before it paints (approve-density.ts), so the box landing later never pushes the request past the fold. Named boxes
// flag the two recipients with the longest lines in every tier combination; counted boxes flag all of them.
export function warningCandidates(recipients: Recipient[]): Check[][] {
  const rs = recipients.map(recipientOf).filter((r) => r.to.toLowerCase() !== TREASURY_ADDR);
  if (!rs.length) return [];
  const flag = (r: { to: string; kind: RecipientKind }, tier: "danger" | "caution"): RecipientFlag =>
    ({ ...r, tier, lookalike: tier === "danger" ? r.to : null });
  const len = (r: { kind: RecipientKind }) => FIRST_TIME_LEAD[r.kind].length + WARN_TAIL[r.kind].length;
  const longest = [...rs].sort((a, b) => len(b) - len(a)).slice(0, NAMED_WARNINGS);
  const tiers = ["danger", "caution"] as const;
  const out: Check[][] = [];
  const combos = longest.length === 1 ? tiers.map((t) => [t]) : tiers.flatMap((a) => tiers.map((b) => [a, b]));
  for (const c of combos) out.push(warningChecks(longest.map((r, i) => flag(r, c[i]!))));
  if (rs.length > NAMED_WARNINGS) {
    out.push(warningChecks(rs.map((r) => flag(r, "danger"))), warningChecks(rs.map((r) => flag(r, "caution"))),
      warningChecks(rs.map((r, i) => flag(r, i === 0 ? "danger" : "caution"))));
  }
  return out;
}

// XREPO-1. Sending to "<name>.csd" resolves the address through a configurable / MITM-able name service.
// The wallet now SPV-verifies that mapping against a PoW header chain it checks itself (core/namespv.ts),
// so the banner is VERIFIED-AWARE: when the chain backs the address it says so (and notes the honest
// residual: a former owner could still show a stale-but-real mapping); when it could NOT be verified
// (resolver offline, service not yet upgraded, or a proven mismatch already refused upstream) it carries
// the original strong caution. Either way the resolved FULL address stays the unmissable thing the user
// confirms. (The name is regex-constrained at resolution, but escape it anyway; defense in depth.)
type NameInfo = { sources?: number; disagree?: boolean; soleSource?: boolean; viaFill?: boolean };
type NameBranch = "viaFill" | "soleSource" | "disagree" | "agree" | "oneSource" | "unverified";
// Which caution a name resolution gets. viaFill is checked before (and independent of) `verified`, so a name bought
// through a fill never reads as verified; soleSource before disagree and agree, so a lone source never reads as
// servers agreeing.
function nameBranch(verified: boolean | undefined, info?: NameInfo): NameBranch {
  if (info?.viaFill) return "viaFill";
  if (!verified) return "unverified";
  if (info?.soleSource) return "soleSource";
  if (info?.disagree) return "disagree";
  return (info?.sources ?? 1) >= 2 ? "agree" : "oneSource";
}
export function nameCautionHtml(name: string, verified?: boolean, info?: NameInfo): string {
  const n = escapeHtml(String(name));
  switch (nameBranch(verified, info)) {
    // NSPV-CLAIMCAP-1 (H1): the records are chain-backed, but ownership was set by an on-chain offer fill whose
    // validity depends on state outside this name's history (a global open-lane claim cap, or a name-for-token
    // buyer's global balance), which a name-scoped proof cannot reconstruct.
    case "viaFill":
      return `<b><code>${n}.csd</code> was acquired by an on-chain purchase (offer fill).</b> The wallet SPV-verified the records, but ownership set by a fill can hinge on chain state <b>outside</b> this name's own history, which a name-scoped proof cannot verify, so the address is <b>not</b> shown as chain-verified. Confirm the <b>To</b> address out-of-band before sending.`;
    // NS-1: one source alone recovered the winner (the union failed). The address shown is still the chain-proven
    // winner; this only stops the badge from asserting multi-source verification.
    case "soleSource":
      return `<b><code>${n}.csd</code>: only one name source could prove this address.</b> The wallet SPV-verified the records, but a single source (which could be hostile or stale) alone decided the address and it is <b>not</b> independently corroborated. Confirm the <b>To</b> address out-of-band before sending.`;
    // A source's claim disagreed with the SPV-proven union winner, or reported the name unregistered (a lagging
    // second resolver, typically).
    case "disagree":
      return `<b><code>${n}.csd</code>: sources disagree.</b> The wallet SPV-verified the records, but one name source's answer did <b>not</b> match what the chain proves across the others (or reported the name unregistered). A source may be hostile, stale, or still indexing. The <b>To</b> address shown is the chain-proven winner, but <b>double-check it out-of-band</b> before any sizable send.`;
    // Two or more sources agreed. They share one operator (cairn-substrate.com and clarvis), so against record
    // withholding the residual is the single-source one: never claim independence here.
    case "agree":
      return `<b><code>${n}.csd</code>: chain-backed, ${info!.sources} name servers agree.</b> The wallet SPV-verified that this address is backed by signed, mined records. Those name servers currently share one operator, so they do not yet rule out that operator hiding a later transfer or competing claim. For any sizable send, confirm the full <b>To</b> address out-of-band.`;
    case "oneSource":
      return `<b><code>${n}.csd</code>: chain-backed (1 source).</b> The wallet SPV-verified that this address is backed by signed, mined records, but only one name source answered, and a single source could still <b>hide</b> a later transfer or a competing claim. For any sizable send, confirm the full <b>To</b> address out-of-band.`;
    case "unverified":
      return `<b>Sending to <code>${n}.csd</code>: verify the full address below.</b> The address was supplied by the name service and could <b>not</b> be verified on-chain right now; a malicious or intercepted server could substitute it. Confirm the <b>To</b> address is the correct owner of <code>${n}.csd</code> before sending.`;
  }
}

// Below this many confirmations a name's resolution could still reorg: the badge says so and the review row is caution.
export const NAME_SAFE_DEPTH = 3;
/** A send review's name row: positive only on the caution's agree branch at a depth that can no longer reorg. */
export function nameCheck(rr: NameInfo & { name?: string | null; badge?: string; lowDepth?: boolean; verified?: boolean }): Check | null {
  if (!rr.name) return null;
  const info = { sources: rr.sources, disagree: rr.disagree, soleSource: rr.soleSource, viaFill: rr.viaFill };
  const ok = nameBranch(rr.verified, info) === "agree" && !rr.lowDepth;
  const badge = rr.badge ? `<span class="check-line">${escapeHtml(rr.badge)}</span>` : "";
  return { tier: ok ? "ok" : "caution", html: nameCautionHtml(rr.name, rr.verified, info) + badge };
}

// XREPO-1 confirm-time guard. A name recipient is re-resolved at sign-time and the send is REFUSED
// unless the service still returns EXACTLY the address the user reviewed. Fail-closed on any error /
// lapse / shape change / network failure (a name that no longer resolves to the reviewed address must
// never be signed silently). Pure over the re-resolution RESULT so it's unit-testable; the popup wires
// the live `resolveName` call. NOTE: this stops a server that re-points the name BETWEEN review and
// confirm; it does NOT defend against a server that is CONSISTENTLY hostile (returns the same attacker
// address both times). Closing that requires the light client (the real fix; see the SPV name-verify path).
export function reresolveUnchanged(reviewed: string, re: { ok?: boolean; addr?: unknown; verified?: boolean } | null | undefined, reviewedVerified?: boolean): boolean {
  if (!(re && re.ok && typeof re.addr === "string" && (re.addr as string).toLowerCase() === reviewed.toLowerCase())) return false;
  // L7 (CONFIRMGUARD): also refuse a verification-status REGRESSION. If the name was chain-verified at
  // review but the confirm-time re-resolution can no longer verify it (even at the SAME address), a source
  // may have gone hostile/stale or a competing claim appeared between the two reads: re-review, don't sign.
  if (reviewedVerified === true && re.verified === false) return false;
  return true;
}

// ── nfinalize finalize-window gate (Plan 63 carry-over; the approve-path backstop for the C1 burn class) ──
// An `nfinalize` pays the registration fee (or recapture premium) for a reservation the signer holds.
// The resolver only credits it while the reservation is still THE SIGNER'S and inside its finalize
// window: a displaced or too-late finalize is no-oped on-chain AFTER the fee output left the wallet
// (fee burned, no name). The site's register flow already carries this guard (the register-names.mjs
// C1 winner re-check); this is the wallet-side backstop for any dApp-built nfinalize reaching the
// approval window. Pure over the fetched /cairnx/name/:name result + tip so it is unit-testable;
// approve.ts wires the live fetch. FAIL-OPEN by design: an unreachable name service / tip WARNS but
// never blocks; approval must not gain a hard network dependency (same posture as the
// CLEARSIGN-FEE-1 offline skip above). A clean 404 is NOT a fetch failure: it is a definitive
// "no reservation" (wallet.fillOffer's 404-vs-5xx asymmetry) and refuses.
export function nfinalizeApproveGate(fetched: NameFetchResult, me: string, tip: number | null): { block: boolean; note: string | null } {
  if (fetched.failed || tip == null || !Number.isFinite(tip)) {
    return { block: false, note: "Could not verify this name reservation is still finalizable (name service or chain tip unreachable). An expired or displaced reservation would burn the fee without registering the name. Approve only if the site shows your registration at the finalize step." };
  }
  const rec = fetched.record;
  // v2.6 recapture: the reservation on a LAPSED name lives OUTSIDE canonical state (served as
  // `.recapture` beside the stale lapsed record); winner-check the live reservation, never the
  // lapsed record itself; a lapsed record with NO reservation means there is nothing to finalize.
  const resv: Record<string, any> | null = rec == null ? null
    : rec.pending === true ? rec
    : rec.recapture && typeof rec.recapture === "object" ? { ...rec.recapture, pending: true }
    : rec.expired === true ? null
    : rec;
  // the vendored C1 check (exists / owner / pending / displacement), and, since cairnx-core 0.1.36
  // (Plans/68 B2), BOTH finalize-window sides when a tip is passed: the freeze/too-early half the old
  // local check missed (a pre-freeze finalize is rejected by the resolver AFTER the fee moved, the
  // same burn as too-late) and the expiry half that used to live in a hand-rolled windowEnd formula
  // here. The helper derives the window purely from the passed commit height (= effectiveHeight)
  // against the shared FINALIZE_TIP_MARGIN band, so wallet and site refuse on identical heights for an
  // HONEST record. TRUST SCOPE (be honest, per the SDK docstring): the wallet passes the reservation's
  // OWN effectiveHeight as the commit height (it has no independent commit height and no SPV on this
  // record), which makes the displacement guard a tautology, so this gate protects against an
  // honest-but-stale resolver and displacement races, NOT against a Byzantine resolver that lies about
  // effectiveHeight to widen the window. That closure is registration-state SPV, the same resolver-trust
  // residual the fill path documents; this gate is best-effort within that posture, and it fails OPEN on
  // transport so it never adds a hard network dependency.
  const w = finalizeWinnerCheck(resv as any, me, Number(resv?.effectiveHeight), tip);
  if (!w.safe) return { block: true, note: `Refusing to sign: ${w.reason}.` };
  return { block: false, note: null };
}

// The cost rows from the request's own params (no network): what leaves the wallet, the network fee and the total,
// with a note for what the rows cannot show. approve.ts fills #bal-after from the balance read.
const NO_FUNDS = new Set(["connect", "getAddress", "requestPermissions", "signin", "signinWithCsd"]);
function costNote(r: any): string {
  const tokenFill = (Number(r.params?.confidence ?? 100) >>> 0) === CONF_TOKEN_FILL;
  if (r.method === "fillOffer") return tokenFill ? "Plus tokens debited from your CairnX balance per the offer's terms." : "";
  if (r.method === "attest") return tokenFill ? `Plus tokens debited from your CairnX balance if this attests an open offer (its ask + ${FEE_BPS_V16 / 100}%).` : "";
  if (r.method === "propose") return Array.isArray(r.params?.outputs) && r.params.outputs.length ? "" : "The network fee is paid to miners.";
  if (r.method === "send") return "";
  return "The network fee is paid to miners, plus a tiny chain fee.";
}
export function costBlock(r: any): string {
  const balance: Row = ["Balance after", `<span id="bal-after" class="dim">checking</span>`];
  if (NO_FUNDS.has(r.method)) return `<div id="cost" class="cost">${rows([["Cost", "None: no funds move"], balance])}<p class="ap-note">This only proves your address to the site.</p></div>`;
  const fee = baseVal(r.params?.fee ?? defaultFeeFor(r.method));
  const out = debitOf(r) - fee;
  const list: Row[] = [
    // a send and a fill show what leaves above the rows (the amount); a propose's outputs get their own row here
    ...(out > 0 && r.method === "propose" ? [["Transferred out", fmtCsd(out)] as Row] : []),
    ["Network fee", feeValue(r.params?.fee, defaultFeeFor(r.method))],
    ...(out > 0 ? [["Total", fmtCsd(debitOf(r))] as Row] : []),
    balance,
  ];
  const note = costNote(r);
  return `<div id="cost" class="cost">${rows(list)}${note ? `<p class="ap-note">${note}</p>` : ""}</div>`;
}
