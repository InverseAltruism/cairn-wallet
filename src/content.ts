// Content script: injects the in-page provider and relays its requests to the
// background service worker (which owns the keys + approval flow).
const chrome: any = (globalThis as any).chrome;

// Per-page-load handshake secret (audit SEQ-INJECT). We hand it to the inpage provider via a data-
// attribute on its own <script> and stamp it on every response/event we send back; inpage rejects any
// inbound message lacking it (and clears the attribute the instant it reads it). Combined with the
// unpredictable per-request id, this removes the trivial response-forgery a co-present page script could
// do before (post any {target:'cairn-inpage', id} message). RESIDUAL: the attribute sits on a <script
// src> that loads asynchronously, so a page script running in that load window could read it from the DOM
// — full isolation would need inline injection (blocked by strict page CSP). The security-critical path
// is unaffected regardless: signing/connect require popup approval bound to the unforgeable sender origin,
// and the key never reaches the page. onload-removal below is a backstop in case inpage's self-clear is
// pre-empted.
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
