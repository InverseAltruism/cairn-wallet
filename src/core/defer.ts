// Deferred finalize (Plan 63): the user approves the fee-bearing nfinalize UPFRONT (full clear-sign,
// exact amount); the wallet holds the SIGNED tx and broadcasts it BY ITSELF once the reservation's
// lock-in window ends — gated, at send time, on a fresh on-chain check that this wallet still holds
// the winning reservation and the window is open. Lost race / expired window ⇒ the tx is dropped and
// NOTHING is paid. This turns registration into "approve everything in the first minutes, close the
// tab": the consensus freeze becomes invisible settling instead of a return trip.
//
// Posture: WYSIWYS holds — the exact signed bytes were disclosed at approval; deferral changes WHEN
// the tx is sent, and only to strictly-safer conditions (the same winner/window guard the site's
// manual path applies at sign time, re-run at send time). Scope is HARD-LIMITED to nfinalize records
// (wallet.buildDeferredFinalize refuses anything else), so this is not a generic pre-signing surface.
// Broadcasting needs no keys, so it works while the wallet is locked.

export interface DeferredFinalize {
  name: string;
  owner: string;                 // lowercase 0x… address the reservation must still belong to
  effectiveHeight: number;       // the reservation's effHeight at arm time — a mismatch means displaced/reorged
  notBeforeHeight: number;       // first height at which broadcasting is safe (freeze end + client margin)
  notAfterHeight: number;        // last safe height (finalizeBy − client margin) — later would burn the fee
  feeTotal: number;              // base units leaving the wallet (display/notification copy)
  txJson: unknown;               // the SIGNED tx, node wire format (submitRawTx posts it verbatim)
  outpoints: string[];           // "txid:vout" inputs — reserved from coin selection until sent/dropped
  createdAt: number;
  broadcastTip?: number;         // tip at our last submit (throttles re-submits while it mines)
  txid?: string;
}

export type DeferOutcome = "wait" | "broadcast" | "complete" | "lost" | "expired";

// The send-time gate, PURE so it is unit-testable: given the live name state (resolver view or null
// when the name is absent) and the tip, decide what to do with a held finalize. Loss requires
// POSITIVE evidence (another owner / a different effectiveHeight); absence alone only expires the
// item once the window has passed, so a resolver blip or reorg snapshot can never burn or drop early.
export function decideDeferred(
  item: DeferredFinalize,
  ns: { owner?: string; pending?: boolean; effectiveHeight?: number } | null,
  tip: number,
): DeferOutcome {
  if (!Number.isFinite(tip) || tip <= 0) return "wait";
  const mine = !!ns && String(ns.owner || "").toLowerCase() === item.owner;
  if (ns && mine && ns.pending !== true) return "complete";              // finalized (by us, or manually on the site)
  if (ns && ns.pending === true) {
    if (!mine || Number(ns.effectiveHeight) !== item.effectiveHeight) return "lost";   // displaced (or reorg moved it)
    if (tip < item.notBeforeHeight) return "wait";                       // contest not frozen yet
    if (tip > item.notAfterHeight) return "expired";                     // too late — sending now would burn
    if (item.broadcastTip !== undefined && tip - item.broadcastTip < 2) return "wait"; // submitted; give it a block
    return "broadcast";
  }
  if (ns && !mine) return "lost";                                        // registered by someone else
  // name absent from the resolver view: tolerate blips inside the window, expire past it
  return tip > item.notAfterHeight ? "expired" : "wait";
}

// Human copy per terminal outcome (system notifications + popup rows share it).
export function deferOutcomeCopy(name: string, outcome: DeferOutcome): { title: string; message: string } | null {
  if (outcome === "complete") return { title: `${name}.csd is yours`, message: "Your registration finalized on-chain." };
  if (outcome === "lost") return { title: `${name}.csd: outbid`, message: "An earlier claim won the name. Nothing was paid — the prepared payment was dropped." };
  if (outcome === "expired") return { title: `${name}.csd: reservation expired`, message: "The finalize window closed before completion. Nothing was paid — the prepared payment was dropped." };
  return null;
}
