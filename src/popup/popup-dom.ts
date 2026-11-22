// Element lookup, the view switch, the status line and the clipboard copy.
import { escapeHtml } from "./clearsign.js";
import { detailsHtml, type Outcome } from "./popup-outcome.js";

export const $ = (id: string) => document.getElementById(id)!;
export const val = (id: string) => ($(id) as HTMLInputElement).value;
export function show(view: string) { for (const v of ["setup", "backup", "locked", "main"]) ($("view-" + v) as HTMLElement).hidden = v !== view; }
// Status line with auto-dismiss: transient info/ok fades after ~3.5s, errors hold ~8s before
// fading (the outcome still lives in Activity/history). busy() cancels any pending fade.
let msgTimer: ReturnType<typeof setTimeout> | undefined;
let msgFadeTimer: ReturnType<typeof setTimeout> | undefined;
// Every flow shares the one status line. A write that says something (an outcome, a refusal, a "…ing" line; a clear
// says nothing) moves this count, so a late note about an earlier action can tell whether anything newer is on screen.
let msgWrites = 0;
export const statusWrites = (): number => msgWrites;
// `detail`, when given, is a second, smaller line under the text (the sent toast says what happens next).
// `details`, when given, is the outcome's technical sentence behind a "Details" tap (popup-outcome.ts detailsHtml); an
// opened Details keeps the line on screen until the next status.
export function msg(text: string, cls = "info", detail?: string, details?: string) {
  if (text) msgWrites++;
  const m = $("msg");
  clearTimeout(msgTimer); clearTimeout(msgFadeTimer);
  m.classList.remove("fade");
  if (detail || details) m.innerHTML = `<span class="msg-body">${escapeHtml(text)}${detail ? `<small>${escapeHtml(detail)}</small>` : ""}${details ? detailsHtml(details) : ""}</span>`;
  else m.textContent = text;
  m.className = "msg " + cls;
  if (details) holdWhileOpen(m);
  if (!text) return;
  const hold = cls.includes("err") ? 8000 : 3500;
  msgTimer = setTimeout(() => {
    m.classList.add("fade");
    msgFadeTimer = setTimeout(() => { m.textContent = ""; m.className = "msg"; }, 450);
  }, hold);
}
// Like msg(), plus ONE inline action button, and NO auto-fade; a refusal whose remedy is a click
// away must stay actionable, not vanish mid-read (the old TOO_MANY_INPUTS toast pointed at a
// settings breadcrumb and faded in 8s). Any later msg()/busy() replaces it, so it never overstays
// a flow change. textContent + createElement only: r.error strings never touch innerHTML.
export function msgAction(text: string, label: string, fn: () => void, cls = "err", details?: string) {
  msgWrites++;
  const m = $("msg");
  clearTimeout(msgTimer); clearTimeout(msgFadeTimer);
  m.classList.remove("fade");
  if (details) { m.innerHTML = `<span class="msg-body">${escapeHtml(text)}${detailsHtml(details)}</span>`; holdWhileOpen(m); }
  else m.textContent = text + " ";
  m.className = "msg " + cls;
  const b = document.createElement("button");
  b.className = "mini";
  b.textContent = label;
  b.addEventListener("click", () => { msg(""); fn(); });
  m.appendChild(b);
}
/** An outcome of the sentence module (popup-outcome.ts): its line, with its Details. */
export function msgOutcome(o: Outcome) { msg(o.text, o.cls, undefined, o.details); }
function holdWhileOpen(m: HTMLElement) {
  m.querySelector("details")?.addEventListener("toggle", (e) => { if ((e.target as HTMLDetailsElement).open) { clearTimeout(msgTimer); clearTimeout(msgFadeTimer); } });
}
// escapeHtml is imported from clearsign.ts - the hardened variant that ALSO neutralizes bidi/
// zero-width controls (WYSIWYS-BIDI-1). A plain 5-char escape lived here until 2026-07-06, so
// account labels/history were HTML-safe but not bidi-safe, silently weaker than the clear-sign
// surface. One implementation, one threat model.
// In-progress status with an animated spinner (for async actions). Never auto-fades: it is
// always replaced by the outcome message of the action that showed it.
export function busy(text: string) {
  msgWrites++;
  const m = $("msg");
  clearTimeout(msgTimer); clearTimeout(msgFadeTimer);
  m.classList.remove("fade");
  m.innerHTML = `<span class="spinner"></span>${escapeHtml(text)}`; m.className = "msg info";
}
// Brief visual confirmation on a button (e.g. copy).
function flashBtn(id: string, label: string, ok = true) { const b = $(id); const o = b.textContent; b.textContent = label; if (ok) b.classList.add("copied"); setTimeout(() => { b.textContent = o; b.classList.remove("copied"); }, 1100); }
// "copied" only once the clipboard write has resolved; a refused or missing clipboard says so instead.
export async function copyText(btnId: string, text: string) {
  try {
    if (!navigator.clipboard?.writeText) throw new Error("no clipboard");
    await navigator.clipboard.writeText(text);
    flashBtn(btnId, "Copied");
  } catch {
    flashBtn(btnId, "Copy failed", false);
    msg("Could not copy to the clipboard. Select the text and copy it by hand.", "err");
  }
}
