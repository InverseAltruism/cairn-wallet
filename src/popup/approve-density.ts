// The approval window's density for one paint: roomy, the approved design's sizes, or compact, the dense scale on which
// every element with weight fits above the buttons for every request shape (test/approve-layout-chrome.test.mjs).
//
// A request paints roomy only when all of it fits the window in the roomy scale with every mount that fills after the
// paint (the recipient warnings, the balance note, a name action's verdict, a fill's listing, the token quote, a
// reveal's secret) reserved at the tallest content it can take. approve.ts decides this synchronously between writing
// the request and the first frame and never changes it for that paint, so the window never shows one density and then
// the other, and a mount landing later fits its reserve, so nothing moves after the latch arms. Served text (a listing,
// a quote) has no length cap; a hostile offer service can outgrow any reserve and push its own text past the fold in
// either density, but not what comes before it: the cost and the warnings render first (test/approve-layout-chrome).
import {
  balanceShortBox, checkRow, debitOf, fillViewHtml, nfinNoteBox, nfinalizeApproveGate, NAMED_WARNINGS, requestRecipients,
  revealPreviewHtml, rowFlagHtml, tokenQuoteHtml, warningCandidates,
} from "./clearsign.js";
import { nameActApproveGate } from "../core/namegate.js";
import { decodeCairnxRecord, CAIRNX_DOMAIN } from "../core/cairnx.js";

export type Density = "roomy" | "compact";
// A mount's room: `id` names a mount describe() wrote (hidden and empty); `after` lists the ids a box is placed after,
// first found wins, as approve.ts places it; `marks` is the mark a counted warning box puts on every recipient row.
type Reserve = { id: string; candidates: string[] } | { after: string[]; candidates: string[] } | { marks: string };

// The longest values these cards print: a seven-digit block height, a 32-character name (NAME_RE), a 12-character
// ticker (TICKER_RE) of wide letters that also trips the look-alike warning, a 20-digit u64 amount, a 128-byte domain
// (the node's cap) and a claim at the 300-character display cap.
const TIP = 9_999_999;
const NAME = "w".repeat(32);
const TICKER = "CX" + "W".repeat(10);
const AMOUNT = "9".repeat(20);
const OTHER = "0x" + "f".repeat(40);

function fillViewCandidates(id: string): string[] {
  const listing = "0x" + "e".repeat(64);
  return [
    fillViewHtml(null, id),
    fillViewHtml({ ok: true }, id),
    fillViewHtml({ ok: true, offerId: listing, giveName: NAME, expiresAt: TIP + 2 }, id, TIP),
    fillViewHtml({ ok: true, offerId: listing, giveTicker: TICKER, giveAmount: AMOUNT, giveDecimals: 8, expiresAt: TIP + 2 }, id, TIP),
  ];
}
function tokenQuoteCandidates(): string[] {
  const q = { ok: true, ticker: TICKER, amount: AMOUNT, fee: AMOUNT, total: AMOUNT, wantDecimals: 8, estimated: true, expiresAt: TIP + 2 };
  return [
    tokenQuoteHtml(null),
    tokenQuoteHtml({ ...q, giveTicker: TICKER, giveAmount: AMOUNT, giveDecimals: 8 }, TIP),
    tokenQuoteHtml({ ...q, giveName: NAME }, TIP),
  ];
}
function revealCandidates(): string[] {
  return [revealPreviewHtml({ failed: true }), revealPreviewHtml(null), revealPreviewHtml({ domain: "w".repeat(128), claim: "W".repeat(400) }),
    revealPreviewHtml({ domain: "w".repeat(128) })];
}
// Every verdict note the name action's gate can paint, from its own functions over each kind of answer.
function nameNoteCandidates(t: "nfinalize" | "nrenew" | "nset", me: string): string[] {
  const notes = t === "nfinalize"
    ? [{ failed: true as const }, { record: null }, { record: { owner: OTHER, pending: true, effectiveHeight: TIP } },
      { record: { owner: me, pending: false } }, { record: { owner: me, pending: true, effectiveHeight: TIP } },
      { record: { owner: me, pending: true, effectiveHeight: 1 } }].map((f) => nfinalizeApproveGate(f, me, TIP))
    : [{ failed: true as const }, { record: null }, { record: { owner: OTHER } }, { record: { owner: me, pending: true } },
      { record: { owner: me, expired: true } }].map((f) => nameActApproveGate(t, f, me));
  return notes.flatMap((g) => (g.note ? [nfinNoteBox({ block: g.block, note: g.note })] : []));
}

/** The mounts request `r` fills after its paint, each with every content it can take. `me` is the signing address. */
export function reservesFor(r: any, me: string): Reserve[] {
  const p = r?.params || {};
  const out: Reserve[] = [];
  const recipients = requestRecipients(r);
  const warn = warningCandidates(recipients).map((cs) => cs.map(checkRow).join(""));
  if (warn.length) out.push({ id: "send-warn", candidates: warn });
  // past NAMED_WARNINGS the box counts and every flagged row carries a mark; the longer one on every row is the tallest
  if (new Set(recipients.map((x) => x.to.toLowerCase())).size > NAMED_WARNINGS) out.push({ marks: rowFlagHtml("danger") });
  if (debitOf(r) > 0) out.push({ after: ["cost"], candidates: [balanceShortBox()] });
  if (r?.method === "propose" && String(p.domain) === CAIRNX_DOMAIN) {
    const rec = decodeCairnxRecord(p.uri, p.payloadHash);
    if (rec && typeof rec.name === "string" && (rec.t === "nfinalize" || rec.t === "nrenew" || rec.t === "nset")) {
      out.push({ after: ["send-warn", "cost"], candidates: nameNoteCandidates(rec.t, me) });
    }
  }
  if (document.getElementById("fill-view")) out.push({ id: "fill-view", candidates: fillViewCandidates(String(p.proposalId || "")) });
  if (document.getElementById("token-sim")) out.push({ id: "token-sim", candidates: tokenQuoteCandidates() });
  if (document.getElementById("reveal-preview")) out.push({ id: "reveal-preview", candidates: revealCandidates() });
  return out;
}

/** Whether the whole request is in view without scrolling. */
const requestFits = (req: HTMLElement): boolean => req.scrollHeight <= req.clientHeight + 1;

/** The density for the paint now in `req`: roomy when it fits in the roomy scale with every reserve at its tallest. Leaves
 *  the request, its mounts and `app.dataset.density` as they were, except the density, which the caller sets. */
export function chooseDensity(app: HTMLElement, req: HTMLElement, reserves: Reserve[]): Density {
  const was = app.dataset.density;
  app.dataset.density = "roomy";
  const placed: HTMLElement[] = [];
  const restore: (() => void)[] = [];
  try {
    if (!requestFits(req)) return "compact";
    for (const r of reserves) {
      if ("marks" in r) {
        for (const dd of req.querySelectorAll<HTMLElement>(".kv > div[data-to] > dd")) {
          dd.insertAdjacentHTML("beforeend", r.marks);
          const mark = dd.lastElementChild;
          if (mark) placed.push(mark as HTMLElement);
        }
        continue;
      }
      let el: HTMLElement | null;
      if ("id" in r) {
        el = document.getElementById(r.id);
        if (!el) continue;
        const html = el.innerHTML, hidden = el.hidden, target = el;
        restore.push(() => { target.innerHTML = html; target.hidden = hidden; target.style.height = ""; });
      } else {
        const anchor = r.after.map((id) => document.getElementById(id)).find((x) => x);
        if (!anchor) continue;
        el = document.createElement("div");
        anchor.insertAdjacentElement("afterend", el);
        placed.push(el);
      }
      el.hidden = false;
      let tallest = 0;
      for (const html of r.candidates) {
        el.innerHTML = html;
        tallest = Math.max(tallest, el.getBoundingClientRect().height);
      }
      el.innerHTML = "";
      el.style.height = `${tallest}px`;
    }
    return requestFits(req) ? "roomy" : "compact";
  } catch {
    return "compact";   // a probe that cannot measure leaves the paint in the dense sizes, which hold the fold
  } finally {
    for (const el of placed) el.remove();
    for (const undo of restore) undo();
    if (was === undefined) delete app.dataset.density; else app.dataset.density = was;
  }
}
