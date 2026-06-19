// Content script: injects the in-page provider and relays its requests to the
// background service worker (which owns the keys + approval flow).
const chrome: any = (globalThis as any).chrome;

// Per-page-load handshake secret. We hand it to the inpage provider via a data- attribute on its own
// <script> (injected here at document_start, before any page script runs) and remove it on load, then
// stamp it on every response/event we send back. The inpage side rejects any inbound message lacking it,
// so a co-present page script can't forge replies (audit SEQ-INJECT). The page never sees it: it is set
// + read + removed entirely within the document_start window before page scripts execute.
const NONCE = (() => { try { return crypto.randomUUID() + crypto.randomUUID(); } catch { return Date.now().toString(36) + Math.random().toString(36).slice(2); } })();

const s = document.createElement("script");
s.src = chrome.runtime.getURL("inpage.js");
s.dataset.cairnNonce = NONCE;
(document.head || document.documentElement).appendChild(s);
s.onload = () => { s.removeAttribute("data-cairn-nonce"); s.remove(); };

window.addEventListener("message", (ev: MessageEvent) => {
  if (ev.source !== window || ev.origin !== window.location.origin || (ev.data as any)?.target !== "cairn-content") return;
  const { id, method, params } = ev.data as any;
  chrome.runtime.sendMessage({ kind: "dapp", method, params }, (res: any) => {
    // Reply only to our own origin (not "*") — the inpage provider lives in the same page.
    window.postMessage({ target: "cairn-inpage", id, res, nonce: NONCE }, window.location.origin);
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
      window.postMessage({ target: "cairn-inpage-event", event: m.event, data: m.data, nonce: NONCE }, window.location.origin);
    });
    port.onDisconnect.addListener(() => { setTimeout(connectEvents, 1000); });
  } catch { /* extension context unavailable */ }
}
connectEvents();

export {};
