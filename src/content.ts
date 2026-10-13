// Content script: injects the in-page provider and relays its requests to the
// background service worker (which owns the keys + approval flow).
const chrome: any = (globalThis as any).chrome;

const s = document.createElement("script");
s.src = chrome.runtime.getURL("inpage.js");
(document.head || document.documentElement).appendChild(s);
s.onload = () => { s.remove(); };

window.addEventListener("message", (ev: MessageEvent) => {
  if (ev.source !== window || ev.origin !== window.location.origin || (ev.data as any)?.target !== "cairn-content") return;
  const { id, method, params } = ev.data as any;
  try {
    chrome.runtime.sendMessage({ kind: "dapp", method, params }, (res: any) => {
      // If this page was moved into the back/forward cache (or the SW dropped) before the reply arrived,
      // the channel is closed — read lastError so Chrome doesn't log "Unchecked runtime.lastError", and
      // skip posting to a now-frozen page (cosmetic; the page reconnects/re-requests on resume). Harmless.
      if (chrome.runtime.lastError) {
        // 0.2.70: a dropped SW / bfcache close used to swallow the reply, leaving window.cairn
        // hung forever. Close the waiter with a coded refusal so the page can retry / refresh.
        window.postMessage({
          target: "cairn-inpage", id,
          res: { ok: false, error: "the wallet is unavailable — it may have reloaded; refresh this page to reconnect", code: "WALLET_UNAVAILABLE" },
        }, window.location.origin);
        return;
      }
      // Reply only to our own origin (not "*") — the inpage provider lives in the same page.
      window.postMessage({ target: "cairn-inpage", id, res }, window.location.origin);
    });
  } catch {
    // The extension was updated/reloaded and THIS page still runs the orphaned content script: its
    // chrome.runtime is invalidated and sendMessage THROWS ("Extension context invalidated"). Without
    // this catch the dApp saw an uncaught error and its call hung forever. Resolve the call with a
    // clean, actionable error instead; the page works again after a refresh (fresh content script).
    window.postMessage({ target: "cairn-inpage", id, res: { ok: false, error: "WALLET_RELOADED: the wallet extension was updated or reloaded - refresh this page to reconnect" } }, window.location.origin);
  }
});

// Provider events: open a long-lived port to the background and relay its pushes to the inpage provider.
// The CONTENT SCRIPT initiates the connection, so no extra permission is needed; the background learns
// this page's origin from the (unforgeable) port sender. On MV3 service-worker idle the port may drop —
// reconnect lazily so later events still arrive. Only background-originated event messages are relayed.
function connectEvents() {
  try {
    const port = chrome.runtime.connect({ name: "cairn-events" });
    port.onMessage.addListener((m: any) => {
      if (m?.kind !== "cairn-event") return;
      window.postMessage({ target: "cairn-inpage-event", event: m.event, data: m.data }, window.location.origin);
    });
    port.onDisconnect.addListener(() => {
      // reconnect only while the extension context is still alive; an orphaned (post-update)
      // content script must not throw once a second trying to reach a dead runtime
      setTimeout(() => { try { if (chrome.runtime?.id) connectEvents(); } catch { /* context gone */ } }, 1000);
    });
  } catch { /* extension context unavailable */ }
}
connectEvents();

export {};
