// Service worker: owns the Wallet (unlocked key lives here, never in the page).
// Handles popup messages (full control) and dApp messages relayed by the content
// script. dApp WRITE/identity requests require the wallet to be unlocked AND an
// explicit user approval via the popup (pending-request queue).
import { Wallet } from "./core/wallet.js";
import { chromeStore } from "./core/storage.js";

const chrome: any = (globalThis as any).chrome;
const wallet = new Wallet(chromeStore());
const ready = wallet.init();

// pending dApp approvals: id -> {origin, method, params, resolve}
const pending = new Map<string, { origin: string; method: string; params: any; resolve: (v: any) => void }>();
let reqSeq = 0;

async function runPopupMethod(method: string, args: any[]): Promise<any> {
  switch (method) {
    case "status": return wallet.status();
    case "create": return wallet.create(args[0]);
    case "restore": return wallet.restore(args[0], args[1]);
    case "import": return wallet.importKey(args[0], args[1]);
    case "unlock": return wallet.unlock(args[0]);
    case "lock": return wallet.lock();
    case "addAccount": return wallet.addAccount(args[0]);
    case "importAccount": return wallet.importAccount(args[0], args[1]);
    case "switchAccount": return wallet.switchAccount(args[0]);
    case "renameAccount": return wallet.renameAccount(args[0], args[1]);
    case "removeAccount": return wallet.removeAccount(args[0]);
    case "balance": return wallet.balance();
    case "propose": return wallet.propose(args[0]);
    case "attest": return wallet.attest(args[0]);
    case "send": return wallet.send(args[0], args[1], args[2]);
    case "cairnPost": return wallet.cairnPost(args[0]);
    case "cairnSupport": return wallet.cairnSupport(args[0], args[1], args[2], args[3]);
    case "signin": return wallet.signIn();
    case "export": return wallet.exportKey(args[0]);
    case "exportMnemonic": return wallet.exportMnemonic(args[0]);
    case "setRpc": return wallet.setRpc(args[0]);
    case "setApi": return wallet.setApi(args[0]);
    case "rpcList": return wallet.rpcList();
    case "addRpc": return wallet.addRpc(args[0]);
    case "removeRpc": return wallet.removeRpc(args[0]);
    case "reset": return wallet.reset();
    case "pending": return [...pending.entries()].map(([id, p]) => ({ id, origin: p.origin, method: p.method, params: p.params }));
    case "openApproval": return openApprovalWindow(); // raise the clear-signing window (toolbar-popup "Review")
    case "resolve": return resolvePending(args[0], args[1]); // (id, approve)
    case "flushPending": return wallet.flushPending();
    case "history": return wallet.history();
    case "sealClaim": return wallet.sealClaim(args[0]);
    case "revealClaim": return wallet.revealClaim(args[0]);
    case "sealedClaims": return wallet.sealedClaims();
    default: throw new Error("unknown method: " + method);
  }
}

async function resolvePending(id: string, approve: boolean): Promise<{ done: boolean }> {
  const p = pending.get(id);
  if (!p) return { done: false };
  pending.delete(id);
  try { chrome.action?.setBadgeText?.({ text: pending.size ? String(pending.size) : "" }); } catch { /* no-op */ }
  if (!approve) { p.resolve({ ok: false, error: "rejected by user" }); return { done: true }; }
  try {
    const st = await wallet.status();
    if (!st.unlocked) { p.resolve({ ok: false, error: "wallet locked" }); return { done: true }; }
    let result: any;
    if (p.method === "connect" || p.method === "getAddress") result = { addr: st.addr };
    else if (p.method === "signin") result = await wallet.signIn();
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
      result = Array.isArray(x.outputs)
        ? await wallet.sendMany({ outputs: x.outputs, fee: x.fee })
        : await wallet.send(x.to, x.amount, x.fee);
    }
    else throw new Error("unsupported dApp method: " + p.method);
    p.resolve({ ok: true, result });
  } catch (e: any) { p.resolve({ ok: false, error: e?.message ?? String(e) }); }
  return { done: true };
}

// The ONLY methods a website may invoke (must match the allowlist in resolvePending).
// Anything else is rejected before it can enter the pending queue or reach the popup UI
// — so an arbitrary attacker-chosen `method` string can never be rendered or queued.
const DAPP_METHODS = new Set(["connect", "getAddress", "signin", "propose", "attest", "sealClaim", "revealClaim", "send"]);

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
function queueDappRequest(origin: string, method: string, params: any): Promise<any> {
  if (!DAPP_METHODS.has(method)) return Promise.resolve({ ok: false, error: "unsupported dApp method: " + String(method).slice(0, 32) });
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
try { chrome.windows?.onRemoved?.addListener((wid: number) => { if (wid === approveWinId) approveWinId = null; }); } catch { /* no-op */ }

chrome.runtime.onMessage.addListener((msg: any, sender: any, sendResponse: (v: any) => void) => {
  (async () => {
    await ready;
    try {
      // Reset the idle auto-lock ONLY on genuine user activity (the extension's own popup
      // UI). dApp/page-relayed messages must NOT extend the unlock — otherwise a malicious
      // allowed-origin page could ping every minute (even with a rejected method) to keep
      // the wallet unlocked forever, defeating the 15-min auto-lock.
      if (msg?.kind === "popup") { wallet.touch(); sendResponse({ ok: true, result: await runPopupMethod(msg.method, msg.args ?? []) }); return; }
      if (msg?.kind === "dapp") {
        const origin = sender?.origin || sender?.url || "unknown";
        const res = await queueDappRequest(origin, msg.method, msg.params);
        sendResponse(res); return;
      }
      sendResponse({ ok: false, error: "unknown message kind" });
    } catch (e: any) { sendResponse({ ok: false, error: e?.message ?? String(e) }); }
  })();
  return true; // async response
});

// Durable content registration: drain the pending queue at startup and on a
// periodic alarm. Alarms wake the service worker even after MV3 has idle-killed
// it, so a post made right before the popup closed still gets its content
// registered once the tx mines (~30-60s) — no more hash-only placeholders.
ready.then(() => wallet.flushPending().catch(() => { /* offline; retry on next alarm */ }));
const AUTO_LOCK_MS = 15 * 60 * 1000; // wipe the in-memory key after 15 min idle
try {
  chrome.alarms?.create("cairn-flush", { periodInMinutes: 1 });
  chrome.alarms?.create("cairn-autolock", { periodInMinutes: 1 });
  chrome.alarms?.onAlarm.addListener((a: any) => {
    if (a.name === "cairn-flush") ready.then(() => wallet.flushPending().catch(() => {}));
    if (a.name === "cairn-autolock") ready.then(() => wallet.autoLock(AUTO_LOCK_MS));
  });
} catch { /* alarms permission unavailable — startup flush still runs */ }
