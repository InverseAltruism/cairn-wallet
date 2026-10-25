// The Activity tab.
import { explorerLink } from "../core/explorer.js";
import { INCLUSION_NOTICE_BLOCKS, inclusionMark } from "../core/inclusion.js";
import { escapeHtml, fmtBalance } from "./clearsign.js";
import { enterOnce } from "./motion.js";
import { call } from "./popup-bridge.js";
import { $ } from "./popup-dom.js";
import { curAddr, currentExplorer } from "./popup-state.js";
import { openPanel } from "./popup-panels.js";

// A label says what this wallet sent, not what the market or the resolver made of it: the history records no
// verdict, so a fill the offer refused and a token transfer the balance did not cover still read as sent.
const TX_LABEL: Record<string, string> = { send: "Sent", propose: "Proposed", post: "Posted", support: "Supported", attest: "Supported", fillOffer: "Offer fill sent", tokenSend: "Token transfer sent", consolidate: "Merged coins" };
// A time in Activity and the sealed claims: the explorer's format and clock (24-hour UTC, day before month) without
// the seconds, so a row reads the same on every machine and matches the explorer: "24 Oct 2026, 15:30 UTC".
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function whenText(ts: number): string {
  const d = new Date(Number(ts));
  if (Number.isNaN(d.getTime())) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} UTC`;
}
// The sprite's external-link icon after a link's text, in place of an arrow character.
export const EXTERNAL_ICON = `<svg class="i ext" aria-hidden="true"><use href="icons.svg#i-external-link"/></svg>`;
const TX_ICON: Record<string, string> = { send: "i-arrow-up-right", tokenSend: "i-arrow-up-right", fillOffer: "i-arrow-left-right", consolidate: "i-refresh-cw", post: "i-message-square-text", propose: "i-stamp" };
export async function renderHistory() {
  const h: any[] = await call("history");
  const el = $("history-list");
  if (!h.length) { el.innerHTML = `<div class="dim" style="padding:8px 0">No transactions yet. Send, post, or support something and it'll appear here.</div>`; return; }
  el.innerHTML = h.map((t) => {
    // token sends display the HUMAN token amount (decimals-aware), not base units as CSD; a coin
    // merge only spends the fee (the total returns to self), so show the FEE as the amount so it
    // doesn't read like a big outgoing payment.
    const csd = t.type === "tokenSend"
      ? `${escapeHtml(String(t.human ?? t.amount ?? ""))} ${escapeHtml(String(t.ticker || ""))}`
      : t.type === "consolidate"
        ? "Fee " + fmtBalance(Number(t.fee ?? 0)) + " CSD"
        : fmtBalance(Number(t.amount ?? t.fee ?? 0)) + " CSD";
    const kind = TX_LABEL[t.type] || t.type;
    const detail = (t.type === "send" || t.type === "fillOffer" || t.type === "tokenSend") ? `to ${escapeHtml(String(t.to || "").slice(0, 12))}…`
      : t.type === "consolidate" ? `${Number(t.merged) || "?"} coins → 1${t.amount ? ` · ${fmtBalance(Number(t.amount))} CSD` : ""}`
      : t.title ? escapeHtml(String(t.title).slice(0, 28))
      : t.domain ? escapeHtml(String(t.domain))
      : t.target ? `${escapeHtml(String(t.target).slice(0, 12))}…` : "";
    const when = t.ts ? whenText(t.ts) : "";
    // The marker reads what the balance refresh's reconcile (pendingMerge) stored on the row; the render
    // itself makes no chain read. Only a gone row (an input spent by a different mined tx, seen at two tips)
    // says not included.
    const mark = inclusionMark(t);
    const maybeMark = mark === "sent" ? ` <span class="dim">· sent, not yet included</span>`
      : mark === "stuck" ? ` <span class="dim">· still not included after ${INCLUSION_NOTICE_BLOCKS} blocks; check the explorer before sending again</span>`
      : mark === "gone" ? ` <span class="dim">· not included: its coins were spent by another transaction; check the explorer before sending again</span>`
      : "";
    return `<div class="tx"><span class="ti"><svg class="i" aria-hidden="true"><use href="icons.svg#${TX_ICON[t.type] ?? "i-arrow-up-right"}"/></svg></span>
      <span class="nm"><b class="tx-kind">${escapeHtml(kind)}</b><small><span class="dim">${detail}</span>${when ? ` · ${when}` : ""}${maybeMark}</small></span>
      <span class="vl"><span class="tx-amt">${csd}</span><small><a href="${escapeHtml(explorerLink(currentExplorer, "tx", String(t.txid)))}" target="_blank" rel="noopener noreferrer">${escapeHtml(String(t.txid).slice(0, 10))}…${EXTERNAL_ICON}</a></small></span>
    </div>`;
  }).join("");
  enterOnce(el, curAddr);
}

$("btn-activity-t").addEventListener("click", () => { if (openPanel("activity")) renderHistory(); });
