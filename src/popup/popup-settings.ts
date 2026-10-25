// The Settings sheet: endpoints, the node RPC and block explorer menus, connected sites.
import { EXPLORER_PRESETS } from "../core/explorer.js";
import { escapeHtml } from "./clearsign.js";
import { EXT, call, chrome } from "./popup-bridge.js";
import { $, msg, msgAction, val } from "./popup-dom.js";
import { currentRpc, currentExplorer } from "./popup-state.js";
import { openPanel } from "./popup-panels.js";
import { forgetTokenMeta } from "./popup-assets.js";
import { renderCoinsInfo } from "./popup-coins.js";
import { render } from "./popup-render.js";

$("btn-settings").addEventListener("click", () => { if (openPanel("settings")) { renderConnectedSites(); renderCoinsInfo(); } });

// Connected sites: list the origins the user has granted address-visibility to, each
// with an instant Revoke. Revoking means that origin must prompt again on its next
// connect(). (Signing was never silent, so revoking doesn't affect fund safety.)
export async function renderConnectedSites() {
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
  forgetTokenMeta(); // re-read token metadata from the new endpoint
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
export function showRpcMoved(from: string) {
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
