// Popup UI controller. In the extension it messages the background service worker
// (which owns the keys); standalone (dev/E2E, no chrome.*) it drives a local Wallet
// against localStorage so the exact UI flows can be tested in a real browser.
import { call, EXT } from "./popup-bridge.js";
import { $, copyText, msg } from "./popup-dom.js";
import { syncNav } from "./popup-panels.js";
import { render } from "./popup-render.js";
import { refreshBalance } from "./popup-balance.js";
import { renderAssets } from "./popup-assets.js";
import { renderPending } from "./popup-pending.js";
import { mountThemeControl } from "./themectl.js";
import type { CairnThemeApi } from "../vendor/cairn-ui/theme.js";
// Each view binds its listeners when its module loads.
import "./popup-onboarding.js";
import "./popup-accounts.js";
import "./popup-history.js";
import "./popup-send.js";
import "./popup-tokensend.js";
import "./popup-nameaction.js";
import "./popup-receive.js";
import "./popup-secrets.js";
import "./popup-coins.js";
import "./popup-settings.js";
import "./popup-publish.js";

$("btn-lock").addEventListener("click", async () => { await call("lock"); msg("locked"); render(); });
$("btn-refresh").addEventListener("click", () => { refreshBalance(); renderAssets(); });
$("btn-copy").addEventListener("click", () => copyText("btn-copy", $("addr").textContent || ""));

mountThemeControl(document, (globalThis as { CairnTheme?: CairnThemeApi }).CairnTheme);
render();
// the tab widths change once Geist has loaded
void document.fonts?.ready.then(syncNav);
if (EXT) setInterval(renderPending, 1500);
