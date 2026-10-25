// Popup UI controller. In the extension it messages the background service worker
// (which owns the keys); standalone (dev/E2E, no chrome.*) it drives a local Wallet
// against localStorage so the exact UI flows can be tested in a real browser.
import { explorerLink, EXPLORER_PRESETS } from "../core/explorer.js";
import { INCLUSION_NOTICE_BLOCKS, inclusionMark } from "../core/inclusion.js";
import { formatUnits, parseUnits, isPlainName, displayDecimals, isTokenDecimals, CAIRNX_PROPOSE_FEE } from "../core/cairnx.js";
import { nameCheck, NAME_SAFE_DEPTH, checkRow, type Check, reresolveUnchanged, recipientStatus, paidRecipients, escapeHtml, fmtCsd, fmtBalance, isZeroAddr, tokenAmountBothScales, balanceShortNote } from "./clearsign.js";
import { avatarGradient, monogram, identitySeed } from "./identicon.js";
import { drawQr } from "./qr/draw.js";
import { enterOnce, flashChange, tokenEase, tokenMs } from "./motion.js";
import { mountThemeControl } from "./themectl.js";
import type { CairnThemeApi } from "../vendor/cairn-ui/theme.js";

const chrome: any = (globalThis as any).chrome;
const EXT = !!(chrome?.runtime?.sendMessage);

// The background ran the method and it threw. The engine returns every outcome after a submit as a
// value (node.ts post() never throws; test/submit-outcome.test.mjs), so a method that threw submitted
// nothing. A broken channel (the service worker died mid-call) is the only ambiguous rejection.
class AnsweredError extends Error {}
async function call(method: string, ...args: any[]): Promise<any> {
  if (EXT) return new Promise((res, rej) => chrome.runtime.sendMessage({ kind: "popup", method, args }, (r: any) => {
    if (chrome.runtime.lastError) return rej(new Error(chrome.runtime.lastError.message));
    r?.ok ? res(r.result) : rej(new AnsweredError(r?.error || "error"));
  }));
  // Dev/E2E only: the Wallet class lives in a dynamically imported chunk so popup.js never
  // statically embeds it (MV3 isolation). The shim throws at load if chrome.runtime.sendMessage exists.
  const { runDevPopupMethod } = await import("./devshim.js");
  try { return await runDevPopupMethod(method, args); }
  catch (e: any) { throw new AnsweredError(String(e?.message ?? e)); }
}
// One reading of a submit outcome for every popup flow (send, token send, merge, name actions, post,
// seal): only SUBMIT_MAYBE_INFLIGHT and a broken channel may say "may already be in flight".
type Outcome = { text: string; cls: "err" | "info"; maybe: boolean };
const clause = (s: unknown): string => String(s).replace(/[.\s]+$/, "");
function inFlightCopy(prefix: string, what: string, txid?: string): Outcome {
  const where = txid ? ` It's in your history as ${String(txid).slice(0, 12)}…` : "";
  return { text: `${prefix}${prefix ? "The" : "the"} ${what} didn't confirm; it may already be in flight. Check your history before trying again.${where}`, cls: "err", maybe: true };
}
function refusedCopy(r: any, what: string): Outcome {
  if (r?.code === "SUBMIT_MAYBE_INFLIGHT") return inFlightCopy(r?.error ? clause(r.error) + ". " : "", what, r?.txid);
  if (r?.code === "SUBMIT_DUPLICATE") return { text: String(r?.error ?? "this transaction, or one spending the same coins, is already pending. Check your history once it is mined before sending again"), cls: "info", maybe: true };
  return { text: `${r?.error ? clause(r.error) : `the ${what} was refused`}. Nothing was sent.`, cls: "err", maybe: false };
}
function thrownCopy(e: any, what: string): Outcome {
  if (!(e instanceof AnsweredError)) return inFlightCopy(e?.message ? clause(e.message) + ". " : "", what);
  if (e.message === "locked") return { text: "the wallet locked before anything was signed. Nothing was sent. Unlock and try again.", cls: "err", maybe: false };
  return { text: `${clause(e.message)}. Nothing was sent.`, cls: "err", maybe: false };
}

const $ = (id: string) => document.getElementById(id)!;
const val = (id: string) => ($(id) as HTMLInputElement).value;
function show(view: string) { for (const v of ["setup", "backup", "locked", "main"]) ($("view-" + v) as HTMLElement).hidden = v !== view; }
// Status line with auto-dismiss: transient info/ok fades after ~3.5s, errors hold ~8s before
// fading (the outcome still lives in Activity/history). busy() cancels any pending fade.
let msgTimer: ReturnType<typeof setTimeout> | undefined;
let msgFadeTimer: ReturnType<typeof setTimeout> | undefined;
function msg(text: string, cls = "info") {
  const m = $("msg");
  clearTimeout(msgTimer); clearTimeout(msgFadeTimer);
  m.classList.remove("fade");
  m.textContent = text; m.className = "msg " + cls;
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
function msgAction(text: string, label: string, fn: () => void, cls = "err") {
  const m = $("msg");
  clearTimeout(msgTimer); clearTimeout(msgFadeTimer);
  m.classList.remove("fade");
  m.textContent = text + " ";
  m.className = "msg " + cls;
  const b = document.createElement("button");
  b.className = "mini";
  b.textContent = label;
  b.addEventListener("click", () => { msg(""); fn(); });
  m.appendChild(b);
}
// escapeHtml is imported from clearsign.ts - the hardened variant that ALSO neutralizes bidi/
// zero-width controls (WYSIWYS-BIDI-1). A plain 5-char escape lived here until 2026-07-06, so
// account labels/history were HTML-safe but not bidi-safe, silently weaker than the clear-sign
// surface. One implementation, one threat model.
// In-progress status with an animated spinner (for async actions). Never auto-fades: it is
// always replaced by the outcome message of the action that showed it.
function busy(text: string) {
  const m = $("msg");
  clearTimeout(msgTimer); clearTimeout(msgFadeTimer);
  m.classList.remove("fade");
  m.innerHTML = `<span class="spinner"></span>${escapeHtml(text)}`; m.className = "msg info";
}
// Brief visual confirmation on a button (e.g. copy).
function flashBtn(id: string, label: string, ok = true) { const b = $(id); const o = b.textContent; b.textContent = label; if (ok) b.classList.add("copied"); setTimeout(() => { b.textContent = o; b.classList.remove("copied"); }, 1100); }
// "copied" only once the clipboard write has resolved; a refused or missing clipboard says so instead.
async function copyText(btnId: string, text: string) {
  try {
    if (!navigator.clipboard?.writeText) throw new Error("no clipboard");
    await navigator.clipboard.writeText(text);
    flashBtn(btnId, "copied ✓");
  } catch {
    flashBtn(btnId, "copy failed", false);
    msg("could not copy to the clipboard. Select the text and copy it by hand.", "err");
  }
}
// Send-success moment: the balance settles once (popup.css `.bal-hero.sent`); display only, reduced-motion aware.
function celebrateSend() {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const hero = document.querySelector(".bal-hero") as HTMLElement | null;
  const dur = tokenMs("--ui-dur-4");
  if (!hero || dur === null) return;
  hero.classList.remove("sent"); void hero.offsetWidth; hero.classList.add("sent");
  setTimeout(() => hero.classList.remove("sent"), dur * 2);
}

let currentRpc = "";
let currentExplorer = "cairn"; // selected block explorer (preset id or custom base) for activity/address links
let siteApi = "";   // the Cairn site base (for the /trade deep-link in the names list)
// ── frozen review snapshots (WYSIWYS) ──────────────────────────────────────────────────────────
// ONE owner for every primed value-moving review: `reviewed` (token send; set when the confirm panel
// opens, signed verbatim on Confirm; `name` is the .csd name typed, re-resolved at confirm so it can't
// silently re-point), `reviewedSend` (CSD send; same symmetry: sign exactly what was reviewed), and
// `reviewedNameAct` (name renew / set-primary). The Confirm buttons sign EXACTLY these snapshots,
// never the live inputs. dropReviews() is the single teardown, used by clearSendDrafts (the lock
// boundary), closeAllPanels (any panel switch) and the flow handlers; panels are mutually exclusive
// via openPanel, so dropping all three is always equivalent to dropping the one that was armed.
const reviewState: {
  reviewed: { to: string; base: string; name?: string | null; verified?: boolean; signer?: string | null } | null;
  reviewedSend: { to: string; amt: number; name?: string | null; verified?: boolean; signer?: string | null } | null;
  reviewedNameAct: { kind: "renew" | "primary"; name: string; total: number; fee: number; signer?: string | null } | null;
} = { reviewed: null, reviewedSend: null, reviewedNameAct: null };
function dropReviews() { reviewState.reviewed = null; reviewState.reviewedSend = null; reviewState.reviewedNameAct = null; }
// Wipe any unsent recipient/amount draft on lock so it doesn't reappear pre-filled on the next unlock or
// popup reopen. The popup view-switches (it does not tear down) on lock, so input values otherwise persist;
// the browser can also restore them on reopen. Cleared here (alongside the secret-wipe) and via autocomplete=off.
function clearSendDrafts() {
  for (const id of ["s-to", "s-amt", "ts-to", "ts-amt"]) { const el = document.getElementById(id) as HTMLInputElement | null; if (el) { el.value = ""; el.disabled = false; } }
  // also tear down any FROZEN review (a primed Confirm panel must not survive the lock boundary, or a click on
  // unlock would sign the stale snapshot). Drop the snapshots + hide both confirm panels.
  dropReviews();
  for (const id of ["send-confirm", "tsend-confirm"]) { const el = document.getElementById(id); if (el) (el as HTMLElement).hidden = true; }
  { const el = document.getElementById("name-action-form"); if (el) (el as HTMLElement).hidden = true; }   // the name renew/primary review panel signs real CSD; never let a primed one survive a lock
}
async function render() {
  const st = await call("status");
  currentRpc = st.rpc || "";
  currentExplorer = st.explorer || "cairn";
  siteApi = st.api || "";
  if (st.rpcMovedFrom) showRpcMoved(String(st.rpcMovedFrom));
  if (!st.hasVault) return show("setup");
  // On lock (manual or idle auto-lock), wipe any revealed private key / recovery phrase from the DOM and
  // module memory so a secret never lingers on the locked screen (audit POPUP-2).
  if (!st.unlocked) { resetRevealPanel(); resetPhrasePanel(); clearSendDrafts(); return show("locked"); }
  show("main");
  syncNav();
  // Only HD wallets have a recovery phrase; hide the reveal button for imported keys.
  ($("btn-phrase") as HTMLElement).hidden = !st.hasMnemonic;
  renderAcctSelect(st.accounts || [], st.active || 0);
  $("addr").textContent = st.addr;
  if (st.addr !== curAddr) { curAddr = st.addr; clearSendDrafts(); invalidateAccountViews(); lastBal = null; paintAvatar(null, curAddr); } // new account: old rows inert, reset identity + balance tween base
  if (st.addr) ($("addr-explorer") as HTMLAnchorElement).href = explorerLink(currentExplorer, "addr", st.addr);
  (($("set-api") as HTMLInputElement)).value = st.api;
  (($("set-tradeapi") as HTMLInputElement)).value = st.tradeApi || "";
  refreshBalance();
  renderAssets();
  renderPending();
  // BP4/N11: warm the SPV light client now, off the click path, so a first fill/name-verify isn't slow.
  // Fire-and-forget; the wallet self-heals a failed warm on the real call.
  void call("prewarmSpv").catch(() => { /* best-effort */ });
  // keep open per-account panels in sync after a switch
  if (!($("activity") as HTMLElement).hidden) renderHistory();
  if (!($("seal-form") as HTMLElement).hidden) renderSealed();
  if (!($("accts-panel") as HTMLElement).hidden) renderAccts();
  if (!($("receive-panel") as HTMLElement).hidden) renderReceive();
}

const short = (a: string) => a && a.length > 14 ? a.slice(0, 8) + "…" + a.slice(-4) : a;
// Custom account switcher (same visual system as the Explorer/RPC dropdowns; the native
// <select> popup can't be styled and clashed with them). Each row carries the account's
// identity-gradient dot (avatarGradient output is numbers-only: injection-safe by construction).
function renderAcctSelect(accounts: { addr: string; label: string }[], active: number) {
  const a = accounts[active];
  $("acct-select").innerHTML = a
    ? `<span class="acct-cur">${escapeHtml(a.label)}</span><span class="acct-addr">${escapeHtml(short(a.addr))}</span><svg class="i acct-caret" aria-hidden="true"><use href="icons.svg#i-chevron-down"/></svg>`
    : "";
  const menu = $("acct-menu");
  menu.innerHTML = accounts.map((x, i) => `
    <div class="rpc-row${i === active ? " active" : ""}">
      <button class="rpc-pick" data-acct="${i}"${i === active ? ' aria-current="true"' : ""}><span class="acct-pick-line"><span class="acct-dot" style="background:${avatarGradient(identitySeed(null, x.addr))}"></span><span class="rpc-label">${escapeHtml(x.label)}</span></span><span class="rpc-url">${escapeHtml(short(x.addr))}</span></button>
    </div>`).join("");
  menu.querySelectorAll<HTMLElement>("[data-acct]").forEach((b) => (b.onclick = () => switchAcct(Number(b.dataset.acct))));
}
async function switchAcct(i: number) {
  ($("acct-menu") as HTMLElement).hidden = true;
  // WYSIWYS (R2-WYSIWYS / SIGN-3): tear down any primed send / name-action review BEFORE switching
  // accounts; a review under the old account must never be Confirmed under the new one. Every sheet closes too:
  // a name's detail lists the old account's names, and its actions must not reach a review under the new one.
  clearSendDrafts();
  closeAllPanels(); syncNav();
  invalidateAccountViews();   // before the await: the old account's rows go inert while the switch is in flight
  try { await call("switchAccount", i); msg("switched account", "ok"); render(); }
  catch (err: any) { msg(err.message, "err"); render(); }
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
    } else if (editing && a.imported) {
      // A2 (Plans/68 F4): an imported key is NOT in the recovery phrase; a one-click remove was
      // permanent fund loss. Removal is password-gated (the background enforces it; this UI collects
      // it) with the irreversibility spelled out. HD accounts below keep the frictionless yes/no.
      right = `<span class="row" style="gap:6px">
          <input class="acct-remove-pw" type="password" data-addr="${escapeHtml(a.addr)}" placeholder="wallet password" style="width:110px" />
          <button class="mini" data-confirm-remove="${escapeHtml(a.addr)}" data-imported="1">remove</button>
          <button class="mini" data-cancel="1">no</button></span>`;
    } else if (editing) {
      right = `<span class="row" style="gap:6px"><span class="dim" style="font-size:11px">remove?</span>
          <button class="mini" data-confirm-remove="${escapeHtml(a.addr)}">yes</button>
          <button class="mini" data-cancel="1">no</button></span>`;
    } else {
      right = `<span class="row" style="gap:6px">
          <button class="mini" data-rename="${escapeHtml(a.addr)}">rename</button>
          ${(st.accounts.length > 1) ? `<button class="mini" data-remove="${escapeHtml(a.addr)}">remove</button>` : ""}</span>`;
    }
    const removeWarn = editing && acctEdit!.mode === "remove" && a.imported
      ? checkRow({ tier: "danger", html: "this imported key is NOT in your recovery phrase: removing it without a saved backup loses its funds forever. Export it first (More › Reveal key), then enter your password to confirm." })
      : "";
    return `<div class="tx">
      <div class="tx-top"><span class="tx-kind">${i === st.active ? "● " : ""}${escapeHtml(a.label)}${tag}</span>${right}</div>
      <div class="tx-sub"><span class="dim">${escapeHtml(a.addr)}</span></div>${removeWarn}
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
    // imported rows carry a password field (A2); HD rows pass no password and stay one-click.
    const pwInp = b.dataset.imported ? el.querySelector(`.acct-remove-pw[data-addr="${b.dataset.confirmRemove}"]`) as HTMLInputElement | null : null;
    if (b.dataset.imported && !pwInp?.value) return msg("enter your wallet password to remove an imported key", "err");
    try {
      await call("removeAccount", b.dataset.confirmRemove, ...(pwInp?.value ? [pwInp.value] : []));
      acctEdit = null; msg("account removed", "ok"); renderAccts(); render();
    } catch (e: any) {
      const m = String(e?.message || e);
      msg(m === "REMOVE_IMPORTED_REAUTH" ? "enter your wallet password to remove an imported key" : m, "err");
    }
  });
  const ri = el.querySelector(".acct-rename-input") as HTMLInputElement | null;
  if (ri) { ri.focus(); ri.select(); ri.onkeydown = (e: any) => { if (e.key === "Enter") (el.querySelector("[data-save]") as HTMLElement)?.click(); if (e.key === "Escape") { acctEdit = null; renderAccts(); } }; }
}

// A label says what this wallet sent, not what the market or the resolver made of it: the history records no
// verdict, so a fill the offer refused and a token transfer the balance did not cover still read as sent.
const TX_LABEL: Record<string, string> = { send: "Sent", propose: "Proposed", post: "Posted", support: "Supported", attest: "Supported", fillOffer: "Offer fill sent", tokenSend: "Token transfer sent", consolidate: "Merged coins" };
const TX_ICON: Record<string, string> = { send: "i-arrow-up-right", tokenSend: "i-arrow-up-right", fillOffer: "i-arrow-left-right", consolidate: "i-refresh-cw", post: "i-message-square-text", propose: "i-stamp" };
async function renderHistory() {
  const h: any[] = await call("history");
  const el = $("history-list");
  if (!h.length) { el.innerHTML = `<div class="dim" style="padding:8px 0">No transactions yet. Send, post, or support something and it'll appear here.</div>`; return; }
  el.innerHTML = h.map((t) => {
    // token sends display the HUMAN token amount (decimals-aware), not base units as CSD; a coin
    // merge only spends the fee (the total returns to self), so show the FEE as the amount so it
    // doesn't read like a big outgoing payment.
    const csd = t.type === "tokenSend"
      ? `${escapeHtml(String(t.human ?? t.amount ?? ""))} ${escapeHtml(String(t.ticker || ""))}`
      : t.type === "consolidate"
        ? "fee " + fmtBalance(Number(t.fee ?? 0)) + " CSD"
        : fmtBalance(Number(t.amount ?? t.fee ?? 0)) + " CSD";
    const kind = TX_LABEL[t.type] || t.type;
    const detail = (t.type === "send" || t.type === "fillOffer" || t.type === "tokenSend") ? `to ${escapeHtml(String(t.to || "").slice(0, 12))}…`
      : t.type === "consolidate" ? `${Number(t.merged) || "?"} coins → 1${t.amount ? ` · ${fmtBalance(Number(t.amount))} CSD` : ""}`
      : t.title ? escapeHtml(String(t.title).slice(0, 28))
      : t.domain ? escapeHtml(String(t.domain))
      : t.target ? `${escapeHtml(String(t.target).slice(0, 12))}…` : "";
    const when = t.ts ? new Date(t.ts).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "";
    // The marker reads what the balance refresh's reconcile (pendingMerge) stored on the row; the render
    // itself makes no chain read. Only a gone row (an input spent by a different mined tx, seen at two tips)
    // says not included.
    const mark = inclusionMark(t);
    const maybeMark = mark === "sent" ? ` <span class="dim">· sent, not yet included</span>`
      : mark === "stuck" ? ` <span class="dim">· still not included after ${INCLUSION_NOTICE_BLOCKS} blocks; check the explorer before sending again</span>`
      : mark === "gone" ? ` <span class="dim">· not included: its coins were spent by another transaction; check the explorer before sending again</span>`
      : "";
    return `<div class="tx"><span class="ti"><svg class="i" aria-hidden="true"><use href="icons.svg#${TX_ICON[t.type] ?? "i-arrow-up-right"}"/></svg></span>
      <span class="nm"><b class="tx-kind">${escapeHtml(kind)}</b><small><span class="dim">${detail}</span>${when ? ` · ${when}` : ""}${maybeMark}</small></span>
      <span class="vl"><span class="tx-amt">${csd}</span><small><a href="${escapeHtml(explorerLink(currentExplorer, "tx", String(t.txid)))}" target="_blank" rel="noopener noreferrer">${escapeHtml(String(t.txid).slice(0, 10))}… ↗</a></small></span>
    </div>`;
  }).join("");
  enterOnce(el, curAddr);
}
// Balance count-up: a display-only tween between the previous fetched value and the new one
// (ends on the exact canonical string; skipped on first paint, on reduced-motion, and on failure).
// `lastBal` is reset on lock and account switch (clearSendDrafts / render) so a tween never
// crosses an identity boundary; `balSeq` supersedes a stale tween if refreshes overlap.
let curAddr = "";
let lastBal: number | null = null;
let balSeq = 0;
// The amount in Geist with the unit muted; fmtBalance output is digits, separators and a sign only.
const balHtml = (base: number) => `${escapeHtml(fmtBalance(base))}<span class="bal-unit">CSD</span>`;
// Identity avatar: a primary .csd name gets its CNS-parity gradient + monogram; a name-less
// account gets the phosphor cairn mark (a bare gradient + hex nibble read as a placeholder).
const CAIRN_MARK_SVG = `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><ellipse cx="12" cy="18.4" rx="8.4" ry="2.7"/><ellipse cx="12" cy="12.1" rx="6" ry="2.5"/><ellipse cx="12" cy="6.2" rx="3.8" ry="2.1"/></svg>`;
function paintAvatar(name: string | null, addr: string) {
  const av = document.getElementById("avatar") as HTMLElement | null;
  if (!av) return;
  const seed = name ? identitySeed(name, addr) : "__mark__";
  if (av.dataset.seed === seed) return;
  av.dataset.seed = seed;
  if (name) {
    av.classList.remove("mark");
    av.style.background = avatarGradient(identitySeed(name, addr));
    av.textContent = monogram(name, addr);
  } else {
    av.classList.add("mark");
    av.style.background = "";
    av.innerHTML = CAIRN_MARK_SVG; // static markup, no interpolation
  }
}
// Pending-merge state (Plans/66 B4): derived by the engine from history + the utxo set the
// balance fetch ALREADY returned (zero extra requests). Cached module-level so the refusal copy
// (sendRefused) can consult it synchronously; refreshed on every balance refresh, which runs on
// open, after sends, and after merges; exactly the moments the state can change.
let mergePendingNow: { pending: boolean; amount: number; maybe: boolean; stuck: boolean } = { pending: false, amount: 0, maybe: false, stuck: false };
async function updateMergePending(utxos: unknown) {
  const line = $("merge-pending") as HTMLElement;
  try {
    mergePendingNow = await call("pendingMerge", utxos);
    if (mergePendingNow?.pending) {
      line.textContent = mergePendingNow.stuck
        ? `merge of ${fmtBalance(mergePendingNow.amount)} CSD still not included after ${INCLUSION_NOTICE_BLOCKS} blocks; check the explorer`
        : mergePendingNow.maybe
          ? `up to +${fmtBalance(mergePendingNow.amount)} CSD may be merging; back in your balance once the merge is mined`
          : `+${fmtBalance(mergePendingNow.amount)} CSD merging; back in your balance once the merge is mined`;
      line.hidden = false;
    } else line.hidden = true;
  } catch { line.hidden = true; mergePendingNow = { pending: false, amount: 0, maybe: false, stuck: false }; }
  // the reconcile may have settled history rows: repaint their markers if the list is on screen
  if (!($("activity") as HTMLElement).hidden) void renderHistory();
}
async function refreshBalance() {
  const el = $("balance");
  const seq = ++balSeq;
  el.classList.add("loading");                 // shimmer while we fetch
  try {
    const b = await call("balance");
    if (seq !== balSeq) return;                // a newer refresh superseded this one
    void updateMergePending(b.utxos);          // piggybacks the utxos this fetch already carried
    el.classList.remove("loading");
    const next = Number(b.confirmed);
    const from = lastBal;
    lastBal = next;
    $("csd-row-amt").textContent = fmtBalance(next);
    if (from !== null && from !== next) flashChange(el, next > from ? "up" : "down");
    const dur = from === null || from === next || matchMedia("(prefers-reduced-motion: reduce)").matches ? null : tokenMs("--ui-dur-4");
    const ease = dur === null ? null : tokenEase();
    if (from === null || dur === null || ease === null) {
      el.innerHTML = balHtml(next);
    } else {
      const t0 = performance.now();
      const step = (t: number) => {
        if (seq !== balSeq) return;            // superseded mid-tween: let the newer write win
        const p = Math.min(1, (t - t0) / dur);
        el.innerHTML = p < 1 ? balHtml(Math.round(from + (next - from) * ease(p))) : balHtml(next);
        if (p < 1) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    }
  }
  catch { if (seq === balSeq) { el.classList.remove("loading"); el.textContent = "unavailable"; $("csd-row-amt").textContent = "unavailable"; lastBal = null; } }
}
// ── CairnX assets (token balances + .csd names); read-only, never blocks the CSD UI ──
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
// Show the primary .csd name as the account identity (server round-trip-verified; owner===addr===you).
function setIdentity(name: string | null | undefined) {
  const el = document.getElementById("primary-name");
  if (!el) return;
  if (name) { el.textContent = `${name}.csd`; (el as HTMLElement).hidden = false; }
  else { el.textContent = ""; (el as HTMLElement).hidden = true; }
  paintAvatar(name || null, curAddr); // identicon follows the resolved identity (name seed == CNS profile)
}
// epochs ≈ hours → a short remaining-time label for a lease
function leaseLabel(n: any): string {
  if (n?.lapsed) return "Lapsed";
  if (!n?.leased) return "";
  if (n.inGrace) return "In grace: renew now";
  const e = Number(n.epochsLeft ?? 0);   // epochs ≈ hours; 720 ≈ 1 month, 8760 ≈ 1 year
  if (e <= 0) return "Lease ending";
  return "Lease ends in about " + (e < 48 ? `${e} h` : e < 1440 ? `${Math.round(e / 24)} days` : e < 8760 ? `${Math.round(e / 720)} months` : `${(e / 8760).toFixed(1)} years`);
}
// A live lease this close to its end (epochs ≈ hours, so about a month) carries a Renew chip on its row.
const RENEW_SOON_EPOCHS = 720;
function tradeNameUrl(name: string): string {
  const base = (siteApi || "https://cairn-substrate.com").replace(/\/$/, "");
  return `${base}/trade?name=${encodeURIComponent(name)}`;
}
// Supersession guard (same pattern as balSeq): an in-flight assets response for a PREVIOUS
// account must never repaint identity/avatar/assets after a switch.
let assetsSeq = 0;
// What a row, a name's detail or a token send acts for. acctGen moves when a switch starts and when render() sees a
// new address; listGen moves on every write of the lists. An action whose binding no longer matches does nothing and
// closes the sheets: a row or a detail drawn for account A must not open a review that account B would sign.
let acctGen = 0, listGen = 0;
type ViewBind = { acct: number; addr: string; list?: number };
const bindView = (withList = false): ViewBind => ({ acct: acctGen, addr: curAddr, ...(withList ? { list: listGen } : {}) });
const viewCurrent = (b: ViewBind | undefined) => !!b && b.acct === acctGen && b.addr === curAddr && (b.list === undefined || b.list === listGen);
function dropStaleView() { closeAllPanels(); syncNav(); }
const LIST_LOADING = `<div class="skeleton-row"></div><div class="skeleton-row"></div>`;
// At the start of a switch: nothing drawn for the old account stays clickable, and its in-flight reads do not paint.
function invalidateAccountViews() {
  acctGen++; listGen++; assetsSeq++; balSeq++;
  nameDetails = new Map(); ndOpen = null;
  const el = $("assets") as HTMLElement;
  el.hidden = false; el.setAttribute("aria-busy", "true"); el.innerHTML = LIST_LOADING;
  $("names-list").innerHTML = LIST_LOADING;
  $("nd-actions").innerHTML = "";
  $("csd-row-amt").textContent = "";
  $("balance").classList.add("loading");
}
async function renderAssets() {
  const seq = ++assetsSeq;
  const el = $("assets") as HTMLElement;
  const a = await call("cairnxAssets").catch(() => ({ ok: false }));
  if (seq !== assetsSeq) return;
  setIdentity(a?.ok ? a.primaryName : null);
  if (!a?.ok) {
    el.hidden = false;
    el.setAttribute("aria-busy", "false");
    el.innerHTML = `<div class="assets-retry dim">token balances unavailable · <a id="assets-retry">retry</a></div>`;
    nameDetails = new Map(); listGen++;
    $("names-list").innerHTML = `<div class="assets-retry dim">names unavailable · refresh the balance to try again</div>`;
    const rt = document.getElementById("assets-retry");
    if (rt) rt.onclick = () => { el.innerHTML = `<div class="assets-retry dim">retrying…</div>`; renderAssets(); };
    refreshOpenDetail();
    return;
  }
  const balances: Record<string, { available: string; locked: string }> = a.balances || {};
  const names: string[] = a.names || [];
  const details: any[] = Array.isArray(a.nameDetails) && a.nameDetails.length ? a.nameDetails : names.map((n) => ({ name: n }));
  const primary: string | null = a.primaryName ?? null;
  const tickers = Object.keys(balances).sort();
  const meta: Record<string, { decimals: number; name?: string }> = tickers.length ? await tokenMeta() : {};
  if (seq !== assetsSeq) return;
  // Decimals build the base units a token send signs, so a pinned token uses its pinned decimals, never served ones.
  const decOf = (t: string): number => { const d = displayDecimals(t, meta[t]?.decimals).decimals; return isTokenDecimals(d) ? d : 0; };
  // A row opens the token's send sheet; the subtitle says what is locked and whether the wallet pins the token.
  const rows = tickers.map((t) => {
    const b = balances[t] || { available: "0", locked: "0" };
    const dec = decOf(t);
    // The served token name is deployer text, so no row shows it; a pinned token says nothing, the rest "Unverified".
    const sub = [
      b.locked && b.locked !== "0" ? `${groupDigits(formatUnits(b.locked, dec))} locked in offers` : "",
      displayDecimals(t, meta[t]?.decimals).pinned ? "" : "Unverified",
    ].filter(Boolean).join(" · ");
    // the tile is a neutral glyph: part of a ticker would be a look-alike, and the full ticker is the title
    return `<button class="w-row" type="button" data-tsend="${escapeHtml(t)}"><span class="ti"><svg class="i" aria-hidden="true"><use href="icons.svg#i-coins"/></svg></span>`
      + `<span class="nm"><b>${escapeHtml(t)}</b>${sub ? `<small>${escapeHtml(sub)}</small>` : ""}</span>`
      + `<span class="vl">${escapeHtml(groupDigits(formatUnits(b.available, dec)))}</span></button>`;
  }).join("");
  // .csd names: a row opens the name's detail (renew, set primary, the site); a lease near its end also gets a
  // Renew chip on the row. Both lead to the same review sheet; nothing here signs.
  const tip = Number(a.tipHeight) || 0;
  nameDetails = new Map(); listGen++;
  const nameRows = details.map((n) => {
    const nm = String(n.name);
    const isPending = n.pending === true;   // v2.5/v2.6 reservation: revealed but not yet finalized; no owner actions
    const isPrimary = !isPending && nm === primary;
    // a pending reservation with a served finalizeBy gets a REAL countdown (~2 min blocks); older
    // services omit the field and the static label stays.
    const finBy = Number(n.finalizeBy) || 0;
    const pendingLabel = finBy && tip
      ? (tip > finBy ? "Reservation expired: register again on the site" : `Finalizing, about ${Math.max(1, (finBy - tip)) * 2} min left to complete`)
      : "Finalizing: complete it on the site";
    const lease = isPending ? pendingLabel : leaseLabel(n);
    const sub = isPrimary ? (lease ? `Primary · ${lease}` : "Primary") : lease;
    const cls = isPending ? " pending" : n.lapsed ? " lapsed" : n.inGrace ? " grace" : "";
    const soon = !isPending && !n.lapsed && n.leased && (n.inGrace || Number(n.epochsLeft ?? 0) <= RENEW_SOON_EPOCHS);
    nameDetails.set(nm, { name: nm, isPending, isPrimary, lapsed: !!n.lapsed, status: sub });
    return `<div class="w-row name-row${cls}"><button class="w-row-hit" type="button" data-name="${escapeHtml(nm)}"><span class="ti">.csd</span>`
      + `<span class="nm"><b>${escapeHtml(nm)}<span class="dim">.csd</span></b>${sub ? `<small>${escapeHtml(sub)}</small>` : ""}</span></button>`
      + (soon ? `<button class="chip-s" type="button" data-nrenew="${escapeHtml(nm)}">Renew</button>` : "") + `</div>`;
  }).join("");
  el.setAttribute("aria-busy", "false");
  el.hidden = !tickers.length;
  el.innerHTML = rows;
  enterOnce(el, curAddr);
  const nl = $("names-list");
  nl.innerHTML = nameRows || `<p class="empty">No .csd names yet. Names held by this account show here; register one at cairn-substrate.com/names.</p>`;
  if (!($("names-tab") as HTMLElement).hidden) enterOnce(nl, curAddr);
  const rows0 = bindView(true);
  const live = (fn: () => void) => () => { if (viewCurrent(rows0)) fn(); else dropStaleView(); };
  el.querySelectorAll<HTMLElement>("[data-tsend]").forEach((b) => b.onclick = live(() => {
    const t = b.dataset.tsend!;
    openTokenSend(t, decOf(t), balances[t]?.available ?? "0");
  }));
  nl.querySelectorAll<HTMLElement>("[data-name]").forEach((b) => b.onclick = live(() => openNameDetail(b.dataset.name!)));
  nl.querySelectorAll<HTMLElement>("[data-nrenew]").forEach((b) => b.onclick = live(() => confirmNameAction("renew", b.dataset.nrenew!)));
  refreshOpenDetail();
}
// A refreshed list redraws the open name detail from the new read: a name now pending or lapsed loses its actions,
// a name the read no longer returns closes the sheet.
function refreshOpenDetail() {
  if (!ndOpen || ($("name-detail") as HTMLElement).hidden) return;
  if (nameDetails.has(ndOpen)) openNameDetail(ndOpen); else dropStaleView();
}
// Thousands separators on formatUnits' output, display only: every digit and the decimal point stay as they are, and
// anything that is not a plain decimal ("?" on bad input) passes through unchanged.
function groupDigits(s: string): string {
  const m = /^(\d+)(\.\d+)?$/.exec(s);
  return m ? m[1]!.replace(/\B(?=(\d{3})+$)/g, ",") + (m[2] ?? "") : s;
}
// The names the last assets read returned, for the detail sheet a row opens.
let nameDetails = new Map<string, { name: string; isPending: boolean; isPrimary: boolean; lapsed: boolean; status: string }>();
let ndOpen: string | null = null;   // the name whose detail sheet is open
// A name's detail: its state and the owner actions. A pending reservation or a lapsed name gets only the link to the
// site: renew and set-primary on them broadcast a fee the resolver rejects (nrenew and nset refuse a pending record).
function openNameDetail(name: string) {
  const d = nameDetails.get(name);
  if (!d) return;
  if (!openPanel("name-detail")) ($("name-detail") as HTMLElement).hidden = false;   // a second row keeps the sheet open
  ndOpen = d.name;
  const bound = bindView(true);
  const act = (kind: "renew" | "primary") => () => { if (viewCurrent(bound) && nameDetails.get(d.name) === d) confirmNameAction(kind, d.name); else dropStaleView(); };
  $("name-detail-title").textContent = `${d.name}.csd`;
  $("nd-rows").innerHTML = `<div class="crow"><span class="label">Status</span><span>${escapeHtml(d.status || "Registered")}</span></div>`;
  const site = (label: string) => `<a class="btn-link" href="${escapeHtml(tradeNameUrl(d.name))}" target="_blank" rel="noopener noreferrer">${label}<svg class="i" aria-hidden="true"><use href="icons.svg#i-external-link"/></svg></a>`;
  const acts = $("nd-actions");
  acts.innerHTML = d.isPending ? site("Finalize on the site")
    : d.lapsed ? site("Recapture on the site")
    : `<button class="primary" type="button" data-nrenew="${escapeHtml(d.name)}">Renew</button>`
      + (d.isPrimary ? "" : `<button type="button" data-nprimary="${escapeHtml(d.name)}">Set as primary</button>`)
      + site("Open on the site");
  acts.querySelectorAll<HTMLElement>("[data-nrenew]").forEach((b) => b.onclick = act("renew"));
  acts.querySelectorAll<HTMLElement>("[data-nprimary]").forEach((b) => b.onclick = act("primary"));
}

// One click opens a review panel (parity with the send-confirm flow); signing happens only on Confirm.
// A name renew / set-primary spends real CSD, so it must be reviewable and declinable like every other
// value-moving action; NOT signed from an easy-to-miss inline message. `reviewState.reviewedNameAct` is
// the frozen snapshot the Confirm button signs (torn down on lock by clearSendDrafts, so a primed panel
// can't survive a lock/unlock; and wallet.must() throws if a click somehow lands while locked).
let nameActSeq = 0;   // QA #18: supersede stale async continuations; a newer invocation bumps this; older ones abort after their awaits
async function confirmNameAction(kind: "renew" | "primary", name: string) {
  const seq = ++nameActSeq;
  const bound = bindView();   // a switch during the reads below leaves no primed review behind
  dropReviews();
  openPanel("name-action-form");
  ($("name-action-form") as HTMLElement).hidden = false;   // always SHOW the review; openPanel toggles, and a name action must never toggle the panel closed
  $("nc-action").textContent = kind === "renew" ? "Renew lease" : "Set primary name";
  $("nc-name").textContent = `${name}.csd`;
  $("nc-anchor").textContent = fmtCsd(CAIRNX_FEE);
  // renew also pays a height-gated registration fee to the treasury; set-primary is anchor-only. The fee is
  // priced at the CURRENT tip; the same one cairnxNameRenew signs (WL-V18-1: never show a stale fee curve).
  let renewFee = 0;
  if (kind === "renew") {
    renewFee = await call("cairnxNameRenewFee", name).then((v) => Number(v) || 0).catch(() => 0);
    if (seq !== nameActSeq || !viewCurrent(bound)) return;   // superseded, or the account changed meanwhile
    ($("nc-fee-row") as HTMLElement).hidden = false;
    $("nc-fee").textContent = renewFee ? fmtCsd(renewFee) : "priced at confirm";
  } else {
    ($("nc-fee-row") as HTMLElement).hidden = true;
  }
  // M8: an unpriceable renew fee (offline/error) must render the total as unknown, never as the
  // anchor-only 0.25 (which would understate a 15.25 action). The fee row already says "priced at
  // confirm"; the total must not contradict it. Set-primary is anchor-only, so its total is exact.
  const total = CAIRNX_FEE + renewFee;
  $("nc-total").textContent = (kind === "renew" && !renewFee) ? "unknown (priced at confirm)" : fmtCsd(total);
  // M8 residual (Fable final QC): when the renew fee is unpriceable the AFTER balance is likewise
  // unknown; subtracting the anchor-only 0.25 would understate a 15.25 action in the second row too.
  let after = "";
  try { const b = await call("balance"); after = (kind === "renew" && !renewFee) ? "" : fmtBalance(b.confirmed - total) + " CSD"; } catch { /* offline */ }
  if (seq !== nameActSeq || !viewCurrent(bound)) return;   // superseded or switched after the balance fetch; abort before priming the snapshot
  $("nc-after").textContent = after || "unknown";
  $("nc-note").textContent = kind === "renew"
    ? "Extends this name's lease by one term. Anyone may renew a live lease."
    // QA #5: the wallet's set-primary is a single nset→self; it makes the name primary only if it's your
    // OLDEST self-pointing name. Switching from an older name needs the multi-step flow on the website.
    : "Points this name at you (its reverse record). If it's your oldest such name it becomes your primary; to switch from an older name, use cairn-substrate.com/names.";
  reviewState.reviewedNameAct = { kind, name, total, fee: renewFee, signer: curAddr };   // freeze the reviewed fee + signer; doNameAction signs EXACTLY this
  msg("");
}
async function doNameAction() {
  if (!reviewState.reviewedNameAct) return;
  const { kind, name, fee, signer } = reviewState.reviewedNameAct;
  const bound = bindView();                                 // the account this review belongs to
  dropReviews();                                            // consume the snapshot: one Confirm = one signature
  try {
    busy(kind === "renew" ? `renewing ${name}.csd…` : `setting ${name}.csd as primary…`);
    // WL-FEE-FREEZE-1: a renew signs EXACTLY the reviewed fee; the background throws FEE_CHANGED (without
    // signing) if the tip crossed a fee-gate since review, so the user never signs a different amount.
    // A1: the reviewed signer rides along; a mid-flight account switch refuses instead of signing.
    const r = await call(kind === "renew" ? "cairnxNameRenew" : "cairnxSetPrimary", name, ...(kind === "renew" ? [fee, signer ?? undefined] : [signer ?? undefined]));
    const what = kind === "renew" ? "renewal" : "set-primary";
    if (r.ok) { ($("name-action-form") as HTMLElement).hidden = true; msg(`${kind === "renew" ? "renewed" : "set primary"}: ${name}.csd · ${String(r.txid).slice(0, 12)}… (takes effect once it is mined)`, "ok"); refreshBalance(); renderAssets(); }
    else {
      const o = refusedCopy(r, what);
      if (o.maybe) { ($("name-action-form") as HTMLElement).hidden = true; refreshBalance(); }
      msg(o.text, o.cls);
    }
  } catch (e: any) {
    const m = String(e?.message || e);
    if (m.startsWith("FEE_CHANGED:")) {                     // tip crossed a fee gate between Review and Confirm; nothing was signed
      const newFee = Number(m.slice("FEE_CHANGED:".length));
      // re-review only for the account and the name it was for: the account may have changed while Confirm was in flight
      if (!viewCurrent(bound) || !nameDetails.has(name)) {
        dropStaleView();
        msg(`renewal fee changed to ${fmtCsd(newFee)} since you reviewed. Nothing was signed; open the name again to review it`, "err");
        return;
      }
      await confirmNameAction("renew", name);               // re-price + re-show the review first (it resets the status line)…
      msg(`renewal fee changed to ${fmtCsd(newFee)} since you reviewed. Check it and confirm again`, "err");  // …then explain
      return;
    }
    const o = thrownCopy(e, kind === "renew" ? "renewal" : "set-primary");
    msg(o.text, o.cls);
  }
}

// Resolve a send recipient: a 0x… address as-is, or a .csd name (nset addr else owner; refuse lapsed).
const looksLikeName = (s: string) => /\.csd$/i.test(s) || isPlainName(s.toLowerCase()); // L10: single-sourced NAME_RE
async function resolveRecipient(raw: string): Promise<{ ok: boolean; addr?: string; name?: string | null; label?: string | null; badge?: string; lowDepth?: boolean; error?: string; verified?: boolean; sources?: number; disagree?: boolean; soleSource?: boolean; viaFill?: boolean }> {
  const r = (raw || "").trim();
  // Refuse the zero address outright: a send there is an irrecoverable burn. Defense-in-depth for the V23
  // transition: a wallet that CARRIES this guard but whose vendored core still lacked the v23 branch would
  // replay a cleared name to 0x000..0, and this blocks that burn. It does NOT cover releases predating this
  // guard (no 0x0 check -> they burn after V23); for those the only safeguard is the deploy discipline in
  // types.ts (set V23_HEIGHT only after wallet ADOPTION, not publication).
  // isZeroAddr is the shared (0x)?-optional guard from clearsign.ts; one test for all three former copies.
  if (/^0x[0-9a-fA-F]{40}$/.test(r)) {
    if (isZeroAddr(r)) return { ok: false, error: "that is the zero address: sends there are burned and unrecoverable" };
    return { ok: true, addr: r.toLowerCase(), name: null, label: null };
  }
  if (looksLikeName(r)) {
    const nm = r.toLowerCase().replace(/\.csd$/, "");
    const res = await call("resolveName", nm).catch(() => ({ ok: false, error: "name lookup failed" }));
    // resolveName SPV-verifies the name over two name sources (primary and clarvis, same operator). A disagreeing
    // source warns rather than refuses: the target is the proven winner with `disagree` set, and an unprovable
    // name comes back verified:false for the badge to caution. res.ok is false only for an invalid, unregistered,
    // address-less or lapsed name, or a failed lookup.
    if (!res.ok) return { ok: false, error: res.error || `couldn't resolve ${nm}.csd` };
    if (isZeroAddr(res.addr)) return { ok: false, error: `${nm}.csd points at the zero address: refusing (sends would be burned)` };
    const verified = res.verified === true;
    const viaFill = res.viaFill === true;
    const conf = res.depth ? ` (${res.depth} conf)` : "";
    // C2 badge honesty (Plans/68 F2/F4): single-source is the EXACT posture where the documented
    // competing-claim withholding redirect is live, so it must read visibly weaker than 2-source
    // agreement, not like the same green check; and a barely-buried (1-2 conf) resolution gets a
    // reorg caution instead of a plain check. Both stay informational; never a block.
    const lowDepth = typeof res.depth === "number" && res.depth > 0 && res.depth < NAME_SAFE_DEPTH;
    const badge = !verified
      ? (viaFill ? "⚠ purchased name: can't be name-scope-proven, confirm the address" : "⚠ NOT chain-verified: confirm the address")
      : res.soleSource ? `⚠ only ONE name source could prove this address and it isn't independently corroborated: confirm it out-of-band before sending${conf}`
      : res.disagree ? `⚠ chain-backed but a name source DISAGREED (or hasn't indexed it yet): verify the address${conf}`
      : (res.sources ?? 1) >= 2
        ? (lowDepth ? `✓ chain-backed, ${res.sources} servers agree, only${conf}, could still reorg` : `✓ chain-backed, ${res.sources} name servers agree (same operator)${conf}`)
        : `△ chain-backed but only 1 source answered: second server unreachable, weaker guarantee${conf}`;
    return { ok: true, addr: res.addr, name: nm, verified, sources: res.sources, disagree: res.disagree, soleSource: res.soleSource, viaFill, lowDepth, label: `${nm}.csd → ${short(res.addr)} (via ${res.via ?? "owner"})`, badge };
  }
  return { ok: false, error: "enter a 0x… address or a name.csd" };
}
// XREPO-1 confirm-time guard wrapper: re-ask the name service at sign-time and REFUSE unless it still
// returns EXACTLY the reviewed address. Fail-closed on any error / network failure. The equality +
// shape check lives in clearsign.reresolveUnchanged (pure, unit-tested); this only wires the live call.
async function nameStillPointsTo(name: string, reviewed: string, reviewedVerified?: boolean): Promise<boolean> {
  const re = await call("confirmName", name).catch(() => ({ ok: false }));
  return reresolveUnchanged(reviewed, re, reviewedVerified); // L7: also refuses a verified→unverified regression
}
// An address in groups of four for comparing by eye; the spans hold no spaces, so its text is the raw address.
const groupedAddr = (a: string) => (a.match(/^0x.{0,4}|.{1,4}/g) || []).map((g) => `<span>${escapeHtml(g)}</span>`).join("");
function setNameRow(rowId: string, valId: string, label: string | null | undefined) {
  const row = document.getElementById(rowId), v = document.getElementById(valId);
  if (!row || !v) return;
  if (label) { v.textContent = label; (row as HTMLElement).hidden = false; }
  else { v.textContent = ""; (row as HTMLElement).hidden = true; }
}

// ── send a CairnX token: recipient + amount → review (ticker/amount/to/fee) → sign ──
// The transfer record is built INSIDE the wallet (core/cairnx.ts) and anchored through
// the existing propose pipeline with the 0.25 CSD convention fee; no value outputs.
const CAIRNX_FEE = CAIRNX_PROPOSE_FEE; // 0.25 CSD (anchor fee, paid in CSD); the vendored MIN_FEE_PROPOSE, never a hand-typed literal
let tsend: { ticker: string; decimals: number; available: string; bind: ViewBind } | null = null;

// ── shared send-flow engine ───────────────────────────────────────────────────────────────────
// The CSD and token send panels are deliberate twins with three real deltas, carried by a flow
// DESCRIPTOR (the element ids are irregular; send-/s-/c- vs tsend-/ts-/tc-; so a prefix won't do):
//   • refresh: a token send repaints the token balances too (renderAssets), a CSD send only the balance
//     (naive sharing would mean a stale token row or a pointless extra fetch; both user-visible);
//   • warning noun: "transfers" (token) vs "payments" (CSD); DELIBERATE per-flow copy, not drift;
//   • snapshot shape: reviewState.reviewed (token, base-unit string) vs .reviewedSend (CSD, number).
// Only the SUCCESS path clears the typed recipient/amount (fail/catch keep the draft for a re-Review);
// Back clears nothing and never refreshes.
type SendFlow = { ids: { confirm: string; to: string; amt: string }; noun: "transfers" | "payments"; refresh: () => void };
const TOKEN_FLOW: SendFlow = { ids: { confirm: "tsend-confirm", to: "ts-to", amt: "ts-amt" }, noun: "transfers", refresh: () => { refreshBalance(); renderAssets(); } };
const CSD_FLOW: SendFlow = { ids: { confirm: "send-confirm", to: "s-to", amt: "s-amt" }, noun: "payments", refresh: () => { refreshBalance(); } };
// Hide the confirm card, drop every frozen snapshot, re-enable the inputs. Success alone clears the
// typed values; every other exit (Back / fail / catch) keeps the draft.
function teardownReview(f: SendFlow, clearValues: boolean) {
  ($(f.ids.confirm) as HTMLElement).hidden = true;
  dropReviews();
  for (const id of [f.ids.to, f.ids.amt]) { const el = $(id) as HTMLInputElement; el.disabled = false; if (clearValues) el.value = ""; }
}
// Arm the review: disable the inputs the snapshot was read from and show the confirm card (editing
// the form after "Review" must not let displayed values diverge from signed ones).
function armReview(f: SendFlow) {
  ($(f.ids.to) as HTMLInputElement).disabled = true;
  ($(f.ids.amt) as HTMLInputElement).disabled = true;
  ($(f.ids.confirm) as HTMLElement).hidden = false;
  msg("");
}
// First-time-recipient + address-poisoning look-alike, computed by the same clearsign.recipientStatus
// as the approval window: paid recipients plus this wallet's own accounts (sending to your own other
// account is not a first send). History unavailable → treat as first time.
async function recipientChecks(to: string): Promise<{ firstTime: boolean; lookalike: string | null }> {
  try {
    const [h, st] = await Promise.all([call("history"), call("status")]);
    return recipientStatus(to, paidRecipients(h), (st.accounts || []).map((a: any) => String(a.addr)));
  } catch { return { firstTime: true, lookalike: null }; }
}
// One source for the review-card warning copy. `noun` is the ONLY wording difference between the two
// flows ("transfers" for tokens, "payments" for CSD; deliberate per-flow copy); the strings are
// otherwise the historical ones byte-for-byte. Empty return = nothing to warn about (box hidden).
function composeSendWarning(lookalike: string | null, firstTime: boolean, nameCaution: Check | null, noun: "transfers" | "payments"): Check[] {
  const Noun = noun.charAt(0).toUpperCase() + noun.slice(1);
  const out: Check[] = nameCaution ? [nameCaution] : [];
  if (lookalike) out.push({ tier: "danger", html: `⚠ <b>Possible address-poisoning.</b> This looks like <code>${escapeHtml(lookalike.slice(0, 10))}…${escapeHtml(lookalike.slice(-6))}</code> you've seen before but is NOT the same address. Verify every character. ${Noun} are irreversible.` });
  else if (firstTime) out.push({ tier: "danger", html: `⚠ First time sending to this address: check every character. ${Noun} are irreversible.` });
  return out;
}
function setWarn(el: HTMLElement, checks: Check[]) {
  if (checks.length) { el.innerHTML = checks.map(checkRow).join(""); el.hidden = false; }
  else { el.innerHTML = ""; el.hidden = true; }
}
// FOOT-3 double-send guard, shared by both flows' ok:false and thrown branches: do NOT leave Confirm
// armed on the same frozen snapshot after a failure (one more click after an ambiguous submit selects a
// DIFFERENT coin and double-pays). Tear the review down (draft preserved) so resending takes a
// deliberate re-Review, and refresh. Only the failure branches route here; the happy path is untouched.
function sendOutcome(f: SendFlow, o: Outcome) {
  teardownReview(f, false);
  f.refresh();
  msg(o.text, o.cls);
}
// A throw is routed by whether anything could have been submitted (see AnsweredError).
function sendThrew(f: SendFlow, e: any) { sendOutcome(f, thrownCopy(e, "send")); }
// A structured {ok:false} from the send engine: only SUBMIT_MAYBE_INFLIGHT is ambiguous; every other
// code is a clean pre-broadcast refusal or a definitive rejection, shown with the engine's own reason.
function sendRefused(f: SendFlow, r: any) {
  const o = refusedCopy(r, "send");
  if (o.maybe) return sendOutcome(f, o);
  teardownReview(f, false);
  f.refresh();
  let text = o.text;
  // Merge-aware refusals (Plans/66 B4b): right after a consolidate, the confirmed balance is
  // legitimately short by the whole merging amount; say so instead of leaving "insufficient"
  // to read as lost funds.
  if ((r?.code === "INSUFFICIENT" || r?.code === "TOO_MANY_INPUTS") && mergePendingNow.pending) {
    text += ` A coin merge (${fmtBalance(mergePendingNow.amount)} CSD) is still confirming; retry once it is mined.`;
  }
  // TOO_MANY_INPUTS: the remedy is one click away; surface it as an action, not a breadcrumb
  // in a toast that fades mid-read (Plans/66 B5).
  if (r?.code === "TOO_MANY_INPUTS") {
    return msgAction(text, "Merge coins now", () => { void openConsolidatePanel(true); });
  }
  msg(text, "err");
}
// Success teardown: outcome message + hero glow first, then the one clear-the-draft path.
function sentOk(f: SendFlow, text: string) {
  msg(text, "ok sent");
  celebrateSend();
  teardownReview(f, true);
  f.refresh();
}

function openTokenSend(ticker: string, decimals: number, available: string) {
  tsend = { ticker, decimals, available, bind: bindView() };
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
  if (!viewCurrent(tsend.bind)) { tsend = null; return dropStaleView(); }   // opened for another account
  const base = parseUnits(val("ts-amt").trim(), tsend.decimals);
  if (base === null || base === "0") return msg(tsend.decimals ? `enter an amount (up to ${tsend.decimals} decimal places)` : "enter a whole-number amount (this token has 0 decimals)", "err");
  const rr = await resolveRecipient(val("ts-to").trim());   // 0x… or alice.csd (refuse lapsed)
  if (!rr.ok) return msg(rr.error!, "err");
  const to = rr.addr!;
  setNameRow("tc-name-row", "tc-name", rr.label);
  // `available` comes from the (configurable) trade API; never let a hostile/garbled value
  // throw out of the handler and silently kill the send flow; treat unparseable as zero.
  let avail = 0n;
  try { avail = BigInt(tsend.available || "0"); } catch { avail = 0n; }
  if (BigInt(base) > avail) return msg(`amount exceeds your available ${tsend.ticker} balance (${formatUnits(tsend.available, tsend.decimals)})`, "err");
  // A token transfer still anchors on-chain via a Propose carrying the 0.25 CSD fee. "Received
  // tokens but holds no CSD" is a completely normal account state, so pre-check the CSD side HERE
  // with a message that names the actual problem; otherwise the engine's generic "insufficient
  // confirmed balance" reads as nonsense to someone staring at a big token balance. Best-effort:
  // offline skips the check and the engine still refuses cleanly at sign time.
  // Run the CSD-fee pre-check CONCURRENTLY with the recipient checks (both are best-effort network reads)
  // so a slow node doesn't add serial latency before the review card arms. Offline -> b is null -> the fee
  // check is skipped and the engine still refuses cleanly at sign time.
  const [b, checks] = await Promise.all([call("balance").catch(() => null), recipientChecks(to)]);
  if (b && Number(b.confirmed ?? 0) < CAIRNX_FEE) return msg(`sending ${tsend.ticker} needs ${fmtCsd(CAIRNX_FEE)} for the on-chain anchor fee; your confirmed CSD balance is ${fmtBalance(Number(b.confirmed ?? 0))} CSD`, "err");
  // same first-time / address-poisoning checks as a CSD send; token sends are just as irreversible
  const { firstTime, lookalike } = checks;
  $("tc-ticker").textContent = tsend.ticker;
  $("tc-to").innerHTML = groupedAddr(to.toLowerCase());     // FULL address, as it will appear in the signed record
  // W8 (B5g): BOTH scales on the review card. `decimals` is resolver-served (the popup token list), so a
  // decimals lie rescales the human number by up to 10^8 while the balance guard compares against the SAME
  // resolver's `available`; the card alone could confirm a rescaled amount back to the user. The base-unit
  // integer IS the value that gets signed; rendering it beside the scaled number makes any rescale visible
  // at review time (F12: both scales, never either alone).
  $("tc-amt").textContent = tokenAmountBothScales(base, tsend.decimals, tsend.ticker);
  $("tc-fee").textContent = fmtCsd(CAIRNX_FEE);
  // A .csd token send ALWAYS carries the name-service-trust caution (XREPO-1), same as a CSD send.
  setWarn($("tc-warn") as HTMLElement, composeSendWarning(lookalike, firstTime, nameCheck(rr), TOKEN_FLOW.noun));
  // SNAPSHOT what was reviewed; the confirm step signs EXACTLY this, never the live inputs
  // signer snapshot (A1/POPUP-SEND-RACE-2): the confirm's nameStillPointsTo await can park across an
  // account switch; expectSigner makes the background refuse at the sign tick instead of signing from
  // the switched-to account (the recipient stays correct but the WRONG account would pay).
  reviewState.reviewed = { to, base, name: rr.name ?? null, verified: rr.verified, signer: curAddr }; // snapshot verified for the L7 confirm-time regression check
  armReview(TOKEN_FLOW);
});
// Back: keep the draft, refresh nothing (only success clears/refreshes)
$("btn-tsend-back").addEventListener("click", () => teardownReview(TOKEN_FLOW, false));
$("btn-tsend-confirm").addEventListener("click", async () => {
  if (!tsend || !reviewState.reviewed) return;
  const { to, base, name, verified, signer } = reviewState.reviewed;
  // re-resolve the name at sign-time and refuse if it now points somewhere else (XREPO-1) or its
  // chain-verification regressed since review (L7).
  if (name && !(await nameStillPointsTo(name, to, verified))) return msg(`${name}.csd changed where it points — review again`, "err");
  try {
    busy("sending…");
    const r = await call("cairnxTransfer", { ticker: tsend.ticker, amount: base, to, decimals: tsend.decimals, fee: CAIRNX_FEE, expectSigner: signer ?? undefined });
    if (r.ok) sentOk(TOKEN_FLOW, `sent ${tokenAmountBothScales(base, tsend.decimals, tsend.ticker)} · ${String(r.txid).slice(0, 12)}… (settles once it is mined)`); // W8: both scales here too
    else sendRefused(TOKEN_FLOW, r);                  // structured refusal: show the REAL reason (token parity with the CSD path)
  } catch (e: any) {
    sendThrew(TOKEN_FLOW, e);       // a wallet-answered throw submitted nothing; only a broken channel is ambiguous
  }
});

// The queue the card last showed: the 1.5 s poll rewrites the card only when it changed, so a poll does not replay
// its entrance or take the focus off Review.
let pendingShown: string | null = null;
async function renderPending() {
  if (!EXT) return;
  const p = await call("pending"); const el = $("pending") as HTMLElement;
  const key = JSON.stringify(p.map((r: any) => [r.id, r.method, r.origin]));
  if (key === pendingShown) return;
  pendingShown = key;
  if (!p.length) { el.hidden = true; el.innerHTML = ""; return; }
  el.hidden = false;
  // The toolbar popup NEVER approves a request inline; approving a fund-moving send/propose/
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
$("btn-create").addEventListener("click", async () => { try { const pw = val("setup-pw"); if (!pw) return msg("enter a password", "err"); const r = await call("create", pw); ($("setup-pw") as HTMLInputElement).value = ""; const h0 = document.getElementById("setup-pw-hint"); if (h0) h0.textContent = ""; showBackup(r.mnemonic, r.privkey); } catch (e: any) { msg(e.message, "err"); } });
// CUST-1-1 nudge: a no-dependency password-strength HINT on the new-wallet field. NON-blocking (the keystore
// still enforces the 8-char minimum); it just steers users toward a long passphrase, which is the real defense
// against an offline brute of an exfiltrated at-rest vault. Length-dominant with a small variety bonus; no dep.
function pwStrength(pw: string): string {
  const len = pw.length; if (!len) return "";
  if (len < 8) return "too short (8+ required)";
  let classes = 0; for (const re of [/[a-z]/, /[A-Z]/, /[0-9]/, /[^a-zA-Z0-9]/]) if (re.test(pw)) classes++;
  if (len >= 16 || (len >= 12 && classes >= 3)) return "strong";
  if (len >= 12 && classes >= 2) return "fair";
  return "weak: use a longer passphrase";
}
$("setup-pw").addEventListener("input", () => {
  const v = ($("setup-pw") as HTMLInputElement).value; const h = document.getElementById("setup-pw-hint");
  if (h) h.textContent = v ? `password strength: ${pwStrength(v)}` : "";
});
$("btn-restore").addEventListener("click", async () => { try { const ph = val("restore-phrase").trim(); const pw = val("restore-pw"); if (!ph) return msg("enter your recovery phrase", "err"); if (!pw) return msg("enter a password to encrypt it", "err"); await call("restore", ph, pw); ($("restore-phrase") as HTMLTextAreaElement).value = ""; ($("restore-pw") as HTMLInputElement).value = ""; msg("wallet restored", "ok"); render(); } catch (e: any) { msg(e.message, "err"); } });
$("btn-copy-seed").addEventListener("click", () => copyText("btn-copy-seed", backupPhrase));
$("btn-copy-priv").addEventListener("click", () => copyText("btn-copy-priv", backupPriv));
($("ack-backup") as HTMLInputElement).addEventListener("change", (e) => { ($("btn-backup-done") as HTMLButtonElement).disabled = !(e.target as HTMLInputElement).checked; });
$("btn-backup-done").addEventListener("click", () => {
  backupPhrase = ""; backupPriv = ""; $("seed-words").innerHTML = ""; $("backup-priv").textContent = "";
  msg("wallet ready", "ok"); render();
  // wallet-ready moment: one-shot ring pulse over the balance hero (CSS-only; killed by reduced-motion)
  const vm = $("view-main");
  vm.classList.add("born");
  setTimeout(() => vm.classList.remove("born"), 1600);
});
$("btn-import").addEventListener("click", async () => { try { if (!val("import-pw")) return msg("enter a password to encrypt the key", "err"); await call("import", val("import-key").trim(), val("import-pw")); msg("key imported", "ok"); render(); } catch (e: any) { msg(e.message, "err"); } });
$("btn-unlock").addEventListener("click", async () => { try { await call("unlock", val("unlock-pw")); msg("unlocked", "ok"); render(); } catch (e: any) { msg(e.message, "err"); } });
$("btn-lock").addEventListener("click", async () => { await call("lock"); msg("locked"); render(); });
$("btn-refresh").addEventListener("click", () => { refreshBalance(); renderAssets(); });
$("btn-copy").addEventListener("click", () => copyText("btn-copy", $("addr").textContent || ""));
// ── accordion: at most ONE action panel open at a time ──────────────────────
// All the collapsible panels under the main view. Opening one closes the rest;
// clicking the same trigger again closes it. Secret panels are wiped on every switch.
const PANELS = ["accts-panel", "receive-panel", "send-form", "tsend-form", "consolidate-form", "name-action-form", "name-detail", "post-form", "seal-form", "activity", "names-tab", "reveal-panel", "phrase-panel", "settings"];
let revealedKey = "", revealedPhrase = "";
// C-8 / PH-16 (2026-09-09): the "auto-clears" clipboard promise was FALSE (the clear needs a
// clipboardRead permission the manifest lacks, and the beforeunload path never settles in the
// shipped build). The machinery is deleted rather than repaired - a clipboard-read permission on a
// wallet is a Chrome Web Store red flag disproportionate to a cosmetic label.
function resetRevealPanel() {
  revealedKey = ""; const o = $("reveal-out"); o.textContent = ""; o.classList.remove("shown"); (o as HTMLElement).hidden = true;
  ($("reveal-actions") as HTMLElement).hidden = true; ($("reveal-pw") as HTMLInputElement).value = "";
}
function resetPhrasePanel() {
  revealedPhrase = ""; const o = $("phrase-out"); o.innerHTML = ""; o.classList.remove("shown"); o.classList.add("blur"); (o as HTMLElement).hidden = true;
  ($("phrase-actions") as HTMLElement).hidden = true; ($("phrase-pw") as HTMLInputElement).value = "";
}
// Close every panel + confirm sub-panel, drop primed value-moving snapshots, wipe revealed
// secrets. Statement order of the original openPanel body preserved (the two snapshot-null
// statements collapsed into one dropReviews()); this teardown is the secret-wipe / WYSIWYS
// boundary and must stay byte-equivalent in behavior.
function closeAllPanels() {
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
function openPanel(id: string): boolean {
  const willOpen = ($(id) as HTMLElement).hidden;
  closeAllPanels();
  if (willOpen) ($(id) as HTMLElement).hidden = false;
  syncNav();
  return willOpen;
}
// Which control shows as current: the Names or Activity tab or the Settings button when their panel is open, else
// Assets. A sheet over a list keeps that list's tab selected.
const TABS = ["nav-home", "nav-names", "btn-activity-t"];
function syncNav() {
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

// ── Receive: QR + full address in a panel. Re-rendered on open AND on every render() while
// open (account switches must never leave a previous account's address/QR on screen). The QR
// is a convenience rendering of the SAME address printed in full beside it; the text is the
// source of truth. ANY failure fail-softs: card hidden AND canvas zeroed (a stale QR bitmap
// must never survive into a different account's context).
async function renderReceive() {
  const card = document.querySelector(".receive-card") as HTMLElement | null;
  const canvas = document.getElementById("receive-qr") as HTMLCanvasElement | null;
  try {
    const st = await call("status");
    if (($("receive-panel") as HTMLElement).hidden) return;   // closed while we fetched
    // Groups of four for comparing by eye; the spans hold no spaces, so textContent (what Copy copies) is the address.
    const addr = String(st.addr || "");
    $("receive-addr").innerHTML = groupedAddr(addr);
    const pn = $("primary-name"), rn = $("receive-name") as HTMLElement;
    if (!(pn as HTMLElement).hidden && pn.textContent) { rn.textContent = pn.textContent; rn.hidden = false; }
    else { rn.textContent = ""; rn.hidden = true; }
    if (!st.addr || !canvas) throw new Error("no address");
    drawQr(canvas, st.addr);
    if (card) card.hidden = false;
  } catch {
    if (canvas) { canvas.width = 0; canvas.height = 0; }      // encodeText throws BEFORE resizing: wipe the old bitmap explicitly
    if (card) card.hidden = true;
  }
}
$("btn-receive").addEventListener("click", () => { if (openPanel("receive-panel")) renderReceive(); });
$("btn-receive-copy").addEventListener("click", () => copyText("btn-receive-copy", $("receive-addr").textContent || ""));

// Reveal private key; in-popup panel (password → masked secret box).
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
$("btn-reveal-copy").addEventListener("click", () => copyText("btn-reveal-copy", revealedKey));
$("btn-reveal-close").addEventListener("click", () => { resetRevealPanel(); ($("reveal-panel") as HTMLElement).hidden = true; });

// Reveal recovery phrase; in-popup panel (password → blurred 12-word grid).
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
$("btn-phrase-copy").addEventListener("click", () => copyText("btn-phrase-copy", revealedPhrase));
$("btn-phrase-close").addEventListener("click", () => { resetPhrasePanel(); ($("phrase-panel") as HTMLElement).hidden = true; });
$("btn-settings").addEventListener("click", () => { if (openPanel("settings")) { renderConnectedSites(); renderCoinsInfo(); } });

// ── coins / consolidate (popup-only; see node.consolidate for the trust posture) ─────────────
// Settings shows a live coin count; "merge coins…" appears only when a merge would actually help
// (≥2 spendable coins). The confirm card previews REPORTED numbers; the spend itself re-verifies
// every input against the chain (TXB-1) and refuses on any mismatch; a lying preview gains nothing.
async function renderCoinsInfo() {
  const info = $("coins-info") as HTMLElement, btn = $("btn-consolidate") as HTMLButtonElement;
  info.textContent = "…"; btn.hidden = true;
  try {
    const p = await call("consolidatePreview", SEND_FEE);
    if (!p?.ok) { info.textContent = "coin count unavailable (node unreachable)"; return; }
    info.textContent = p.coins < 2
      ? `you have ${p.coins} spendable coin${p.coins === 1 ? "" : "s"}: nothing to merge`
      : `you have ${p.coins} spendable coins · one merge combines ${p.merge} of them (${fmtBalance(p.total)} CSD) into a single coin`;
    btn.hidden = p.coins < 2;
  } catch { info.textContent = "coin count unavailable"; }
}
// A single merge can be in flight for ~10s (verifying up to 512 inputs). `consolidating` latches ACROSS
// a panel reopen so a second concurrent merge can't be fired (the reopen re-enables the confirm button);
// two concurrent merges are self-conflicting and harmless, but this keeps a single, clean flow.
let consolidating = false;
// Shared opener: the settings button (toggle semantics) and the TOO_MANY_INPUTS "Merge coins now"
// action (force-open) both land here. The preview arms Confirm for every legitimate case:
// including while an EARLIER round is still confirming: back-to-back rounds select disjoint coins
// (the node's available-utxo view already excludes the in-flight round's inputs), so disarming
// here would be a decline path on a designed flow. Only two things keep Confirm down: a merge
// in flight in THIS popup (the double-fire latch) and a dust-only preview (out = 0 would just
// burn the fee at the engine's INSUFFICIENT refusal).
async function openConsolidatePanel(force = false) {
  if (!openPanel("consolidate-form")) {
    if (!force) return;                                        // settings-button toggle: closing is a valid click
    ($("consolidate-form") as HTMLElement).hidden = false;     // action path: always end OPEN
  }
  const note = $("cs-note") as HTMLElement;
  ($("btn-consolidate-confirm") as HTMLButtonElement).disabled = true;
  note.textContent = "";
  try {
    const p = await call("consolidatePreview", SEND_FEE);
    if (!p?.ok || p.coins < 2) { note.textContent = p?.ok ? "nothing to merge: fewer than two spendable coins." : "node unreachable: try again in a moment."; return; }
    $("cs-merge").textContent = String(p.merge) + (p.coins > p.merge ? ` of ${p.coins}` : "");
    $("cs-total").textContent = fmtBalance(p.total) + " CSD";
    $("cs-fee").textContent = fmtCsd(SEND_FEE);
    $("cs-out").textContent = fmtBalance(p.out) + " CSD";
    // Round plan: merging 512 coins into 1 retires 511 per pass, and intermediate outputs get
    // swept into a later pass once confirmed; so ceil((coins-1)/511) covers the whole plan.
    const rounds = Math.ceil((p.coins - 1) / 511);
    note.textContent = (p.coins > p.merge ? `a transaction fits at most ${p.merge} coins, so about ${rounds} merges are needed in total. You can run the next one right away; only the final combining pass needs the earlier merges mined first. ` : "")
      + (consolidating ? "a merge is already in progress in this window; wait for it to finish." : "")
      + (!consolidating && mergePendingNow.pending ? `a previous merge (${fmtBalance(mergePendingNow.amount)} CSD) is confirming; merging more coins now is safe. ` : "")
      + "This is a normal payment to yourself: your balance only changes by the fee.";
    if (p.out <= 0) { note.textContent = "these coins are too small to cover the fee: nothing to gain by merging them."; return; } // keep Confirm down: the engine would refuse anyway
    if (!consolidating) ($("btn-consolidate-confirm") as HTMLButtonElement).disabled = false;   // keep it latched only while a merge runs in THIS popup
  } catch { note.textContent = "node unreachable: try again in a moment."; }
}
$("btn-consolidate").addEventListener("click", () => { void openConsolidatePanel(); });
$("btn-consolidate-back").addEventListener("click", () => { openPanel("settings"); renderConnectedSites(); renderCoinsInfo(); });
$("btn-consolidate-confirm").addEventListener("click", async () => {
  const btn = $("btn-consolidate-confirm") as HTMLButtonElement;
  if (btn.disabled || consolidating) return;
  btn.disabled = true; consolidating = true; // latch across the ~10s verify AND any panel reopen
  try {
    busy("verifying & merging coins… (can take ~10s)");
    const r = await call("consolidate", SEND_FEE);
    if (r.ok) {
      // Sent, not merged: the merge line under the balance says when it is mined. The next round selects
      // DISJOINT coins (the node's available view excludes this round's inputs), so "run the next merge
      // right away" is true; only the final combining pass waits on confirmations.
      msg(`merge sent (${String(r.txid).slice(0, 12)}…); confirming` + (r.remaining >= 1 ? `. ${r.remaining} coin(s) left; you can run the next merge right away` : ""), "ok sent");
      ($("consolidate-form") as HTMLElement).hidden = true;
      refreshBalance();
    } else {
      // maybe-inflight is recorded maybe:true and duplicate means the merge IS pending, so the pending
      // line takes over and Confirm stays down; any other code is a clean refusal.
      const o = refusedCopy(r, "merge");
      msg(o.text, o.cls);
      if (o.maybe) { ($("consolidate-form") as HTMLElement).hidden = true; refreshBalance(); }
      else btn.disabled = false;
    }
  } catch (e: any) {
    const o = thrownCopy(e, "merge");
    msg(o.text, o.cls);
    if (o.maybe) { ($("consolidate-form") as HTMLElement).hidden = true; refreshBalance(); }
    else btn.disabled = false;
  } finally { consolidating = false; }
});

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
// (localhost / 127.0.0.1); the default Cairn proxy is a required host_permission, so the
// common cases need no grant. The wallet refuses a remote RPC before this point (rpcAllowed);
// a remote custom API host is not in the optional set, so the request rejects (caught, false).
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
  if (!granted) return msg("not saved: host access denied (the wallet can't reach an API it has no permission for)", "err");
  await call("setApi", api);
  await call("setTradeApi", tradeApi);
  tokensCache = null; // re-read token metadata from the new endpoint
  msg("settings saved", "ok"); render();
});

// ── header dropdown menus (RPC + Explorer); one builder, two configs ──────────────────────────
// The two menus are the same visual component with different plumbing; the deltas ride in the config
// so the row markup / add-row wiring can never drift between them again. Kept distinct: the data-*
// hooks and input ids (DOM stability), the add flows (addExplorer validates → try/catch; addRpc does
// not), and the value shape (RPC rows pick a URL, explorer presets pick an id). The ACCOUNT menu is a
// different shape (identity dot, two-line rows) and stays bespoke.
type MenuEntry = { value: string; label: string; hint: string; removable: boolean };
function buildMenu(menu: HTMLElement, cfg: {
  entries: MenuEntry[];
  isActive: (v: string) => boolean;
  pickAttr: string; delAttr: string;
  addInputId: string; addBtnId: string; placeholder: string; badUrlMsg: string;
  pick: (v: string) => void;
  remove: (v: string) => Promise<void>;
  rerender: () => void;
  add: (u: string) => Promise<void> | void;
}) {
  const row = (e: MenuEntry) => `
    <div class="rpc-row${cfg.isActive(e.value) ? " active" : ""}">
      <button class="rpc-pick" ${cfg.pickAttr}="${escapeHtml(e.value)}"${cfg.isActive(e.value) ? ' aria-current="true"' : ""}><span class="rpc-label">${escapeHtml(e.label)}</span><span class="rpc-url">${escapeHtml(e.hint)}</span></button>
      ${e.removable ? `<button class="rpc-del mini" ${cfg.delAttr}="${escapeHtml(e.value)}" title="remove" aria-label="remove"><svg class="i" aria-hidden="true"><use href="icons.svg#i-x"/></svg></button>` : ""}
    </div>`;
  menu.innerHTML = cfg.entries.map(row).join("")
    + `<div class="rpc-add"><input id="${cfg.addInputId}" placeholder="${cfg.placeholder}" /><button id="${cfg.addBtnId}" class="mini">add</button></div>`;
  menu.querySelectorAll<HTMLElement>(`[${cfg.pickAttr}]`).forEach((b) => b.onclick = () => cfg.pick(b.getAttribute(cfg.pickAttr)!));
  menu.querySelectorAll<HTMLElement>(`[${cfg.delAttr}]`).forEach((b) => b.onclick = async (e) => { e.stopPropagation(); await cfg.remove(b.getAttribute(cfg.delAttr)!); cfg.rerender(); });
  ($(cfg.addBtnId) as HTMLElement).onclick = async () => {
    const u = (($(cfg.addInputId) as HTMLInputElement).value || "").trim();
    if (!/^https?:\/\/.+/.test(u)) return msg(cfg.badUrlMsg, "err");
    await cfg.add(u);
  };
}
const noProto = (u: string) => u.replace(/^https?:\/\//, "");

// A saved remote RPC was moved to the Cairn proxy at load (wallet.init); say so once, then clear the flag.
function showRpcMoved(from: string) {
  msgAction(`Your saved node RPC (${from.replace(/^https?:\/\//, "")}) is a remote server, which this wallet no longer supports. It now uses the Cairn proxy. A node on this computer can still be chosen in Settings › Network.`, "OK", () => {}, "info");
  void call("dismissRpcNotice").catch(() => { /* the notice shows again on the next open */ });
}
// ── RPC dropdown (header); preset + user-added nodes, switch with one click ──
const RPC_PRESETS = [
  { label: "Cairn proxy", url: "https://cairn-substrate.com/api/rpc" },
  { label: "Local node", url: "http://127.0.0.1:8789" },
];
async function renderRpcMenu() {
  const customs: string[] = await call("rpcList").catch(() => []);
  const preset = (u: string) => RPC_PRESETS.find((p) => p.url === u)?.label;
  buildMenu($("rpc-menu"), {
    entries: [
      ...RPC_PRESETS.map((p) => ({ value: p.url, label: p.label, hint: noProto(p.url), removable: false })),
      ...customs.filter((u) => !preset(u)).map((u) => ({ value: u, label: "Custom", hint: noProto(u), removable: true })),
    ],
    isActive: (v) => v === currentRpc,
    pickAttr: "data-url", delAttr: "data-del",
    addInputId: "rpc-add-input", addBtnId: "rpc-add-btn", placeholder: "http://127.0.0.1:port",
    badUrlMsg: "enter a local node URL (http://127.0.0.1:port or http://localhost:port)",
    pick: (v) => selectRpc(v),
    remove: (v) => call("removeRpc", v),
    rerender: renderRpcMenu,
    add: async (u) => { try { await call("addRpc", u); await selectRpc(u); } catch (e: any) { msg(e.message, "err"); } },
  });
}
async function selectRpc(url: string) {
  const granted = await ensureHostAccess([url]);
  if (!granted) return msg("RPC not switched: host access denied", "err");
  await call("setRpc", url); ($("rpc-menu") as HTMLElement).hidden = true; msg("RPC: " + url.replace(/^https?:\/\//, ""), "ok"); render();
}
$("btn-rpc").addEventListener("click", () => { const m = $("rpc-menu") as HTMLElement; if (m.hidden) { renderRpcMenu(); m.hidden = false; } else m.hidden = true; });

// ── Explorer dropdown (header, left of RPC); choose the block explorer for activity/address links ──
// Navigation-only: switching it changes where ↗ links point; it never grants fetch/host access (no ensureHostAccess).
async function renderExplorerMenu() {
  const customs: string[] = await call("explorerList").catch(() => []);
  buildMenu($("explorer-menu"), {
    entries: [
      ...EXPLORER_PRESETS.map((p) => ({ value: p.id, label: p.label, hint: noProto(p.base), removable: false })),
      ...customs.map((u) => ({ value: u, label: "Custom", hint: noProto(u), removable: true })),
    ],
    isActive: (v) => v === currentExplorer,
    pickAttr: "data-exp", delAttr: "data-delexp",
    addInputId: "exp-add-input", addBtnId: "exp-add-btn", placeholder: "https://your-explorer…",
    badUrlMsg: "enter a full explorer URL (https://…)",
    pick: (v) => selectExplorer(v),
    remove: (v) => call("removeExplorer", v),
    rerender: renderExplorerMenu,
    add: async (u) => { try { await call("addExplorer", u); await selectExplorer(u); } catch (e: any) { msg(e.message, "err"); } },
  });
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
  for (const [btnId, menuId] of [["btn-rpc", "rpc-menu"], ["btn-explorer", "explorer-menu"], ["acct-select", "acct-menu"]] as const) {
    const m = document.getElementById(menuId), b = document.getElementById(btnId);
    if (m && !m.hidden && b && !m.contains(t) && !b.contains(t)) m.hidden = true;
  }
});

$("acct-select").addEventListener("click", () => { const m = $("acct-menu") as HTMLElement; m.hidden = !m.hidden; });
$("btn-accts").addEventListener("click", () => { if (openPanel("accts-panel")) renderAccts(); });
$("btn-add-acct").addEventListener("click", async () => {
  try { const r = await call("addAccount"); msg("added " + (r.addr ? r.addr.slice(0, 10) + "…" : "account"), "ok"); render(); }
  catch (e: any) { msg(e.message, "err"); }
});
$("btn-imp-acct").addEventListener("click", async () => {
  const key = val("imp-acct-key").trim(); if (!key) return msg("paste a private key", "err");
  // A2 defense-in-depth: state the misconception up front; an imported key is NOT covered by the
  // recovery phrase, so the user learns it at import time, not at (password-gated) removal time.
  try { await call("importAccount", key, val("imp-acct-label").trim()); ($("imp-acct-key") as HTMLInputElement).value = ""; msg("account imported. Note: imported keys are NOT in your recovery phrase; keep their own backup", "ok"); render(); }
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
  sel.value = domains.includes("csd:apps") ? "csd:apps" : (domains[0] ?? "");   // an empty list selects no option either way
  sel.onchange = () => { const isCustom = sel.value === "__custom__"; custom.hidden = !isCustom; if (isCustom) custom.focus(); };
}
$("btn-activity-t").addEventListener("click", () => { if (openPanel("activity")) renderHistory(); });
$("nav-names").addEventListener("click", () => { if (openPanel("names-tab")) enterOnce($("names-list"), curAddr); });
$("csd-row").addEventListener("click", () => { openPanel("send-form"); });
$("btn-seal-t").addEventListener("click", () => { if (openPanel("seal-form")) renderSealed(); });
$("btn-seal").addEventListener("click", async () => {
  const claim = val("seal-claim").trim(); if (!claim) return msg("enter a claim to seal", "err");
  const domain = val("seal-domain").trim() || "csd:sealed";
  try { busy("sealing…"); const r = await call("sealClaim", { domain, claim });
    if (r.ok) { msg(`seal submitted · ${String(r.txid).slice(0, 12)}…; you can reveal it once it is mined`, "ok"); (($("seal-claim")) as HTMLTextAreaElement).value = ""; renderSealed(); refreshBalance(); }
    else {
      const o = refusedCopy(r, "seal");
      if (o.maybe) { (($("seal-claim")) as HTMLTextAreaElement).value = ""; renderSealed(); refreshBalance(); }
      msg(o.text, o.cls);
    }
  } catch (e: any) { const o = thrownCopy(e, "seal"); msg(o.text, o.cls); }
});
async function renderSealed() {
  const list: any[] = await call("sealedClaims");
  const el = $("seal-list");
  if (!list.length) { el.innerHTML = `<div class="dim" style="padding:6px 0">No sealed claims yet. Seal one above; it stays secret until you reveal.</div>`; return; }
  el.innerHTML = list.map((s) => {
    const when = s.committedTs ? new Date(s.committedTs).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "";
    // a maybe-path seal's anchor may never have landed (0.2.57): say so; revealing it would fail
    // its on-chain commit check, and the honest state is "verify the anchor first".
    const status = s.revealed ? `<span style="color:var(--green)">✅ revealed</span>`
      : s.maybe ? `🔒 sealed <span class="dim">(anchor may not have landed: check the txid on the explorer)</span>` : `🔒 sealed`;
    const right = s.revealed
      ? `<a href="${escapeHtml(explorerLink(currentExplorer, "tx", String(s.txid)))}" target="_blank" rel="noopener noreferrer">${String(s.txid).slice(0, 10)}… ↗</a>`
      : `<button class="mini" data-reveal="${escapeHtml(String(s.txid))}">Reveal</button>`;
    return `<div class="tx"><div class="tx-top"><span class="tx-kind">${status}</span><span class="dim">${when}</span></div>
      <div class="tx-sub"><span class="dim">${escapeHtml(String(s.claim).slice(0, 44))}</span>${right}</div></div>`;
  }).join("");
  el.querySelectorAll("[data-reveal]").forEach((b) => b.addEventListener("click", async () => {
    const id = (b as HTMLElement).dataset.reveal!; busy("revealing…");
    const r = await call("revealClaim", id);
    (r && r.ok) ? msg("revealed ✓: now public + provably committed earlier", "ok") : msg("reveal failed: " + ((r && r.error) || "?"), "err");
    renderSealed();
  }));
}
// Address-poisoning lookalike: attackers seed your history with an address that
// shares the head+tail you eyeball but differs in the middle. Flag a recipient that
// matches a previously-seen address on first 6 + last 4 hex chars but isn't identical.
// lookalikeOf (the address-poisoning heuristic) lives in ./clearsign.js and reaches this file through
// recipientStatus: one definition, so a tuning change can't land in only one of two copies of a security check.
// Two-step send: "Review" shows a confirmation with the FULL recipient address,
// amount, fee, and projected balance-after (defends against address-poisoning /
// clipboard-swap; the user verifies exactly what will be signed), warns on a
// never-seen-before recipient, and hard-flags a poisoning lookalike.
const SEND_FEE = 1_000_000; // 0.01 CSD
$("btn-send").addEventListener("click", async () => {
  const raw = val("s-to").trim();
  // Strict base-unit parse (audit AMT-1): the lax Math.round(parseFloat()) accepted "1e3" (→1000 CSD),
  // "1,000" (→1), "1abc", "+1", ".5" and half-sat rounding; so the signed amount could differ from what
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
  const [b, checks] = await Promise.all([call("balance").catch(() => null), recipientChecks(to)]);
  const { firstTime, lookalike } = checks;
  const after = b ? fmtBalance(b.confirmed - amt - SEND_FEE) + " CSD" : "";
  $("c-to").innerHTML = groupedAddr(to);           // FULL address, not truncated
  $("c-amt").textContent = fmtCsd(amt);
  $("c-fee").textContent = fmtCsd(SEND_FEE);
  $("c-after").textContent = after || "unknown";
  // A .csd send ALWAYS carries the name-service-trust caution (XREPO-1), regardless of first-time /
  // look-alike status; verifying the resolved address is the whole defense the wallet can offer here.
  // Same rule as the approval window: a negative balance-after keeps Confirm down (the engine's
  // INSUFFICIENT refusal stays the backstop). An unreadable balance does not block.
  const short = !!b && Number(b.confirmed) - amt - SEND_FEE < 0;
  const warn = composeSendWarning(lookalike, firstTime, nameCheck(rr), CSD_FLOW.noun);
  setWarn($("c-warn") as HTMLElement, short ? [{ tier: "danger", html: escapeHtml(balanceShortNote("Go back")) }, ...warn] : warn);
  ($("btn-send-confirm") as HTMLButtonElement).disabled = short;
  // freeze the reviewed values; confirm signs THIS, not the live (still-visible) inputs
  // signer snapshot (A1/POPUP-SEND-RACE-2): see the token-review note; same race, same backstop.
  reviewState.reviewedSend = { to, amt, name: rr.name ?? null, verified: rr.verified, signer: curAddr }; // snapshot verified for the L7 confirm-time regression check
  armReview(CSD_FLOW);
});
// Back: keep the draft, refresh nothing (only success clears/refreshes)
$("btn-send-back").addEventListener("click", () => teardownReview(CSD_FLOW, false));
$("btn-send-confirm").addEventListener("click", async () => {
  if (!reviewState.reviewedSend || ($("btn-send-confirm") as HTMLButtonElement).disabled) return;
  const { to, amt, name, verified, signer } = reviewState.reviewedSend;
  // a name recipient is re-resolved at sign-time: refuse if it now points somewhere else (XREPO-1) or if its
  // chain-verification regressed since review (L7); fail-closed to a re-review either way.
  if (name && !(await nameStillPointsTo(name, to, verified))) return msg(`${name}.csd changed where it points — review again`, "err");
  try {
    busy("sending…"); const r = await call("send", to, amt, SEND_FEE, signer ?? undefined);
    if (r.ok) sentOk(CSD_FLOW, "sent " + fmtCsd(amt) + " · " + String(r.txid).slice(0, 12) + "…");
    else sendRefused(CSD_FLOW, r);                    // structured refusal: show the REAL reason (FOOT-3 teardown inside)
  } catch (e: any) {
    sendThrew(CSD_FLOW, e);       // a wallet-answered throw submitted nothing; only a broken channel is ambiguous
  }
});
$("btn-name-confirm").addEventListener("click", () => doNameAction());
$("btn-name-cancel").addEventListener("click", () => {
  ($("name-action-form") as HTMLElement).hidden = true;
  dropReviews();
  msg("");
});
$("btn-post").addEventListener("click", async () => {
  const sel = ($("p-domain") as HTMLSelectElement).value;
  const domain = (sel === "__custom__" ? val("p-domain-custom").trim() : sel);
  if (!/^csd:[a-z0-9:_-]+$/i.test(domain)) return msg("pick a category or enter one like csd:tools", "err");
  if (!val("p-title").trim()) return msg("enter a title", "err");
  try {
    const feeStr = parseUnits((val("p-fee").trim() || "0.25"), 8); // strict parse (audit AMT-1); no "1e3"/"1,000"/half-sat
    if (feeStr === null) return msg("enter a valid fee (e.g. 0.25)", "err");
    const feeNum = Number(feeStr);
    if (!Number.isSafeInteger(feeNum)) return msg("fee out of range", "err"); // parity with the send-amount path (safe-integer backstop)
    const fee = Math.max(feeNum, CAIRNX_PROPOSE_FEE);
    busy("posting…");
    const r = await call("cairnPost", { domain, title: val("p-title"), body: val("p-body"), fee });
    if (r.ok) { msg("posted · " + String(r.txid).slice(0, 12) + "… (shows on Cairn once it is mined)", "ok"); refreshBalance(); }
    else {
      const o = refusedCopy(r, "post");
      if (o.maybe) refreshBalance();
      msg(o.text, o.cls);
    }
  } catch (e: any) { const o = thrownCopy(e, "post"); msg(o.text, o.cls); }
});

mountThemeControl(document, (globalThis as { CairnTheme?: CairnThemeApi }).CairnTheme);
render();
// the tab widths change once Geist has loaded
void document.fonts?.ready.then(syncNav);
if (EXT) setInterval(renderPending, 1500);
