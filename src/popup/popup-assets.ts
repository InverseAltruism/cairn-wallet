// The Assets and Names lists (CairnX token balances and .csd names) and a name's detail sheet; read-only.
import { formatUnits, displayDecimals, isTokenDecimals } from "../core/cairnx.js";
import { escapeHtml } from "./clearsign.js";
import { enterOnce } from "./motion.js";
import { call } from "./popup-bridge.js";
import { $ } from "./popup-dom.js";
import { curAddr, siteApi, bindView, viewCurrent, nextAccountGen, nextListGen } from "./popup-state.js";
import { dropStaleView, openPanel } from "./popup-panels.js";
import { paintAvatar, resetBalanceView, supersedeBalance } from "./popup-balance.js";
import { openTokenSend } from "./popup-tokensend.js";
import { confirmNameAction } from "./popup-nameaction.js";

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
  paintAvatar(name || null, curAddr); // the avatar follows the resolved identity (a name seeds the same avatar as its names page)
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

const LIST_LOADING = `<div class="skeleton-row"></div><div class="skeleton-row"></div>`;
// At the start of a switch: nothing drawn for the old account stays clickable, and its in-flight reads do not paint.
export function invalidateAccountViews() {
  nextAccountGen(); assetsSeq++; supersedeBalance();
  nameDetails = new Map(); ndOpen = null;
  const el = $("assets") as HTMLElement;
  el.hidden = false; el.setAttribute("aria-busy", "true"); el.innerHTML = LIST_LOADING;
  $("names-list").innerHTML = LIST_LOADING;
  $("nd-actions").innerHTML = "";
  resetBalanceView();
}
export async function renderAssets() {
  const seq = ++assetsSeq;
  const el = $("assets") as HTMLElement;
  const a = await call("cairnxAssets").catch(() => ({ ok: false }));
  if (seq !== assetsSeq) return;
  setIdentity(a?.ok ? a.primaryName : null);
  if (!a?.ok) {
    el.hidden = false;
    el.setAttribute("aria-busy", "false");
    el.innerHTML = `<div class="assets-retry dim">Token balances unavailable · <a id="assets-retry">Retry</a></div>`;
    nameDetails = new Map(); nextListGen();
    $("names-list").innerHTML = `<div class="assets-retry dim">Names unavailable: refresh the balance to try again.</div>`;
    const rt = document.getElementById("assets-retry");
    if (rt) rt.onclick = () => { el.innerHTML = `<div class="assets-retry dim">Retrying…</div>`; renderAssets(); };
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
  nameDetails = new Map(); nextListGen();
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
export let nameDetails = new Map<string, { name: string; isPending: boolean; isPrimary: boolean; lapsed: boolean; status: string }>();
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

$("nav-names").addEventListener("click", () => { if (openPanel("names-tab")) enterOnce($("names-list"), curAddr); });

export function forgetTokenMeta() { tokensCache = null; }
