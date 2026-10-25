// The coin count in Settings and the Merge coins sheet.
import { fmtCsd, fmtBalance } from "./clearsign.js";
import { call, refusedCopy, thrownCopy } from "./popup-bridge.js";
import { $, busy, msg } from "./popup-dom.js";
import { openPanel } from "./popup-panels.js";
import { mergePendingNow, refreshBalance } from "./popup-balance.js";
import { renderConnectedSites } from "./popup-settings.js";
import { SEND_FEE } from "./popup-send.js";

// ── coins / consolidate (popup-only; see node.consolidate for the trust posture) ─────────────
// Settings shows a live coin count; "merge coins…" appears only when a merge would actually help
// (≥2 spendable coins). The confirm card previews REPORTED numbers; the spend itself re-verifies
// every input against the chain (TXB-1) and refuses on any mismatch; a lying preview gains nothing.
export async function renderCoinsInfo() {
  const info = $("coins-info") as HTMLElement, btn = $("btn-consolidate") as HTMLButtonElement;
  info.textContent = "…"; btn.hidden = true;
  try {
    const p = await call("consolidatePreview", SEND_FEE);
    if (!p?.ok) { info.textContent = "coin count unavailable (node unreachable)"; return; }
    info.textContent = p.coins < 2
      ? `you have ${p.coins} spendable coin${p.coins === 1 ? "" : "s"}: nothing to merge`
      : `you have ${p.coins} spendable coins · one merge combines ${p.merge} of them (${fmtBalance(p.total)} CSD) into a single coin`;
    btn.hidden = p.coins < 2;
  } catch { info.textContent = "coin count unavailable"; }
}
// A single merge can be in flight for ~10s (verifying up to 512 inputs). `consolidating` latches ACROSS
// a panel reopen so a second concurrent merge can't be fired (the reopen re-enables the confirm button);
// two concurrent merges are self-conflicting and harmless, but this keeps a single, clean flow.
let consolidating = false;
// Shared opener: the settings button (toggle semantics) and the TOO_MANY_INPUTS "Merge coins now"
// action (force-open) both land here. The preview arms Confirm for every legitimate case:
// including while an EARLIER round is still confirming: back-to-back rounds select disjoint coins
// (the node's available-utxo view already excludes the in-flight round's inputs), so disarming
// here would be a decline path on a designed flow. Only two things keep Confirm down: a merge
// in flight in THIS popup (the double-fire latch) and a dust-only preview (out = 0 would just
// burn the fee at the engine's INSUFFICIENT refusal).
export async function openConsolidatePanel(force = false) {
  if (!openPanel("consolidate-form")) {
    if (!force) return;                                        // settings-button toggle: closing is a valid click
    ($("consolidate-form") as HTMLElement).hidden = false;     // action path: always end OPEN
  }
  const note = $("cs-note") as HTMLElement;
  ($("btn-consolidate-confirm") as HTMLButtonElement).disabled = true;
  note.textContent = "";
  try {
    const p = await call("consolidatePreview", SEND_FEE);
    if (!p?.ok || p.coins < 2) { note.textContent = p?.ok ? "nothing to merge: fewer than two spendable coins." : "node unreachable: try again in a moment."; return; }
    $("cs-merge").textContent = String(p.merge) + (p.coins > p.merge ? ` of ${p.coins}` : "");
    $("cs-total").textContent = fmtBalance(p.total) + " CSD";
    $("cs-fee").textContent = fmtCsd(SEND_FEE);
    $("cs-out").textContent = fmtBalance(p.out) + " CSD";
    // Round plan: merging 512 coins into 1 retires 511 per pass, and intermediate outputs get
    // swept into a later pass once confirmed; so ceil((coins-1)/511) covers the whole plan.
    const rounds = Math.ceil((p.coins - 1) / 511);
    note.textContent = (p.coins > p.merge ? `a transaction fits at most ${p.merge} coins, so about ${rounds} merges are needed in total. You can run the next one right away; only the final combining pass needs the earlier merges mined first. ` : "")
      + (consolidating ? "a merge is already in progress in this window; wait for it to finish." : "")
      + (!consolidating && mergePendingNow.pending ? `a previous merge (${fmtBalance(mergePendingNow.amount)} CSD) is confirming; merging more coins now is safe. ` : "")
      + "This is a normal payment to yourself: your balance only changes by the fee.";
    if (p.out <= 0) { note.textContent = "these coins are too small to cover the fee: nothing to gain by merging them."; return; } // keep Confirm down: the engine would refuse anyway
    if (!consolidating) ($("btn-consolidate-confirm") as HTMLButtonElement).disabled = false;   // keep it latched only while a merge runs in THIS popup
  } catch { note.textContent = "node unreachable: try again in a moment."; }
}
$("btn-consolidate").addEventListener("click", () => { void openConsolidatePanel(); });
$("btn-consolidate-back").addEventListener("click", () => { openPanel("settings"); renderConnectedSites(); renderCoinsInfo(); });
$("btn-consolidate-confirm").addEventListener("click", async () => {
  const btn = $("btn-consolidate-confirm") as HTMLButtonElement;
  if (btn.disabled || consolidating) return;
  btn.disabled = true; consolidating = true; // latch across the ~10s verify AND any panel reopen
  try {
    busy("verifying & merging coins… (can take ~10s)");
    const r = await call("consolidate", SEND_FEE);
    if (r.ok) {
      // Sent, not merged: the merge line under the balance says when it is mined. The next round selects
      // DISJOINT coins (the node's available view excludes this round's inputs), so "run the next merge
      // right away" is true; only the final combining pass waits on confirmations.
      msg(`merge sent (${String(r.txid).slice(0, 12)}…); confirming` + (r.remaining >= 1 ? `. ${r.remaining} coin(s) left; you can run the next merge right away` : ""), "ok sent");
      ($("consolidate-form") as HTMLElement).hidden = true;
      refreshBalance();
    } else {
      // maybe-inflight is recorded maybe:true and duplicate means the merge IS pending, so the pending
      // line takes over and Confirm stays down; any other code is a clean refusal.
      const o = refusedCopy(r, "merge");
      msg(o.text, o.cls);
      if (o.maybe) { ($("consolidate-form") as HTMLElement).hidden = true; refreshBalance(); }
      else btn.disabled = false;
    }
  } catch (e: any) {
    const o = thrownCopy(e, "merge");
    msg(o.text, o.cls);
    if (o.maybe) { ($("consolidate-form") as HTMLElement).hidden = true; refreshBalance(); }
    else btn.disabled = false;
  } finally { consolidating = false; }
});
