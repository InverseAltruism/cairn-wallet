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
    case "restore": return w.restore(args[0], args[1]);
    case "import": return w.importKey(args[0], args[1]);
    case "unlock": return w.unlock(args[0]);
    case "lock": return w.lock();
    case "addAccount": return w.addAccount(args[0]);
    case "importAccount": return w.importAccount(args[0], args[1]);
    case "switchAccount": return w.switchAccount(args[0]);
    case "renameAccount": return w.renameAccount(args[0], args[1]);
    case "removeAccount": return w.removeAccount(args[0]);
    case "balance": return w.balance();
    case "send": return w.send(args[0], args[1], args[2]);
    case "cairnPost": return w.cairnPost(args[0]);
    case "cairnSupport": return w.cairnSupport(args[0], args[1], args[2], args[3]);
    case "signin": return w.signIn();
    case "export": return w.exportKey(args[0]);
    case "exportMnemonic": return w.exportMnemonic(args[0]);
    case "setRpc": return w.setRpc(args[0]);
    case "setApi": return w.setApi(args[0]);
    case "rpcList": return w.rpcList();
    case "addRpc": return w.addRpc(args[0]);
    case "removeRpc": return w.removeRpc(args[0]);
    case "pending": return [];
    case "resolve": return { done: true };
    default: throw new Error("unknown " + method);
  }
}

const $ = (id: string) => document.getElementById(id)!;
const val = (id: string) => ($(id) as HTMLInputElement).value;
function show(view: string) { for (const v of ["setup", "backup", "locked", "main"]) ($("view-" + v) as HTMLElement).hidden = v !== view; }
function msg(text: string, cls = "info") { const m = $("msg"); m.textContent = text; m.className = "msg " + cls; }
const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
// In-progress status with an animated spinner (for async actions).
function busy(text: string) { const m = $("msg"); m.innerHTML = `<span class="spinner"></span>${escapeHtml(text)}`; m.className = "msg info"; }
// Brief visual confirmation on a button (e.g. copy).
function flashBtn(id: string, label: string) { const b = $(id); const o = b.textContent; b.textContent = label; b.classList.add("copied"); setTimeout(() => { b.textContent = o; b.classList.remove("copied"); }, 1100); }

let currentRpc = "";
async function render() {
  const st = await call("status");
  currentRpc = st.rpc || "";
  if (!st.hasVault) return show("setup");
  if (!st.unlocked) return show("locked");
  show("main");
  // Only HD wallets have a recovery phrase; hide the reveal button for imported keys.
  ($("btn-phrase") as HTMLElement).hidden = !st.hasMnemonic;
  renderAcctSelect(st.accounts || [], st.active || 0);
  $("addr").textContent = st.addr;
  if (st.addr) ($("addr-explorer") as HTMLAnchorElement).href = explorerAddr(st.addr);
  (($("set-api") as HTMLInputElement)).value = st.api;
  refreshBalance();
  renderPending();
  // keep open per-account panels in sync after a switch
  if (!($("activity") as HTMLElement).hidden) renderHistory();
  if (!($("seal-form") as HTMLElement).hidden) renderSealed();
  if (!($("accts-panel") as HTMLElement).hidden) renderAccts();
}

const short = (a: string) => a && a.length > 14 ? a.slice(0, 8) + "…" + a.slice(-4) : a;
function renderAcctSelect(accounts: { addr: string; label: string }[], active: number) {
  const sel = $("acct-select") as HTMLSelectElement;
  sel.innerHTML = accounts.map((a, i) => `<option value="${i}">${escapeHtml(a.label)} · ${escapeHtml(short(a.addr))}</option>`).join("");
  sel.value = String(active);
}
// per-row inline edit state (rename/remove) so we never use a browser prompt/confirm
let acctEdit: { addr: string; mode: "rename" | "remove" } | null = null;
async function renderAccts() {
  const st = await call("status");
  const el = $("accts-list");
  el.innerHTML = (st.accounts || []).map((a: any, i: number) => {
    const editing = acctEdit && acctEdit.addr.toLowerCase() === a.addr.toLowerCase();
    const tag = a.imported ? ` <span class="badge">imported</span>` : "";
    let right: string;
    if (editing && acctEdit!.mode === "rename") {
      right = `<span class="row" style="gap:6px">
          <input class="acct-rename-input" data-addr="${escapeHtml(a.addr)}" value="${escapeHtml(a.label)}" />
          <button class="mini" data-save="${escapeHtml(a.addr)}">save</button>
          <button class="mini" data-cancel="1">cancel</button></span>`;
    } else if (editing) {
      right = `<span class="row" style="gap:6px"><span class="dim" style="font-size:11px">remove?</span>
          <button class="mini" data-confirm-remove="${escapeHtml(a.addr)}">yes</button>
          <button class="mini" data-cancel="1">no</button></span>`;
    } else {
      right = `<span class="row" style="gap:6px">
          <button class="mini" data-rename="${escapeHtml(a.addr)}">rename</button>
          ${(st.accounts.length > 1) ? `<button class="mini" data-remove="${escapeHtml(a.addr)}">remove</button>` : ""}</span>`;
    }
    return `<div class="tx">
      <div class="tx-top"><span class="tx-kind">${i === st.active ? "● " : ""}${escapeHtml(a.label)}${tag}</span>${right}</div>
      <div class="tx-sub"><span class="dim mono">${escapeHtml(a.addr)}</span></div>
    </div>`;
  }).join("");
  const edit = (addr: string | undefined, mode: "rename" | "remove") => { if (addr) { acctEdit = { addr, mode }; renderAccts(); } };
  el.querySelectorAll<HTMLElement>("[data-rename]").forEach((b) => b.onclick = () => edit(b.dataset.rename, "rename"));
  el.querySelectorAll<HTMLElement>("[data-remove]").forEach((b) => b.onclick = () => edit(b.dataset.remove, "remove"));
  el.querySelectorAll<HTMLElement>("[data-cancel]").forEach((b) => b.onclick = () => { acctEdit = null; renderAccts(); });
  el.querySelectorAll<HTMLElement>("[data-save]").forEach((b) => b.onclick = async () => {
    const inp = el.querySelector(`.acct-rename-input[data-addr="${b.dataset.save}"]`) as HTMLInputElement | null;
    const label = inp?.value.trim(); if (!label) return msg("enter a label", "err");
    try { await call("renameAccount", b.dataset.save, label); acctEdit = null; renderAccts(); render(); } catch (e: any) { msg(e.message, "err"); }
  });
  el.querySelectorAll<HTMLElement>("[data-confirm-remove]").forEach((b) => b.onclick = async () => {
    try { await call("removeAccount", b.dataset.confirmRemove); acctEdit = null; msg("account removed", "ok"); renderAccts(); render(); } catch (e: any) { msg(e.message, "err"); }
  });
  const ri = el.querySelector(".acct-rename-input") as HTMLInputElement | null;
  if (ri) { ri.focus(); ri.select(); ri.onkeydown = (e: any) => { if (e.key === "Enter") (el.querySelector("[data-save]") as HTMLElement)?.click(); if (e.key === "Escape") { acctEdit = null; renderAccts(); } }; }
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
  const el = $("balance");
  el.classList.add("loading");                 // shimmer while we fetch
  try {
    const b = await call("balance");
    el.classList.remove("loading");
    el.textContent = (b.confirmed / 1e8).toLocaleString(undefined, { maximumFractionDigits: 4 }) + " CSD";
    el.classList.remove("flash"); void (el as HTMLElement).offsetWidth; el.classList.add("flash"); // retrigger green flash
  }
  catch { el.classList.remove("loading"); el.textContent = "—"; }
}
async function renderPending() {
  if (!EXT) return;
  const p = await call("pending"); const el = $("pending") as HTMLElement;
  if (!p.length) { el.hidden = true; el.innerHTML = ""; return; }
  el.hidden = false;
  el.innerHTML = p.map((r: any) => `<div class="req"><b>${escapeHtml(String(r.method))}</b> from ${escapeHtml(String(r.origin))}</div><div class="row"><button data-ap="${escapeHtml(String(r.id))}" class="primary">Approve</button><button data-rj="${escapeHtml(String(r.id))}">Reject</button></div>`).join("");
  el.querySelectorAll<HTMLElement>("[data-ap]").forEach((b) => b.onclick = () => resolve(b.dataset.ap!, true));
  el.querySelectorAll<HTMLElement>("[data-rj]").forEach((b) => b.onclick = () => resolve(b.dataset.rj!, false));
}
async function resolve(id: string, ap: boolean) { await call("resolve", id, ap); msg(ap ? "approved" : "rejected"); renderPending(); }

// Render the 12 words as a numbered grid.
function seedGridHtml(mnemonic: string): string {
  return mnemonic.split(" ").map((w, i) => `<span class="seed-word"><span class="seed-n">${i + 1}</span>${escapeHtml(w)}</span>`).join("");
}
// Post-create backup screen: shows BOTH the recovery phrase and this account's
// (portable) private key, each with its own info note.
let backupPhrase = "", backupPriv = "";
function showBackup(mnemonic: string, privkey: string) {
  backupPhrase = mnemonic; backupPriv = privkey;
  $("seed-words").innerHTML = seedGridHtml(mnemonic);
  $("backup-priv").textContent = privkey;
  ($("ack-backup") as HTMLInputElement).checked = false;
  ($("btn-backup-done") as HTMLButtonElement).disabled = true;
  show("backup");
}
$("btn-create").addEventListener("click", async () => { try { const pw = val("setup-pw"); if (!pw) return msg("enter a password", "err"); const r = await call("create", pw); ($("setup-pw") as HTMLInputElement).value = ""; showBackup(r.mnemonic, r.privkey); } catch (e: any) { msg(e.message, "err"); } });
$("btn-restore").addEventListener("click", async () => { try { const ph = val("restore-phrase").trim(); const pw = val("restore-pw"); if (!ph) return msg("enter your recovery phrase", "err"); if (!pw) return msg("enter a password to encrypt it", "err"); await call("restore", ph, pw); ($("restore-phrase") as HTMLTextAreaElement).value = ""; ($("restore-pw") as HTMLInputElement).value = ""; msg("wallet restored", "ok"); render(); } catch (e: any) { msg(e.message, "err"); } });
$("btn-copy-seed").addEventListener("click", () => { navigator.clipboard?.writeText(backupPhrase); flashBtn("btn-copy-seed", "copied ✓"); });
$("btn-copy-priv").addEventListener("click", () => { navigator.clipboard?.writeText(backupPriv); flashBtn("btn-copy-priv", "copied ✓"); });
($("ack-backup") as HTMLInputElement).addEventListener("change", (e) => { ($("btn-backup-done") as HTMLButtonElement).disabled = !(e.target as HTMLInputElement).checked; });
$("btn-backup-done").addEventListener("click", () => { backupPhrase = ""; backupPriv = ""; $("seed-words").innerHTML = ""; $("backup-priv").textContent = ""; msg("wallet ready", "ok"); render(); });
$("btn-import").addEventListener("click", async () => { try { if (!val("import-pw")) return msg("enter a password to encrypt the key", "err"); await call("import", val("import-key").trim(), val("import-pw")); msg("key imported", "ok"); render(); } catch (e: any) { msg(e.message, "err"); } });
$("btn-unlock").addEventListener("click", async () => { try { await call("unlock", val("unlock-pw")); msg("unlocked", "ok"); render(); } catch (e: any) { msg(e.message, "err"); } });
$("btn-lock").addEventListener("click", async () => { await call("lock"); msg("locked"); render(); });
$("btn-refresh").addEventListener("click", refreshBalance);
$("btn-copy").addEventListener("click", () => { navigator.clipboard?.writeText($("addr").textContent || ""); flashBtn("btn-copy", "copied ✓"); });
// ── accordion: at most ONE action panel open at a time ──────────────────────
// All the collapsible panels under the main view. Opening one closes the rest;
// clicking the same trigger again closes it. Secret panels are wiped on every switch.
const PANELS = ["accts-panel", "send-form", "post-form", "seal-form", "activity", "reveal-panel", "phrase-panel", "settings"];
let revealedKey = "", revealedPhrase = "";
function resetRevealPanel() {
  revealedKey = ""; const o = $("reveal-out"); o.textContent = ""; o.classList.remove("shown"); (o as HTMLElement).hidden = true;
  ($("reveal-actions") as HTMLElement).hidden = true; ($("reveal-pw") as HTMLInputElement).value = "";
}
function resetPhrasePanel() {
  revealedPhrase = ""; const o = $("phrase-out"); o.innerHTML = ""; o.classList.remove("shown"); o.classList.add("blur"); (o as HTMLElement).hidden = true;
  ($("phrase-actions") as HTMLElement).hidden = true; ($("phrase-pw") as HTMLInputElement).value = "";
}
// Show `id` and hide every other panel; returns true if it ended up OPEN. Wipes any
// revealed secret so a key/phrase never lingers behind a now-hidden panel.
function openPanel(id: string): boolean {
  const willOpen = ($(id) as HTMLElement).hidden;
  for (const p of PANELS) ($(p) as HTMLElement).hidden = true;
  ($("send-confirm") as HTMLElement).hidden = true;
  resetRevealPanel(); resetPhrasePanel();
  if (willOpen) ($(id) as HTMLElement).hidden = false;
  return willOpen;
}

// Reveal private key — in-popup panel (password → masked secret box).
$("btn-export").addEventListener("click", () => { openPanel("reveal-panel"); });
$("btn-reveal-go").addEventListener("click", async () => {
  const pw = val("reveal-pw"); if (!pw) return msg("enter your password", "err");
  try {
    revealedKey = await call("export", pw);
    const out = $("reveal-out") as HTMLElement;
    out.textContent = revealedKey; out.classList.remove("shown"); out.hidden = false;
    ($("reveal-actions") as HTMLElement).hidden = false; ($("reveal-pw") as HTMLInputElement).value = ""; msg("");
  } catch (e: any) { msg(e.message, "err"); }
});
$("btn-reveal-show").addEventListener("click", () => { ($("reveal-out") as HTMLElement).classList.toggle("shown"); });
$("btn-reveal-copy").addEventListener("click", () => { navigator.clipboard?.writeText(revealedKey); flashBtn("btn-reveal-copy", "copied ✓"); });
$("btn-reveal-close").addEventListener("click", () => { resetRevealPanel(); ($("reveal-panel") as HTMLElement).hidden = true; });

// Reveal recovery phrase — in-popup panel (password → blurred 12-word grid).
$("btn-phrase").addEventListener("click", () => { openPanel("phrase-panel"); });
$("btn-phrase-go").addEventListener("click", async () => {
  const pw = val("phrase-pw"); if (!pw) return msg("enter your password", "err");
  try {
    revealedPhrase = await call("exportMnemonic", pw);
    const out = $("phrase-out") as HTMLElement;
    out.innerHTML = seedGridHtml(revealedPhrase); out.classList.add("blur"); out.classList.remove("shown"); out.hidden = false;
    ($("phrase-actions") as HTMLElement).hidden = false; ($("phrase-pw") as HTMLInputElement).value = ""; msg("");
  } catch (e: any) { msg(e.message, "err"); }
});
$("btn-phrase-show").addEventListener("click", () => { const o = $("phrase-out"); o.classList.toggle("shown"); o.classList.toggle("blur"); });
$("btn-phrase-copy").addEventListener("click", () => { navigator.clipboard?.writeText(revealedPhrase); flashBtn("btn-phrase-copy", "copied ✓"); });
$("btn-phrase-close").addEventListener("click", () => { resetPhrasePanel(); ($("phrase-panel") as HTMLElement).hidden = true; });
$("btn-settings").addEventListener("click", () => { openPanel("settings"); });
// Turn an RPC/API base URL into an MV3 host-match pattern ("https://host:port/*").
// Returns null for the URLs already in the static host_permissions (so we don't
// pointlessly re-request) or anything unparseable.
function originPattern(u: string): string | null {
  try {
    const url = new URL(u);
    const host = url.host; // includes :port if present
    if (host === "cairn-substrate.com" || host === "127.0.0.1:8790") return null;
    return `${url.protocol}//${host}/*`;
  } catch { return null; }
}
// Request host access for any custom RPC/API origins. MV3 blocks fetches to hosts
// outside host_permissions, so "point at your own node" needs an optional grant —
// requested here, inside the click (a user gesture), or Chrome rejects it silently.
async function ensureHostAccess(urls: string[]): Promise<boolean> {
  if (!EXT || !chrome.permissions?.request) return true;
  const origins = [...new Set(urls.map(originPattern).filter(Boolean) as string[])];
  if (!origins.length) return true;
  try {
    if (await chrome.permissions.contains({ origins })) return true;
    return await chrome.permissions.request({ origins });
  } catch { return false; }
}
$("btn-save-settings").addEventListener("click", async () => {
  const api = val("set-api").trim();
  const granted = await ensureHostAccess([api]);
  if (!granted) return msg("not saved — host access denied (the wallet can't reach an API it has no permission for)", "err");
  await call("setApi", api); msg("settings saved", "ok"); render();
});

// ── RPC dropdown (header) — preset + user-added nodes, switch with one click ──
const RPC_PRESETS = [
  { label: "Cairn proxy", url: "https://cairn-substrate.com/api/rpc" },
  { label: "Local node", url: "http://127.0.0.1:8790" },
];
async function renderRpcMenu() {
  const menu = $("rpc-menu");
  const customs: string[] = await call("rpcList").catch(() => []);
  const preset = (u: string) => RPC_PRESETS.find((p) => p.url === u)?.label;
  const row = (url: string, label: string, removable: boolean) => `
    <div class="rpc-row${url === currentRpc ? " active" : ""}">
      <button class="rpc-pick" data-url="${escapeHtml(url)}">${url === currentRpc ? "● " : ""}<span class="rpc-label">${escapeHtml(label)}</span><span class="rpc-url">${escapeHtml(url.replace(/^https?:\/\//, ""))}</span></button>
      ${removable ? `<button class="rpc-del mini" data-del="${escapeHtml(url)}" title="remove">×</button>` : ""}
    </div>`;
  const customRows = customs.filter((u) => !preset(u)).map((u) => row(u, "Custom", true)).join("");
  menu.innerHTML = RPC_PRESETS.map((p) => row(p.url, p.label, false)).join("") + customRows
    + `<div class="rpc-add"><input id="rpc-add-input" placeholder="https://your-node…" /><button id="rpc-add-btn" class="mini">add</button></div>`;
  menu.querySelectorAll<HTMLElement>("[data-url]").forEach((b) => b.onclick = () => selectRpc(b.dataset.url!));
  menu.querySelectorAll<HTMLElement>("[data-del]").forEach((b) => b.onclick = async (e) => { e.stopPropagation(); await call("removeRpc", b.dataset.del); renderRpcMenu(); });
  ($("rpc-add-btn") as HTMLElement).onclick = async () => {
    const u = (($("rpc-add-input") as HTMLInputElement).value || "").trim();
    if (!/^https?:\/\/.+/.test(u)) return msg("enter a full RPC URL (http(s)://…)", "err");
    await call("addRpc", u); await selectRpc(u);
  };
}
async function selectRpc(url: string) {
  const granted = await ensureHostAccess([url]);
  if (!granted) return msg("RPC not switched — host access denied", "err");
  await call("setRpc", url); ($("rpc-menu") as HTMLElement).hidden = true; msg("RPC: " + url.replace(/^https?:\/\//, ""), "ok"); render();
}
$("btn-rpc").addEventListener("click", () => { const m = $("rpc-menu") as HTMLElement; if (m.hidden) { renderRpcMenu(); m.hidden = false; } else m.hidden = true; });
// click-away closes the RPC menu
document.addEventListener("click", (e) => { const m = $("rpc-menu") as HTMLElement; const w = (e.target as HTMLElement).closest(".rpc-wrap"); if (!w && !m.hidden) m.hidden = true; });

($("acct-select") as HTMLSelectElement).addEventListener("change", async (e) => {
  try { await call("switchAccount", Number((e.target as HTMLSelectElement).value)); msg("switched account", "ok"); render(); }
  catch (err: any) { msg(err.message, "err"); }
});
$("btn-accts").addEventListener("click", () => { if (openPanel("accts-panel")) renderAccts(); });
$("btn-add-acct").addEventListener("click", async () => {
  try { const r = await call("addAccount"); msg("added " + (r.addr ? r.addr.slice(0, 10) + "…" : "account"), "ok"); render(); }
  catch (e: any) { msg(e.message, "err"); }
});
$("btn-imp-acct").addEventListener("click", async () => {
  const key = val("imp-acct-key").trim(); if (!key) return msg("paste a private key", "err");
  try { await call("importAccount", key, val("imp-acct-label").trim()); ($("imp-acct-key") as HTMLInputElement).value = ""; msg("account imported", "ok"); render(); }
  catch (e: any) { msg(e.message, "err"); }
});

$("btn-send-t").addEventListener("click", () => { openPanel("send-form"); });
$("btn-post-t").addEventListener("click", () => { if (openPanel("post-form")) populateDomains(); });
// Fill the category dropdown from the live Cairn board (/api/domains), with a
// "+ new category…" option for open domains. Falls back to the built-in vocabulary
// offline. Cached per popup so reopening is instant.
let domainsCache: string[] | null = null;
const FALLBACK_DOMAINS = ["csd:apps", "csd:features", "csd:bugs", "csd:bounties", "csd:docs", "csd:tools", "csd:integrations", "csd:signals", "csd:quests"];
async function populateDomains() {
  const sel = $("p-domain") as HTMLSelectElement;
  const custom = $("p-domain-custom") as HTMLInputElement;
  custom.hidden = true;
  let domains = domainsCache || FALLBACK_DOMAINS;
  if (!domainsCache) {
    try {
      const st = await call("status");
      const j = await (await fetch(`${st.api}/api/domains`)).json();
      if (j && Array.isArray(j.domains) && j.domains.length) { domains = j.domains.map((d: any) => d.key); domainsCache = domains; }
    } catch { /* offline → fallback vocabulary */ }
  }
  sel.innerHTML = domains.map((d) => `<option value="${escapeHtml(d)}">${escapeHtml(d)}</option>`).join("") + `<option value="__custom__">+ new category…</option>`;
  sel.value = domains.includes("csd:apps") ? "csd:apps" : domains[0];
  sel.onchange = () => { const isCustom = sel.value === "__custom__"; custom.hidden = !isCustom; if (isCustom) custom.focus(); };
}
$("btn-activity-t").addEventListener("click", () => { if (openPanel("activity")) renderHistory(); });
$("btn-seal-t").addEventListener("click", () => { if (openPanel("seal-form")) renderSealed(); });
$("btn-seal").addEventListener("click", async () => {
  const claim = val("seal-claim").trim(); if (!claim) return msg("enter a claim to seal", "err");
  const domain = val("seal-domain").trim() || "csd:sealed";
  try { busy("sealing…"); const r = await call("sealClaim", { domain, claim });
    if (r.ok) { msg("sealed on-chain ✓ — reveal it whenever you like", "ok"); (($("seal-claim")) as HTMLTextAreaElement).value = ""; renderSealed(); refreshBalance(); }
    else msg("seal failed: " + (r.error || "?"), "err");
  } catch (e: any) { msg(e.message, "err"); }
});
async function renderSealed() {
  const list: any[] = await call("sealedClaims");
  const el = $("seal-list");
  if (!list.length) { el.innerHTML = `<div class="dim" style="padding:6px 0">No sealed claims yet. Seal one above; it stays secret until you reveal.</div>`; return; }
  el.innerHTML = list.map((s) => {
    const when = s.committedTs ? new Date(s.committedTs).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "";
    const status = s.revealed ? `<span style="color:var(--green)">✅ revealed</span>` : `🔒 sealed`;
    const right = s.revealed
      ? `<a href="${explorerTx(String(s.txid))}" target="_blank" rel="noopener noreferrer">${String(s.txid).slice(0, 10)}… ↗</a>`
      : `<button class="mini" data-reveal="${escapeHtml(String(s.txid))}">Reveal</button>`;
    return `<div class="tx"><div class="tx-top"><span class="tx-kind">${status}</span><span class="dim">${when}</span></div>
      <div class="tx-sub"><span class="dim">${escapeHtml(String(s.claim).slice(0, 44))}</span>${right}</div></div>`;
  }).join("");
  el.querySelectorAll("[data-reveal]").forEach((b) => b.addEventListener("click", async () => {
    const id = (b as HTMLElement).dataset.reveal!; busy("revealing…");
    const r = await call("revealClaim", id);
    (r && r.ok) ? msg("revealed ✓ — now public + provably committed earlier", "ok") : msg("reveal failed: " + ((r && r.error) || "?"), "err");
    renderSealed();
  }));
}
// Address-poisoning lookalike: attackers seed your history with an address that
// shares the head+tail you eyeball but differs in the middle. Flag a recipient that
// matches a previously-seen address on first 6 + last 4 hex chars but isn't identical.
function lookalikeOf(to: string, known: string[]): string | null {
  const t = to.toLowerCase(); const head = t.slice(0, 8), tail = t.slice(-4);
  for (const k of known) { const a = k.toLowerCase(); if (a !== t && a.slice(0, 8) === head && a.slice(-4) === tail) return k; }
  return null;
}
// Two-step send: "Review" shows a confirmation with the FULL recipient address,
// amount, fee, and projected balance-after (defends against address-poisoning /
// clipboard-swap — the user verifies exactly what will be signed), warns on a
// never-seen-before recipient, and hard-flags a poisoning lookalike.
const SEND_FEE = 1_000_000; // 0.01 CSD
$("btn-send").addEventListener("click", async () => {
  const to = val("s-to").trim();
  const amt = Math.round(parseFloat(val("s-amt") || "0") * 1e8);
  if (!/^0x[0-9a-fA-F]{40}$/.test(to)) return msg("enter a valid 0x… 20-byte address", "err");
  if (!(amt > 0)) return msg("enter an amount", "err");
  let firstTime = true, known: string[] = [], lookalike: string | null = null, after = "";
  try {
    const h: any[] = await call("history");
    const sentTo = h.filter((t) => t.type === "send").map((t) => String(t.to || ""));
    firstTime = !sentTo.some((a) => a.toLowerCase() === to.toLowerCase());
    const st = await call("status"); known = [...sentTo, ...((st.accounts || []).map((a: any) => a.addr))];
    lookalike = lookalikeOf(to, known);
  } catch { /* no history → treat as first time */ }
  try { const b = await call("balance"); after = ((b.confirmed - amt - SEND_FEE) / 1e8).toLocaleString(undefined, { maximumFractionDigits: 4 }) + " CSD"; } catch { /* offline */ }
  $("c-to").textContent = to;                       // FULL address, not truncated
  $("c-amt").textContent = (amt / 1e8) + " CSD";
  $("c-fee").textContent = (SEND_FEE / 1e8) + " CSD";
  $("c-after").textContent = after || "—";
  const warnEl = $("c-warn") as HTMLElement;
  if (lookalike) { warnEl.innerHTML = `⚠ <b>Possible address-poisoning.</b> This looks like <code>${escapeHtml(lookalike.slice(0, 10))}…${escapeHtml(lookalike.slice(-6))}</code> you've seen before but is NOT the same address. Verify every character — payments are irreversible.`; warnEl.hidden = false; }
  else if (firstTime) { warnEl.textContent = "⚠ First time sending to this address — check every character. Payments are irreversible."; warnEl.hidden = false; }
  else warnEl.hidden = true;
  ($("send-confirm") as HTMLElement).hidden = false;
  msg("");
});
$("btn-send-back").addEventListener("click", () => { ($("send-confirm") as HTMLElement).hidden = true; });
$("btn-send-confirm").addEventListener("click", async () => {
  const to = val("s-to").trim();
  const amt = Math.round(parseFloat(val("s-amt") || "0") * 1e8);
  try {
    busy("sending…"); const r = await call("send", to, amt, SEND_FEE);
    if (r.ok) {
      msg("sent " + (amt / 1e8) + " CSD · " + String(r.txid).slice(0, 12) + "…", "ok");
      ($("send-confirm") as HTMLElement).hidden = true;
      ($("s-to") as HTMLInputElement).value = ""; ($("s-amt") as HTMLInputElement).value = "";
      refreshBalance();
    } else msg("send failed: " + (r.error || "?"), "err");
  } catch (e: any) { msg(e.message, "err"); }
});
$("btn-post").addEventListener("click", async () => {
  const sel = ($("p-domain") as HTMLSelectElement).value;
  const domain = (sel === "__custom__" ? val("p-domain-custom").trim() : sel);
  if (!/^csd:[a-z0-9:_-]+$/i.test(domain)) return msg("pick a category or enter one like csd:tools", "err");
  if (!val("p-title").trim()) return msg("enter a title", "err");
  try {
    const fee = Math.max(Math.round(parseFloat(val("p-fee") || "0.25") * 1e8), 25000000);
    busy("posting…");
    const r = await call("cairnPost", { domain, title: val("p-title"), body: val("p-body"), fee });
    if (r.ok) { msg("posted · " + String(r.txid).slice(0, 12) + "… (shows on Cairn after ~1 block)", "ok"); refreshBalance(); }
    else msg("post failed: " + (r.error || "?"), "err");
  } catch (e: any) { msg(e.message, "err"); }
});

render();
if (EXT) setInterval(renderPending, 1500);
