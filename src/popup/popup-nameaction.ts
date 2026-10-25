// The review and signature of a name renew or set-primary.
import { fmtCsd, fmtBalance } from "./clearsign.js";
import { call, refusedCopy, thrownCopy } from "./popup-bridge.js";
import { $, busy, msg } from "./popup-dom.js";
import { curAddr, reviewState, dropReviews, bindView, viewCurrent } from "./popup-state.js";
import { dropStaleView, openPanel } from "./popup-panels.js";
import { refreshBalance } from "./popup-balance.js";
import { nameDetails, renderAssets } from "./popup-assets.js";
import { CAIRNX_FEE } from "./popup-tokensend.js";

// One click opens a review panel (parity with the send-confirm flow); signing happens only on Confirm.
// A name renew / set-primary spends real CSD, so it must be reviewable and declinable like every other
// value-moving action; NOT signed from an easy-to-miss inline message. `reviewState.reviewedNameAct` is
// the frozen snapshot the Confirm button signs (torn down on lock by clearSendDrafts, so a primed panel
// can't survive a lock/unlock; and wallet.must() throws if a click somehow lands while locked).
let nameActSeq = 0;   // QA #18: supersede stale async continuations; a newer invocation bumps this; older ones abort after their awaits
export async function confirmNameAction(kind: "renew" | "primary", name: string) {
  const seq = ++nameActSeq;
  const bound = bindView();   // a switch during the reads below leaves no primed review behind
  dropReviews();
  openPanel("name-action-form");
  ($("name-action-form") as HTMLElement).hidden = false;   // always SHOW the review; openPanel toggles, and a name action must never toggle the panel closed
  $("nc-action").textContent = kind === "renew" ? "Renew lease" : "Set primary name";
  $("nc-name").textContent = `${name}.csd`;
  $("nc-anchor").textContent = fmtCsd(CAIRNX_FEE);
  // renew also pays a height-gated registration fee to the treasury; set-primary is anchor-only. The fee is
  // priced at the CURRENT tip; the same one cairnxNameRenew signs (WL-V18-1: never show a stale fee curve).
  let renewFee = 0;
  if (kind === "renew") {
    renewFee = await call("cairnxNameRenewFee", name).then((v) => Number(v) || 0).catch(() => 0);
    if (seq !== nameActSeq || !viewCurrent(bound)) return;   // superseded, or the account changed meanwhile
    ($("nc-fee-row") as HTMLElement).hidden = false;
    $("nc-fee").textContent = renewFee ? fmtCsd(renewFee) : "Priced at confirm";
  } else {
    ($("nc-fee-row") as HTMLElement).hidden = true;
  }
  // M8: an unpriceable renew fee (offline/error) must render the total as unknown, never as the
  // anchor-only 0.25 (which would understate a 15.25 action). The fee row already says "priced at
  // confirm"; the total must not contradict it. Set-primary is anchor-only, so its total is exact.
  const total = CAIRNX_FEE + renewFee;
  $("nc-total").textContent = (kind === "renew" && !renewFee) ? "Unknown (priced at confirm)" : fmtCsd(total);
  // M8 residual (Fable final QC): when the renew fee is unpriceable the AFTER balance is likewise
  // unknown; subtracting the anchor-only 0.25 would understate a 15.25 action in the second row too.
  let after = "";
  try { const b = await call("balance"); after = (kind === "renew" && !renewFee) ? "" : fmtBalance(b.confirmed - total) + " CSD"; } catch { /* offline */ }
  if (seq !== nameActSeq || !viewCurrent(bound)) return;   // superseded or switched after the balance fetch; abort before priming the snapshot
  $("nc-after").textContent = after || "Unknown";
  $("nc-note").textContent = kind === "renew"
    ? "Extends this name's lease by one term. Anyone may renew a live lease."
    // QA #5: the wallet's set-primary is a single nset→self; it makes the name primary only if it's your
    // OLDEST self-pointing name. Switching from an older name needs the multi-step flow on the website.
    : "Points this name at you (its reverse record). If it's your oldest such name it becomes your primary; to switch from an older name, use cairn-substrate.com/names.";
  reviewState.reviewedNameAct = { kind, name, total, fee: renewFee, signer: curAddr };   // freeze the reviewed fee + signer; doNameAction signs EXACTLY this
  msg("");
}
async function doNameAction() {
  if (!reviewState.reviewedNameAct) return;
  const { kind, name, fee, signer } = reviewState.reviewedNameAct;
  const bound = bindView();                                 // the account this review belongs to
  dropReviews();                                            // consume the snapshot: one Confirm = one signature
  try {
    busy(kind === "renew" ? `Renewing ${name}.csd…` : `Setting ${name}.csd as primary…`);
    // WL-FEE-FREEZE-1: a renew signs EXACTLY the reviewed fee; the background throws FEE_CHANGED (without
    // signing) if the tip crossed a fee-gate since review, so the user never signs a different amount.
    // A1: the reviewed signer rides along; a mid-flight account switch refuses instead of signing.
    const r = await call(kind === "renew" ? "cairnxNameRenew" : "cairnxSetPrimary", name, ...(kind === "renew" ? [fee, signer ?? undefined] : [signer ?? undefined]));
    const what = kind === "renew" ? "renewal" : "set-primary";
    if (r.ok) { ($("name-action-form") as HTMLElement).hidden = true; msg(`${kind === "renew" ? "Renewed" : "Set primary"}: ${name}.csd · ${String(r.txid).slice(0, 12)}… (takes effect once it is mined).`, "ok"); refreshBalance(); renderAssets(); }
    else {
      const o = refusedCopy(r, what);
      if (o.maybe) { ($("name-action-form") as HTMLElement).hidden = true; refreshBalance(); }
      msg(o.text, o.cls);
    }
  } catch (e: any) {
    const m = String(e?.message || e);
    if (m.startsWith("FEE_CHANGED:")) {                     // tip crossed a fee gate between Review and Confirm; nothing was signed
      const newFee = Number(m.slice("FEE_CHANGED:".length));
      // re-review only for the account and the name it was for: the account may have changed while Confirm was in flight
      if (!viewCurrent(bound) || !nameDetails.has(name)) {
        dropStaleView();
        msg(`The renewal fee changed to ${fmtCsd(newFee)} since you reviewed. Nothing was signed; open the name again to review it.`, "err");
        return;
      }
      await confirmNameAction("renew", name);               // re-price + re-show the review first (it resets the status line)…
      msg(`The renewal fee changed to ${fmtCsd(newFee)} since you reviewed. Check it and confirm again.`, "err");  // …then explain
      return;
    }
    const o = thrownCopy(e, kind === "renew" ? "renewal" : "set-primary");
    msg(o.text, o.cls);
  }
}

$("btn-name-confirm").addEventListener("click", () => doNameAction());
$("btn-name-cancel").addEventListener("click", () => {
  ($("name-action-form") as HTMLElement).hidden = true;
  dropReviews();
  msg("");
});
