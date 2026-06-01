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
  if (r.method === "attest") return `<b>Support / review</b><br>target: <code>${escapeHtml(String(p.proposalId || "").slice(0, 18))}…</code><br>${feeLine(p.fee)} · score ${escapeHtml(String(p.score))} · confidence ${escapeHtml(String(p.confidence))}`;
  if (r.method === "sealClaim") return `<b>Seal a claim</b> — commit a hidden claim on-chain (reveal later).<br>domain: <code>${escapeHtml(String(p.domain || "csd:sealed"))}</code><br>${feeLine(p.fee, 25000000)} · the salt + claim stay in your wallet`;
  if (r.method === "revealClaim") return `<b>Reveal a sealed claim</b> — publish the preimage; it becomes public + provably committed earlier.<br>tx: <code>${escapeHtml(String(r.params || "").slice(0, 18))}…</code>`;
  return `<b>${escapeHtml(r.method)}</b>`;
}

let current: any = null;
async function render() {
  const st = await call("status");
  ($("view-locked") as HTMLElement).hidden = st.unlocked;
  const pend = await call("pending");
  if (!pend.length) { window.close(); return; }
  current = pend[0];
  const reqView = $("view-req") as HTMLElement;
  reqView.hidden = !st.unlocked;
  if (st.unlocked) {
    const acct = (st.accounts || [])[st.active || 0];
    const signer = acct ? `${escapeHtml(acct.label)} · ${escapeHtml(String(st.addr || ""))}` : escapeHtml(String(st.addr || ""));
    $("req").innerHTML = `<div class="req dim">signing as <b>${signer}</b></div>`
      + `<div class="req">${describe(current)}</div><div class="req dim">from ${escapeHtml(String(current.origin))}</div>`
      + `<div class="req dim" id="cost">${costLine(current)}</div>`;
    fillBalance(current);
  }
}

// Static cost summary from the request's own params (no network).
function costLine(r: any): string {
  if (r.method === "connect" || r.method === "getAddress" || r.method === "signin") return "no funds move — this only shares/signs your identity.";
  const fee = Number(r.params?.fee || (r.method === "sealClaim" ? 25000000 : 0));
  return `cost: ${fee / 1e8} CSD network fee (paid to miners), + a tiny chain fee.`;
}
// Fetch the signer's balance once per request and show the projected balance-after so
// the user sees the real impact of approving — fetched once per request id (the render
// loop ticks every ~1.2s; we don't want to spam the node).
let balForId: string | null = null;
async function fillBalance(r: any) {
  if (balForId === r.id) return; balForId = r.id;
  try {
    const b = await call("balance");
    const fee = Number(r.params?.fee || (r.method === "sealClaim" ? 25000000 : 0));
    const after = (b.confirmed - fee) / 1e8;
    const el = document.getElementById("cost");
    if (el) el.textContent = `${costLine(r)}  balance: ${(b.confirmed / 1e8).toLocaleString(undefined, { maximumFractionDigits: 4 })} → ~${after.toLocaleString(undefined, { maximumFractionDigits: 4 })} CSD`;
  } catch { /* offline — leave the static cost line */ }
}
async function resolve(approve: boolean) { if (!current) return; await call("resolve", current.id, approve); msg(approve ? "approved" : "rejected"); render(); }

$("btn-unlock").addEventListener("click", async () => { try { await call("unlock", ($("unlock-pw") as HTMLInputElement).value); msg("unlocked", "ok"); render(); } catch (e: any) { msg(e.message, "err"); } });
$("btn-approve").addEventListener("click", () => resolve(true));
$("btn-reject").addEventListener("click", () => resolve(false));
render();
setInterval(render, 1200);

export {};
