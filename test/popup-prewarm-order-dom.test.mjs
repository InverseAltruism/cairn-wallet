// The popup sends `prewarmSpv` (the header build and the background sync) only once the balance has its answer, so no
// header request goes out before the balance request at unlock (invariant 10 of the WL2 design). A balance read that
// fails still lets the prewarm go. Driven through the real popup.ts and popup-render.ts against a fake DOM and a
// scripted background bridge.
// Run: npx tsx test/popup-prewarm-order-dom.test.mjs   (offline)
import { installFakeDom, installBridge, flush } from "./_fakedom.mjs";
import { checker } from "./helpers/check.mjs";

const { check, done } = checker("the popup's prewarm follows the balance answer");
installFakeDom({ autoCreate: true });
const ME = "0x" + "ab".repeat(20);
const status = { hasVault: true, unlocked: true, addr: ME, accounts: [{ label: "A1", addr: ME }], active: 0, rpc: "https://cairn-substrate.com/api/rpc", api: "https://x", tradeApi: "https://x/trade/api", explorer: "cairn", hasMnemonic: true, rpcMovedFrom: null };
let answer = null;
const gate = () => new Promise((res, rej) => { answer = { res, rej }; });
const h = {
  status: () => status,
  balance: () => gate(),
  pendingMerge: () => ({ pending: false, amount: 0, maybe: false }),
  cairnxAssets: () => ({ ok: true, balances: {}, names: [], primaryName: null, tipHeight: 1 }),
  cairnxTokens: () => ({ ok: true, tokens: [] }),
  prewarmSpv: () => ({ ok: true }),
  pending: () => [], history: () => [], sealedClaims: () => [], connectedSites: () => [], explorerList: () => [], rpcList: () => [],
  csdMarket: () => ({ ok: false }),
};
const { calls } = installBridge(h);
globalThis.setInterval = () => 0;

await import("../src/popup/popup.ts");
await flush();
const before = calls.filter((m) => m === "prewarmSpv").length;
check(`while the balance read is open, the popup has asked it (${calls.includes("balance")}) and sent no prewarm (${before})`, calls.includes("balance") && before === 0);
answer.res({ confirmed: 100e8, utxos: [] });
await flush();
const i = calls.indexOf("prewarmSpv");
check(`once it answers, the prewarm is sent, after the balance request (${calls.indexOf("balance")} < ${i})`, i > calls.indexOf("balance") && calls.filter((m) => m === "prewarmSpv").length === 1);

const { render } = await import("../src/popup/popup-render.ts");
calls.length = 0;
const again = render();
await flush();
const held = calls.filter((m) => m === "prewarmSpv").length;
answer.rej(new Error("balance unavailable"));
await again; await flush();
check(`a balance read that fails: no prewarm while open (${held}), one after the failure (${calls.filter((m) => m === "prewarmSpv").length})`, held === 0 && calls.filter((m) => m === "prewarmSpv").length === 1);

done("popup-prewarm-order-dom");
