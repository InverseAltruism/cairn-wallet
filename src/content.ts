// Content script: injects the in-page provider and relays its requests to the
// background service worker (which owns the keys + approval flow).
const chrome: any = (globalThis as any).chrome;

const s = document.createElement("script");
s.src = chrome.runtime.getURL("inpage.js");
(document.head || document.documentElement).appendChild(s);
s.onload = () => s.remove();

window.addEventListener("message", (ev: MessageEvent) => {
  if (ev.source !== window || ev.origin !== window.location.origin || (ev.data as any)?.target !== "cairn-content") return;
  const { id, method, params } = ev.data as any;
  chrome.runtime.sendMessage({ kind: "dapp", method, params }, (res: any) => {
    // Reply only to our own origin (not "*") — the inpage provider lives in the same page.
    window.postMessage({ target: "cairn-inpage", id, res }, window.location.origin);
  });
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
    port.onDisconnect.addListener(() => { setTimeout(connectEvents, 1000); });
  } catch { /* extension context unavailable */ }
}
connectEvents();

export {};
