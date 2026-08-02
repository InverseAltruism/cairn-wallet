// In-page provider: exposes window.cairn to dApps (e.g. the Cairn board). Every
// call is relayed to the extension and gated by user approval + an unlocked wallet.
// The private key is NEVER exposed to the page.
(() => {
  // Per-page-load secret shared with our content script via this script's `data-cairn-nonce` attribute,
  // which we clear the INSTANT we read it. Every RESPONSE/EVENT the content script sends back must carry
  // it, so a co-present page script can't forge a reply by guessing the (now-random) request id. Requests
  // we POST OUT deliberately omit the nonce (posting it on `window` would leak it); only the inbound
  // direction — the one an attacker forges — is authenticated. RESIDUAL (honest): the attribute is briefly
  // DOM-readable while this <script src> loads asynchronously, so a script running in that window could
  // read it and regain forgery capability — full isolation would need inline injection, which strict page
  // CSP blocks. This still removes the trivial "post any reply" forge and, regardless, the security-
  // critical path is unaffected: signing/connect require popup approval bound to the unforgeable sender
  // origin, and the key never reaches the page. Fail-closed: no currentScript ⇒ NONCE="" ⇒ all replies
  // rejected rather than trusted (breaks connectivity loudly, never silently downgrades).
  const NONCE = (() => {
    try {
      const el = document.currentScript as HTMLScriptElement | null;
      const n = el?.dataset?.cairnNonce;
      el?.removeAttribute("data-cairn-nonce"); // minimise the exposure window — don't wait for content's onload
      return typeof n === "string" && n ? n : "";
    } catch { return ""; }
  })();
  const newId = () => { try { return crypto.randomUUID(); } catch { return Date.now().toString(36) + Math.random().toString(36).slice(2); } };
  const waiters = new Map<string, (v: any) => void>();
  window.addEventListener("message", (ev: MessageEvent) => {
    if (ev.source !== window || (ev.data as any)?.target !== "cairn-inpage" || (ev.data as any)?.nonce !== NONCE) return;
    const { id, res } = ev.data as any;
    const w = waiters.get(id);
    if (w) { waiters.delete(id); w(res); }
  });
  const req = (method: string, params?: any) => new Promise((resolve) => {
    const id = newId(); // unguessable per-request id (was a predictable sequential int — audit SEQ-INJECT)
    waiters.set(id, resolve);
    // Target our OWN origin, not "*", so the relay message can never be delivered to a
    // cross-origin iframe embedded in the page (defence in depth; we also check source).
    window.postMessage({ target: "cairn-content", id, method, params }, window.location.origin);
  });
  // Provider events (accountsChanged / disconnect). The content script relays background pushes here
  // as { target: "cairn-inpage-event", event, data }; we fan them out to the page's registered handlers.
  const handlers: Record<string, Set<(d: any) => void>> = Object.create(null); // null-proto: on('__proto__') can't pollute Object.prototype (audit PROTO-POLLUTE)
  window.addEventListener("message", (ev: MessageEvent) => {
    if (ev.source !== window || (ev.data as any)?.target !== "cairn-inpage-event" || (ev.data as any)?.nonce !== NONCE) return;
    const { event, data } = ev.data as any;
    const set = handlers[event];
    if (set) for (const h of [...set]) { try { h(data); } catch { /* a bad handler can't break the others */ } }
  });
  const provider = Object.freeze({
    isCairn: true,
    version: "0.2.66",
    connect: () => req("connect"),
    getAddress: () => req("getAddress"),
    signIn: () => req("signin"),
    signInWithCsd: (p: any) => req("signinWithCsd", p),
    // Per-origin permissions (EIP-2255-style). getPermissions/revokePermissions are origin-scoped reads/
    // self-revoke (silent); requestPermissions prompts (grants address visibility) like connect.
    getPermissions: () => req("getPermissions"),
    requestPermissions: () => req("requestPermissions"),
    revokePermissions: () => req("revokePermissions"),
    // Event subscription (accountsChanged / disconnect). on() returns nothing; use the same handler ref
    // to removeListener. Cairn emits accountsChanged([]) on lock/account-switch/revoke (never a new addr).
    on: (event: string, handler: (d: any) => void) => { (handlers[event] ||= new Set()).add(handler); },
    removeListener: (event: string, handler: (d: any) => void) => { handlers[event]?.delete(handler); },
    getCapabilities: () => Promise.resolve({ version: "0.2.66", siwc: "1", discovery: "csd", events: ["accountsChanged", "disconnect"], methods: ["connect", "getAddress", "signIn", "signInWithCsd", "getPermissions", "requestPermissions", "revokePermissions", "propose", "attest", "send", "fillOffer", "sealClaim", "revealClaim"] }),
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
  });
  // Expose window.cairn as a NON-WRITABLE, NON-CONFIGURABLE, FROZEN provider (audit NSPV-PMR-FREEZE): a
  // co-present page script must not be able to replace a method (e.g. swap `send`) to spoof what the dApp
  // invokes. Methods stay functional — on()/removeListener() mutate a closure-captured handler map, not the
  // frozen object. Guarded so a (rare) double-injection can't throw on the non-configurable redefine.
  try {
    if (!(window as any).cairn?.isCairn) Object.defineProperty(window, "cairn", { value: provider, writable: false, configurable: false, enumerable: true });
  } catch { try { (window as any).cairn = provider; } catch { /* already non-writable — leave the existing provider */ } }
  window.dispatchEvent(new Event("cairn#initialized"));

  // Discovery (EIP-6963 analog, under our OWN `csd:` namespace — window.cairn is NOT an EIP-1193
  // provider, so we mirror the pattern rather than reuse the `eip6963:` names). Lets a dApp enumerate
  // installed wallets without the single-global collision and coexist with other extensions. The dApp
  // dispatches `csd:requestProvider`; we (re)announce a FROZEN detail {info:{uuid,name,icon,rdns},
  // provider}. Tamper-resistant: the page can't mutate the frozen detail to swap the provider.
  const uuid = (() => { try { return crypto.randomUUID(); } catch { return Date.now().toString(36) + Math.random().toString(36).slice(2); } })();
  const ICON = "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI5NiIgaGVpZ2h0PSI5NiIgdmlld0JveD0iMCAwIDk2IDk2Ij48cmVjdCB3aWR0aD0iOTYiIGhlaWdodD0iOTYiIHJ4PSIxOCIgZmlsbD0iIzBlMTExNiIvPjxnIGZpbGw9IiNlOGMzNGEiPjxlbGxpcHNlIGN4PSI0OCIgY3k9IjY2IiByeD0iMjYiIHJ5PSI5Ii8+PGVsbGlwc2UgY3g9IjQ4IiBjeT0iNDciIHJ4PSIxOSIgcnk9IjgiLz48ZWxsaXBzZSBjeD0iNDgiIGN5PSIzMSIgcng9IjEyIiByeT0iNiIvPjwvZz48L3N2Zz4=";
  const detail = Object.freeze({
    info: Object.freeze({ uuid, name: "Cairn Wallet", icon: ICON, rdns: "com.cairn-substrate.wallet" }),
    provider,
  });
  const announce = () => window.dispatchEvent(new CustomEvent("csd:announceProvider", { detail }));
  window.addEventListener("csd:requestProvider", announce as EventListener);
  announce();
})();
