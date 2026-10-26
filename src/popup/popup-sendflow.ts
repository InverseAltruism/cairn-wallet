// The review-and-confirm engine the CSD and token sends share.
import { checkRow, type Check, escapeHtml, fmtBalance } from "./clearsign.js";
import { type Outcome, refusedCopy, thrownCopy } from "./popup-bridge.js";
import { $, busy, msg, msgAction } from "./popup-dom.js";
import { dropReviews } from "./popup-state.js";
import { celebrateSend, mergePendingNow, refreshBalance } from "./popup-balance.js";
import { closeAllPanels, syncNav } from "./popup-panels.js";
import { tokenMs } from "./motion.js";
import { renderAssets } from "./popup-assets.js";
import { openConsolidatePanel } from "./popup-coins.js";
import { nameStillPointsTo } from "./popup-recipient.js";

// ── shared send-flow engine ───────────────────────────────────────────────────────────────────
// The CSD and token send panels are deliberate twins with three real deltas, carried by a flow
// DESCRIPTOR (the element ids are irregular; send-/s-/c- vs tsend-/ts-/tc-; so a prefix won't do):
//   • refresh: a token send repaints the token balances too (renderAssets), a CSD send only the balance
//     (naive sharing would mean a stale token row or a pointless extra fetch; both user-visible);
//   • warning noun: "transfers" (token) vs "payments" (CSD); DELIBERATE per-flow copy, not drift;
//   • snapshot shape: reviewState.reviewed (token, base-unit string) vs .reviewedSend (CSD, number).
// Only the SUCCESS path clears the typed recipient/amount (fail/catch keep the draft for a re-Review);
// Back clears nothing and never refreshes. `sent` is the sent toast's second line.
type SendFlow = { ids: { confirm: string; button: string; to: string; amt: string }; noun: "transfers" | "payments"; refresh: (settleIn?: number) => void; sent: (txid: string) => string };
const pending = (txid: string) => `Transaction ${String(txid).slice(0, 12)}… is waiting for inclusion in a block.`;
export const TOKEN_FLOW: SendFlow = { ids: { confirm: "tsend-confirm", button: "btn-tsend-confirm", to: "ts-to", amt: "ts-amt" }, noun: "transfers", refresh: (settleIn) => { refreshBalance(settleIn); renderAssets(); },
  sent: (txid) => `${pending(txid)} The token balance updates once it is mined.` };
export const CSD_FLOW: SendFlow = { ids: { confirm: "send-confirm", button: "btn-send-confirm", to: "s-to", amt: "s-amt" }, noun: "payments", refresh: (settleIn) => { refreshBalance(settleIn); },
  sent: pending };
// A Confirm whose review was dropped (Back, a sheet switch, a lock, an account switch) or replaced while it waited.
export const REVIEW_GONE = "The review was closed before it was signed. Nothing was sent.";
// Hide the confirm card, drop every frozen snapshot, re-enable the inputs. Success alone clears the
// typed values; every other exit (Back / fail / catch) keeps the draft.
export function teardownReview(f: SendFlow, clearValues: boolean) {
  ($(f.ids.confirm) as HTMLElement).hidden = true;
  dropReviews();
  for (const id of [f.ids.to, f.ids.amt]) { const el = $(id) as HTMLInputElement; el.disabled = false; if (clearValues) el.value = ""; }
}
// Arm the review: disable the inputs the snapshot was read from and show the confirm card (editing
// the form after "Review" must not let displayed values diverge from signed ones). Confirm is live unless `hold`
// (a balance that does not cover the send) or a send is still in flight; a Confirm click disarms it until the next
// review.
export function armReview(f: SendFlow, hold = false) {
  ($(f.ids.to) as HTMLInputElement).disabled = true;
  ($(f.ids.amt) as HTMLInputElement).disabled = true;
  ($(f.ids.button) as HTMLButtonElement).disabled = hold || submitting;
  ($(f.ids.confirm) as HTMLElement).hidden = false;
  msg("");
}

// ── Confirm, for both sends ────────────────────────────────────────────────────────────────────
// Confirm signs the frozen review and nothing else (R3: "Confirm signs the frozen review snapshot"; "one Confirm is one
// signature"; "any failure tears the review down"):
//   - the click disarms Confirm before any await, and the snapshot is consumed before the call;
//   - after the confirm-time name re-check the snapshot must still be the one clicked (Back, a sheet switch, a lock, an
//     account switch drop it, a new Review replaces it), or nothing is sent;
//   - only the latest Confirm writes an outcome (`confirmGen`, across both flows): a Confirm overtaken during its re-check
//     shows nothing, so it cannot cover a later Confirm's "Sent" or "Sending…";
//   - while a submission is in flight no review arms Confirm (`submitting`), so a second submission cannot start before
//     the first one's outcome lands.
let confirmGen = 0;
let submitting = false;
type Snapshot = { to: string; name?: string | null; verified?: boolean };
export async function runConfirm<S extends Snapshot>(f: SendFlow, review: { read: () => S | null; consume: () => void }, submit: (s: S) => Promise<any>, sentText: (s: S) => string) {
  const snap = review.read();
  const btn = $(f.ids.button) as HTMLButtonElement;
  if (!snap || btn.disabled) return;
  btn.disabled = true;
  const gen = ++confirmGen;
  // a name recipient is re-resolved at sign-time: refuse if it now points somewhere else (XREPO-1) or if its
  // chain-verification regressed since review (L7); fail-closed to a re-review either way.
  const stillPoints = !snap.name || (await nameStillPointsTo(snap.name, snap.to, snap.verified));
  if (gen !== confirmGen) return;                    // a later Confirm owns the outcome line; this one sent nothing
  if (review.read() !== snap) return msg(REVIEW_GONE, "err");
  if (!stillPoints) { teardownReview(f, false); return msg(`${snap.name}.csd changed where it points. Nothing was sent: review it again.`, "err"); }
  review.consume();                                  // a second click finds no review
  submitting = true;
  // Only the call is inside the try: a throw from the outcome's own display code must not read as a submit outcome.
  let r: any;
  try { busy("Sending…"); r = await submit(snap); }
  catch (e: any) { return sendThrew(f, e); }         // a wallet-answered throw submitted nothing; only a broken channel is ambiguous
  finally { submitting = false; }
  if (r?.ok) sentOk(f, sentText(snap), r.txid);
  else sendRefused(f, r);                            // structured refusal: show the REAL reason (FOOT-3 teardown inside)
}

// One source for the review-card warning copy. `noun` is the ONLY wording difference between the two
// flows ("transfers" for tokens, "payments" for CSD; deliberate per-flow copy); the strings are
// otherwise the historical ones byte-for-byte. A look-alike is danger, a first send caution, as in the approval window
// (clearsign.warningChecks). Empty return = nothing to warn about (box hidden).
export function composeSendWarning(lookalike: string | null, firstTime: boolean, nameCaution: Check | null, noun: "transfers" | "payments"): Check[] {
  const Noun = noun.charAt(0).toUpperCase() + noun.slice(1);
  const out: Check[] = nameCaution ? [nameCaution] : [];
  if (lookalike) out.push({ tier: "danger", html: `<b>Possible address-poisoning.</b> This looks like <code>${escapeHtml(lookalike.slice(0, 10))}…${escapeHtml(lookalike.slice(-6))}</code> you've seen before but is <b>not</b> the same address. Verify every character. ${Noun} are irreversible.` });
  else if (firstTime) out.push({ tier: "caution", html: `First time sending to this address: check every character. ${Noun} are irreversible.` });
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
// Success: the sent toast with its txid first, then the one clear-the-draft path, then the sheet closes (only a confirmed
// submission closes it; a refusal or an ambiguous outcome keeps the sheet and the draft, sendOutcome and sendRefused
// above), and the balance settles in the hero once the closing sheet has cleared it.
export function sentOk(f: SendFlow, text: string, txid: string) {
  msg(text, "ok sent", f.sent(txid));   // the outcome first: nothing after it can leave "Sending…" on screen
  teardownReview(f, true);
  closeAllPanels(); syncNav();
  const settleIn = tokenMs("--ui-dur-2") ?? 0;
  celebrateSend(settleIn);
  f.refresh(settleIn);
}
