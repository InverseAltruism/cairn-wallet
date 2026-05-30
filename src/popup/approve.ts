// MetaMask-style approval window: opened by the background when a site calls
// window.cairn.*. Unlock if needed, review the request, approve/reject. Closes
// itself when the queue is empty.
const chrome: any = (globalThis as any).chrome;
const $ = (id: string) => document.getElementById(id)!;
const escapeHtml = (s: string) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]!));

function call(method: string, ...args: any[]): Promise<any> {
  return new Promise((res, rej) => chrome.runtime.sendMessage({ kind: "popup", method, args }, (r: any) => {
    if (chrome.runtime.lastError) return rej(new Error(chrome.runtime.lastError.message));
    r?.ok ? res(r.result) : rej(new Error(r?.error || "error"));
  }));
}
function msg(t: string, cls = "info") { const m = $("msg"); m.textContent = t; m.className = "msg " + cls; }

function describe(r: any): string {
  const p = r.params || {};
  if (r.method === "connect" || r.method === "getAddress") return "<b>Connect</b> — share your address with this site.";
  if (r.method === "signin") return "<b>Sign in with CSD</b> — prove your address (no transaction).";
  if (r.method === "propose") return `<b>Post a proposal</b><br>domain: <code>${escapeHtml(String(p.domain))}</code><br>fee: ${(Number(p.fee || 0) / 1e8)} CSD`;
  if (r.method === "attest") return `<b>Support / review</b><br>target: <code>${escapeHtml(String(p.proposalId || "").slice(0, 18))}…</code><br>fee: ${(Number(p.fee || 0) / 1e8)} CSD · score ${p.score}`;
  if (r.method === "sealClaim") return `<b>Seal a claim</b> — commit a hidden claim on-chain (reveal later).<br>domain: <code>${escapeHtml(String(p.domain || "csd:sealed"))}</code><br>fee: ${(Number(p.fee || 25000000) / 1e8)} CSD · the salt + claim stay in your wallet`;
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
    $("req").innerHTML = `<div class="req">${describe(current)}</div><div class="req dim">from ${escapeHtml(String(current.origin))}</div>`;
  }
}
async function resolve(approve: boolean) { if (!current) return; await call("resolve", current.id, approve); msg(approve ? "approved" : "rejected"); render(); }

$("btn-unlock").addEventListener("click", async () => { try { await call("unlock", ($("unlock-pw") as HTMLInputElement).value); msg("unlocked", "ok"); render(); } catch (e: any) { msg(e.message, "err"); } });
$("btn-approve").addEventListener("click", () => resolve(true));
$("btn-reject").addEventListener("click", () => resolve(false));
render();
setInterval(render, 1200);

export {};
