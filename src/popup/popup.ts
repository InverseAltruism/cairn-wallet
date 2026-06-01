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

async function render() {
  const st = await call("status");
  $("net").textContent = (st.rpc || "").replace(/^https?:\/\//, "");
  if (!st.hasVault) return show("setup");
  if (!st.unlocked) return show("locked");
  show("main");
  // Only HD wallets have a recovery phrase; hide the reveal button for imported keys.
  ($("btn-phrase") as HTMLElement).hidden = !st.hasMnemonic;
  renderAcctSelect(st.accounts || [], st.active || 0);
  $("addr").textContent = st.addr;
  if (st.addr) ($("addr-explorer") as HTMLAnchorElement).href = explorerAddr(st.addr);
  (($("set-rpc") as HTMLInputElement)).value = st.rpc;
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
async function renderAccts() {
  const st = await call("status");
  const el = $("accts-list");
  el.innerHTML = (st.accounts || []).map((a: any, i: number) => `<div class="tx">
      <div class="tx-top"><span class="tx-kind">${i === st.active ? "● " : ""}${escapeHtml(a.label)}</span>
        <span class="row" style="gap:6px">
          <button class="mini" data-rename="${escapeHtml(a.addr)}">rename</button>
          ${(st.accounts.length > 1) ? `<button class="mini" data-remove="${escapeHtml(a.addr)}">remove</button>` : ""}
        </span></div>
      <div class="tx-sub"><span class="dim mono">${escapeHtml(a.addr)}</span></div>
    </div>`).join("");
  el.querySelectorAll<HTMLElement>("[data-rename]").forEach((b) => b.onclick = async () => {
    const label = window.prompt("New label for this account:"); if (!label) return;
    try { await call("renameAccount", b.dataset.rename, label); renderAccts(); render(); } catch (e: any) { msg(e.message, "err"); }
  });
  el.querySelectorAll<HTMLElement>("[data-remove]").forEach((b) => b.onclick = async () => {
    if (!window.confirm("Remove this account from the wallet? Make sure you've backed up its key — this only forgets it locally.")) return;
    try { await call("removeAccount", b.dataset.remove); msg("account removed"); renderAccts(); render(); } catch (e: any) { msg(e.message, "err"); }
  });
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
  el.innerHTML = p.map((r: any) => `<div class="req"><b>${r.method}</b> from ${escapeHtml(String(r.origin))}</div><div class="row"><button data-ap="${r.id}" class="primary">Approve</button><button data-rj="${r.id}">Reject</button></div>`).join("");
  el.querySelectorAll<HTMLElement>("[data-ap]").forEach((b) => b.onclick = () => resolve(b.dataset.ap!, true));
  el.querySelectorAll<HTMLElement>("[data-rj]").forEach((b) => b.onclick = () => resolve(b.dataset.rj!, false));
}
async function resolve(id: string, ap: boolean) { await call("resolve", id, ap); msg(ap ? "approved" : "rejected"); renderPending(); }

// Render the 12 words into the backup screen and show it (after create / reveal).
let backupPhrase = "";
function showBackup(mnemonic: string) {
  backupPhrase = mnemonic;
  $("seed-words").innerHTML = mnemonic.split(" ").map((w, i) =>
    `<span class="seed-word"><span class="seed-n">${i + 1}</span>${escapeHtml(w)}</span>`).join("");
  ($("ack-backup") as HTMLInputElement).checked = false;
  ($("btn-backup-done") as HTMLButtonElement).disabled = true;
  show("backup");
}
$("btn-create").addEventListener("click", async () => { try { const pw = val("setup-pw"); if (!pw) return msg("enter a password", "err"); const r = await call("create", pw); ($("setup-pw") as HTMLInputElement).value = ""; showBackup(r.mnemonic); } catch (e: any) { msg(e.message, "err"); } });
$("btn-restore").addEventListener("click", async () => { try { const ph = val("restore-phrase").trim(); const pw = val("restore-pw"); if (!ph) return msg("enter your recovery phrase", "err"); if (!pw) return msg("enter a password to encrypt it", "err"); await call("restore", ph, pw); ($("restore-phrase") as HTMLTextAreaElement).value = ""; ($("restore-pw") as HTMLInputElement).value = ""; msg("wallet restored", "ok"); render(); } catch (e: any) { msg(e.message, "err"); } });
$("btn-copy-seed").addEventListener("click", () => { navigator.clipboard?.writeText(backupPhrase); flashBtn("btn-copy-seed", "copied ✓"); });
($("ack-backup") as HTMLInputElement).addEventListener("change", (e) => { ($("btn-backup-done") as HTMLButtonElement).disabled = !(e.target as HTMLInputElement).checked; });
$("btn-backup-done").addEventListener("click", () => { backupPhrase = ""; $("seed-words").innerHTML = ""; msg("wallet ready", "ok"); render(); });
$("btn-import").addEventListener("click", async () => { try { if (!val("import-pw")) return msg("enter a password to encrypt the key", "err"); await call("import", val("import-key").trim(), val("import-pw")); msg("key imported", "ok"); render(); } catch (e: any) { msg(e.message, "err"); } });
$("btn-unlock").addEventListener("click", async () => { try { await call("unlock", val("unlock-pw")); msg("unlocked", "ok"); render(); } catch (e: any) { msg(e.message, "err"); } });
$("btn-lock").addEventListener("click", async () => { await call("lock"); msg("locked"); render(); });
$("btn-refresh").addEventListener("click", refreshBalance);
$("btn-copy").addEventListener("click", () => { navigator.clipboard?.writeText($("addr").textContent || ""); flashBtn("btn-copy", "copied ✓"); });
$("btn-signin").addEventListener("click", async () => { try { busy("signing in…"); const r = await call("signin"); r.ok ? msg("signed in as " + r.addr, "ok") : msg("sign-in failed: " + (r.error || "?"), "err"); } catch (e: any) { msg(e.message, "err"); } });
$("btn-phrase").addEventListener("click", async () => { const pw = window.prompt("Re-enter your password to reveal your recovery phrase:"); if (!pw) return; try { const m = await call("exportMnemonic", pw); showBackup(m); } catch (e: any) { msg(e.message, "err"); } });
// In-popup private-key reveal (no window.prompt): password → masked secret box that
// you click to reveal, copy, then dismiss (clears it from the DOM).
let revealedKey = "";
$("btn-export").addEventListener("click", () => {
  const p = $("reveal-panel") as HTMLElement; p.hidden = !p.hidden;
  ($("reveal-pw") as HTMLInputElement).value = ""; ($("reveal-out") as HTMLElement).hidden = true; ($("reveal-actions") as HTMLElement).hidden = true; revealedKey = "";
});
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
$("btn-reveal-close").addEventListener("click", () => { revealedKey = ""; $("reveal-out").textContent = ""; ($("reveal-panel") as HTMLElement).hidden = true; });
$("btn-settings").addEventListener("click", () => { const s = $("settings") as HTMLElement; s.hidden = !s.hidden; });
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
  const rpc = val("set-rpc").trim(), api = val("set-api").trim();
  const granted = await ensureHostAccess([rpc, api]);
  if (!granted) return msg("settings not saved — host access denied (the wallet can't reach a node it has no permission for)", "err");
  await call("setRpc", rpc); await call("setApi", api); msg("settings saved", "ok"); render();
});

($("acct-select") as HTMLSelectElement).addEventListener("change", async (e) => {
  try { await call("switchAccount", Number((e.target as HTMLSelectElement).value)); msg("switched account", "ok"); render(); }
  catch (err: any) { msg(err.message, "err"); }
});
$("btn-accts").addEventListener("click", () => { const p = $("accts-panel") as HTMLElement; p.hidden = !p.hidden; if (!p.hidden) renderAccts(); });
$("btn-add-acct").addEventListener("click", async () => {
  try { const r = await call("addAccount"); msg("added " + (r.addr ? r.addr.slice(0, 10) + "…" : "account"), "ok"); render(); }
  catch (e: any) { msg(e.message, "err"); }
});
$("btn-imp-acct").addEventListener("click", async () => {
  const key = val("imp-acct-key").trim(); if (!key) return msg("paste a private key", "err");
  try { await call("importAccount", key, val("imp-acct-label").trim()); ($("imp-acct-key") as HTMLInputElement).value = ""; msg("account imported", "ok"); render(); }
  catch (e: any) { msg(e.message, "err"); }
});

const toggle = (id: string) => { const e = $(id) as HTMLElement; e.hidden = !e.hidden; };
$("btn-send-t").addEventListener("click", () => { toggle("send-form"); ($("send-confirm") as HTMLElement).hidden = true; });
$("btn-post-t").addEventListener("click", () => toggle("post-form"));
$("btn-activity-t").addEventListener("click", () => { toggle("activity"); if (!($("activity") as HTMLElement).hidden) renderHistory(); });
$("btn-seal-t").addEventListener("click", () => { toggle("seal-form"); if (!($("seal-form") as HTMLElement).hidden) renderSealed(); });
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
  try {
    const fee = Math.max(Math.round(parseFloat(val("p-fee") || "0.25") * 1e8), 25000000);
    busy("posting…");
    const r = await call("cairnPost", { domain: val("p-domain").trim(), title: val("p-title"), body: val("p-body"), fee });
    if (r.ok) { msg("posted · " + String(r.txid).slice(0, 12) + "… (shows on Cairn after ~1 block)", "ok"); refreshBalance(); }
    else msg("post failed: " + (r.error || "?"), "err");
  } catch (e: any) { msg(e.message, "err"); }
});

render();
if (EXT) setInterval(renderPending, 1500);
