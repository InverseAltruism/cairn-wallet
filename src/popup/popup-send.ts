// Sending CSD: recipient and amount, the review, the signature.
import { formatUnits, parseUnits } from "../core/cairnx.js";
import { nameCheck, escapeHtml, fmtCsd, fmtBalance, balanceShortNote, groupedAddr } from "./clearsign.js";
import { call } from "./popup-bridge.js";
import { $, msg, val } from "./popup-dom.js";
import { balanceState, beginReview, curAddr, reviewCurrent, reviewState } from "./popup-state.js";
import { openPanel } from "./popup-panels.js";
import { resolveRecipient, setNameRow, recipientChecks } from "./popup-recipient.js";
import { CSD_FLOW, teardownReview, armReview, composeSendWarning, setWarn, runConfirm } from "./popup-sendflow.js";

$("btn-send-t").addEventListener("click", () => { openPanel("send-form"); resetMax(); updateSendEstimate(); });

$("csd-row").addEventListener("click", () => { openPanel("send-form"); resetMax(); updateSendEstimate(); });

// Max: the most one send accepts now, worked out by the send engine itself (background maxSendable: it verifies the
// coins a send would spend and signs nothing). It fills the amount; the review and the confirm then run as for a typed
// amount. An answer that arrives after the sheet closed, the account changed, the amount was typed or Max was pressed
// again is dropped.
let maxSeq = 0;
function maxNote(text: string | null) {
  const el = $("s-max-note") as HTMLElement;
  el.textContent = text ?? "";
  el.hidden = text === null;
}
function resetMax() { maxSeq++; maxNote(null); ($("s-max") as HTMLButtonElement).disabled = false; }
$("s-max").addEventListener("click", async () => {
  const amt = $("s-amt") as HTMLInputElement, btn = $("s-max") as HTMLButtonElement;
  if (amt.disabled) return;
  const seq = ++maxSeq, who = curAddr;
  btn.disabled = true;
  maxNote("Working out the most one transaction can send…");
  const r = await call("maxSendable", SEND_FEE).catch((e: unknown) => ({ ok: false, error: e instanceof Error ? e.message : String(e) }));
  if (seq !== maxSeq || who !== curAddr || ($("send-form") as HTMLElement).hidden) return;
  btn.disabled = false;
  if (amt.disabled) return maxNote(null);
  if (!r?.ok) return maxNote(`Max is not available: ${String(r?.error ?? "the coins could not be read")}`);
  if (!(r.amount > 0)) return maxNote(`Nothing to send: the confirmed coins do not cover the ${fmtCsd(SEND_FEE)} fee.`);
  amt.value = formatUnits(String(r.amount), 8);
  updateSendEstimate();
  const notes = [
    r.capped ? `The most one transaction can send: it spends ${r.inputs} of your ${r.eligible} coins, the limit per transaction. Merge coins in Settings to send more at once.` : "",
    r.skipped > 0 ? `${r.skipped} coin${r.skipped === 1 ? "" : "s"} the node could not prove ${r.skipped === 1 ? "is" : "are"} left out.` : "",
  ].filter(Boolean);
  maxNote(notes.length ? notes.join(" ") : null);
});

// While the amount is typed: the network fee and the balance after it, from SEND_FEE and the balance the hero shows (no
// read of its own). Display only: the review reads the balance again, and a negative result there keeps Confirm down.
function updateSendEstimate() {
  $("s-fee").textContent = fmtCsd(SEND_FEE);
  const after = $("s-after"), bal = balanceState.stale ? null : balanceState.last;
  const raw = val("s-amt").trim();
  const base = raw ? parseUnits(raw, 8) : "0";
  if (bal === null || base === null) { after.textContent = bal === null ? "Unknown" : "Not a valid amount"; after.className = "dim"; return; }
  const left = raw ? bal - Number(base) - SEND_FEE : bal;
  after.textContent = fmtBalance(left) + " CSD";
  after.className = left < 0 ? "err" : "dim";
}
$("s-amt").addEventListener("input", () => { maxSeq++; maxNote(null); ($("s-max") as HTMLButtonElement).disabled = false; updateSendEstimate(); });
balanceState.onChange = updateSendEstimate;

// Address-poisoning lookalike: attackers seed your history with an address that
// shares the head+tail you eyeball but differs in the middle. Flag a recipient that
// matches a previously-seen address on first 6 + last 4 hex chars but isn't identical.
// lookalikeOf (the address-poisoning heuristic) lives in ./clearsign.js and reaches this file through
// recipientStatus: one definition, so a tuning change can't land in only one of two copies of a security check.
// Two-step send: "Review" shows a confirmation with the FULL recipient address,
// amount, fee, and projected balance-after (defends against address-poisoning /
// clipboard-swap; the user verifies exactly what will be signed), warns on a
// never-seen-before recipient, and hard-flags a poisoning lookalike.
export const SEND_FEE = 1_000_000; // 0.01 CSD
$("btn-send").addEventListener("click", async () => {
  const gen = beginReview();   // a Review the user leaves during its reads below primes nothing (popup-state reviewCurrent)
  const raw = val("s-to").trim();
  // Strict base-unit parse (audit AMT-1): the lax Math.round(parseFloat()) accepted "1e3" (→1000 CSD),
  // "1,000" (→1), "1abc", "+1", ".5" and half-sat rounding; so the signed amount could differ from what
  // the user typed/saw. parseUnits enforces /^\d+(\.\d{0,8})?$/ and exact base-unit conversion (same path
  // the token send already uses), so a malformed amount is rejected up front instead of silently coerced.
  const amtStr = parseUnits(val("s-amt").trim(), 8);
  if (amtStr === null || amtStr === "0") return msg("Enter a valid amount (up to 8 decimal places).", "err");
  const amt = Number(amtStr);
  if (!Number.isSafeInteger(amt) || amt <= 0) return msg("Amount out of range.", "err");
  const rr = await resolveRecipient(raw);   // 0x… as-is, or alice.csd → resolved address (refuse lapsed)
  if (!reviewCurrent(gen)) return;
  if (!rr.ok) return msg(rr.error!, "err");
  const to = rr.addr!;
  setNameRow("c-name-row", "c-name", rr.label);
  const [b, checks] = await Promise.all([call("balance").catch(() => null), recipientChecks(to)]);
  if (!reviewCurrent(gen)) return;          // left, or the account changed: `curAddr` below must be the reviewed signer
  const { firstTime, lookalike } = checks;
  const after = b ? fmtBalance(b.confirmed - amt - SEND_FEE) + " CSD" : "";
  $("c-to").innerHTML = groupedAddr(to);           // FULL address, not truncated
  $("c-amt").textContent = fmtCsd(amt);
  $("c-fee").textContent = fmtCsd(SEND_FEE);
  $("c-after").textContent = after || "Unknown";
  // A .csd send ALWAYS carries the name-service-trust caution (XREPO-1), regardless of first-time /
  // look-alike status; verifying the resolved address is the whole defense the wallet can offer here.
  // Same rule as the approval window: a negative balance-after keeps Confirm down (the engine's
  // INSUFFICIENT refusal stays the backstop). An unreadable balance does not block.
  const short = !!b && Number(b.confirmed) - amt - SEND_FEE < 0;
  const warn = composeSendWarning(lookalike, firstTime, nameCheck(rr), CSD_FLOW.noun);
  setWarn($("c-warn") as HTMLElement, short ? [{ tier: "danger", html: escapeHtml(balanceShortNote("Go back")) }, ...warn] : warn);
  // freeze the reviewed values; confirm signs THIS, not the live (still-visible) inputs
  // signer snapshot (A1/POPUP-SEND-RACE-2): see the token-review note; same race, same backstop.
  reviewState.reviewedSend = { to, amt, name: rr.name ?? null, verified: rr.verified, signer: curAddr }; // snapshot verified for the L7 confirm-time regression check
  armReview(CSD_FLOW, short);
});
// Back: keep the draft, refresh nothing (only success clears/refreshes)
$("btn-send-back").addEventListener("click", () => teardownReview(CSD_FLOW, false));
// Confirm signs the frozen review and nothing else (popup-sendflow runConfirm).
$("btn-send-confirm").addEventListener("click", () => runConfirm(CSD_FLOW,
  { read: () => reviewState.reviewedSend, consume: () => { reviewState.reviewedSend = null; } },
  ({ to, amt, signer }) => call("send", to, amt, SEND_FEE, signer ?? undefined),
  ({ amt }) => "Sent " + fmtCsd(amt)));
