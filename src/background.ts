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
    case "import": return wallet.importKey(args[0], args[1]);
    case "unlock": return wallet.unlock(args[0]);
    case "lock": return wallet.lock();
    case "balance": return wallet.balance();
    case "propose": return wallet.propose(args[0]);
    case "attest": return wallet.attest(args[0]);
    case "signin": return wallet.signIn();
    case "export": return wallet.exportKey(args[0]);
    case "setRpc": return wallet.setRpc(args[0]);
    case "setApi": return wallet.setApi(args[0]);
    case "reset": return wallet.reset();
    case "pending": return [...pending.entries()].map(([id, p]) => ({ id, origin: p.origin, method: p.method, params: p.params }));
    case "resolve": return resolvePending(args[0], args[1]); // (id, approve)
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
    else throw new Error("unsupported dApp method: " + p.method);
    p.resolve({ ok: true, result });
  } catch (e: any) { p.resolve({ ok: false, error: e?.message ?? String(e) }); }
  return { done: true };
}

// dApp request → queue for approval and pop a MetaMask-style approval window.
function queueDappRequest(origin: string, method: string, params: any): Promise<any> {
  return new Promise((resolve) => {
    const wasEmpty = pending.size === 0;
    const id = `${Date.now()}-${reqSeq++}`;
    pending.set(id, { origin, method, params, resolve });
    try { chrome.action?.setBadgeText?.({ text: String(pending.size) }); } catch { /* no-op */ }
    if (wasEmpty) {
      try { chrome.windows.create({ url: chrome.runtime.getURL("approve.html"), type: "popup", width: 380, height: 620, focused: true }); }
      catch { /* fall back to badge — user opens the toolbar popup */ }
    }
  });
}

chrome.runtime.onMessage.addListener((msg: any, sender: any, sendResponse: (v: any) => void) => {
  (async () => {
    await ready;
    try {
      if (msg?.kind === "popup") { sendResponse({ ok: true, result: await runPopupMethod(msg.method, msg.args ?? []) }); return; }
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
