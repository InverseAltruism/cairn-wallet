// The account switcher in the header and the Accounts sheet (rename, remove, add, import).
import { checkRow, escapeHtml, groupedAddr, short } from "./clearsign.js";
import { avatarGradient, identitySeed } from "./identicon.js";
import { call } from "./popup-bridge.js";
import { $, msg, val } from "./popup-dom.js";
import { clearSendDrafts, closeAllPanels, openPanel, syncNav } from "./popup-panels.js";
import { invalidateAccountViews } from "./popup-assets.js";
import { render } from "./popup-render.js";

// Custom account switcher (same visual system as the Explorer/RPC dropdowns; the native
// <select> popup can't be styled and clashed with them). Each row carries the account's
// identity-gradient dot (avatarGradient output is numbers-only: injection-safe by construction).
export function renderAcctSelect(accounts: { addr: string; label: string }[], active: number) {
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
  try { await call("switchAccount", i); msg("Switched account.", "ok"); render(); }
  catch (err: any) { msg(err.message, "err"); render(); }
}
// per-row inline edit state (rename/remove) so we never use a browser prompt/confirm
let acctEdit: { addr: string; mode: "rename" | "remove" } | null = null;
export async function renderAccts() {
  const st = await call("status");
  const el = $("accts-list");
  el.innerHTML = (st.accounts || []).map((a: any, i: number) => {
    const editing = acctEdit && acctEdit.addr.toLowerCase() === a.addr.toLowerCase();
    const tag = a.imported ? ` <span class="badge">Imported</span>` : "";
    let right: string;
    if (editing && acctEdit!.mode === "rename") {
      right = `<span class="row" style="gap:6px">
          <input class="acct-rename-input" data-addr="${escapeHtml(a.addr)}" value="${escapeHtml(a.label)}" />
          <button class="mini" data-save="${escapeHtml(a.addr)}">Save</button>
          <button class="mini" data-cancel="1">Cancel</button></span>`;
    } else if (editing && a.imported) {
      // A2 (Plans/68 F4): an imported key is NOT in the recovery phrase; a one-click remove was
      // permanent fund loss. Removal is password-gated (the background enforces it; this UI collects
      // it) with the irreversibility spelled out. HD accounts below keep the frictionless yes/no.
      right = `<span class="row" style="gap:6px">
          <input class="acct-remove-pw" type="password" data-addr="${escapeHtml(a.addr)}" placeholder="Wallet password" style="width:110px" />
          <button class="mini" data-confirm-remove="${escapeHtml(a.addr)}" data-imported="1">Remove</button>
          <button class="mini" data-cancel="1">no</button></span>`;
    } else if (editing) {
      right = `<span class="row" style="gap:6px"><span class="dim" style="font-size:11px">Remove?</span>
          <button class="mini" data-confirm-remove="${escapeHtml(a.addr)}">Yes</button>
          <button class="mini" data-cancel="1">no</button></span>`;
    } else {
      right = `<span class="row" style="gap:6px">
          <button class="mini" data-rename="${escapeHtml(a.addr)}">Rename</button>
          ${(st.accounts.length > 1) ? `<button class="mini" data-remove="${escapeHtml(a.addr)}">Remove</button>` : ""}</span>`;
    }
    const removeWarn = editing && acctEdit!.mode === "remove" && a.imported
      ? checkRow({ tier: "danger", html: "This imported key is <b>not</b> in your recovery phrase: removing it without a saved backup loses its funds forever. Export it first (More › Reveal key), then enter your password to confirm." })
      : "";
    return `<div class="tx">
      <div class="tx-top"><span class="tx-kind">${i === st.active ? "● " : ""}${escapeHtml(a.label)}${tag}</span>${right}</div>
      <div class="tx-sub"><code class="addr dim">${groupedAddr(String(a.addr))}</code></div>${removeWarn}
    </div>`;
  }).join("");
  const edit = (addr: string | undefined, mode: "rename" | "remove") => { if (addr) { acctEdit = { addr, mode }; renderAccts(); } };
  el.querySelectorAll<HTMLElement>("[data-rename]").forEach((b) => b.onclick = () => edit(b.dataset.rename, "rename"));
  el.querySelectorAll<HTMLElement>("[data-remove]").forEach((b) => b.onclick = () => edit(b.dataset.remove, "remove"));
  el.querySelectorAll<HTMLElement>("[data-cancel]").forEach((b) => b.onclick = () => { acctEdit = null; renderAccts(); });
  el.querySelectorAll<HTMLElement>("[data-save]").forEach((b) => b.onclick = async () => {
    const inp = el.querySelector(`.acct-rename-input[data-addr="${b.dataset.save}"]`) as HTMLInputElement | null;
    const label = inp?.value.trim(); if (!label) return msg("Enter a label.", "err");
    try { await call("renameAccount", b.dataset.save, label); acctEdit = null; renderAccts(); render(); } catch (e: any) { msg(e.message, "err"); }
  });
  el.querySelectorAll<HTMLElement>("[data-confirm-remove]").forEach((b) => b.onclick = async () => {
    // imported rows carry a password field (A2); HD rows pass no password and stay one-click.
    const pwInp = b.dataset.imported ? el.querySelector(`.acct-remove-pw[data-addr="${b.dataset.confirmRemove}"]`) as HTMLInputElement | null : null;
    if (b.dataset.imported && !pwInp?.value) return msg("Enter your wallet password to remove an imported key.", "err");
    try {
      await call("removeAccount", b.dataset.confirmRemove, ...(pwInp?.value ? [pwInp.value] : []));
      acctEdit = null; msg("Account removed.", "ok"); renderAccts(); render();
    } catch (e: any) {
      const m = String(e?.message || e);
      msg(m === "REMOVE_IMPORTED_REAUTH" ? "Enter your wallet password to remove an imported key." : m, "err");
    }
  });
  const ri = el.querySelector(".acct-rename-input") as HTMLInputElement | null;
  if (ri) { ri.focus(); ri.select(); ri.onkeydown = (e: any) => { if (e.key === "Enter") (el.querySelector("[data-save]") as HTMLElement)?.click(); if (e.key === "Escape") { acctEdit = null; renderAccts(); } }; }
}

$("acct-select").addEventListener("click", () => { const m = $("acct-menu") as HTMLElement; m.hidden = !m.hidden; });
$("btn-accts").addEventListener("click", () => { if (openPanel("accts-panel")) renderAccts(); });
$("btn-add-acct").addEventListener("click", async () => {
  try { const r = await call("addAccount"); msg("Added " + (r.addr ? r.addr.slice(0, 10) + "…" : "an account") + ".", "ok"); render(); }
  catch (e: any) { msg(e.message, "err"); }
});
$("btn-imp-acct").addEventListener("click", async () => {
  const key = val("imp-acct-key").trim(); if (!key) return msg("Paste a private key.", "err");
  // A2 defense-in-depth: state the misconception up front; an imported key is NOT covered by the
  // recovery phrase, so the user learns it at import time, not at (password-gated) removal time.
  try { await call("importAccount", key, val("imp-acct-label").trim()); ($("imp-acct-key") as HTMLInputElement).value = ""; msg("Account imported. Imported keys are not in your recovery phrase: keep their own backup.", "ok"); render(); }
  catch (e: any) { msg(e.message, "err"); }
});
