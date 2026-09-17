// Dev/E2E popup shim: drives a local Wallet against localStorage when chrome.runtime
// is absent. MUST NOT load in the packaged extension — a static Wallet import in
// popup.ts would embed the signing class in popup.js. This module throws at load if
// the extension message surface exists, so a mistaken static import fails closed.
import { Wallet } from "../core/wallet.js";
import { localStore } from "../core/storage.js";

const chromeRef = (globalThis as { chrome?: { runtime?: { sendMessage?: unknown } } }).chrome;
if (chromeRef?.runtime?.sendMessage) {
  throw new Error("devshim must not load in the extension — chrome.runtime.sendMessage is present");
}

let dev: Wallet | null = null;
async function devWallet(): Promise<Wallet> {
  if (!dev) { dev = new Wallet(localStore()); await dev.init(); }
  return dev;
}

// Forward the same privileged methods the background runPopupMethod switch exposes,
// including expectSigner on spend paths and the remove-account password (A2).
export async function runDevPopupMethod(method: string, args: any[]): Promise<any> {
  const w = await devWallet();
  switch (method) {
    case "status": return w.status();
    case "create": return w.create(args[0]);
    case "restore": return w.restore(args[0], args[1]);
    case "import": return w.importKey(args[0], args[1]);
    case "unlock": return w.unlock(args[0]);
    case "lock": return w.lock();
    case "addAccount": return w.addAccount(args[0]);
    case "importAccount": return w.importAccount(args[0], args[1]);
    case "switchAccount": return w.switchAccount(args[0]);
    case "renameAccount": return w.renameAccount(args[0], args[1]);
    case "removeAccount": return w.removeAccount(args[0], args[1]);
    case "balance": return w.balance();
    case "prewarmSpv": { w.prewarmSpv(); return { ok: true }; }
    case "epoch": return w.epoch();
    case "tip": return w.tip();
    case "tipFloor": return w.tipFloor();
    case "send": return w.send(args[0], args[1], args[2], args[3]);
    case "consolidate": return w.consolidate(args[0]);
    case "consolidatePreview": return w.consolidatePreview(args[0]);
    case "pendingMerge": return w.pendingMerge(args[0]);
    case "cairnPost": return w.cairnPost(args[0]);
    case "cairnxAssets": return w.cairnxAssets();
    case "cairnxTokens": return w.cairnxTokens();
    case "cairnxTransfer": return w.cairnxTransfer(args[0]);
    case "resolveName": return w.resolveName(args[0]);
    case "confirmName": return w.confirmName(args[0]);
    case "verifyName": return w.verifyName(args[0]);
    case "tokenFillQuote": return w.tokenFillQuote(args[0]);
    case "cairnxNameRenew": return w.cairnxNameRenew(args[0], args[1], args[2]);
    case "cairnxNameRenewFee": return w.cairnxNameRenewFee(args[0]);
    case "cairnxSetPrimary": return w.cairnxSetPrimary(args[0], args[1]);
    case "setTradeApi": return w.setTradeApi(args[0]);
    case "export": return w.exportKey(args[0]);
    case "exportMnemonic": return w.exportMnemonic(args[0]);
    case "setRpc": return w.setRpc(args[0]);
    case "setApi": return w.setApi(args[0]);
    case "rpcList": return w.rpcList();
    case "addRpc": return w.addRpc(args[0]);
    case "removeRpc": return w.removeRpc(args[0]);
    case "setExplorer": return w.setExplorer(args[0]);
    case "explorerList": return w.explorerList();
    case "addExplorer": return w.addExplorer(args[0]);
    case "removeExplorer": return w.removeExplorer(args[0]);
    case "history": return w.history();
    case "sealClaim": return w.sealClaim(args[0]);
    case "sealedClaims": return w.sealedClaims();
    case "revealClaim": return w.revealClaim(args[0]);
    case "connectedSites": return [];
    case "disconnectSite": return { ok: true };
    case "pending": return [];
    case "resolve": return { done: true };
    case "openApproval": return { opened: false };
    case "flushPending": return w.flushPending();
    default: throw new Error("unknown " + method);
  }
}
