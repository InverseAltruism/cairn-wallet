// The review-and-confirm engine the CSD and token sends share.
import { checkRow, type Check, escapeHtml, fmtBalance } from "./clearsign.js";
import { type Outcome, refusedCopy, thrownCopy } from "./popup-bridge.js";
import { $, msg, msgAction } from "./popup-dom.js";
import { dropReviews } from "./popup-state.js";
import { celebrateSend, mergePendingNow, refreshBalance } from "./popup-balance.js";
import { renderAssets } from "./popup-assets.js";
import { openConsolidatePanel } from "./popup-coins.js";

// ── shared send-flow engine ───────────────────────────────────────────────────────────────────
// The CSD and token send panels are deliberate twins with three real deltas, carried by a flow
// DESCRIPTOR (the element ids are irregular; send-/s-/c- vs tsend-/ts-/tc-; so a prefix won't do):
//   • refresh: a token send repaints the token balances too (renderAssets), a CSD send only the balance
//     (naive sharing would mean a stale token row or a pointless extra fetch; both user-visible);
//   • warning noun: "transfers" (token) vs "payments" (CSD); DELIBERATE per-flow copy, not drift;
//   • snapshot shape: reviewState.reviewed (token, base-unit string) vs .reviewedSend (CSD, number).
// Only the SUCCESS path clears the typed recipient/amount (fail/catch keep the draft for a re-Review);
// Back clears nothing and never refreshes.
type SendFlow = { ids: { confirm: string; to: string; amt: string }; noun: "transfers" | "payments"; refresh: () => void };
export const TOKEN_FLOW: SendFlow = { ids: { confirm: "tsend-confirm", to: "ts-to", amt: "ts-amt" }, noun: "transfers", refresh: () => { refreshBalance(); renderAssets(); } };
export const CSD_FLOW: SendFlow = { ids: { confirm: "send-confirm", to: "s-to", amt: "s-amt" }, noun: "payments", refresh: () => { refreshBalance(); } };
// Hide the confirm card, drop every frozen snapshot, re-enable the inputs. Success alone clears the
// typed values; every other exit (Back / fail / catch) keeps the draft.
export function teardownReview(f: SendFlow, clearValues: boolean) {
  ($(f.ids.confirm) as HTMLElement).hidden = true;
  dropReviews();
  for (const id of [f.ids.to, f.ids.amt]) { const el = $(id) as HTMLInputElement; el.disabled = false; if (clearValues) el.value = ""; }
}
// Arm the review: disable the inputs the snapshot was read from and show the confirm card (editing
// the form after "Review" must not let displayed values diverge from signed ones).
export function armReview(f: SendFlow) {
  ($(f.ids.to) as HTMLInputElement).disabled = true;
  ($(f.ids.amt) as HTMLInputElement).disabled = true;
  ($(f.ids.confirm) as HTMLElement).hidden = false;
  msg("");
}

// One source for the review-card warning copy. `noun` is the ONLY wording difference between the two
// flows ("transfers" for tokens, "payments" for CSD; deliberate per-flow copy); the strings are
// otherwise the historical ones byte-for-byte. Empty return = nothing to warn about (box hidden).
export function composeSendWarning(lookalike: string | null, firstTime: boolean, nameCaution: Check | null, noun: "transfers" | "payments"): Check[] {
  const Noun = noun.charAt(0).toUpperCase() + noun.slice(1);
  const out: Check[] = nameCaution ? [nameCaution] : [];
  if (lookalike) out.push({ tier: "danger", html: `⚠ <b>Possible address-poisoning.</b> This looks like <code>${escapeHtml(lookalike.slice(0, 10))}…${escapeHtml(lookalike.slice(-6))}</code> you've seen before but is NOT the same address. Verify every character. ${Noun} are irreversible.` });
  else if (firstTime) out.push({ tier: "danger", html: `⚠ First time sending to this address: check every character. ${Noun} are irreversible.` });
  return out;
}
export function setWarn(el: HTMLElement, checks: Check[]) {
  if (checks.length) { el.innerHTML = checks.map(checkRow).join(""); el.hidden = false; }
  else { el.innerHTML = ""; el.hidden = true; }
}
// FOOT-3 double-send guard, shared by both flows' ok:false and thrown branches: do NOT leave Confirm
// armed on the same frozen snapshot after a failure (one more click after an ambiguous submit selects a
// DIFFERENT coin and double-pays). Tear the review down (draft preserved) so resending takes a
// deliberate re-Review, and refresh. Only the failure branches route here; the happy path is untouched.
function sendOutcome(f: SendFlow, o: Outcome) {
  teardownReview(f, false);
  f.refresh();
  msg(o.text, o.cls);
}
// A throw is routed by whether anything could have been submitted (see AnsweredError).
export function sendThrew(f: SendFlow, e: any) { sendOutcome(f, thrownCopy(e, "send")); }
// A structured {ok:false} from the send engine: only SUBMIT_MAYBE_INFLIGHT is ambiguous; every other
// code is a clean pre-broadcast refusal or a definitive rejection, shown with the engine's own reason.
export function sendRefused(f: SendFlow, r: any) {
  const o = refusedCopy(r, "send");
  if (o.maybe) return sendOutcome(f, o);
  teardownReview(f, false);
  f.refresh();
  let text = o.text;
  // Merge-aware refusals (Plans/66 B4b): right after a consolidate, the confirmed balance is
  // legitimately short by the whole merging amount; say so instead of leaving "insufficient"
  // to read as lost funds.
  if ((r?.code === "INSUFFICIENT" || r?.code === "TOO_MANY_INPUTS") && mergePendingNow.pending) {
    text += ` A coin merge (${fmtBalance(mergePendingNow.amount)} CSD) is still confirming; retry once it is mined.`;
  }
  // TOO_MANY_INPUTS: the remedy is one click away; surface it as an action, not a breadcrumb
  // in a toast that fades mid-read (Plans/66 B5).
  if (r?.code === "TOO_MANY_INPUTS") {
    return msgAction(text, "Merge coins now", () => { void openConsolidatePanel(true); });
  }
  msg(text, "err");
}
// Success teardown: outcome message + hero glow first, then the one clear-the-draft path.
export function sentOk(f: SendFlow, text: string) {
  msg(text, "ok sent");
  celebrateSend();
  teardownReview(f, true);
  f.refresh();
}
