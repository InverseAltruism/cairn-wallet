// Two approval views of one request. The background takes a request off the queue when a view resolves it, before
// the signing runs, so a second view that approves or rejects the same request gets { done: false } while the first
// one signs. The second view must not say nothing was signed: the request may have been approved and sent from the
// other view, and "nothing was signed" invites the site's retry, which pays twice. The REAL background service worker
// (its message listener, with a mock `chrome`) and the REAL src/popup/approve.ts on helpers/approve-dom.mjs, whose
// channel goes to that listener; the other view is a second window's `resolve` on the same channel.
//   red before (Approve): the second view read "This request was already closed; nothing was signed." while the first
//   signed and submitted the send.
//   red before (Reject, sections a and b): the second view's Reject read "Rejected. Nothing was signed." and the window
//   closed, while the first view signed and submitted the send (a); a Reject whose reply was lost read the same (b).
//   paired honest path: the first view's approval signs and submits once, and the page receives its txid; a Reject in a
//   single view sends resolve(id, false, signer), reads "Rejected. Nothing was signed." and closes the window (c).
// Run: npx tsx test/approve-handled-elsewhere.test.mjs   (offline)
import { checker } from "./helpers/check.mjs";
import { mountApproveWindow, loadApprove, flush, sleep } from "./helpers/approve-dom.mjs";
import { mkCoin, txReply } from "./_coin.ts";

const { check, done } = checker("two approval views of one request:");
const PW = "correct horse battery staple";
const ORIGIN = "https://dapp.example", TO = "0x" + "77".repeat(20);
const SENDER = { id: "cairnwallettestid", url: "chrome-extension://x/approve.html", tab: { id: 1 } };
let listener = () => undefined;
const popup = (method, ...args) => new Promise((res) => listener({ kind: "popup", method, args }, SENDER, res));
const dapp = (method, params) => new Promise((res) => listener({ kind: "dapp", method, params }, { origin: ORIGIN }, res));
const tick = () => new Promise((r) => setTimeout(r, 0));

// The approval window's channel is the background's popup channel; `sent` records what the window sends on it.
const sent = [];
const handlers = new Proxy({}, { get: (_, method) => async (...args) => { sent.push([method, args]); const r = await popup(method, ...args); if (!r?.ok) throw new Error(r?.error ?? "error"); return r.result; } });
const { registry, closes } = mountApproveWindow(handlers);
// A broken channel for the next message of one method: the background receives it, and its reply never arrives
// (the port closed, as when the service worker restarts mid-call).
const deliver = globalThis.chrome.runtime.sendMessage;
let dropReplyTo = null;
globalThis.chrome.runtime.sendMessage = (m, cb) => {
  if (m.method !== dropReplyTo) return deliver(m, cb);
  dropReplyTo = null;
  deliver(m, () => {
    globalThis.chrome.runtime.lastError = { message: "The message port closed before a response was received." };
    cb(undefined);
    globalThis.chrome.runtime.lastError = undefined;
  });
};
const mem = new Map();
Object.assign(globalThis.chrome.runtime, { id: SENDER.id, getURL: (p) => "chrome-extension://x/" + p, onMessage: { addListener: (fn) => { listener = fn; } }, onConnect: { addListener: () => undefined } });
Object.assign(globalThis.chrome, {
  storage: { local: { get: async (k) => ({ [k]: structuredClone(mem.get(k)) }), set: async (o) => { for (const k of Object.keys(o)) mem.set(k, structuredClone(o[k])); }, remove: async (k) => { mem.delete(k); } } },
  alarms: { create: () => undefined, onAlarm: { addListener: () => undefined } },
  action: { setBadgeText: () => undefined },
  windows: { create: () => undefined },
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

// The site asks for another send; view 2 paints it and arms. Returns the page's promise and the queued request.
async function queueSend(amount) {
  const pageP = dapp("send", { to: TO, amount, fee: 1_000_000 });
  await tick(); await tick();
  const r = (await popup("pending")).result.find((p) => p.method === "send");
  await pollTick(); await flush(); await sleep(760); await pollTick(); await flush();
  return { pageP, r };
}
const rejectsSent = (from) => sent.slice(from).filter(([m]) => m === "resolve").map(([, a]) => a);
const sameCall = (got, want) => got.length === 1 && JSON.stringify(got[0]) === JSON.stringify(want);

// (a) View 1 approves a second send; while its signing runs, view 2 rejects the same request.
const a = await queueSend(2_00000000);
check("(a) setup: view 2 shows the second send with Reject live", a.r?.origin === ORIGIN && registry.get("btn-reject")?.disabled === false);
const closesA = closes(), sentA = sent.length;
const view1a = popup("resolve", a.r.id, true, me);
let view1aSettled = false;
view1a.then(() => { view1aSettled = true; });
for (let i = 0; i < 50 && (await popup("pending")).result.some((p) => p.id === a.r.id); i++) await tick();
const concurrentA = !view1aSettled;
registry.get("btn-reject")._listeners.click();
const out1a = (await view1a).result;
await flush(20);
const textA = registry.get("msg").textContent;
check("(a) view 2 rejected while view 1 was still signing", concurrentA);
check("(a) view 2 sent the rejection as the production call: resolve(id, false, signer)", sameCall(rejectsSent(sentA), [a.r.id, false, me]));
check(`(a) view 1 signed and submitted the send (${out1a?.ok}, ${submits.length} submits)`, out1a?.done === true && out1a?.ok === true && /^0x[0-9a-f]{64}$/.test(String(out1a?.txid)) && submits.length === 2);
check(`(a) the page received the txid (${(await a.pageP).result?.txid})`, (await a.pageP).result?.txid === out1a.txid);
check(`(a) view 2 does not say nothing was signed (${textA})`, !/nothing was signed/i.test(textA));
check(`(a) view 2 shows the Approve branch's handled-elsewhere text (${textA})`, textA === text && registry.get("msg").className === "msg info");
await pollTick(); await flush();
check(`(a) the window stays open over it, as after Approve (${closes() - closesA} closes)`, closes() === closesA && registry.get("msg").textContent === textA);

// (b) View 2 rejects a third send and the channel loses the reply: the background rejected it, the window cannot know.
const b = await queueSend(3_00000000);
check("(b) setup: view 2 shows the third send with Reject live", b.r?.origin === ORIGIN && registry.get("btn-reject")?.disabled === false);
const closesB = closes(), submitsB = submits.length;
dropReplyTo = "resolve";
registry.get("btn-reject")._listeners.click();
await flush(20);
const textB = registry.get("msg").textContent;
const pageB = await b.pageP;
check(`(b) the background took the rejection: the page received USER_REJECTED (${pageB?.code})`, pageB?.ok === false && pageB?.code === "USER_REJECTED" && submits.length === submitsB);
check(`(b) view 2 does not say nothing was signed (${textB})`, !/nothing was signed/i.test(textB));
check(`(b) view 2 says the rejection could not be confirmed and to check the history (${textB})`, textB === "The rejection could not be confirmed. Check your history before sending again." && registry.get("msg").className === "msg err");
await pollTick(); await flush();
check(`(b) the window stays open over it (${closes() - closesB} closes)`, closes() === closesB && registry.get("msg").textContent === textB);

// (c) Paired honest path: a Reject in a single view, with the real background answering it.
const c = await queueSend(4_00000000);
check("(c) setup: view 2 shows the fourth send with Reject live", c.r?.origin === ORIGIN && registry.get("btn-reject")?.disabled === false);
const closesC = closes(), sentC = sent.length, submitsC = submits.length;
registry.get("btn-reject")._listeners.click();
await flush(20);
const textC = registry.get("msg").textContent;
const pageC = await c.pageP;
check("(c) the window sent the rejection as the production call: resolve(id, false, signer)", sameCall(rejectsSent(sentC), [c.r.id, false, me]));
check(`(c) the page received USER_REJECTED and nothing was submitted (${pageC?.code})`, pageC?.ok === false && pageC?.code === "USER_REJECTED" && submits.length === submitsC);
check(`(c) the window says "Rejected. Nothing was signed." (${textC})`, textC === "Rejected. Nothing was signed." && registry.get("msg").className === "msg info");
check(`(c) no hold: the empty queue closes the window at once, as before (${closes() - closesC} closes)`, closes() === closesC + 1);

done("approve-handled-elsewhere");
