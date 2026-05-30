// Popup UI controller. In the extension it messages the background service worker
// (which owns the keys); standalone (dev/E2E, no chrome.*) it drives a local Wallet
// against localStorage so the exact UI flows can be tested in a real browser.
import { Wallet, explorerTx, explorerAddr } from "../core/wallet.js";
import { localStore } from "../core/storage.js";

const chrome: any = (globalThis as any).chrome;
const EXT = !!(chrome?.runtime?.sendMessage);
let dev: Wallet | null = null;
async function devWallet() { if (!dev) { dev = new Wallet(localStore()); await dev.init(); } return dev; }

async function call(method: string, ...args: any[]): Promise<any> {
  if (EXT) return new Promise((res, rej) => chrome.runtime.sendMessage({ kind: "popup", method, args }, (r: any) => {
    if (chrome.runtime.lastError) return rej(new Error(chrome.runtime.lastError.message));
    r?.ok ? res(r.result) : rej(new Error(r?.error || "error"));
  }));
  const w = await devWallet();
  switch (method) {
    case "status": return w.status();
    case "create": return w.create(args[0]);
    case "import": return w.importKey(args[0], args[1]);
    case "unlock": return w.unlock(args[0]);
    case "lock": return w.lock();
    case "balance": return w.balance();
    case "send": return w.send(args[0], args[1], args[2]);
    case "cairnPost": return w.cairnPost(args[0]);
    case "cairnSupport": return w.cairnSupport(args[0], args[1], args[2], args[3]);
    case "signin": return w.signIn();
    case "export": return w.exportKey(args[0]);
    case "setRpc": return w.setRpc(args[0]);
    case "setApi": return w.setApi(args[0]);
    case "pending": return [];
    case "resolve": return { done: true };
    default: throw new Error("unknown " + method);
  }
}

const $ = (id: string) => document.getElementById(id)!;
const val = (id: string) => ($(id) as HTMLInputElement).value;
function show(view: string) { for (const v of ["setup", "locked", "main"]) ($("view-" + v) as HTMLElement).hidden = v !== view; }
function msg(text: string, cls = "info") { const m = $("msg"); m.textContent = text; m.className = "msg " + cls; }
const escapeHtml = (s: string) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]!));

async function render() {
  const st = await call("status");
  $("net").textContent = (st.rpc || "").replace(/^https?:\/\//, "");
  if (!st.hasVault) return show("setup");
  if (!st.unlocked) return show("locked");
  show("main");
  $("addr").textContent = st.addr;
  if (st.addr) ($("addr-explorer") as HTMLAnchorElement).href = explorerAddr(st.addr);
  (($("set-rpc") as HTMLInputElement)).value = st.rpc;
  (($("set-api") as HTMLInputElement)).value = st.api;
  refreshBalance();
  renderPending();
}

const TX_LABEL: Record<string, string> = { send: "Sent", propose: "Proposed", post: "Posted", support: "Supported", attest: "Supported" };
async function renderHistory() {
  const h: any[] = await call("history");
  const el = $("history-list");
  if (!h.length) { el.innerHTML = `<div class="dim" style="padding:8px 0">No transactions yet. Send, post, or support something and it'll appear here.</div>`; return; }
  el.innerHTML = h.map((t) => {
    const csd = ((Number(t.amount ?? t.fee ?? 0)) / 1e8).toLocaleString(undefined, { maximumFractionDigits: 4 });
    const kind = TX_LABEL[t.type] || t.type;
    const detail = t.type === "send" ? `to ${escapeHtml(String(t.to || "").slice(0, 12))}…`
      : t.title ? escapeHtml(String(t.title).slice(0, 28))
      : t.domain ? escapeHtml(String(t.domain))
      : t.target ? `${escapeHtml(String(t.target).slice(0, 12))}…` : "";
    const when = t.ts ? new Date(t.ts).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "";
    return `<div class="tx">
      <div class="tx-top"><span class="tx-kind">${kind}</span><span class="tx-amt">${csd} CSD</span></div>
      <div class="tx-sub"><span class="dim">${detail}</span><a href="${explorerTx(String(t.txid))}" target="_blank" rel="noopener noreferrer">${escapeHtml(String(t.txid).slice(0, 10))}… ↗</a></div>
      <div class="tx-when dim">${when}</div>
    </div>`;
  }).join("");
}
async function refreshBalance() {
  try { const b = await call("balance"); $("balance").textContent = (b.confirmed / 1e8).toLocaleString(undefined, { maximumFractionDigits: 4 }) + " CSD"; }
  catch { $("balance").textContent = "—"; }
}
async function renderPending() {
  if (!EXT) return;
  const p = await call("pending"); const el = $("pending") as HTMLElement;
  if (!p.length) { el.hidden = true; el.innerHTML = ""; return; }
  el.hidden = false;
  el.innerHTML = p.map((r: any) => `<div class="req"><b>${r.method}</b> from ${escapeHtml(String(r.origin))}</div><div class="row"><button data-ap="${r.id}" class="primary">Approve</button><button data-rj="${r.id}">Reject</button></div>`).join("");
  el.querySelectorAll<HTMLElement>("[data-ap]").forEach((b) => b.onclick = () => resolve(b.dataset.ap!, true));
  el.querySelectorAll<HTMLElement>("[data-rj]").forEach((b) => b.onclick = () => resolve(b.dataset.rj!, false));
}
async function resolve(id: string, ap: boolean) { await call("resolve", id, ap); msg(ap ? "approved" : "rejected"); renderPending(); }

$("btn-create").addEventListener("click", async () => { try { const pw = val("setup-pw"); if (!pw) return msg("enter a password", "err"); await call("create", pw); msg("wallet created — back it up!", "ok"); render(); } catch (e: any) { msg(e.message, "err"); } });
$("btn-import").addEventListener("click", async () => { try { if (!val("import-pw")) return msg("enter a password to encrypt the key", "err"); await call("import", val("import-key").trim(), val("import-pw")); msg("key imported", "ok"); render(); } catch (e: any) { msg(e.message, "err"); } });
$("btn-unlock").addEventListener("click", async () => { try { await call("unlock", val("unlock-pw")); msg("unlocked", "ok"); render(); } catch (e: any) { msg(e.message, "err"); } });
$("btn-lock").addEventListener("click", async () => { await call("lock"); msg("locked"); render(); });
$("btn-refresh").addEventListener("click", refreshBalance);
$("btn-copy").addEventListener("click", () => { navigator.clipboard?.writeText($("addr").textContent || ""); msg("address copied"); });
$("btn-signin").addEventListener("click", async () => { try { msg("signing in…"); const r = await call("signin"); r.ok ? msg("signed in as " + r.addr, "ok") : msg("sign-in failed: " + (r.error || "?"), "err"); } catch (e: any) { msg(e.message, "err"); } });
$("btn-export").addEventListener("click", async () => { const pw = window.prompt("Re-enter your password to reveal the private key:"); if (!pw) return; try { const k = await call("export", pw); window.prompt("Private key — keep it SECRET:", k); } catch (e: any) { msg(e.message, "err"); } });
$("btn-settings").addEventListener("click", () => { const s = $("settings") as HTMLElement; s.hidden = !s.hidden; });
$("btn-save-settings").addEventListener("click", async () => { await call("setRpc", val("set-rpc").trim()); await call("setApi", val("set-api").trim()); msg("settings saved", "ok"); render(); });

const toggle = (id: string) => { const e = $(id) as HTMLElement; e.hidden = !e.hidden; };
$("btn-send-t").addEventListener("click", () => toggle("send-form"));
$("btn-post-t").addEventListener("click", () => toggle("post-form"));
$("btn-activity-t").addEventListener("click", () => { toggle("activity"); if (!($("activity") as HTMLElement).hidden) renderHistory(); });
$("btn-send").addEventListener("click", async () => {
  try {
    const to = val("s-to").trim(); const amt = Math.round(parseFloat(val("s-amt") || "0") * 1e8);
    if (!(amt > 0)) return msg("enter an amount", "err");
    msg("sending…"); const r = await call("send", to, amt);
    if (r.ok) { msg("sent " + (amt / 1e8) + " CSD · " + String(r.txid).slice(0, 12) + "…", "ok"); refreshBalance(); }
    else msg("send failed: " + (r.error || "?"), "err");
  } catch (e: any) { msg(e.message, "err"); }
});
$("btn-post").addEventListener("click", async () => {
  try {
    const fee = Math.max(Math.round(parseFloat(val("p-fee") || "0.25") * 1e8), 25000000);
    msg("posting…");
    const r = await call("cairnPost", { domain: val("p-domain").trim(), title: val("p-title"), body: val("p-body"), fee });
    if (r.ok) { msg("posted · " + String(r.txid).slice(0, 12) + "… (shows on Cairn after ~1 block)", "ok"); refreshBalance(); }
    else msg("post failed: " + (r.error || "?"), "err");
  } catch (e: any) { msg(e.message, "err"); }
});

render();
if (EXT) setInterval(renderPending, 1500);
