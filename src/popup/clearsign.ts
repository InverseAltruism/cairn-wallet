// Pure clear-signing formatters for the approval window — NO DOM / chrome, so they're unit-testable
// (the high-stakes "what am I signing?" layer). approve.ts imports these and only owns the DOM glue.
import { decodeCairnxRecord, CAIRNX_DOMAIN } from "../core/cairnx.js";

export const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

// Surface a fee in CSD and flag an unusually large one so a phishing site can't slip a huge fee past
// a user skimming the dialog. propose min is 0.25 CSD; >5 CSD is odd.
const FEE_WARN = 5 * 1e8;

// Coerce a base-unit value for DISPLAY: a malicious/garbage value renders "invalid amount", never
// "NaN CSD" — which a user skimming the clear-signing dialog might approve as a meaningless amount. C-WL5
export function fmtCsd(raw: any): string { const n = Number(raw); return Number.isFinite(n) ? `${n / 1e8} CSD` : "invalid amount"; }
// Finite base-unit number for sums / balance-after math (garbage → 0; the tx won't build anyway —
// node.send/sendMany hard-reject non-numeric amounts, so this only keeps the DISPLAY sane).
export function baseVal(raw: any): number { const n = Number(raw); return Number.isFinite(n) ? n : 0; }

export function feeLine(raw: number, fallback = 0): string {
  const fee = Number(raw || fallback);
  if (!Number.isFinite(fee)) return `fee: <span class="err">invalid amount</span>`;
  const warn = fee > FEE_WARN ? ` <span class="err">⚠ unusually large fee</span>` : "";
  return `fee: ${fee / 1e8} CSD${warn}`;
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
  if (s && typeof s === "object" && "value" in s) return `${fmtCsd(Number(s.value))}`;
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
      return `<b>CairnX token deploy</b><br>ticker: <b>${esc(r.ticker)}</b>${r.name !== undefined ? ` (${esc(r.name)})` : ""}<br>supply: ${baseAmt(r.supply)} · decimals: ${esc(r.decimals)}<br>minting: ${esc(r.mint)}${limit}`;
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
      return `<b>.csd name commit</b> — reserves a sealed name claim (revealed later)<br>commit: <code>${esc(r.commit)}</code>`;
    case "name":
      return `<b>.csd name claim</b><br>name: <code>${esc(r.name)}.csd</code>${r.salt !== undefined ? `<br><span class="dim">reveals a prior commit</span>` : ""}`;
    case "nxfer":
      return `<b>.csd name transfer</b><br>name: <code>${esc(r.name)}.csd</code><br>to: <code>${esc(r.to)}</code>`;
    case "nset":
      return `<b>.csd name → address record</b><br><code>${esc(r.name)}.csd</code> resolves to <code>${esc(r.addr)}</code>`;
    case "nrenew":
      return `<b>.csd name renewal</b><br>extends the lease on <code>${esc(r.name)}.csd</code>`;
    case "tmeta":
      return `<b>CairnX token metadata</b> (issuer-only)<br>token: <b>${esc(r.ticker)}</b><br>content: <code>${esc(r.hash)}</code>`;
    default:
      return null;
  }
}

export function describe(r: any): string {
  const p = r.params || {};
  if (r.method === "connect" || r.method === "getAddress") return "<b>Connect</b> — share your address with this site.";
  if (r.method === "signin") return "<b>Sign in with CSD</b> — prove your address (no transaction, no funds move).";
  // Clear-signing: show EVERYTHING the site controls and the chain will commit —
  // not just domain+fee. payloadHash/uri are dApp-supplied and were previously hidden.
  if (r.method === "propose") {
    // A proposal MAY carry value outputs (e.g. a CairnX protocol fee to its treasury). The wallet
    // cannot verify a recipient is a "legit fee" — so these are shown NEUTRALLY as funds leaving
    // the wallet, capped + truncated, with the SAME first-time/look-alike (address-poisoning)
    // warning as Send (#send-warn, populated by approve.ts). This defeats a malicious site that
    // tries to disguise a payout to itself as a "fee".
    const outs = Array.isArray(p.outputs) ? p.outputs : [];
    const SHOWN = 6;
    const total = outs.reduce((a: number, o: any) => a + baseVal(o.value), 0);
    const rows = outs.slice(0, SHOWN).map((o: any) => `→ <code>${escapeHtml(String(o.to))}</code> &nbsp;<b>${fmtCsd(o.value)}</b>`).join("<br>")
      + (outs.length > SHOWN ? `<br><span class="dim">…and ${outs.length - SHOWN} more recipient(s)</span>` : "");
    const xfer = outs.length
      ? `<br><b>⚠ this proposal also transfers funds OUT of your wallet:</b><br>${rows}<br>total out: <b>${fmtCsd(total)}</b><div id="send-warn" class="err" style="margin-top:8px" hidden></div>`
      : "";
    // cairnx:v1 proposes are ACTIONS (token transfer / offer / name claim…): decode the
    // record and clear-sign its fields instead of a raw JSON blob. Falls through to the
    // raw uri for anything that doesn't decode (which the resolver would no-op anyway).
    if (String(p.domain) === CAIRNX_DOMAIN) {
      const cx = cairnxDescribe(p.uri, p.payloadHash);
      if (cx) return `${cx}<br><span class="dim">anchored as a cairnx:v1 proposal</span><br>${feeLine(p.fee, 1000000)}`
        + `<br>payload hash: <code>${escapeHtml(String(p.payloadHash || "—"))}</code>${xfer}`;
    }
    return `<b>Post a proposal</b><br>domain: <code>${escapeHtml(String(p.domain))}</code><br>${feeLine(p.fee, 1000000)}`
      + `<br>payload hash: <code>${escapeHtml(String(p.payloadHash || "—"))}</code><br>uri: <code>${escapeHtml(String(p.uri || "—"))}</code>${xfer}`;
  }
  // score/confidence are serialized as u32 (>>>0); display the SAME value that will be
  // signed so a negative/oversized input can't show one thing and commit another.
  if (r.method === "attest") return `<b>Support / review</b><br>target: <code>${escapeHtml(String(p.proposalId || "—"))}</code><br>${feeLine(p.fee)} · score ${(Number(p.score) >>> 0)} · confidence ${(Number(p.confidence) >>> 0)}`;
  if (r.method === "sealClaim") return `<b>Seal a claim</b> — commit a hidden claim on-chain (reveal later).<br>domain: <code>${escapeHtml(String(p.domain || "csd:sealed"))}</code><br>${feeLine(p.fee, 25000000)} · the salt + claim stay in your wallet`;
  if (r.method === "revealClaim") return `<b>Reveal a sealed claim</b> — publish the preimage; it becomes public + provably committed earlier.<br>tx: <code>${escapeHtml(String(r.params || "").slice(0, 18))}…</code>`;
  // Send is the only dApp method that MOVES funds to a page-chosen recipient, so we
  // clear-sign the FULL (untruncated) recipient address(es) + each amount + total + fee.
  // #send-warn is populated async by fillSendWarning (first-time / address-poisoning).
  if (r.method === "send") {
    const outs = Array.isArray(p.outputs) ? p.outputs : [{ to: p.to, value: p.amount }];
    const total = outs.reduce((a: number, o: any) => a + baseVal(o.value), 0);
    // Cap rendered rows so a huge multi-output request can't scroll the fee/total/buttons
    // out of the window; the total + count are always shown.
    const SHOWN = 12;
    const rows = outs.slice(0, SHOWN).map((o: any) => `→ <code>${escapeHtml(String(o.to))}</code> &nbsp;<b>${fmtCsd(o.value)}</b>`).join("<br>")
      + (outs.length > SHOWN ? `<br><span class="dim">…and ${outs.length - SHOWN} more recipient(s)</span>` : "");
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
    const SHOWN = 12;
    const rows = outs.slice(0, SHOWN).map((o: any) => `→ <code>${escapeHtml(String(o.to))}</code> &nbsp;<b>${fmtCsd(o.value)}</b>`).join("<br>")
      + (outs.length > SHOWN ? `<br><span class="dim">…and ${outs.length - SHOWN} more recipient(s)</span>` : "");
    const totalLine = outs.length > 1 ? `<br>total: <b>${fmtCsd(total)}</b> to ${outs.length} recipients` : "";
    // CairnX v1.2: confidence 1 000 000 is the TOKEN-PRICED-FILL marker — approving it lets the
    // convention debit the user's CairnX token balance (offer ask + 1% fee) with NO CSD output
    // visible here. The wallet can't see which token/how much (resolver-level), so it must say
    // so loudly: an outputs-free fill would otherwise clear-sign as "free".
    const tokenFill = (Number(p.confidence ?? 100) >>> 0) === 1_000_000
      ? `<br><b class="err">⚠ TOKEN-PRICED FILL: approving SPENDS TOKENS from your CairnX balance</b> — the offer's asking amount + 1% protocol fee, debited by the trading convention (not visible as outputs below). Verify the offer's price on the site/explorer before approving.`
      : "";
    return `<b>Fill offer</b> — pay + attest in ONE atomic transaction<br>`
      + `offer: <code>${escapeHtml(String(p.proposalId || "—"))}</code>${tokenFill}<br>${rows}<br>`
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
  if (r.method === "connect" || r.method === "getAddress" || r.method === "signin") return 0;
  // a propose may carry protocol-fee outputs (CairnX deploy / name registration) → count them
  const outs = r.method === "propose" && Array.isArray(p.outputs) ? p.outputs.reduce((a: number, o: any) => a + baseVal(o.value), 0) : 0;
  return outs + baseVal(p.fee || (r.method === "sealClaim" ? 25000000 : 0));
}

// Address-poisoning lookalike: an attacker seeds your history with an address sharing the head+tail
// you eyeball but differing in the middle. Flag a recipient matching a previously-seen address on
// first 8 + last 4 hex but not identical.
export function lookalikeOf(to: string, known: string[]): string | null {
  const t = to.toLowerCase(), head = t.slice(0, 8), tail = t.slice(-4);
  for (const k of known) { const a = k.toLowerCase(); if (a !== t && a.slice(0, 8) === head && a.slice(-4) === tail) return k; }
  return null;
}

// Cost summary line from the request's own params (no network).
export function costLine(r: any): string {
  if (r.method === "connect" || r.method === "getAddress" || r.method === "signin") return "no funds move — this only shares/signs your identity.";
  if (r.method === "send") { const fee = baseVal(r.params?.fee || 1_000_000); const sent = debitOf(r) - fee; return `cost: ${fmtCsd(sent)} sent + ${fmtCsd(fee)} network fee.`; }
  if (r.method === "fillOffer") {
    const fee = baseVal(r.params?.fee || 5_000_000); const sent = debitOf(r) - fee;
    const tok = (Number(r.params?.confidence ?? 100) >>> 0) === 1_000_000 ? " PLUS tokens debited from your CairnX balance per the offer's terms" : "";
    return `cost: ${fmtCsd(sent)} paid to the seller + ${fmtCsd(fee)} network fee${tok} — atomic with the fill.`;
  }
  if (r.method === "propose") {
    const outs = Array.isArray(r.params?.outputs) ? r.params.outputs : [];
    const out = outs.reduce((a: number, o: any) => a + baseVal(o.value), 0);
    const fee = baseVal(r.params?.fee || 1_000_000);
    return out ? `cost: ${fmtCsd(out)} transferred out of your wallet + ${fmtCsd(fee)} network fee.` : `cost: ${fmtCsd(fee)} network fee (paid to miners).`;
  }
  const fee = baseVal(r.params?.fee || (r.method === "sealClaim" ? 25000000 : 0));
  return `cost: ${fmtCsd(fee)} network fee (paid to miners), + a tiny chain fee.`;
}
