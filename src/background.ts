// Service worker: owns the Wallet (unlocked key lives here, never in the page).
// Handles popup messages (full control) and dApp messages relayed by the content
// script. dApp WRITE/identity requests require the wallet to be unlocked AND an
// explicit user approval via the popup (pending-request queue).
import { Wallet, AUTO_LOCK_MS } from "./core/wallet.js";
import { chromeStore, chromeSessionStore } from "./core/storage.js";
import { PortRegistry } from "./core/events.js";

const chrome: any = (globalThis as any).chrome;
// session store (chrome.storage.session, in-RAM) lets an unlocked wallet survive MV3 SW idle-kills.
try { (chrome as any).storage?.session?.setAccessLevel?.({ accessLevel: "TRUSTED_CONTEXTS" }); } catch { /* older runtime */ }
const wallet = new Wallet(chromeStore(), chromeSessionStore());
const ready = wallet.init();

// pending dApp approvals: id -> {origin, method, params, resolve}
const pending = new Map<string, { origin: string; method: string; params: any; resolve: (v: any) => void }>();
let reqSeq = 0;

// Per-origin "connected sites" (MetaMask model): once the user approves a `connect`
// for an origin, that origin may READ the address (connect/getAddress) without a fresh
// prompt. This grants ADDRESS VISIBILITY ONLY — every signing / fund-moving method
// (signin/send/propose/attest/sealClaim/revealClaim) ALWAYS goes through the
// clear-signing approval window, every time, regardless of connection state. Consent
// is wiped on `reset` and revocable from the popup. Stored separately from the vault.
const consentStore = chromeStore();
const CONSENT_KEY = "connectedOrigins";
type ConsentMap = Record<string, { addr: string; ts: number }>;
async function getConsents(): Promise<ConsentMap> { return (await consentStore.get(CONSENT_KEY)) || {}; }
async function recordConsent(origin: string, addr: string): Promise<void> {
  if (!origin || origin === "unknown") return;
  const c = await getConsents();
  c[origin] = { addr, ts: Date.now() };
  await consentStore.set(CONSENT_KEY, c);
}
async function revokeConsent(origin: string): Promise<{ removed: boolean }> {
  const c = await getConsents();
  if (!c[origin]) return { removed: false };
  delete c[origin];
  await consentStore.set(CONSENT_KEY, c);
  return { removed: true };
}
async function listConsents(): Promise<{ origin: string; addr: string; ts: number }[]> {
  const c = await getConsents();
  return Object.entries(c).map(([origin, v]) => ({ origin, addr: v.addr, ts: v.ts })).sort((a, b) => b.ts - a.ts);
}

// --- Provider events (doc 28 Phase 2): push accountsChanged/disconnect to connected dApp pages. ---
// The CONTENT SCRIPT opens a long-lived port (it initiates, so no extra permission is needed); we track
// ports by their browser-set, UNFORGEABLE sender origin. We push events ONLY to the relevant origins.
// F11-safe: we NEVER push a new address — the sole account signal is `[]` ("you lost access / reconnect")
// emitted on lock, account-switch, or consent-revoke. A page must call connect() again to (re)share.
const eventRegistry = new PortRegistry();
chrome.runtime?.onConnect?.addListener((port: any) => {
  if (port?.name !== "cairn-events") return;
  const origin = port.sender?.origin || port.sender?.url || "unknown";
  eventRegistry.add(origin, port);
  port.onDisconnect?.addListener(() => eventRegistry.remove(origin, port));
});
function emitToOrigin(origin: string, event: string, data: unknown): void { eventRegistry.emitToOrigin(origin, event, data); }
// Emit ONLY to origins the user has connected (consented), never to every visited page — a random site
// the user happens to have open must not learn the wallet's lock/account-switch timing.
async function emitConnected(event: string, data: unknown): Promise<void> {
  const c = await getConsents();
  for (const origin of Object.keys(c)) emitToOrigin(origin, event, data);
}

async function runPopupMethod(method: string, args: any[]): Promise<any> {
  switch (method) {
    case "status": return wallet.status();
    case "create": return wallet.create(args[0]);
    case "restore": return wallet.restore(args[0], args[1]);
    case "import": return wallet.importKey(args[0], args[1]);
    case "unlock": return wallet.unlock(args[0]);
    case "lock": { const r = await wallet.lock(); await emitConnected("accountsChanged", []); await emitConnected("disconnect", { reason: "locked" }); return r; }
    case "addAccount": return wallet.addAccount(args[0]);
    case "importAccount": return wallet.importAccount(args[0], args[1]);
    case "switchAccount": { const r = await wallet.switchAccount(args[0]); await emitConnected("accountsChanged", []); return r; }
    case "renameAccount": return wallet.renameAccount(args[0], args[1]);
    case "removeAccount": return wallet.removeAccount(args[0], args[1]); // args[1] = password (A2: imported-key removal re-auth)
    case "balance": return wallet.balance();
    case "epoch": return wallet.epoch();
    case "tip": return wallet.tip();
    case "propose": return wallet.propose(args[0]);
    case "attest": return wallet.attest(args[0]);
    case "send": return wallet.send(args[0], args[1], args[2], args[3]); // args[3] = expectSigner (A1 popup snapshot)
    // popup-only coin maintenance (deliberately NOT in DAPP_METHODS — a dApp must not restructure the user's coins)
    case "consolidate": return wallet.consolidate(args[0]);
    case "consolidatePreview": return wallet.consolidatePreview(args[0]);
    case "pendingMerge": return wallet.pendingMerge(args[0]); // merge-in-flight probe (feeds the popup pending line); writes only its own bookkeeping latches — in READ_ONLY_METHODS because it must never extend the idle lock
    case "cairnPost": return wallet.cairnPost(args[0]);
    case "cairnSupport": return wallet.cairnSupport(args[0], args[1], args[2], args[3]);
    case "cairnxAssets": return wallet.cairnxAssets();
    case "cairnxTokens": return wallet.cairnxTokens();
    case "cairnxTransfer": return wallet.cairnxTransfer(args[0]);
    case "resolveName": return wallet.resolveName(args[0]);
    case "verifyName": return wallet.verifyName(args[0]);
    case "tokenFillQuote": return wallet.tokenFillQuote(args[0]); // M3: token-fill debit preview (read-only)
    case "cairnxNameRenew": return wallet.cairnxNameRenew(args[0], args[1], args[2]); // args[2] = expectSigner (A1)
    case "cairnxNameRenewFee": return wallet.cairnxNameRenewFee(args[0]);
    case "cairnxSetPrimary": return wallet.cairnxSetPrimary(args[0], args[1]); // args[1] = expectSigner (A1)
    case "setTradeApi": return wallet.setTradeApi(args[0]);
    case "signin": return wallet.signIn();
    case "export": return wallet.exportKey(args[0]);
    case "exportMnemonic": return wallet.exportMnemonic(args[0]);
    case "setRpc": return wallet.setRpc(args[0]);
    case "setApi": return wallet.setApi(args[0]);
    case "rpcList": return wallet.rpcList();
    case "addRpc": return wallet.addRpc(args[0]);
    case "removeRpc": return wallet.removeRpc(args[0]);
    case "setExplorer": return wallet.setExplorer(args[0]);
    case "explorerList": return wallet.explorerList();
    case "addExplorer": return wallet.addExplorer(args[0]);
    case "removeExplorer": return wallet.removeExplorer(args[0]);
    case "reset": { await consentStore.set(CONSENT_KEY, {}); return wallet.reset(); }
    case "connectedSites": return listConsents();
    case "disconnectSite": { const r = await revokeConsent(args[0]); emitToOrigin(args[0], "accountsChanged", []); emitToOrigin(args[0], "disconnect", { reason: "disconnected" }); return r; } // tell the page it lost access (audit DISC-MISSING + EIP disconnect)
    case "pending": return [...pending.entries()].map(([id, p]) => ({ id, origin: p.origin, method: p.method, params: p.params }));
    case "openApproval": return openApprovalWindow(); // raise the clear-signing window (toolbar-popup "Review")
    case "resolve": return resolvePending(args[0], args[1], args[2]); // (id, approve, displayedSigner?)
    case "flushPending": return wallet.flushPending();
    case "history": return wallet.history();
    case "sealClaim": return wallet.sealClaim(args[0]);
    case "revealClaim": return wallet.revealClaim(args[0]);
    case "sealedClaims": return wallet.sealedClaims();
    default: throw new Error("unknown method: " + method);
  }
}

async function resolvePending(id: string, approve: boolean, displayedSigner?: string): Promise<{ done: boolean; ok?: boolean; error?: string; txid?: string }> {
  const p = pending.get(id);
  if (!p) return { done: false };
  pending.delete(id);
  try { chrome.action?.setBadgeText?.({ text: pending.size ? String(pending.size) : "" }); } catch { /* no-op */ }
  // MACHINE ERROR CODES (Plan 57 B9, additive): every {ok:false} a dApp can see now also carries a
  // stable `code` (USER_REJECTED / WALLET_LOCKED / ACCOUNT_CHANGED / FIRST_PARTY_ONLY /
  // UNSUPPORTED_METHOD / RATE_LIMITED / APPROVAL_CLOSED / FORBIDDEN / UNKNOWN_KIND / INTERNAL) so
  // SDKs stop matching on human error STRINGS (which are UX copy and may change). The strings stay
  // exactly as they were: nothing existing breaks, and pre-0.2.46 consumers keep working.
  // POPUP-OUTCOME-1: resolve the dApp promise (UNCHANGED) AND report the TRUE action outcome back to the
  // approval popup, so it shows "sent ✓" / "failed: …" instead of a blanket "approved" when the signed action
  // actually failed (locked, account-switch, a network/guard reject, or a soft {ok:false} builder result).
  const finish = (out: { ok: boolean; result?: any; error?: string; code?: string }): { done: boolean; ok: boolean; error?: string; txid?: string } => {
    p.resolve(out);
    const actionOk = out.ok && (out.result?.ok !== false);
    return { done: true, ok: actionOk, error: out.error ?? (out.result?.ok === false ? out.result?.error : undefined), txid: out.result?.txid };
  };
  if (!approve) return finish({ ok: false, code: "USER_REJECTED", error: "rejected by user" });
  try {
    const st = await wallet.status();
    // unlocked implies a loaded key/address; the explicit addr check makes the invariant
    // visible to the type system (st.addr is string|null before unlock)
    if (!st.unlocked || !st.addr) return finish({ ok: false, code: "WALLET_LOCKED", error: "wallet locked" });
    // M5 (account-switch mid-approval — WYSIWYS on the SIGNER): the approval window passes the account it
    // DISPLAYED ("signing as …"). If the active account changed between review and approve (e.g. the user
    // switched accounts in the toolbar popup after the window rendered), refuse rather than silently sign/
    // disclose with the now-active account the user did NOT review. Fail-closed → reopen + re-review.
    if (typeof displayedSigner === "string" && displayedSigner && displayedSigner.toLowerCase() !== String(st.addr).toLowerCase()) {
      return finish({ ok: false, code: "ACCOUNT_CHANGED", error: "the active account changed since you reviewed this request — reopen it and review again before approving" });
    }
    let result: any;
    if (p.method === "connect" || p.method === "getAddress") {
      // The user explicitly approved address disclosure to this origin → remember it
      // (connected sites). This ONLY enables silent connect/getAddress later; it never
      // pre-approves any signing method.
      result = { addr: st.addr };
      await recordConsent(p.origin, st.addr);
    }
    // EIP-2255-style explicit permission request (prompts like connect; records per-origin consent).
    else if (p.method === "requestPermissions") {
      await recordConsent(p.origin, st.addr);
      result = [{ invoker: p.origin, accounts: [st.addr], grantedAt: Date.now() }];
    }
    else if (p.method === "signin") {
      // defense-in-depth: the queue gate (AUTH-LEGACY-1) already blocks third-party signin, but
      // never run the session-minting legacy path for a non-first-party origin even if queued.
      if (!wallet.isFirstPartyOrigin(p.origin)) return finish({ ok: false, code: "FIRST_PARTY_ONLY", error: "signIn() is first-party only; use signInWithCsd()." });
      result = await wallet.signIn();
    }
    // Audience-bound SIWC for third parties: the wallet builds the message from the ATTESTED origin
    // (p.origin) and signs it; it never mints a session, so it is safe for any origin.
    else if (p.method === "signinWithCsd") result = await wallet.signInWithCsd(p.params, p.origin);
    else if (p.method === "propose") result = await wallet.propose(p.params);
    else if (p.method === "attest") result = await wallet.attest(p.params);
    else if (p.method === "sealClaim") result = await wallet.sealClaim(p.params);
    else if (p.method === "revealClaim") result = await wallet.revealClaim(p.params);
    // Plain transfer. Reachable from a dApp ONLY through this approval path (the user
    // saw the recipient/amount/fee in the approve window). We read ONLY to/amount/fee
    // or outputs[] — never any caller-supplied inputs/UTXOs/change address; node.send*
    // selects inputs itself and returns change to the wallet's own address. Privileged
    // methods (export/restore/import/reset/settings/account mgmt) stay out of this list
    // and fall through to the throw below, so a dApp can never reach them.
    else if (p.method === "send") {
      const x = p.params || {};
      // A1: thread the DISPLAYED signer into the method so the check fires at the sign tick,
      // not only at the pre-dispatch M5 guard above (fillOffer awaits between the two). Set from
      // displayedSigner LAST so a dApp-supplied expectSigner in params can never substitute it.
      const exp = typeof displayedSigner === "string" && displayedSigner ? displayedSigner : undefined;
      result = Array.isArray(x.outputs)
        ? await wallet.sendMany({ outputs: x.outputs, fee: x.fee, expectSigner: exp })
        : await wallet.send(x.to, x.amount, x.fee, exp);
    }
    // Atomic fill (Attest + payment in one tx — CairnX DvP). Same posture as send:
    // the user clear-signed the recipient(s)/amount/fee; inputs are selected internally
    // and change only ever returns to the wallet's own address.
    else if (p.method === "fillOffer") result = await wallet.fillOffer({ ...(p.params || {}), expectSigner: typeof displayedSigner === "string" && displayedSigner ? displayedSigner : undefined });
    else throw new Error("unsupported dApp method: " + p.method);
    return finish({ ok: true, result });
  } catch (e: any) { return finish({ ok: false, code: "INTERNAL", error: e?.message ?? String(e) }); }
}

// The ONLY methods a website may invoke (must match the allowlist in resolvePending).
// Anything else is rejected before it can enter the pending queue or reach the popup UI
// — so an arbitrary attacker-chosen `method` string can never be rendered or queued.
const DAPP_METHODS = new Set(["connect", "getAddress", "signin", "signinWithCsd", "getPermissions", "requestPermissions", "revokePermissions", "propose", "attest", "sealClaim", "revealClaim", "send", "fillOffer"]);

// Pure READ / poll methods that must NOT reset the idle auto-lock. The approval window
// polls status+pending every ~1.2s (approve.ts), so if these refreshed lastActive a
// connected site could keep ≥1 request queued and hold the wallet unlocked forever,
// defeating the 15-min idle lock (WL-1/R19). Genuine user actions (unlock/send/propose/…)
// still touch(). The DENY-list is intentionally conservative — anything NOT listed here
// (i.e. any write/sign/settings method) keeps extending the unlock as before.
const READ_ONLY_METHODS = new Set(["status", "pending", "balance", "history", "epoch", "tip", "rpcList", "explorerList", "connectedSites", "sealedClaims", "cairnxAssets", "cairnxTokens", "resolveName", "tokenFillQuote", "pendingMerge"]);

// dApp request → queue for approval and pop a MetaMask-style approval window.
let approveWinId: number | null = null; // track the approval popup so we can raise it for queued requests

// Open (or focus) the dedicated clear-signing approval window. Used both when a request
// first arrives and when the user clicks "Review" in the toolbar popup — so EVERY approval
// goes through the full recipient/amount/fee/warnings disclosure, never a blind approve.
function openApprovalWindow(): Promise<{ opened: boolean }> {
  return new Promise((resolve) => {
    if (!pending.size) { resolve({ opened: false }); return; }
    if (approveWinId != null) {
      try { chrome.windows.update?.(approveWinId, { focused: true, drawAttention: true }, () => resolve({ opened: true })); return; } catch { /* fall through to create */ }
    }
    try { chrome.windows.create({ url: chrome.runtime.getURL("approve.html"), type: "popup", width: 380, height: 620, focused: true }, (w: any) => { approveWinId = w?.id ?? null; resolve({ opened: approveWinId != null }); }); }
    catch { resolve({ opened: false }); }
  });
}
// Bound the approval queue (audit NSPV-DAPP-QUEUE): a malicious page could otherwise flood the SW with
// approval requests, growing `pending` without limit, burying the user's real request and DoS-ing the
// approval UI. A legitimate dApp never has many outstanding prompts at once, so cap per-origin and global
// and reject the excess with a clear {ok:false} (never queue it) — the page is told to clear its backlog.
const MAX_PENDING_GLOBAL = 32;
const MAX_PENDING_PER_ORIGIN = 5;
function queueDappRequest(origin: string, method: string, params: any): Promise<any> {
  if (!DAPP_METHODS.has(method)) return Promise.resolve({ ok: false, code: "UNSUPPORTED_METHOD", error: "unsupported dApp method: " + String(method).slice(0, 32) });
  if (pending.size >= MAX_PENDING_GLOBAL) return Promise.resolve({ ok: false, code: "RATE_LIMITED", error: "too many pending wallet requests — approve or reject the queued ones first" });
  let perOrigin = 0; for (const p of pending.values()) if (p.origin === origin) perOrigin++;
  if (perOrigin >= MAX_PENDING_PER_ORIGIN) return Promise.resolve({ ok: false, code: "RATE_LIMITED", error: "too many pending requests from this site — approve or reject the queued ones first" });
  return new Promise((resolve) => {
    const id = `${Date.now()}-${reqSeq++}`;
    pending.set(id, { origin, method, params, resolve });
    try { chrome.action?.setBadgeText?.({ text: String(pending.size) }); } catch { /* no-op */ }
    // Raise the clear-signing window. If it can't open (rare), the request still sits in the
    // queue + badge; the user opens the toolbar popup and clicks "Review", which calls
    // openApprovalWindow again — approval ALWAYS routes through the disclosure window, never
    // a blind toolbar approve.
    openApprovalWindow().catch(() => { /* best-effort; badge still shows the count */ });
  });
}

// forget the approval window once it closes, so the next request (or "Review") reopens it
try { chrome.windows?.onRemoved?.addListener((wid: number) => {
  if (wid !== approveWinId) return;
  approveWinId = null;
  // POPUP-DISMISS-REJECT: the user closed the approval window with requests still queued. Settle those dApp
  // promises as REJECTED (MetaMask parity) instead of leaving them hanging until the 24h GC (which stranded the
  // page on an optimistic "waiting…" state — e.g. the phantom "commitment placed" card). An APPROVED request is
  // already removed from `pending` by resolvePending before the window closes, and approve.ts only auto-closes
  // the window once the queue is EMPTY, so this rejects exactly the genuinely un-actioned requests.
  if (pending.size) {
    for (const [, p] of pending) { try { p.resolve({ ok: false, code: "APPROVAL_CLOSED", error: "rejected (approval window closed)" }); } catch { /* no-op */ } }
    pending.clear();
    try { chrome.action?.setBadgeText?.({ text: "" }); } catch { /* no-op */ }
  }
}); } catch { /* no-op */ }

chrome.runtime.onMessage.addListener((msg: any, sender: any, sendResponse: (v: any) => void) => {
  (async () => {
    await ready;
    try {
      // Reset the idle auto-lock ONLY on genuine user activity (the extension's own popup
      // UI). dApp/page-relayed messages must NOT extend the unlock — otherwise a malicious
      // allowed-origin page could ping every minute (even with a rejected method) to keep
      // the wallet unlocked forever, defeating the 15-min auto-lock.
      if (msg?.kind === "popup") {
        // Defense-in-depth sender check: popup-kind messages run privileged methods (unlock / export /
        // settings / account mgmt). Today isolation rests SOLELY on the manifest having no external
        // message surface (so no external listener fires + websites can't reach this one). Assert it
        // positively too: only the extension's OWN popup/extension pages may send `popup` messages.
        // The correct discriminator vs a content-script forgery is the sender's ORIGIN, NOT the
        // presence of a tab: the approval window is opened with chrome.windows.create({type:"popup"}),
        // which runs the extension page INSIDE A TAB — so sender.tab IS populated for the legit popup
        // too. The old `|| sender?.tab` check therefore rejected the real connect/approval flow with
        // "forbidden" (empty popup). A content script's sender.url is the host web page; an extension
        // page's sender.url is chrome-extension://<our-id>/… — require exactly that. (A page cannot
        // forge sender.url; it is set by the browser.) A build/CI tripwire (test/extension-boundary.ts)
        // keeps the no-external-message-surface invariant from regressing.
        const fromExtensionPage = sender?.id === chrome.runtime.id &&
          typeof sender?.url === "string" && sender.url.startsWith(chrome.runtime.getURL(""));
        if (!fromExtensionPage) { sendResponse({ ok: false, code: "FORBIDDEN", error: "forbidden" }); return; }
        // Reset the idle auto-lock ONLY on genuine USER ACTIVITY — never on a pure read/poll. The
        // approval window status/pending-polls every ~1.2s; if those kept the wallet alive, a site
        // that always keeps ≥1 request queued would never let the 15-min idle lock fire (WL-1/R19).
        if (!READ_ONLY_METHODS.has(msg.method)) wallet.touch();
        sendResponse({ ok: true, result: await runPopupMethod(msg.method, msg.args ?? []) }); return;
      }
      if (msg?.kind === "dapp") {
        const origin = sender?.origin || sender?.url || "unknown";
        // AUTH-LEGACY-1 gate: the legacy no-arg signIn() authenticates against the wallet's OWN
        // configured api (this.api) and returns that server's SESSION TOKEN — safe only for the
        // first-party site. Reject it from any third-party origin BEFORE it can prompt, pointing
        // devs to the audience-bound signInWithCsd() (which never mints a first-party session).
        if (msg.method === "signin" && !wallet.isFirstPartyOrigin(origin)) {
          sendResponse({ ok: false, code: "FIRST_PARTY_ONLY", error: "signIn() is reserved for the wallet's first-party site; third-party sites must use the audience-bound signInWithCsd()." });
          return;
        }
        // Per-origin permission queries (EIP-2255-style), origin-scoped + silent: getPermissions reads
        // THIS origin's own grant; revokePermissions drops THIS origin's own consent. Both are keyed on
        // the unforgeable sender origin, so a page can neither see nor revoke another origin's grant — no
        // prompt needed (a read of / a self-revoke of one's own access). requestPermissions DOES prompt
        // (it grants address visibility) → it falls through to the approval queue below.
        if (msg.method === "getPermissions") {
          // F-PERM-LOCKED (Plans/68 A3): the silent getAddress path requires UNLOCKED before it
          // discloses the address; this read disclosed the consented addr even while LOCKED. Same
          // posture now: a locked wallet answers "no permissions" (not an error — a page polling
          // permissions must not learn the address, or that one exists, from a locked wallet).
          const stp = await wallet.status();
          if (!stp.unlocked) { sendResponse({ ok: true, result: [] }); return; }
          const c = (await getConsents())[origin];
          sendResponse({ ok: true, result: c ? [{ invoker: origin, accounts: [c.addr], grantedAt: c.ts }] : [] });
          return;
        }
        if (msg.method === "revokePermissions") {
          const r = await revokeConsent(origin);
          emitToOrigin(origin, "accountsChanged", []); // tell a connected page it lost access (P2.3 events)
          emitToOrigin(origin, "disconnect", { reason: "revoked" }); // make the advertised `disconnect` capability real (EIP footgun)
          sendResponse({ ok: true, result: { revoked: r.removed } });
          return;
        }
        // Fast-path for ALREADY-CONNECTED origins: connect/getAddress may resolve the
        // address WITHOUT a fresh prompt — but ONLY when (a) the method is exactly
        // connect/getAddress (address visibility), (b) the wallet is UNLOCKED, (c) the
        // origin was previously consented, AND (d) the currently-active address is the
        // SAME one the user consented to share. If the user has since switched accounts
        // (F11), the active addr differs from the stored consent addr — so we fall through
        // to a fresh approval prompt rather than silently leak the NEW (unconsented) address.
        // This is the sole "silent" path; every signing method always queues + prompts.
        if (msg.method === "connect" || msg.method === "getAddress") {
          const st = await wallet.status();
          const consentAddr = (await getConsents())[origin]?.addr;
          if (st.unlocked && consentAddr && st.addr && consentAddr.toLowerCase() === String(st.addr).toLowerCase()) {
            sendResponse({ ok: true, result: { addr: st.addr } });
            return;
          }
        }
        const res = await queueDappRequest(origin, msg.method, msg.params);
        sendResponse(res); return;
      }
      sendResponse({ ok: false, code: "UNKNOWN_KIND", error: "unknown message kind" });
    } catch (e: any) { sendResponse({ ok: false, code: "INTERNAL", error: e?.message ?? String(e) }); }
  })();
  return true; // async response
});

// Durable content registration: drain the pending queue at startup and on a
// periodic alarm. Alarms wake the service worker even after MV3 has idle-killed
// it, so a post made right before the popup closed still gets its content
// registered once the tx mines (~30-60s) — no more hash-only placeholders.
ready.then(() => wallet.flushPending().catch(() => { /* offline; retry on next alarm */ }));
// AUTO_LOCK_MS is imported from core/wallet.js so this enforced window can't drift from the wallet's
// own idle default (both were separate 15-min literals). Wipe the in-memory + session key after it.
wallet.idleMs = AUTO_LOCK_MS;        // keep the session-rehydrate window == the auto-lock window
try {
  chrome.alarms?.create("cairn-flush", { periodInMinutes: 1 });
  chrome.alarms?.create("cairn-autolock", { periodInMinutes: 1 });
  chrome.alarms?.onAlarm.addListener((a: any) => {
    if (a.name === "cairn-flush") ready.then(() => wallet.flushPending().catch(() => {}));
    if (a.name === "cairn-autolock") ready.then(async () => {
      const wasUnlocked = (await wallet.status()).unlocked;
      await wallet.autoLock(AUTO_LOCK_MS);
      if (wasUnlocked && !(await wallet.status()).unlocked) { await emitConnected("accountsChanged", []); await emitConnected("disconnect", { reason: "idle-lock" }); } // idle-lock → tell pages
    });
  });
} catch { /* alarms permission unavailable — startup flush still runs */ }
