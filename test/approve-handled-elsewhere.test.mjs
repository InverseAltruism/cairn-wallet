// Two approval views of one request. The background takes a request off the queue when a view resolves it, before
// the signing runs, so a second view that approves the same request gets { done: false } while the first one signs.
// The second view must not say nothing was signed: the request may have been approved and sent from the other view,
// and "nothing was signed" invites the site's retry, which pays twice. The REAL background service worker (its
// message listener, with a mock `chrome`) and the REAL src/popup/approve.ts on helpers/approve-dom.mjs, whose channel
// goes to that listener; the other view is a second window's `resolve` on the same channel.
//   red before: the second view read "This request was already closed; nothing was signed." while the first signed
//   and submitted the send.
//   paired honest path: the first view's approval signs and submits once, and the page receives its txid.
// Run: npx tsx test/approve-handled-elsewhere.test.mjs   (offline)
import { checker } from "./helpers/check.mjs";
import { mountApproveWindow, loadApprove, flush, sleep } from "./helpers/approve-dom.mjs";
import { mkCoin, txReply } from "./_coin.ts";

const { check, done } = checker("two approval views of one request:");
const PW = "correct horse battery staple";
const ORIGIN = "https://dapp.example", TO = "0x" + "77".repeat(20);
const SENDER = { id: "cairnwallettestid", url: "chrome-extension://x/approve.html", tab: { id: 1 } };
let listener = () => {};
const popup = (method, ...args) => new Promise((res) => listener({ kind: "popup", method, args }, SENDER, res));
const dapp = (method, params) => new Promise((res) => listener({ kind: "dapp", method, params }, { origin: ORIGIN }, res));
const tick = () => new Promise((r) => setTimeout(r, 0));

// The approval window's channel is the background's popup channel.
const handlers = new Proxy({}, { get: (_, method) => async (...args) => { const r = await popup(method, ...args); if (!r?.ok) throw new Error(r?.error ?? "error"); return r.result; } });
const { registry } = mountApproveWindow(handlers);
const mem = new Map();
Object.assign(globalThis.chrome.runtime, { id: SENDER.id, getURL: (p) => "chrome-extension://x/" + p, onMessage: { addListener: (fn) => { listener = fn; } }, onConnect: { addListener: () => {} } });
Object.assign(globalThis.chrome, {
  storage: { local: { get: async (k) => ({ [k]: structuredClone(mem.get(k)) }), set: async (o) => { for (const k of Object.keys(o)) mem.set(k, structuredClone(o[k])); }, remove: async (k) => { mem.delete(k); } } },
  alarms: { create: () => {}, onAlarm: { addListener: () => {} } },
  action: { setBadgeText: () => {} },
  windows: { create: () => {} },
});
const coin = mkCoin(10_00000000);
const submits = [];
let me = "";
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u.endsWith("/tip")) return { ok: true, status: 200, json: async () => ({ height: 65_000 }) };
  if (u.includes("/utxos/")) return { ok: true, status: 200, json: async () => (u.includes(me) ? { confirmed_balance: coin.coin.value, utxos: [coin.coin] } : { confirmed_balance: 0, utxos: [] }) };
  if (u.includes("/tx/submit")) { submits.push(u); return { ok: true, status: 200, json: async () => ({ ok: true }) }; }
  return txReply(u, [coin]) ?? { ok: false, status: 404, json: async () => ({}) };
};

await import("../src/background.js");
await tick();
check("setup: the popup channel creates a wallet", (await popup("create", PW)).ok === true);
me = (await popup("status")).result.addr;
const conn = dapp("connect", {});
await tick(); await tick();
const reqC = (await popup("pending")).result.find((p) => p.method === "connect");
await popup("resolve", reqC.id, true, me);
check("setup: the site is connected", (await conn).ok === true);

// The site asks for a send; the approval window (view 2) paints it and arms.
const page = dapp("send", { to: TO, amount: 1_00000000, fee: 1_000_000 });
await tick(); await tick();
const req = (await popup("pending")).result.find((p) => p.method === "send");
check("setup: the send is queued", req?.origin === ORIGIN);
const pollTick = await loadApprove();
await flush(); await sleep(760); await pollTick(); await flush();
check("setup: view 2 shows the request with Approve live", registry.get("btn-approve")?.disabled === false);

// View 1 approves first; while its signing runs, view 2 approves the same request.
const view1 = popup("resolve", req.id, true, me);
let view1Settled = false;
view1.then(() => { view1Settled = true; });
for (let i = 0; i < 50 && (await popup("pending")).result.some((p) => p.id === req.id); i++) await tick();
const concurrent = !view1Settled;
registry.get("btn-approve")._listeners.click();
const out1 = (await view1).result;
await flush(20);
const text = registry.get("msg").textContent;
check("view 2 approved while view 1 was still signing", concurrent);
check(`view 1 signed and submitted the send (${out1?.ok}, ${submits.length} submit)`, out1?.done === true && out1?.ok === true && /^0x[0-9a-f]{64}$/.test(String(out1?.txid)) && submits.length === 1);
check(`the page received the txid (${(await page).result?.txid})`, (await page).result?.txid === out1.txid);
check(`view 2 does not say nothing was signed (${text})`, !/nothing was signed/i.test(text));
check(`view 2 says the request was handled elsewhere and to check the history (${text})`, /already handled or closed/.test(text) && /Check your history before/.test(text) && registry.get("msg").className === "msg info");

done("approve-handled-elsewhere");
