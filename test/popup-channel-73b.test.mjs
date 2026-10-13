// Plan 85 7.3b: the real background service worker, driven through its message listener with a mock `chrome`.
//
// (1) Dead popup-channel cases are gone. No extension page sends verifyName, signin, propose, attest or
//     flushPending on the popup channel (popup.ts and approve.ts are the only senders; grep in
//     the commit message). The dApp path runs signin/propose/attest from resolvePending, and the content
//     flush runs from the alarm, neither through runPopupMethod.
//     `reset` has no sender either but stays: its case wipes the site consents (pinned by pentest.ts §15).
//     RED-FIRST: restore any of the five cases in background.ts runPopupMethod and its row in (1) fails.
//     PAIRED HONEST PATH: (2) the methods the popup does send still answer, and a dApp propose still
//     reaches the approval queue.
// (3) A saved remote RPC is moved to the Cairn proxy when the service worker loads the wallet, the popup
//     reads the notice from status, and dismissRpcNotice clears it (popup-only, read-only for the idle lock).
//     RED-FIRST: drop the migration block in Wallet.init and (3a) fails; drop the dismissRpcNotice case and
//     (3c) fails.
//
// Run: node --import tsx test/popup-channel-73b.test.mjs   (offline)
import { checker } from "./helpers/check.mjs";

const PW = "correct horse battery staple";
const REMOTE = "https://my-node.example/rpc";
const PROXY = "https://cairn-substrate.com/api/rpc";
const mem = new Map([["rpc", REMOTE]]);
let listener = () => {};
globalThis.chrome = {
  runtime: {
    id: "cairnwallettestid", lastError: undefined, getURL: (p) => "chrome-extension://x/" + p,
    onMessage: { addListener: (fn) => { listener = fn; } }, onConnect: { addListener: () => {} },
  },
  storage: { local: {
    get: async (k) => ({ [k]: structuredClone(mem.get(k)) }),
    set: async (o) => { for (const k of Object.keys(o)) mem.set(k, structuredClone(o[k])); },
    remove: async (k) => { mem.delete(k); },
  } },
  alarms: { create: () => {}, onAlarm: { addListener: () => {} } },
  action: { setBadgeText: () => {} },
  windows: { create: () => {} },
};
globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.endsWith("/tip")) return { ok: true, status: 200, json: async () => ({ height: 65_000 }) };
  return { ok: false, status: 404, json: async () => ({}) };
};
const SENDER = { id: "cairnwallettestid", url: "chrome-extension://x/popup.html" };
const popup = (method, ...args) => new Promise((res) => listener({ kind: "popup", method, args }, SENDER, res));
const dapp = (method, params, origin) => new Promise((res) => listener({ kind: "dapp", method, params }, { origin }, res));
const tick = () => new Promise((r) => setTimeout(r, 0));

await import("../src/background.ts");
await tick();
const { check, done } = checker("popup channel (Plan 85 7.3b):");

console.log("(3) a saved remote RPC");
const st0 = (await popup("status")).result;
check("(3a) the service worker loaded the wallet on the Cairn proxy", st0?.rpc === PROXY && mem.get("rpc") === PROXY);
check("(3b) status carries the moved RPC for the popup's one-time notice", st0?.rpcMovedFrom === REMOTE);
const dis = await popup("dismissRpcNotice");
check("(3c) dismissRpcNotice answers on the popup channel and clears the notice", dis?.ok === true && (await popup("status")).result?.rpcMovedFrom === null);

check("setup: the popup channel creates a wallet", (await popup("create", PW))?.ok === true);

console.log("(1) dead popup-channel cases");
for (const m of ["verifyName", "signin", "propose", "attest", "flushPending"]) {
  const r = await popup(m, {});
  check(`(1) popup '${m}' is an unknown method`, r?.ok === false && /unknown method/.test(String(r?.error)));
}

console.log("(2) honest path");
for (const m of ["status", "pending", "rpcList", "history"]) {
  const r = await popup(m);
  check(`(2) popup '${m}' still answers`, r?.ok === true);
}
const q = dapp("propose", { domain: "csd:test", payloadHash: "0x" + "11".repeat(32), uri: "cairn:v1:x", expiresEpoch: 1, fee: 25_000_000 }, "https://a.example");
for (let i = 0; i < 5; i++) await tick();
check("(2) a dApp propose still reaches the approval queue", (await popup("pending")).result.some((p) => p.method === "propose"));
void q;

done();
