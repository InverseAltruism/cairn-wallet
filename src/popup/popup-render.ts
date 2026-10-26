// One status read decides the view and repaints every open per-account panel.
import { explorerLink } from "../core/explorer.js";
import { groupedAddr } from "./clearsign.js";
import { call } from "./popup-bridge.js";
import { $, show } from "./popup-dom.js";
import { curAddr, currentExplorer, setCurAddr, setEndpoints } from "./popup-state.js";
import { clearSendDrafts, syncNav } from "./popup-panels.js";
import { resetRevealPanel, resetPhrasePanel } from "./popup-secrets.js";
import { renderAcctSelect, renderAccts } from "./popup-accounts.js";
import { invalidateAccountViews, renderAssets } from "./popup-assets.js";
import { forgetBalance, paintAvatar, refreshBalance } from "./popup-balance.js";
import { renderPending } from "./popup-pending.js";
import { renderHistory } from "./popup-history.js";
import { renderSealed } from "./popup-publish.js";
import { renderReceive } from "./popup-receive.js";
import { showRpcMoved } from "./popup-settings.js";

export async function render() {
  const st = await call("status");
  setEndpoints(st);
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
  $("addr").innerHTML = groupedAddr(String(st.addr || ""));
  if (st.addr !== curAddr) { setCurAddr(st.addr); clearSendDrafts(); invalidateAccountViews(); forgetBalance(); paintAvatar(null, curAddr); } // new account: old rows inert, reset identity + balance tween base
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
