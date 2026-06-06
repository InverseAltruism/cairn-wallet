// MetaMask-style approval window: opened by the background when a site calls
// window.cairn.*. Unlock if needed, review the request, approve/reject. Closes
// itself when the queue is empty.
const chrome: any = (globalThis as any).chrome;
const $ = (id: string) => document.getElementById(id)!;
const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

function call(method: string, ...args: any[]): Promise<any> {
  return new Promise((res, rej) => chrome.runtime.sendMessage({ kind: "popup", method, args }, (r: any) => {
    if (chrome.runtime.lastError) return rej(new Error(chrome.runtime.lastError.message));
    r?.ok ? res(r.result) : rej(new Error(r?.error || "error"));
  }));
}
function msg(t: string, cls = "info") { const m = $("msg"); m.textContent = t; m.className = "msg " + cls; }

// Surface a fee in CSD and flag an unusually large one so a phishing site can't slip
// a huge fee past a user skimming the dialog. propose min is 0.25 CSD; >5 CSD is odd.
const FEE_WARN = 5 * 1e8;
function feeLine(raw: number, fallback = 0): string {
  const fee = Number(raw || fallback);
  const warn = fee > FEE_WARN ? ` <span class="err">⚠ unusually large fee</span>` : "";
  return `fee: ${fee / 1e8} CSD${warn}`;
}

function describe(r: any): string {
  const p = r.params || {};
  if (r.method === "connect" || r.method === "getAddress") return "<b>Connect</b> — share your address with this site.";
  if (r.method === "signin") return "<b>Sign in with CSD</b> — prove your address (no transaction, no funds move).";
  // Clear-signing: show EVERYTHING the site controls and the chain will commit —
  // not just domain+fee. payloadHash/uri are dApp-supplied and were previously hidden.
  if (r.method === "propose") return `<b>Post a proposal</b><br>domain: <code>${escapeHtml(String(p.domain))}</code><br>${feeLine(p.fee)}`
    + `<br>payload hash: <code>${escapeHtml(String(p.payloadHash || "—"))}</code><br>uri: <code>${escapeHtml(String(p.uri || "—"))}</code>`;
  // score/confidence are serialized as u32 (>>>0); display the SAME value that will be
  // signed so a negative/oversized input can't show one thing and commit another.
  if (r.method === "attest") return `<b>Support / review</b><br>target: <code>${escapeHtml(String(p.proposalId || "—"))}</code><br>${feeLine(p.fee)} · score ${(Number(p.score) >>> 0)} · confidence ${(Number(p.confidence) >>> 0)}`;
  if (r.method === "sealClaim") return `<b>Seal a claim</b> — commit a hidden claim on-chain (reveal later).<br>domain: <code>${escapeHtml(String(p.domain || "csd:sealed"))}</code><br>${feeLine(p.fee, 25000000)} · the salt + claim stay in your wallet`;
  if (r.method === "revealClaim") return `<b>Reveal a sealed claim</b> — publish the preimage; it becomes public + provably committed earlier.<br>tx: <code>${escapeHtml(String(r.params || "").slice(0, 18))}…</code>`;
  // Send is the only dApp method that MOVES funds to a page-chosen recipient, so we
  // clear-sign the FULL (untruncated) recipient address(es) + each amount + total + fee.
  // #send-warn is populated async by fillSendWarning (first-time / address-poisoning).
  if (r.method === "send") {
    const outs = Array.isArray(p.outputs) ? p.outputs : [{ to: p.to, value: p.amount }];
    const total = outs.reduce((a: number, o: any) => a + Number(o.value || 0), 0);
    // Cap rendered rows so a huge multi-output request can't scroll the fee/total/buttons
    // out of the window; the total + count are always shown.
    const SHOWN = 12;
    const rows = outs.slice(0, SHOWN).map((o: any) => `→ <code>${escapeHtml(String(o.to))}</code> &nbsp;<b>${Number(o.value || 0) / 1e8} CSD</b>`).join("<br>")
      + (outs.length > SHOWN ? `<br><span class="dim">…and ${outs.length - SHOWN} more recipient(s)</span>` : "");
    const totalLine = outs.length > 1 ? `<br>total: <b>${total / 1e8} CSD</b> to ${outs.length} recipients` : "";
    return `<b>Send CSD</b><br>${rows}<br>${feeLine(p.fee, 1000000)}${totalLine}<div id="send-warn" class="err" style="margin-top:8px" hidden></div>`;
  }
  return `<b>${escapeHtml(r.method)}</b>`;
}

// Base units that will LEAVE the wallet if this request is approved (for balance-after).
function debitOf(r: any): number {
  const p = r.params || {};
  if (r.method === "send") {
    const outs = Array.isArray(p.outputs) ? p.outputs : [{ value: p.amount }];
    const total = outs.reduce((a: number, o: any) => a + Number(o.value || 0), 0);
    return total + Number(p.fee || 1_000_000);
  }
  if (r.method === "connect" || r.method === "getAddress" || r.method === "signin") return 0;
  return Number(p.fee || (r.method === "sealClaim" ? 25000000 : 0));
}

// Address-poisoning lookalike (ported from the in-popup send review): an attacker seeds
// your history with an address sharing the head+tail you eyeball but differing in the
// middle. Flag a recipient matching a previously-seen address on first 8 + last 4 hex
// but not identical.
function lookalikeOf(to: string, known: string[]): string | null {
  const t = to.toLowerCase(), head = t.slice(0, 8), tail = t.slice(-4);
  for (const k of known) { const a = k.toLowerCase(); if (a !== t && a.slice(0, 8) === head && a.slice(-4) === tail) return k; }
  return null;
}

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

// Static cost summary from the request's own params (no network).
function costLine(r: any): string {
  if (r.method === "connect" || r.method === "getAddress" || r.method === "signin") return "no funds move — this only shares/signs your identity.";
  if (r.method === "send") { const fee = Number(r.params?.fee || 1_000_000); const sent = debitOf(r) - fee; return `cost: ${sent / 1e8} CSD sent + ${fee / 1e8} CSD network fee.`; }
  const fee = Number(r.params?.fee || (r.method === "sealClaim" ? 25000000 : 0));
  return `cost: ${fee / 1e8} CSD network fee (paid to miners), + a tiny chain fee.`;
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
