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

export {};
