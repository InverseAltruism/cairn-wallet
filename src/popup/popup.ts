// Popup UI controller. In the extension it messages the background service worker
// (which owns the keys); standalone (dev/E2E, no chrome.*) it drives a local Wallet
// against localStorage so the exact UI flows can be tested in a real browser.
import { Wallet, explorerLink, EXPLORER_PRESETS } from "../core/wallet.js";
import { localStore } from "../core/storage.js";
import { formatUnits, parseUnits, isPlainName } from "../core/cairnx.js";
import { nameCautionHtml, reresolveUnchanged, lookalikeOf, paidRecipients } from "./clearsign.js";

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
    case "cairnxAssets": return w.cairnxAssets();
    case "cairnxTokens": return w.cairnxTokens();
    case "cairnxTransfer": return w.cairnxTransfer(args[0]);
    case "resolveName": return w.resolveName(args[0]);
    case "verifyName": return w.verifyName(args[0]);
    case "cairnxNameRenew": return w.cairnxNameRenew(args[0]);
    case "cairnxSetPrimary": return w.cairnxSetPrimary(args[0]);
    case "setTradeApi": return w.setTradeApi(args[0]);
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
let currentExplorer = "cairn"; // selected block explorer (preset id or custom base) for activity/address links
let siteApi = "";   // the Cairn site base (for the /trade deep-link in the names list)
async function render() {
  const st = await call("status");
  currentRpc = st.rpc || "";
  currentExplorer = st.explorer || "cairn";
  siteApi = st.api || "";
  if (!st.hasVault) return show("setup");
  // On lock (manual or idle auto-lock), wipe any revealed private key / recovery phrase from the DOM and
  // module memory so a secret never lingers on the locked screen (audit POPUP-2).
  if (!st.unlocked) { resetRevealPanel(); resetPhrasePanel(); return show("locked"); }
  show("main");
  // Only HD wallets have a recovery phrase; hide the reveal button for imported keys.
  ($("btn-phrase") as HTMLElement).hidden = !st.hasMnemonic;
  renderAcctSelect(st.accounts || [], st.active || 0);
  $("addr").textContent = st.addr;
  if (st.addr) ($("addr-explorer") as HTMLAnchorElement).href = explorerLink(currentExplorer, "addr", st.addr);
  (($("set-api") as HTMLInputElement)).value = st.api;
  (($("set-tradeapi") as HTMLInputElement)).value = st.tradeApi || "";
  refreshBalance();
  renderAssets();
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

const TX_LABEL: Record<string, string> = { send: "Sent", propose: "Proposed", post: "Posted", support: "Supported", attest: "Supported", fillOffer: "Filled offer", tokenSend: "Sent token" };
async function renderHistory() {
  const h: any[] = await call("history");
  const el = $("history-list");
  if (!h.length) { el.innerHTML = `<div class="dim" style="padding:8px 0">No transactions yet. Send, post, or support something and it'll appear here.</div>`; return; }
  el.innerHTML = h.map((t) => {
    // token sends display the HUMAN token amount (decimals-aware), not base units as CSD
    const csd = t.type === "tokenSend"
      ? `${escapeHtml(String(t.human ?? t.amount ?? ""))} ${escapeHtml(String(t.ticker || ""))}`
      : ((Number(t.amount ?? t.fee ?? 0)) / 1e8).toLocaleString(undefined, { maximumFractionDigits: 4 }) + " CSD";
    const kind = TX_LABEL[t.type] || t.type;
    const detail = (t.type === "send" || t.type === "fillOffer" || t.type === "tokenSend") ? `to ${escapeHtml(String(t.to || "").slice(0, 12))}…`
      : t.title ? escapeHtml(String(t.title).slice(0, 28))
      : t.domain ? escapeHtml(String(t.domain))
      : t.target ? `${escapeHtml(String(t.target).slice(0, 12))}…` : "";
    const when = t.ts ? new Date(t.ts).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "";
    return `<div class="tx">
      <div class="tx-top"><span class="tx-kind">${kind}</span><span class="tx-amt">${csd}</span></div>
      <div class="tx-sub"><span class="dim">${detail}</span><a href="${escapeHtml(explorerLink(currentExplorer, "tx", String(t.txid)))}" target="_blank" rel="noopener noreferrer">${escapeHtml(String(t.txid).slice(0, 10))}… ↗</a></div>
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
// ── CairnX assets (token balances + .csd names) — read-only, never blocks the CSD UI ──
// Balances come from the public CairnX resolver API. When it's unreachable we show a
// single quiet retry line (and nothing else); the CSD balance above is untouched.
let tokensCache: Record<string, { decimals: number; name?: string }> | null = null; // per-popup
async function tokenMeta(): Promise<Record<string, { decimals: number; name?: string }>> {
  if (tokensCache) return tokensCache;
  const r = await call("cairnxTokens").catch(() => ({ ok: false }));
  const m: Record<string, { decimals: number; name?: string }> = {};
  if (r?.ok) for (const t of r.tokens || []) if (t && typeof t.ticker === "string") m[t.ticker] = { decimals: Number(t.decimals) || 0, name: t.name };
  if (r?.ok) tokensCache = m;
  return m;
}
// Show the primary .csd name as the account identity (server round-trip-verified — owner===addr===you).
function setIdentity(name: string | null | undefined) {
  const el = document.getElementById("primary-name");
  if (!el) return;
  if (name) { el.textContent = `${name}.csd`; (el as HTMLElement).hidden = false; }
  else { el.textContent = ""; (el as HTMLElement).hidden = true; }
}
// epochs ≈ hours → a short remaining-time label for a lease
function leaseLabel(n: any): string {
  if (n?.lapsed) return "lapsed";
  if (!n?.leased) return "";
  if (n.inGrace) return "in grace · renew now";
  const e = Number(n.epochsLeft ?? 0);   // epochs ≈ hours; 720 ≈ 1 month, 8760 ≈ 1 year
  if (e <= 0) return "expiring";
  return "expires " + (e < 48 ? `~${e}h` : e < 1440 ? `~${Math.round(e / 24)}d` : e < 8760 ? `~${Math.round(e / 720)}mo` : `~${(e / 8760).toFixed(1)}y`);
}
function tradeNameUrl(name: string): string {
  const base = (siteApi || "https://cairn-substrate.com").replace(/\/$/, "");
  return `${base}/trade?name=${encodeURIComponent(name)}`;
}
async function renderAssets() {
  const el = $("assets") as HTMLElement;
  const a = await call("cairnxAssets").catch(() => ({ ok: false }));
  setIdentity(a?.ok ? a.primaryName : null);
  if (!a?.ok) {
    el.hidden = false;
    el.innerHTML = `<div class="assets-retry dim">token balances unavailable · <a id="assets-retry">retry</a></div>`;
    const rt = document.getElementById("assets-retry");
    if (rt) rt.onclick = () => { el.innerHTML = `<div class="assets-retry dim">retrying…</div>`; renderAssets(); };
    return;
  }
  const balances: Record<string, { available: string; locked: string }> = a.balances || {};
  const names: string[] = a.names || [];
  const details: any[] = Array.isArray(a.nameDetails) && a.nameDetails.length ? a.nameDetails : names.map((n) => ({ name: n }));
  const primary: string | null = a.primaryName ?? null;
  const tickers = Object.keys(balances).sort();
  if (!tickers.length && !details.length) { el.hidden = true; el.innerHTML = ""; return; }
  const meta = await tokenMeta();
  const rows = tickers.map((t) => {
    const b = balances[t] || { available: "0", locked: "0" };
    const dec = meta[t]?.decimals ?? 0;
    const locked = b.locked && b.locked !== "0" ? ` <span class="asset-locked">(+${escapeHtml(formatUnits(b.locked, dec))} locked)</span>` : "";
    return `<div class="asset"><span class="asset-ticker">${escapeHtml(t)}</span>
      <span class="asset-bal">${escapeHtml(formatUnits(b.available, dec))}${locked}</span>
      <button class="mini" data-tsend="${escapeHtml(t)}">send</button></div>`;
  }).join("");
  // .csd names: identity + lease state + inline renew / set-primary + manage on /trade
  const nameRows = details.length ? `<div class="names-head"><span class="label">.csd names</span></div>` + details.map((n) => {
    const nm = String(n.name);
    const isPrimary = nm === primary;
    const lease = leaseLabel(n);
    const cls = n.lapsed ? " lapsed" : n.inGrace ? " grace" : "";
    const acts = n.lapsed
      ? `<a class="mini" href="${escapeHtml(tradeNameUrl(nm))}" target="_blank" rel="noopener noreferrer">recapture ↗</a>`
      : `<button class="mini" data-nrenew="${escapeHtml(nm)}">renew</button>${isPrimary ? "" : `<button class="mini" data-nprimary="${escapeHtml(nm)}">★ primary</button>`}<a class="mini" href="${escapeHtml(tradeNameUrl(nm))}" target="_blank" rel="noopener noreferrer">⋯</a>`;
    return `<div class="name-asset${cls}">
      <span class="na-name">${escapeHtml(nm)}<span class="dim">.csd</span>${isPrimary ? ` <span class="na-tag">★ primary</span>` : ""}</span>
      <span class="na-lease dim">${escapeHtml(lease)}</span>
      <span class="na-acts">${acts}</span></div>`;
  }).join("") : "";
  el.hidden = false;
  el.innerHTML = `<span class="label">assets</span>${rows}${nameRows}`;
  el.querySelectorAll<HTMLElement>("[data-tsend]").forEach((b) => b.onclick = () => {
    const t = b.dataset.tsend!;
    openTokenSend(t, meta[t]?.decimals ?? 0, balances[t]?.available ?? "0");
  });
  el.querySelectorAll<HTMLElement>("[data-nrenew]").forEach((b) => b.onclick = () => confirmNameAction("renew", b.dataset.nrenew!));
  el.querySelectorAll<HTMLElement>("[data-nprimary]").forEach((b) => b.onclick = () => confirmNameAction("primary", b.dataset.nprimary!));
}

// Two-click confirm (the popup has no modal): first click arms + shows the cost, second runs it.
let pendingNameAct: { kind: string; name: string } | null = null;
async function confirmNameAction(kind: "renew" | "primary", name: string) {
  if (pendingNameAct && pendingNameAct.kind === kind && pendingNameAct.name === name) { pendingNameAct = null; return doNameAction(kind, name); }
  pendingNameAct = { kind, name };
  // v1.8: the renewal fee is height-gated, so the background prices it at the CURRENT tip — the same fee
  // cairnxNameRenew will sign (WL-V18-1: never display the stale pre-V18 curve while signing the V18 fee).
  let cost = "0.25 CSD anchor";
  if (kind === "renew") {
    const feeBase = await call("cairnxNameRenewFee", name).then((v) => Number(v) || 0).catch(() => 0);
    cost = feeBase ? `${feeBase / 1e8} CSD + 0.25 anchor` : "fee + 0.25 anchor";
  }
  msg(`click again to confirm: ${kind === "renew" ? "renew" : "set primary for"} ${name}.csd (${cost})`, "info");
  setTimeout(() => { if (pendingNameAct && pendingNameAct.name === name && pendingNameAct.kind === kind) pendingNameAct = null; }, 6000);
}
async function doNameAction(kind: "renew" | "primary", name: string) {
  try {
    busy(kind === "renew" ? `renewing ${name}.csd…` : `setting ${name}.csd as primary…`);
    const r = await call(kind === "renew" ? "cairnxNameRenew" : "cairnxSetPrimary", name);
    if (r.ok) { msg(`${kind === "renew" ? "renewed" : "set primary"}: ${name}.csd · ${String(r.txid).slice(0, 12)}… (settles ~1 block)`, "ok"); refreshBalance(); renderAssets(); }
    else msg(`${kind === "renew" ? "renew" : "set primary"} failed: ${r.error || "?"}`, "err");
  } catch (e: any) { msg(e.message, "err"); }
}

// Resolve a send recipient: a 0x… address as-is, or a .csd name (nset addr else owner; refuse lapsed).
const looksLikeName = (s: string) => /\.csd$/i.test(s) || isPlainName(s.toLowerCase()); // L10: single-sourced NAME_RE
async function resolveRecipient(raw: string): Promise<{ ok: boolean; addr?: string; name?: string | null; label?: string | null; error?: string; verified?: boolean; sources?: number; agreed?: number; disagree?: boolean; viaFill?: boolean }> {
  const r = (raw || "").trim();
  if (/^0x[0-9a-fA-F]{40}$/.test(r)) return { ok: true, addr: r.toLowerCase(), name: null, label: null };
  if (looksLikeName(r)) {
    const nm = r.toLowerCase().replace(/\.csd$/, "");
    const res = await call("resolveName", nm).catch(() => ({ ok: false, error: "name lookup failed" }));
    // XREPO-1 cure: resolveName SPV-verifies the name → address against a PoW header chain the wallet checks
    // itself AND cross-checks ≥2 independent resolvers (NSPV-COMPLETE-1, doc 36). A fabricated redirect is
    // REFUSED here (res.ok === false). The send target is the chain-PROVEN union winner; the badge tells the
    // user how strong the confirmation is (2 independent sources / 1 source / a flagged disagreement).
    if (!res.ok) return { ok: false, error: res.error || `couldn't resolve ${nm}.csd` };
    const verified = res.verified === true;
    const viaFill = res.viaFill === true;
    const conf = res.depth ? ` (${res.depth} conf)` : "";
    const badge = !verified
      ? (viaFill ? "⚠ purchased name — can't be name-scope-proven, confirm the address" : "⚠ NOT chain-verified — confirm the address")
      : res.disagree ? `⚠ chain-backed but a name source DISAGREED — verify the address${conf}`
      : (res.sources ?? 1) >= 2 ? `✓ chain-backed by ${res.sources} independent sources${conf}`
      : `✓ chain-backed (1 source)${conf}`;
    return { ok: true, addr: res.addr, name: nm, verified, sources: res.sources, agreed: res.agreed, disagree: res.disagree, viaFill, label: `${nm}.csd → ${short(res.addr)} (via ${res.via ?? "owner"}) · ${badge}` };
  }
  return { ok: false, error: "enter a 0x… address or a name.csd" };
}
// XREPO-1 confirm-time guard wrapper: re-ask the name service at sign-time and REFUSE unless it still
// returns EXACTLY the reviewed address. Fail-closed on any error / network failure. The equality +
// shape check lives in clearsign.reresolveUnchanged (pure, unit-tested); this only wires the live call.
async function nameStillPointsTo(name: string, reviewed: string, reviewedVerified?: boolean): Promise<boolean> {
  const re = await call("resolveName", name).catch(() => ({ ok: false }));
  return reresolveUnchanged(reviewed, re, reviewedVerified); // L7: also refuses a verified→unverified regression
}
function setNameRow(rowId: string, valId: string, label: string | null | undefined) {
  const row = document.getElementById(rowId), v = document.getElementById(valId);
  if (!row || !v) return;
  if (label) { v.textContent = label; (row as HTMLElement).hidden = false; }
  else { v.textContent = ""; (row as HTMLElement).hidden = true; }
}

// ── send a CairnX token: recipient + amount → review (ticker/amount/to/fee) → sign ──
// The transfer record is built INSIDE the wallet (core/cairnx.ts) and anchored through
// the existing propose pipeline with the 0.25 CSD convention fee — no value outputs.
const CAIRNX_FEE = 25_000_000; // 0.25 CSD (anchor fee, paid in CSD)
let tsend: { ticker: string; decimals: number; available: string } | null = null;
// the reviewed-and-frozen send: set when the confirm panel opens, signed verbatim on confirm.
// `name` is the .csd name typed (if any) — re-resolved at confirm so it can't silently re-point.
let reviewed: { to: string; base: string; name?: string | null; verified?: boolean } | null = null;
// CSD-send reviewed snapshot (symmetry with token-send: sign exactly what was reviewed)
let reviewedSend: { to: string; amt: number; name?: string | null; verified?: boolean } | null = null;
function openTokenSend(ticker: string, decimals: number, available: string) {
  tsend = { ticker, decimals, available };
  // force-open (openPanel toggles; clicking send on a second token must keep it open)
  if (!openPanel("tsend-form")) ($("tsend-form") as HTMLElement).hidden = false;
  ($("ts-ticker") as HTMLElement).textContent = ticker;
  ($("ts-avail") as HTMLElement).textContent = `available: ${formatUnits(available, decimals)} ${ticker} · fee: 0.25 CSD`;
  ($("ts-to") as HTMLInputElement).value = ""; ($("ts-amt") as HTMLInputElement).value = "";
  ($("tsend-confirm") as HTMLElement).hidden = true;
  msg("");
}
$("btn-tsend").addEventListener("click", async () => {
  if (!tsend) return;
  const base = parseUnits(val("ts-amt").trim(), tsend.decimals);
  if (base === null || base === "0") return msg(tsend.decimals ? `enter an amount (up to ${tsend.decimals} decimal places)` : "enter a whole-number amount (this token has 0 decimals)", "err");
  const rr = await resolveRecipient(val("ts-to").trim());   // 0x… or alice.csd (refuse lapsed)
  if (!rr.ok) return msg(rr.error!, "err");
  const to = rr.addr!;
  setNameRow("tc-name-row", "tc-name", rr.label);
  // `available` comes from the (configurable) trade API — never let a hostile/garbled value
  // throw out of the handler and silently kill the send flow; treat unparseable as zero.
  let avail = 0n;
  try { avail = BigInt(tsend.available || "0"); } catch { avail = 0n; }
  if (BigInt(base) > avail) return msg(`amount exceeds your available ${tsend.ticker} balance (${formatUnits(tsend.available, tsend.decimals)})`, "err");
  // same first-time / address-poisoning checks as a CSD send — token sends are just as irreversible
  let firstTime = true, lookalike: string | null = null;
  try {
    const h: any[] = await call("history");
    const sentTo = paidRecipients(h); // single-sourced paid-recipient set (audit NSPV-POISON-FILTERS)
    firstTime = !sentTo.some((a) => a.toLowerCase() === to.toLowerCase());
    const st = await call("status");
    lookalike = lookalikeOf(to, [...sentTo, ...((st.accounts || []).map((a: any) => a.addr))]);
  } catch { /* no history → treat as first time */ }
  $("tc-ticker").textContent = tsend.ticker;
  $("tc-to").textContent = to.toLowerCase();              // FULL address, as it will appear in the signed record
  $("tc-amt").textContent = `${formatUnits(base, tsend.decimals)} ${tsend.ticker}`;
  $("tc-fee").textContent = (CAIRNX_FEE / 1e8) + " CSD";
  const warnEl = $("tc-warn") as HTMLElement;
  // A .csd token send ALWAYS carries the name-service-trust caution (XREPO-1), same as a CSD send.
  const nameCaution = rr.name ? nameCautionHtml(rr.name, rr.verified, { sources: rr.sources, agreed: rr.agreed, disagree: rr.disagree, viaFill: rr.viaFill }) : "";
  if (lookalike) { warnEl.innerHTML = `${nameCaution ? nameCaution + "<br><br>" : ""}⚠ <b>Possible address-poisoning.</b> This looks like <code>${escapeHtml(lookalike.slice(0, 10))}…${escapeHtml(lookalike.slice(-6))}</code> you've seen before but is NOT the same address. Verify every character — transfers are irreversible.`; warnEl.hidden = false; }
  else if (firstTime) { warnEl.innerHTML = `${nameCaution ? nameCaution + "<br><br>" : ""}⚠ First time sending to this address — check every character. Transfers are irreversible.`; warnEl.hidden = false; }
  else if (nameCaution) { warnEl.innerHTML = nameCaution; warnEl.hidden = false; }
  else warnEl.hidden = true;
  // SNAPSHOT what was reviewed — the confirm step signs EXACTLY this, never the live inputs
  // (editing the form after "Review" must not let displayed values diverge from signed ones)
  reviewed = { to, base, name: rr.name ?? null, verified: rr.verified }; // snapshot verified for the L7 confirm-time regression check
  ($("ts-to") as HTMLInputElement).disabled = true;
  ($("ts-amt") as HTMLInputElement).disabled = true;
  ($("tsend-confirm") as HTMLElement).hidden = false;
  msg("");
});
$("btn-tsend-back").addEventListener("click", () => {
  ($("tsend-confirm") as HTMLElement).hidden = true;
  reviewed = null;
  ($("ts-to") as HTMLInputElement).disabled = false;
  ($("ts-amt") as HTMLInputElement).disabled = false;
});
$("btn-tsend-confirm").addEventListener("click", async () => {
  if (!tsend || !reviewed) return;
  const { to, base, name, verified } = reviewed;
  // re-resolve the name at sign-time and refuse if it now points somewhere else (XREPO-1) or its
  // chain-verification regressed since review (L7).
  if (name && !(await nameStillPointsTo(name, to, verified))) return msg(`${name}.csd changed where it points — review again`, "err");
  try {
    busy("sending…");
    const r = await call("cairnxTransfer", { ticker: tsend.ticker, amount: base, to, decimals: tsend.decimals, fee: CAIRNX_FEE });
    if (r.ok) {
      msg(`sent ${formatUnits(base, tsend.decimals)} ${tsend.ticker} · ${String(r.txid).slice(0, 12)}… (settles after ~1 block)`, "ok");
      ($("tsend-confirm") as HTMLElement).hidden = true;
      reviewed = null;
      ($("ts-to") as HTMLInputElement).disabled = false;
      ($("ts-amt") as HTMLInputElement).disabled = false;
      ($("ts-to") as HTMLInputElement).value = ""; ($("ts-amt") as HTMLInputElement).value = "";
      refreshBalance(); renderAssets();
    } else msg("send failed: " + (r.error || "?"), "err");
  } catch (e: any) { msg(e.message, "err"); }
});

async function renderPending() {
  if (!EXT) return;
  const p = await call("pending"); const el = $("pending") as HTMLElement;
  if (!p.length) { el.hidden = true; el.innerHTML = ""; return; }
  el.hidden = false;
  // The toolbar popup NEVER approves a request inline — approving a fund-moving send/propose/
  // attest requires the full clear-signing window (recipient, amount, fee, balance-after,
  // first-time/poisoning/large-fee warnings). "Review & approve" opens that window; Reject is
  // safe to do blind. This keeps a single, fully-disclosed approval path.
  const pluralReview = p.length > 1 ? `Review ${p.length} requests` : "Review & approve";
  el.innerHTML =
    p.map((r: any) => `<div class="req"><b>${escapeHtml(String(r.method))}</b> from ${escapeHtml(String(r.origin))}</div>`).join("") +
    `<div class="row"><button data-review="1" class="primary">${escapeHtml(pluralReview)}</button>` +
    p.map((r: any) => `<button data-rj="${escapeHtml(String(r.id))}">Reject ${escapeHtml(String(r.method))}</button>`).join("") +
    `</div>`;
  const reviewBtn = el.querySelector<HTMLElement>("[data-review]");
  if (reviewBtn) reviewBtn.onclick = async () => { await call("openApproval"); window.close(); };
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
$("btn-copy-seed").addEventListener("click", () => { navigator.clipboard?.writeText(backupPhrase)?.catch(() => {}); flashBtn("btn-copy-seed", "copied ✓"); });
$("btn-copy-priv").addEventListener("click", () => { navigator.clipboard?.writeText(backupPriv)?.catch(() => {}); flashBtn("btn-copy-priv", "copied ✓"); });
($("ack-backup") as HTMLInputElement).addEventListener("change", (e) => { ($("btn-backup-done") as HTMLButtonElement).disabled = !(e.target as HTMLInputElement).checked; });
$("btn-backup-done").addEventListener("click", () => { backupPhrase = ""; backupPriv = ""; $("seed-words").innerHTML = ""; $("backup-priv").textContent = ""; msg("wallet ready", "ok"); render(); });
$("btn-import").addEventListener("click", async () => { try { if (!val("import-pw")) return msg("enter a password to encrypt the key", "err"); await call("import", val("import-key").trim(), val("import-pw")); msg("key imported", "ok"); render(); } catch (e: any) { msg(e.message, "err"); } });
$("btn-unlock").addEventListener("click", async () => { try { await call("unlock", val("unlock-pw")); msg("unlocked", "ok"); render(); } catch (e: any) { msg(e.message, "err"); } });
$("btn-lock").addEventListener("click", async () => { await call("lock"); msg("locked"); render(); });
$("btn-refresh").addEventListener("click", () => { refreshBalance(); renderAssets(); });
$("btn-copy").addEventListener("click", () => { navigator.clipboard?.writeText($("addr").textContent || "")?.catch(() => {}); flashBtn("btn-copy", "copied ✓"); });
// ── accordion: at most ONE action panel open at a time ──────────────────────
// All the collapsible panels under the main view. Opening one closes the rest;
// clicking the same trigger again closes it. Secret panels are wiped on every switch.
const PANELS = ["accts-panel", "send-form", "tsend-form", "post-form", "seal-form", "activity", "reveal-panel", "phrase-panel", "settings"];
let revealedKey = "", revealedPhrase = "";
// Best-effort clipboard hygiene for a copied key/phrase (audit KEY-6): when the reveal panel closes
// (switch/close/popup-unload), clear the clipboard IFF it still holds the secret we copied — so we never
// clobber unrelated clipboard content. Wrapped so a clipboard-permission error can never break a flow.
let copiedSecret = "";
function clearCopiedSecret() {
  const s = copiedSecret; copiedSecret = "";
  if (!s) return;
  try { navigator.clipboard?.readText?.().then((c) => { if (c === s) navigator.clipboard?.writeText("").catch(() => {}); }).catch(() => {}); } catch { /* clipboard unavailable */ }
}
function resetRevealPanel() {
  clearCopiedSecret();
  revealedKey = ""; const o = $("reveal-out"); o.textContent = ""; o.classList.remove("shown"); (o as HTMLElement).hidden = true;
  ($("reveal-actions") as HTMLElement).hidden = true; ($("reveal-pw") as HTMLInputElement).value = "";
}
function resetPhrasePanel() {
  clearCopiedSecret();
  revealedPhrase = ""; const o = $("phrase-out"); o.innerHTML = ""; o.classList.remove("shown"); o.classList.add("blur"); (o as HTMLElement).hidden = true;
  ($("phrase-actions") as HTMLElement).hidden = true; ($("phrase-pw") as HTMLInputElement).value = "";
}
// Show `id` and hide every other panel; returns true if it ended up OPEN. Wipes any
// revealed secret so a key/phrase never lingers behind a now-hidden panel.
function openPanel(id: string): boolean {
  const willOpen = ($(id) as HTMLElement).hidden;
  for (const p of PANELS) ($(p) as HTMLElement).hidden = true;
  ($("send-confirm") as HTMLElement).hidden = true;
  ($("tsend-confirm") as HTMLElement).hidden = true;
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
$("btn-reveal-copy").addEventListener("click", () => { navigator.clipboard?.writeText(revealedKey)?.catch(() => {}); copiedSecret = revealedKey; flashBtn("btn-reveal-copy", "copied ✓ (auto-clears)"); });
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
$("btn-phrase-copy").addEventListener("click", () => { navigator.clipboard?.writeText(revealedPhrase)?.catch(() => {}); copiedSecret = revealedPhrase; flashBtn("btn-phrase-copy", "copied ✓ (auto-clears)"); });
$("btn-phrase-close").addEventListener("click", () => { resetPhrasePanel(); ($("phrase-panel") as HTMLElement).hidden = true; });
$("btn-settings").addEventListener("click", () => { if (openPanel("settings")) renderConnectedSites(); });

// Connected sites: list the origins the user has granted address-visibility to, each
// with an instant Revoke. Revoking means that origin must prompt again on its next
// connect(). (Signing was never silent, so revoking doesn't affect fund safety.)
async function renderConnectedSites() {
  const el = $("connected-sites");
  let sites: { origin: string; addr: string; ts: number }[] = [];
  try { sites = await call("connectedSites"); } catch { /* ignore */ }
  if (!sites.length) { el.innerHTML = `<div class="dim" style="padding:6px 0">No connected sites yet.</div>`; return; }
  el.innerHTML = sites.map((s) =>
    `<div class="row" style="justify-content:space-between;align-items:center;gap:8px">`
    + `<code class="addr" title="${escapeHtml(s.origin)}">${escapeHtml(s.origin)}</code>`
    + `<button class="mini" data-disconnect="${escapeHtml(s.origin)}">disconnect</button></div>`
  ).join("");
  el.querySelectorAll<HTMLElement>("[data-disconnect]").forEach((b) => b.onclick = async () => {
    try { await call("disconnectSite", b.dataset.disconnect); } catch { /* ignore */ }
    renderConnectedSites();
  });
}
// Turn an RPC/API base URL into an MV3 host-match pattern ("https://host:port/*").
// Returns null for the URLs already in the static host_permissions (so we don't
// pointlessly re-request) or anything unparseable.
function originPattern(u: string): string | null {
  try {
    const url = new URL(u);
    const host = url.host; // includes :port if present
    if (host === "cairn-substrate.com" || host === "127.0.0.1:8789") return null;
    return `${url.protocol}//${host}/*`;
  } catch { return null; }
}
// Request host access for a custom RPC/API origin, scoped to that EXACT origin (never a
// broad pattern). `optional_host_permissions` is deliberately narrowed to local nodes
// (localhost / 127.0.0.1) — the default Cairn proxy is a required host_permission, so the
// common cases need no grant. A REMOTE custom https host is not in the optional set, so
// chrome.permissions.request rejects it (caught → false) and Settings shows "host access
// denied: use a local node or the Cairn proxy". This keeps least-privilege (no all-https
// grant / Web-Store red flag); remote custom RPC is a documented power-user limitation.
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
  const tradeApi = val("set-tradeapi").trim();
  const granted = await ensureHostAccess(tradeApi ? [api, tradeApi] : [api]);
  if (!granted) return msg("not saved — host access denied (the wallet can't reach an API it has no permission for)", "err");
  await call("setApi", api);
  await call("setTradeApi", tradeApi);
  tokensCache = null; // re-read token metadata from the new endpoint
  msg("settings saved", "ok"); render();
});

// ── RPC dropdown (header) — preset + user-added nodes, switch with one click ──
const RPC_PRESETS = [
  { label: "Cairn proxy", url: "https://cairn-substrate.com/api/rpc" },
  { label: "Local node", url: "http://127.0.0.1:8789" },
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

// ── Explorer dropdown (header, left of RPC) — choose the block explorer for activity/address links ──
// Navigation-only: switching it changes where ↗ links point; it never grants fetch/host access (no ensureHostAccess).
async function renderExplorerMenu() {
  const menu = $("explorer-menu");
  const customs: string[] = await call("explorerList").catch(() => []);
  const sel = (v: string) => v === currentExplorer;
  const row = (val: string, label: string, hint: string, removable: boolean) => `
    <div class="rpc-row${sel(val) ? " active" : ""}">
      <button class="rpc-pick" data-exp="${escapeHtml(val)}">${sel(val) ? "● " : ""}<span class="rpc-label">${escapeHtml(label)}</span><span class="rpc-url">${escapeHtml(hint)}</span></button>
      ${removable ? `<button class="rpc-del mini" data-delexp="${escapeHtml(val)}" title="remove">×</button>` : ""}
    </div>`;
  menu.innerHTML = EXPLORER_PRESETS.map((p) => row(p.id, p.label, p.base.replace(/^https?:\/\//, ""), false)).join("")
    + customs.map((u) => row(u, "Custom", u.replace(/^https?:\/\//, ""), true)).join("")
    + `<div class="rpc-add"><input id="exp-add-input" placeholder="https://your-explorer…" /><button id="exp-add-btn" class="mini">add</button></div>`;
  menu.querySelectorAll<HTMLElement>("[data-exp]").forEach((b) => b.onclick = () => selectExplorer(b.dataset.exp!));
  menu.querySelectorAll<HTMLElement>("[data-delexp]").forEach((b) => b.onclick = async (e) => { e.stopPropagation(); await call("removeExplorer", b.dataset.delexp); renderExplorerMenu(); });
  ($("exp-add-btn") as HTMLElement).onclick = async () => {
    const u = (($("exp-add-input") as HTMLInputElement).value || "").trim();
    if (!/^https?:\/\/.+/.test(u)) return msg("enter a full explorer URL (https://…)", "err");
    try { await call("addExplorer", u); await selectExplorer(u); } catch (e: any) { msg(e.message, "err"); }
  };
}
async function selectExplorer(v: string) {
  try { await call("setExplorer", v); } catch (e: any) { return msg(e.message, "err"); }
  ($("explorer-menu") as HTMLElement).hidden = true;
  msg("Explorer: " + (EXPLORER_PRESETS.find((p) => p.id === v)?.label || v.replace(/^https?:\/\//, "")), "ok"); render();
}
$("btn-explorer").addEventListener("click", () => { const m = $("explorer-menu") as HTMLElement; if (m.hidden) { renderExplorerMenu(); m.hidden = false; } else m.hidden = true; });

// click-away: close each header dropdown when the click is outside BOTH its button and its menu
document.addEventListener("click", (e) => {
  const t = e.target as HTMLElement;
  for (const [btnId, menuId] of [["btn-rpc", "rpc-menu"], ["btn-explorer", "explorer-menu"]]) {
    const m = document.getElementById(menuId), b = document.getElementById(btnId);
    if (m && !m.hidden && b && !m.contains(t) && !b.contains(t)) m.hidden = true;
  }
});

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
      ? `<a href="${escapeHtml(explorerLink(currentExplorer, "tx", String(s.txid)))}" target="_blank" rel="noopener noreferrer">${String(s.txid).slice(0, 10)}… ↗</a>`
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
// lookalikeOf (the address-poisoning heuristic) is imported from ./clearsign.js — one definition,
// so a tuning change can't land in only one of two copies of a security check.
// Two-step send: "Review" shows a confirmation with the FULL recipient address,
// amount, fee, and projected balance-after (defends against address-poisoning /
// clipboard-swap — the user verifies exactly what will be signed), warns on a
// never-seen-before recipient, and hard-flags a poisoning lookalike.
const SEND_FEE = 1_000_000; // 0.01 CSD
$("btn-send").addEventListener("click", async () => {
  const raw = val("s-to").trim();
  // Strict base-unit parse (audit AMT-1): the lax Math.round(parseFloat()) accepted "1e3" (→1000 CSD),
  // "1,000" (→1), "1abc", "+1", ".5" and half-sat rounding — so the signed amount could differ from what
  // the user typed/saw. parseUnits enforces /^\d+(\.\d{0,8})?$/ and exact base-unit conversion (same path
  // the token send already uses), so a malformed amount is rejected up front instead of silently coerced.
  const amtStr = parseUnits(val("s-amt").trim(), 8);
  if (amtStr === null || amtStr === "0") return msg("enter a valid amount (up to 8 decimal places)", "err");
  const amt = Number(amtStr);
  if (!Number.isSafeInteger(amt) || amt <= 0) return msg("amount out of range", "err");
  const rr = await resolveRecipient(raw);   // 0x… as-is, or alice.csd → resolved address (refuse lapsed)
  if (!rr.ok) return msg(rr.error!, "err");
  const to = rr.addr!;
  setNameRow("c-name-row", "c-name", rr.label);
  let firstTime = true, known: string[] = [], lookalike: string | null = null, after = "";
  try {
    const h: any[] = await call("history");
    const sentTo = paidRecipients(h); // single-sourced paid-recipient set (audit NSPV-POISON-FILTERS)
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
  // A .csd send ALWAYS carries the name-service-trust caution (XREPO-1), regardless of first-time /
  // look-alike status — verifying the resolved address is the whole defense the wallet can offer here.
  const nameCaution = rr.name ? nameCautionHtml(rr.name, rr.verified, { sources: rr.sources, agreed: rr.agreed, disagree: rr.disagree, viaFill: rr.viaFill }) : "";
  if (lookalike) { warnEl.innerHTML = `${nameCaution ? nameCaution + "<br><br>" : ""}⚠ <b>Possible address-poisoning.</b> This looks like <code>${escapeHtml(lookalike.slice(0, 10))}…${escapeHtml(lookalike.slice(-6))}</code> you've seen before but is NOT the same address. Verify every character — payments are irreversible.`; warnEl.hidden = false; }
  else if (firstTime) { warnEl.innerHTML = `${nameCaution ? nameCaution + "<br><br>" : ""}⚠ First time sending to this address — check every character. Payments are irreversible.`; warnEl.hidden = false; }
  else if (nameCaution) { warnEl.innerHTML = nameCaution; warnEl.hidden = false; }
  else warnEl.hidden = true;
  // freeze the reviewed values; confirm signs THIS, not the live (still-visible) inputs
  reviewedSend = { to, amt, name: rr.name ?? null, verified: rr.verified }; // snapshot verified for the L7 confirm-time regression check
  ($("s-to") as HTMLInputElement).disabled = true;
  ($("s-amt") as HTMLInputElement).disabled = true;
  ($("send-confirm") as HTMLElement).hidden = false;
  msg("");
});
$("btn-send-back").addEventListener("click", () => {
  ($("send-confirm") as HTMLElement).hidden = true;
  reviewedSend = null;
  ($("s-to") as HTMLInputElement).disabled = false;
  ($("s-amt") as HTMLInputElement).disabled = false;
});
$("btn-send-confirm").addEventListener("click", async () => {
  if (!reviewedSend) return;
  const { to, amt, name, verified } = reviewedSend;
  // a name recipient is re-resolved at sign-time: refuse if it now points somewhere else (XREPO-1) or if its
  // chain-verification regressed since review (L7) — fail-closed to a re-review either way.
  if (name && !(await nameStillPointsTo(name, to, verified))) return msg(`${name}.csd changed where it points — review again`, "err");
  try {
    busy("sending…"); const r = await call("send", to, amt, SEND_FEE);
    if (r.ok) {
      msg("sent " + (amt / 1e8) + " CSD · " + String(r.txid).slice(0, 12) + "…", "ok");
      ($("send-confirm") as HTMLElement).hidden = true;
      reviewedSend = null;
      ($("s-to") as HTMLInputElement).disabled = false; ($("s-amt") as HTMLInputElement).disabled = false;
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
    const feeStr = parseUnits((val("p-fee").trim() || "0.25"), 8); // strict parse (audit AMT-1) — no "1e3"/"1,000"/half-sat
    if (feeStr === null) return msg("enter a valid fee (e.g. 0.25)", "err");
    const feeNum = Number(feeStr);
    if (!Number.isSafeInteger(feeNum)) return msg("fee out of range", "err"); // parity with the send-amount path (safe-integer backstop)
    const fee = Math.max(feeNum, 25000000);
    busy("posting…");
    const r = await call("cairnPost", { domain, title: val("p-title"), body: val("p-body"), fee });
    if (r.ok) { msg("posted · " + String(r.txid).slice(0, 12) + "… (shows on Cairn after ~1 block)", "ok"); refreshBalance(); }
    else msg("post failed: " + (r.error || "?"), "err");
  } catch (e: any) { msg(e.message, "err"); }
});

render();
if (EXT) setInterval(renderPending, 1500);
// Clear a copied secret from the clipboard when the popup closes (audit KEY-6, best-effort).
window.addEventListener("beforeunload", clearCopiedSecret);
