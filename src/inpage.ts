// In-page provider: exposes window.cairn to dApps (e.g. the Cairn board). Every
// call is relayed to the extension and gated by user approval + an unlocked wallet.
// The private key is NEVER exposed to the page.
(() => {
  let seq = 0;
  const waiters = new Map<string, (v: any) => void>();
  window.addEventListener("message", (ev: MessageEvent) => {
    if (ev.source !== window || (ev.data as any)?.target !== "cairn-inpage") return;
    const { id, res } = ev.data as any;
    const w = waiters.get(id);
    if (w) { waiters.delete(id); w(res); }
  });
  const req = (method: string, params?: any) => new Promise((resolve) => {
    const id = String(seq++);
    waiters.set(id, resolve);
    window.postMessage({ target: "cairn-content", id, method, params }, "*");
  });
  (window as any).cairn = {
    isCairn: true,
    version: "0.1.0",
    connect: () => req("connect"),
    getAddress: () => req("getAddress"),
    signIn: () => req("signin"),
    propose: (p: any) => req("propose", p),
    attest: (p: any) => req("attest", p),
  };
  window.dispatchEvent(new Event("cairn#initialized"));
})();
