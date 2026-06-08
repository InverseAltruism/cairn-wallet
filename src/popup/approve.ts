// MetaMask-style approval window: opened by the background when a site calls
// window.cairn.*. Unlock if needed, review the request, approve/reject. Closes
// itself when the queue is empty. The pure "what am I signing?" formatters live in ./clearsign (unit-tested).
import { describe, debitOf, lookalikeOf, costLine, escapeHtml } from "./clearsign.js";
const chrome: any = (globalThis as any).chrome;
const $ = (id: string) => document.getElementById(id)!;

function call(method: string, ...args: any[]): Promise<any> {
  return new Promise((res, rej) => chrome.runtime.sendMessage({ kind: "popup", method, args }, (r: any) => {
    if (chrome.runtime.lastError) return rej(new Error(chrome.runtime.lastError.message));
    r?.ok ? res(r.result) : rej(new Error(r?.error || "error"));
  }));
}
function msg(t: string, cls = "info") { const m = $("msg"); m.textContent = t; m.className = "msg " + cls; }

let current: any = null;
let renderedId: string | null = null; // only rebuild the request view when the request changes
async function render() {
  const st = await call("status");
  ($("view-locked") as HTMLElement).hidden = st.unlocked;
  const pend = await call("pending");
  if (!pend.length) { window.close(); return; }
  current = pend[0];
  const reqView = $("view-req") as HTMLElement;
  reqView.hidden = !st.unlocked;
  if (!st.unlocked) { renderedId = null; return; }
  // Rebuild only on a NEW request (or first unlock). Re-rendering every ~1.2s tick would
  // wipe the async-filled balance-after AND the security warning — so we don't.
  if (renderedId === current.id) return;
  renderedId = current.id;
  const acct = (st.accounts || [])[st.active || 0];
  const signer = acct ? `${escapeHtml(acct.label)} · ${escapeHtml(String(st.addr || ""))}` : escapeHtml(String(st.addr || ""));
  const queued = pend.length > 1 ? `<div class="req dim">request 1 of ${pend.length} — review each separately</div>` : "";
  $("req").innerHTML = `<div class="req dim">signing as <b>${signer}</b></div>${queued}`
    + `<div class="req">${describe(current)}</div><div class="req dim">from ${escapeHtml(String(current.origin))}</div>`
    + `<div class="req dim" id="cost">${costLine(current)}</div>`;
  msg(""); // clear any stale "approved"/"rejected" from a previous request
  armButtons();         // briefly disable Approve/Reject so a stale click can't land on a freshly-swapped request
  fillBalance(current);
  fillSendWarning(current);
}

// Fetch the signer's balance once per request and show the projected balance-after so
// the user sees the real impact of approving (render no longer rebuilds each tick, so
// this value persists once filled).
let balForId: string | null = null;
async function fillBalance(r: any) {
  if (balForId === r.id) return; balForId = r.id;
  try {
    const b = await call("balance");
    const after = (b.confirmed - debitOf(r)) / 1e8;
    const el = document.getElementById("cost");
    if (el) el.textContent = `${costLine(r)}  balance: ${(b.confirmed / 1e8).toLocaleString(undefined, { maximumFractionDigits: 4 })} → ~${after.toLocaleString(undefined, { maximumFractionDigits: 4 })} CSD`;
  } catch { /* offline — leave the static cost line */ }
}
// For a send, warn on a never-seen-before recipient and hard-flag an address-poisoning
// lookalike — checked against this account's send history + own addresses. The recipient
// is dApp-supplied, so this defense MUST live in the approval window (not just the manual
// send form). Runs once per request; the warning persists (render doesn't rebuild).
let warnForId: string | null = null;
async function fillSendWarning(r: any) {
  if (r.method !== "send" || warnForId === r.id) return; warnForId = r.id;
  const p = r.params || {};
  const outs = Array.isArray(p.outputs) ? p.outputs : [{ to: p.to }];
  try {
    const [h, st] = await Promise.all([call("history"), call("status")]);
    const sentTo = (h as any[]).filter((t) => t.type === "send").map((t) => String(t.to || ""));
    const known = [...sentTo, ...((st.accounts || []).map((a: any) => a.addr))];
    const warns: string[] = [];
    for (const o of outs) {
      const to = String(o.to || ""); const tag = `<code>${escapeHtml(to.slice(0, 10))}…${escapeHtml(to.slice(-6))}</code>`;
      const la = lookalikeOf(to, known);
      if (la) warns.push(`⚠ <b>Possible address-poisoning:</b> ${tag} resembles <code>${escapeHtml(la.slice(0, 10))}…${escapeHtml(la.slice(-6))}</code> you've seen before but is NOT identical. Verify every character — payments are irreversible.`);
      else if (!sentTo.some((a) => a.toLowerCase() === to.toLowerCase())) warns.push(`⚠ First time sending to ${tag} — verify every character. Payments are irreversible.`);
    }
    const el = document.getElementById("send-warn");
    if (el && warns.length) { el.innerHTML = warns.join("<br>"); (el as HTMLElement).hidden = false; }
  } catch { /* no history → no warning */ }
}
// Anti-click-through: when the request view (re)builds for a NEW request, disable both
// buttons for a beat so a click already in motion (or a reflexive double-click after a
// prior "approved") cannot resolve a request the user hasn't actually looked at. Defeats
// the approval-swap hijack where a second request is queued behind the one on screen.
function armButtons() {
  const ap = $("btn-approve") as HTMLButtonElement, rj = $("btn-reject") as HTMLButtonElement;
  ap.disabled = true; rj.disabled = true;
  setTimeout(() => { ap.disabled = false; rj.disabled = false; }, 700);
}
async function resolve(approve: boolean) {
  if (!current) return;
  const id = current.id;
  // Force the NEXT request (if any) to fully re-render + re-arm before it can be resolved.
  current = null; renderedId = null;
  await call("resolve", id, approve);
  msg(approve ? "approved" : "rejected");
  render();
}

$("btn-unlock").addEventListener("click", async () => { try { await call("unlock", ($("unlock-pw") as HTMLInputElement).value); msg("unlocked", "ok"); render(); } catch (e: any) { msg(e.message, "err"); } });
$("btn-approve").addEventListener("click", () => { if (!($("btn-approve") as HTMLButtonElement).disabled) resolve(true); });
$("btn-reject").addEventListener("click", () => { if (!($("btn-reject") as HTMLButtonElement).disabled) resolve(false); });
render();
setInterval(render, 1200);

export {};
