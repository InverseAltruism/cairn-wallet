// The sheets and tabs: one sheet open at a time, the teardown every switch runs, focus and Escape, and the dropdowns'
// click-away.
import { $, msg } from "./popup-dom.js";
import { dropReviews } from "./popup-state.js";
import { resetRevealPanel, resetPhrasePanel } from "./popup-secrets.js";

// Wipe any unsent recipient/amount draft on lock so it doesn't reappear pre-filled on the next unlock or
// popup reopen. The popup view-switches (it does not tear down) on lock, so input values otherwise persist;
// the browser can also restore them on reopen. Cleared here (alongside the secret-wipe) and via autocomplete=off.
export function clearSendDrafts() {
  for (const id of ["s-to", "s-amt", "ts-to", "ts-amt"]) { const el = document.getElementById(id) as HTMLInputElement | null; if (el) { el.value = ""; el.disabled = false; } }
  // also tear down any FROZEN review (a primed Confirm panel must not survive the lock boundary, or a click on
  // unlock would sign the stale snapshot). Drop the snapshots + hide both confirm panels.
  dropReviews();
  for (const id of ["send-confirm", "tsend-confirm"]) { const el = document.getElementById(id); if (el) (el as HTMLElement).hidden = true; }
  { const el = document.getElementById("name-action-form"); if (el) (el as HTMLElement).hidden = true; }   // the name renew/primary review panel signs real CSD; never let a primed one survive a lock
}

export function dropStaleView() { closeAllPanels(); syncNav(); }

// ── accordion: at most ONE action panel open at a time ──────────────────────
// All the collapsible panels under the main view. Opening one closes the rest;
// clicking the same trigger again closes it. Secret panels are wiped on every switch.
const PANELS = ["accts-panel", "receive-panel", "send-form", "tsend-form", "consolidate-form", "name-action-form", "name-detail", "post-form", "seal-form", "activity", "names-tab", "reveal-panel", "phrase-panel", "settings"];

// Close every panel + confirm sub-panel, drop primed value-moving snapshots, wipe revealed
// secrets. Statement order of the original openPanel body preserved (the two snapshot-null
// statements collapsed into one dropReviews()); this teardown is the secret-wipe / WYSIWYS
// boundary and must stay byte-equivalent in behavior.
export function closeAllPanels() {
  for (const p of PANELS) ($(p) as HTMLElement).hidden = true;
  ($("send-confirm") as HTMLElement).hidden = true;
  ($("tsend-confirm") as HTMLElement).hidden = true;
  // switching views drops any primed name renew/set-primary snapshot, and armed send/token reviews
  // die with their panels: drop the frozen snapshots AND re-enable the inputs that only
  // btn-send-back/btn-tsend-back used to re-enable (a back/home exit otherwise left the forms
  // disabled = bricked until lock/unlock)
  dropReviews();
  for (const id of ["s-to", "s-amt", "ts-to", "ts-amt"]) { const el = document.getElementById(id) as HTMLInputElement | null; if (el) el.disabled = false; }
  resetRevealPanel(); resetPhrasePanel();
  $("nd-actions").innerHTML = "";   // a closed name detail keeps no action that could open a review
}
// Show `id` and hide every other panel; returns true if it ended up OPEN. Wipes any
// revealed secret so a key/phrase never lingers behind a now-hidden panel.
export function openPanel(id: string): boolean {
  const willOpen = ($(id) as HTMLElement).hidden;
  closeAllPanels();
  if (willOpen) ($(id) as HTMLElement).hidden = false;
  syncNav();
  return willOpen;
}
// Which control shows as current: the Names or Activity tab or the Settings button when their panel is open, else
// Assets. A sheet over a list keeps that list's tab selected.
const TABS = ["nav-home", "nav-names", "btn-activity-t"];
export function syncNav() {
  const active = !($("activity") as HTMLElement).hidden ? "btn-activity-t"
    : !($("names-tab") as HTMLElement).hidden ? "nav-names"
    : !($("settings") as HTMLElement).hidden ? "btn-settings" : "nav-home";
  for (const id of [...TABS, "btn-settings"]) $(id).classList.toggle("active", id === active);
  for (const id of TABS) $(id).setAttribute("aria-selected", String(id === active));
  // the one indicator slides under the selected tab (Settings leaves it under Assets)
  const tab = $(TABS.includes(active) ? active : "nav-home") as HTMLElement;
  const bar = $("tabs") as HTMLElement;
  if (typeof tab.offsetLeft === "number" && bar.style?.setProperty) {
    bar.style.setProperty("--ind-x", `${tab.offsetLeft}px`);
    bar.style.setProperty("--ind-w", `${tab.offsetWidth}px`);
  }
}
// Escape closes the open sheet through its own close button, the same exit as a click on it.
function closeSheetOnEscape(e: KeyboardEvent) {
  if (e.key !== "Escape") return;
  const close = document.querySelector<HTMLElement>("#layer > .sheet:not([hidden]) .panel-head .panel-back");
  if (!close) return;
  e.preventDefault();
  close.click();
}
document.addEventListener("keydown", closeSheetOnEscape);
// While a sheet is open the page behind it is inert, so Tab and a pointer reach only the sheet and the request band;
// focus moves to the sheet's first control after its header (or its close button), without scrolling, and back to
// what opened it when it closes.
const BEHIND = ["#view-main > .topbar", "#view-main > .bal-hero", "#view-main > .actions", "#tabs", "#home", "#names-tab", "#activity", "#more-menu"];
let sheetOpener: HTMLElement | null = null;
function syncSheetFocus() {
  const sheet = document.querySelector<HTMLElement>("#layer > .sheet:not([hidden])");
  if (sheet && !sheetOpener) {
    const from = document.activeElement as HTMLElement | null;
    sheetOpener = from && from !== document.body && !sheet.contains(from) ? from : null;
  }
  for (const sel of BEHIND) { const el = document.querySelector<HTMLElement>(sel); if (el) el.inert = !!sheet; }
  if (sheet) {
    if (!sheet.contains(document.activeElement)) {
      const first = [...sheet.querySelectorAll<HTMLElement>("input:not([disabled]), textarea, select, button:not([disabled]), a[href], [tabindex='0']")]
        .find((el) => !el.closest(".panel-head") && el.tabIndex >= 0 && el.offsetParent !== null);
      (first ?? sheet.querySelector<HTMLElement>(".panel-head .panel-back"))?.focus({ preventScroll: true });
    }
  } else if (sheetOpener) {
    if (sheetOpener.isConnected) sheetOpener.focus();
    sheetOpener = null;
  }
}
if (typeof MutationObserver === "function") {
  new MutationObserver(syncSheetFocus).observe($("layer"), { subtree: true, attributes: true, attributeFilter: ["hidden"] });
}
// The request band over an open sheet shows its first origin in full however long; the sheet and the toast start
// under the band's real height.
if (typeof ResizeObserver === "function") {
  const pend = $("pending"), app = $("app");
  new ResizeObserver(() => {
    if (getComputedStyle(pend).position !== "fixed") return;
    const gap = parseFloat(getComputedStyle(app).getPropertyValue("--ui-space-2")) || 0;   // the gap under the band
    app.style.setProperty("--pending-band", `${Math.ceil(pend.getBoundingClientRect().bottom + gap)}px`);
  }).observe(pend);
}
$("nav-home").addEventListener("click", () => { closeAllPanels(); syncNav(); msg(""); });
// One delegated back-button for every panel head (no per-panel IDs): exits the panel with the
// same full teardown as any panel switch (snapshots dropped, secrets wiped).
$("layer").addEventListener("click", (e) => {
  if ((e.target as HTMLElement).closest(".panel-back")) { closeAllPanels(); syncNav(); msg(""); }
});

// click-away: close each header dropdown when the click is outside BOTH its button and its menu
document.addEventListener("click", (e) => {
  const t = e.target as HTMLElement;
  for (const [btnId, menuId] of [["btn-rpc", "rpc-menu"], ["btn-explorer", "explorer-menu"], ["acct-select", "acct-menu"]] as const) {
    const m = document.getElementById(menuId), b = document.getElementById(btnId);
    if (m && !m.hidden && b && !m.contains(t) && !b.contains(t)) m.hidden = true;
  }
});
