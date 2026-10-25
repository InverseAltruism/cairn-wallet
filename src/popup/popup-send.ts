// Sending CSD: recipient and amount, the review, the signature.
import { parseUnits } from "../core/cairnx.js";
import { nameCheck, escapeHtml, fmtCsd, fmtBalance, balanceShortNote } from "./clearsign.js";
import { groupedAddr } from "./addr.js";
import { call } from "./popup-bridge.js";
import { $, busy, msg, val } from "./popup-dom.js";
import { curAddr, reviewState } from "./popup-state.js";
import { openPanel } from "./popup-panels.js";
import { resolveRecipient, nameStillPointsTo, setNameRow, recipientChecks } from "./popup-recipient.js";
import { CSD_FLOW, teardownReview, armReview, composeSendWarning, setWarn, sendThrew, sendRefused, sentOk } from "./popup-sendflow.js";

$("btn-send-t").addEventListener("click", () => { openPanel("send-form"); });

$("csd-row").addEventListener("click", () => { openPanel("send-form"); });

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
  const raw = val("s-to").trim();
  // Strict base-unit parse (audit AMT-1): the lax Math.round(parseFloat()) accepted "1e3" (→1000 CSD),
  // "1,000" (→1), "1abc", "+1", ".5" and half-sat rounding; so the signed amount could differ from what
  // the user typed/saw. parseUnits enforces /^\d+(\.\d{0,8})?$/ and exact base-unit conversion (same path
  // the token send already uses), so a malformed amount is rejected up front instead of silently coerced.
  const amtStr = parseUnits(val("s-amt").trim(), 8);
  if (amtStr === null || amtStr === "0") return msg("enter a valid amount (up to 8 decimal places)", "err");
  const amt = Number(amtStr);
  if (!Number.isSafeInteger(amt) || amt <= 0) return msg("amount out of range", "err");
  const rr = await resolveRecipient(raw);   // 0x… as-is, or alice.csd → resolved address (refuse lapsed)
  if (!rr.ok) return msg(rr.error!, "err");
  const to = rr.addr!;
  setNameRow("c-name-row", "c-name", rr.label);
  const [b, checks] = await Promise.all([call("balance").catch(() => null), recipientChecks(to)]);
  const { firstTime, lookalike } = checks;
  const after = b ? fmtBalance(b.confirmed - amt - SEND_FEE) + " CSD" : "";
  $("c-to").innerHTML = groupedAddr(to);           // FULL address, not truncated
  $("c-amt").textContent = fmtCsd(amt);
  $("c-fee").textContent = fmtCsd(SEND_FEE);
  $("c-after").textContent = after || "unknown";
  // A .csd send ALWAYS carries the name-service-trust caution (XREPO-1), regardless of first-time /
  // look-alike status; verifying the resolved address is the whole defense the wallet can offer here.
  // Same rule as the approval window: a negative balance-after keeps Confirm down (the engine's
  // INSUFFICIENT refusal stays the backstop). An unreadable balance does not block.
  const short = !!b && Number(b.confirmed) - amt - SEND_FEE < 0;
  const warn = composeSendWarning(lookalike, firstTime, nameCheck(rr), CSD_FLOW.noun);
  setWarn($("c-warn") as HTMLElement, short ? [{ tier: "danger", html: escapeHtml(balanceShortNote("Go back")) }, ...warn] : warn);
  ($("btn-send-confirm") as HTMLButtonElement).disabled = short;
  // freeze the reviewed values; confirm signs THIS, not the live (still-visible) inputs
  // signer snapshot (A1/POPUP-SEND-RACE-2): see the token-review note; same race, same backstop.
  reviewState.reviewedSend = { to, amt, name: rr.name ?? null, verified: rr.verified, signer: curAddr }; // snapshot verified for the L7 confirm-time regression check
  armReview(CSD_FLOW);
});
// Back: keep the draft, refresh nothing (only success clears/refreshes)
$("btn-send-back").addEventListener("click", () => teardownReview(CSD_FLOW, false));
$("btn-send-confirm").addEventListener("click", async () => {
  if (!reviewState.reviewedSend || ($("btn-send-confirm") as HTMLButtonElement).disabled) return;
  const { to, amt, name, verified, signer } = reviewState.reviewedSend;
  // a name recipient is re-resolved at sign-time: refuse if it now points somewhere else (XREPO-1) or if its
  // chain-verification regressed since review (L7); fail-closed to a re-review either way.
  if (name && !(await nameStillPointsTo(name, to, verified))) return msg(`${name}.csd changed where it points — review again`, "err");
  try {
    busy("sending…"); const r = await call("send", to, amt, SEND_FEE, signer ?? undefined);
    if (r.ok) sentOk(CSD_FLOW, "sent " + fmtCsd(amt) + " · " + String(r.txid).slice(0, 12) + "…");
    else sendRefused(CSD_FLOW, r);                    // structured refusal: show the REAL reason (FOOT-3 teardown inside)
  } catch (e: any) {
    sendThrew(CSD_FLOW, e);       // a wallet-answered throw submitted nothing; only a broken channel is ambiguous
  }
});
