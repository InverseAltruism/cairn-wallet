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
    // Target our OWN origin, not "*", so the relay message can never be delivered to a
    // cross-origin iframe embedded in the page (defence in depth; we also check source).
    window.postMessage({ target: "cairn-content", id, method, params }, window.location.origin);
  });
  (window as any).cairn = {
    isCairn: true,
    version: "0.2.21",
    connect: () => req("connect"),
    getAddress: () => req("getAddress"),
    signIn: () => req("signin"),
    propose: (p: any) => req("propose", p),
    attest: (p: any) => req("attest", p),
    // Plain CSD transfer. ALWAYS routes through the wallet's approval popup, which
    // clear-signs the full recipient(s), amount(s), fee and balance-after and warns on
    // first-time / look-alike (address-poisoning) recipients. Param is an object:
    //   { to, amount, fee? }                         single recipient
    //   { outputs: [{ to, value }, …], fee? }         1→many. The wallet always selects
    // its own inputs and returns change to itself — a page can't pick UTXOs or redirect
    // change. (Secret-key access, account management and settings stay wallet-UI-only.)
    send: (p: any) => req("send", p),
    // commit-reveal. The claim text passes through the page, but the salt (nonce)
    // is generated in the wallet and never leaves it — so the page can't forge the
    // commitment, and reveal can only be done by the wallet that sealed it.
    sealClaim: (p: any) => req("sealClaim", p),
    revealClaim: (txid: string) => req("revealClaim", txid),
    // Atomic fill (CairnX delivery-versus-payment): ONE tx = Attest(proposalId, score,
    // confidence) + payment outputs. ALWAYS clear-signed like send — the approval window
    // shows the offer id, every recipient/amount, the fee and balance-after. The wallet
    // selects its own inputs; change returns only to itself.
    //   { proposalId, outputs: [{ to, value }, …], score?, confidence?, fee? }
    fillOffer: (p: any) => req("fillOffer", p),
  };
  window.dispatchEvent(new Event("cairn#initialized"));
})();
