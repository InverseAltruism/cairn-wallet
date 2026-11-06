// Two views of one request. The background takes a request off the queue when a view resolves it, before the signing
// runs, so a second view that approves or rejects the same request gets { done: false } while the first one signs. The
// second view must not say nothing was signed: the request may have been approved and sent from the other view, and
// "nothing was signed" invites the site's retry, which pays twice. The REAL background service worker (its message
// listener, with a mock `chrome`), the REAL src/popup/approve.ts on helpers/approve-dom.mjs, whose channel goes to that
// listener, and the REAL toolbar band (src/popup/popup-pending.ts), bundled with esbuild and run in its own vm context
// so its document and channel are its own, as in Chrome; the other approval view is a second window's `resolve`.
//   red before (Approve): the second view read "This request was already closed; nothing was signed." while the first
//   signed and submitted the send.
//   red before (Reject, sections a and b): the second view's Reject read "Rejected. Nothing was signed." and the window
//   closed, while the first view signed and submitted the send (a); a Reject whose reply was lost read the same (b).
//   red before (toolbar Reject, sections d, e and g): the window's Approve on an owned-name renewal waited for its name
//   read; the toolbar popup, opened meanwhile, listed the renewal; the read landed and the approval took it and signed;
//   the popup's Reject then read "Rejected. Nothing was signed." while the renewal was submitted (d); a toolbar Reject
//   whose reply was lost wrote nothing and left an unhandled rejection (e); a double click sent two rejections (g).
//   red before (queued requests, sections h and i): the held outcome of a resolved request was erased the moment the
//   request queued behind it painted.
//   paired honest path: the first view's approval signs and submits once, and the page receives its txid; a Reject in a
//   single view sends resolve(id, false, signer), reads "Rejected. Nothing was signed." and closes the window (c); the
//   toolbar Reject sends resolve(id, false) and reads "Rejected. Nothing was signed." (f), also on a double click (g); a
//   confirmed Reject carries nothing to the next request, whose line is empty as before (h).
// Run: npx tsx test/approve-handled-elsewhere.test.mjs   (offline)
import vm from "node:vm";
import { build } from "esbuild";
import { checker } from "./helpers/check.mjs";
import { mountApproveWindow, loadApprove, flush, sleep } from "./helpers/approve-dom.mjs";
import { mkCoin, txReply } from "./_coin.ts";
import { CAIRNX_DOMAIN, TREASURY_ADDR, buildNameRenew } from "../src/core/cairnx.js";

const { check, done } = checker("two views of one request:");
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
// The background and the window are separate contexts, each with its own onMessage: the background's listener is
// captured here, and the window's own is put back once the background has loaded.
const windowOnMessage = globalThis.chrome.runtime.onMessage;
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
// The approval window's name read (the renewal gate) waits until the test answers it; a submit waits while `submitGate`
// holds a promise.
const nameReads = [];
let submitGate = null;
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u.includes("/cairnx/name/")) return new Promise((res) => nameReads.push(res));
  if (u.endsWith("/tip")) return { ok: true, status: 200, json: async () => ({ height: 65_000 }) };
  if (u.includes("/utxos/")) return { ok: true, status: 200, json: async () => (u.includes(me) ? { confirmed_balance: coin.coin.value, utxos: [coin.coin] } : { confirmed_balance: 0, utxos: [] }) };
  if (u.includes("/tx/submit")) { if (submitGate) await submitGate; submits.push(u); return { ok: true, status: 200, json: async () => ({ ok: true }) }; }
  return txReply(u, [coin]) ?? { ok: false, status: 404, json: async () => ({}) };
};

await import("../src/background.js");
globalThis.chrome.runtime.onMessage = windowOnMessage;
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

// The site asks for something; returns the page's promise and the queued request (the newest of that method).
async function request(method, params) {
  const pageP = dapp(method, params);
  await tick(); await tick();
  const r = (await popup("pending")).result.filter((p) => p.method === method).pop();
  return { pageP, r };
}
// The site asks for another send; view 2 paints it and arms.
async function queueSend(amount) {
  const q = await request("send", { to: TO, amount, fee: 1_000_000 });
  await pollTick(); await flush(); await sleep(760); await pollTick(); await flush();
  return q;
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


// The toolbar popup's request band, in its own context: its document holds the band and the status line, its channel
// is the background's popup channel with the action popup's sender (an extension page, no tab). `bandDropReplyTo`
// loses the reply to the next message of that method, as `dropReplyTo` does for the window.
class BandEl {
  constructor() { this.hidden = false; this.className = ""; this._text = ""; this._html = ""; this._buttons = []; this.classList = { add: () => undefined, remove: () => undefined }; }
  get textContent() { return this._text; }
  set textContent(v) { this._text = String(v); this._html = this._text; this._buttons = []; }
  get innerHTML() { return this._html; }
  set innerHTML(v) {
    this._html = String(v); this._text = this._html.replace(/<[^>]*>/g, "");
    this._buttons = [...this._html.matchAll(/<button([^>]*)>([^<]*)<\/button>/g)].map(([, attrs, label]) => ({
      dataset: Object.fromEntries([...attrs.matchAll(/data-([a-z]+)="([^"]*)"/g)].map(([, k, v]) => [k, v])), textContent: label, disabled: false, onclick: null,
    }));
  }
  querySelectorAll(sel) { const k = /^\[data-([a-z]+)\]$/.exec(sel)?.[1]; return this._buttons.filter((b) => k in b.dataset); }
  querySelector(sel) { return this.querySelectorAll(sel)[0] ?? null; }
}
const band = { pending: new BandEl(), msg: new BandEl() };
// A promise the popup leaves rejected is a page error in a browser, not the end of the page.
const bandErrors = [];
process.on("unhandledRejection", (err) => { bandErrors.push(String(err?.message ?? err)); });
// The status line fades a few seconds after it is written; each section starts with it empty.
const clearBandMsg = () => { band.msg.textContent = ""; band.msg.className = "msg"; };
const bandSent = [];
let bandDropReplyTo = null;
const POPUP_SENDER = { id: SENDER.id, url: "chrome-extension://x/popup.html" };
const bandChrome = { runtime: { lastError: undefined, sendMessage(m, cb) {
  bandSent.push([m.method, [...(m.args ?? [])]]);
  const drop = m.method === bandDropReplyTo;
  if (drop) bandDropReplyTo = null;
  listener(m, POPUP_SENDER, (r) => {
    if (!drop) return cb(r);
    bandChrome.runtime.lastError = { message: "The message port closed before a response was received." };
    cb(undefined);
    bandChrome.runtime.lastError = undefined;
  });
} } };
const bandCode = (await build({
  entryPoints: [new URL("../src/popup/popup-pending.ts", import.meta.url).pathname], bundle: true, format: "iife", globalName: "bandPage",
  platform: "browser", target: "es2022", write: false, logLevel: "warning", external: ["./devshim.js"],
})).outputFiles[0].text;
const bandCtx = vm.createContext({ document: { getElementById: (id) => band[id] ?? null }, chrome: bandChrome, window: { close: () => undefined }, setTimeout, clearTimeout, console });
vm.runInContext(bandCode, bandCtx);
const renderBand = async () => { await bandCtx.bandPage.renderPending(); await flush(); };
const rejectButton = (id) => band.pending.querySelectorAll("[data-rj]").find((b) => b.dataset.rj === id) ?? null;
const click = (b) => { if (b && !b.disabled) b.onclick?.(); };   // a disabled button gets no click, as in a browser
const bandRejects = (from) => bandSent.slice(from).filter(([m]) => m === "resolve").map(([, a]) => a);

// (d) The toolbar Reject after a delayed approval. The window's Approve on an owned-name renewal waits for the renewal
// gate's name read before the request leaves the queue; the toolbar popup, opened meanwhile, lists the renewal; the
// read lands, the approval takes the renewal and signs; then the popup's Reject. The site's call shape
// (public/trade/name-lease.js anchorRecord): the record, expiresEpoch now + 1000, the propose fee and the treasury fee.
const RENEW = buildNameRenew({ name: "satoshi" });
const d = await request("propose", { domain: CAIRNX_DOMAIN, payloadHash: RENEW.payloadHash, uri: RENEW.uri, expiresEpoch: Math.floor(65_000 / 30) + 1000, fee: 25_000_000, outputs: [{ to: TREASURY_ADDR, value: 100_000_000 }] });
await pollTick(); await flush(); await sleep(760); await pollTick(); await flush();
check(`(d) setup: the window shows the renewal with Approve live and its name read pending (${nameReads.length} read)`, d.r?.origin === ORIGIN && registry.get("btn-approve")?.disabled === false && nameReads.length === 1);
const submitsD = submits.length;
registry.get("btn-approve")._listeners.click();
await flush(20);
check("(d) the window's Approve waits for the name read: the renewal is still queued", (await popup("pending")).result.some((p) => p.id === d.r.id));
await renderBand();
check("(d) the toolbar popup, opened now, lists the renewal with its Reject", band.pending.hidden === false && rejectButton(d.r.id) !== null);
let releaseSubmit = () => undefined;
submitGate = new Promise((r) => { releaseSubmit = r; });
nameReads.shift()({ ok: true, status: 200, json: async () => ({ name: "satoshi", owner: me }) });
for (let i = 0; i < 50 && (await popup("pending")).result.some((p) => p.id === d.r.id); i++) await tick();
check(`(d) the read landed and the approval took the renewal off the queue, not submitted yet (${submits.length - submitsD} submits)`, !(await popup("pending")).result.some((p) => p.id === d.r.id) && submits.length === submitsD);
const sentD = bandSent.length;
clearBandMsg();
click(rejectButton(d.r.id));
await flush(20);
const bandD = band.msg.textContent;
check("(d) the popup sent the rejection as its production call: resolve(id, false)", sameCall(bandRejects(sentD), [d.r.id, false]));
check(`(d) the popup does not say nothing was signed (${bandD})`, !/nothing was signed/i.test(bandD));
check(`(d) the popup shows the approval window's handled-elsewhere text (${bandD})`, bandD === text && band.msg.className === "msg info");
releaseSubmit(); submitGate = null;
const pageD = await d.pageP;
await flush(20);
check(`(d) the renewal was signed and submitted, and the page received its txid (${pageD.result?.txid})`, submits.length === submitsD + 1 && /^0x[0-9a-f]{64}$/.test(String(pageD.result?.txid)));
check(`(d) the window shows it sent (${registry.get("msg").textContent})`, registry.get("msg").textContent.startsWith("Sent "));

// (e) A toolbar Reject whose reply is lost: the background rejected the request, the popup cannot know.
const e = await request("send", { to: TO, amount: 5_00000000, fee: 1_000_000 });
await renderBand();
check("(e) setup: the toolbar popup lists the send", rejectButton(e.r.id) !== null);
const submitsE = submits.length, errorsE = bandErrors.length;
clearBandMsg();
bandDropReplyTo = "resolve";
click(rejectButton(e.r.id));
await flush(20);
const bandE = band.msg.textContent;
const pageE = await e.pageP;
check(`(e) the background took the rejection: the page received USER_REJECTED (${pageE?.code})`, pageE?.ok === false && pageE?.code === "USER_REJECTED" && submits.length === submitsE);
check(`(e) the popup does not say nothing was signed (${bandE})`, !/nothing was signed/i.test(bandE));
check(`(e) the popup shows the window's could-not-be-confirmed text (${bandE})`, bandE === textB && band.msg.className === "msg err");
check(`(e) the lost reply is no page error (${bandErrors.slice(errorsE).join("; ")})`, bandErrors.length === errorsE);

// (f) Paired honest path: the ordinary toolbar Reject, with the real background answering it.
const f = await request("send", { to: TO, amount: 6_00000000, fee: 1_000_000 });
await renderBand();
const sentF = bandSent.length, submitsF = submits.length;
clearBandMsg();
click(rejectButton(f.r.id));
await flush(20);
const bandF = band.msg.textContent;
const pageF = await f.pageP;
check("(f) the popup sent the rejection as its production call: resolve(id, false)", sameCall(bandRejects(sentF), [f.r.id, false]));
check(`(f) the page received USER_REJECTED and nothing was submitted (${pageF?.code})`, pageF?.ok === false && pageF?.code === "USER_REJECTED" && submits.length === submitsF);
check(`(f) the popup says "Rejected. Nothing was signed." (${bandF})`, bandF === "Rejected. Nothing was signed." && band.msg.className === "msg info");
check("(f) the band is empty again", band.pending.hidden === true);

// (g) A double click on the toolbar Reject: one rejection, and the second click cannot turn the answer into the
// handled-elsewhere text (the request is already off the queue when it lands).
const g = await request("send", { to: TO, amount: 7_00000000, fee: 1_000_000 });
await renderBand();
const sentG = bandSent.length;
const rejectG = rejectButton(g.r.id);
clearBandMsg();
click(rejectG); click(rejectG);
await flush(20);
const bandG = band.msg.textContent;
check(`(g) a double click sends one rejection (${bandRejects(sentG).length})`, sameCall(bandRejects(sentG), [g.r.id, false]));
check(`(g) the popup says "Rejected. Nothing was signed." (${bandG})`, bandG === "Rejected. Nothing was signed." && (await g.pageP)?.code === "USER_REJECTED");

// (h) Requests queued behind the one resolved: an outcome the window holds stays above the next request, marked as the
// previous request's, until the user resolves that one; the line under the buttons is the request on screen's. Four
// sends: the first is approved in view 1 while view 2 rejects it, the second's Reject loses its reply, the third's is
// confirmed (the paired honest path: nothing carried to the fourth).
const reqHtml = () => registry.get("req").innerHTML;
const hA = await request("send", { to: TO, amount: 1_10000000, fee: 1_000_000 });
const hB = await request("send", { to: TO, amount: 1_20000000, fee: 1_000_000 });
const hC = await request("send", { to: TO, amount: 1_30000000, fee: 1_000_000 });
const hD = await request("send", { to: TO, amount: 1_40000000, fee: 1_000_000 });
await pollTick(); await flush(); await sleep(760); await pollTick(); await flush();
check("(h) setup: view 2 shows the first of four sends with Reject live", reqHtml().includes("Request 1 of 4") && registry.get("btn-reject")?.disabled === false);
const view1h = popup("resolve", hA.r.id, true, me);
for (let i = 0; i < 50 && (await popup("pending")).result.some((p) => p.id === hA.r.id); i++) await tick();
const sentH = sent.length;
registry.get("btn-reject")._listeners.click();
await view1h; await flush(20); await sleep(760); await pollTick(); await flush();
check("(h) view 2 rejected the first while view 1 signed it", sameCall(rejectsSent(sentH), [hA.r.id, false, me]) && /^0x[0-9a-f]{64}$/.test(String((await hA.pageP).result?.txid)));
check("(h) the second send is on screen", reqHtml().includes("Request 1 of 3") && reqHtml().includes(">1.2 CSD<"));
check(`(h) the handled-elsewhere text stays above it as the previous request's (${reqHtml().slice(0, 220)})`, reqHtml().includes(`Previous request: ${text}`));
check(`(h) the line under the buttons is the second send's, empty (${registry.get("msg").textContent})`, registry.get("msg").textContent === "");
await pollTick(); await flush(); await pollTick(); await flush();
check("(h) two polls later it is still there", reqHtml().includes(`Previous request: ${text}`));
const sentHB = sent.length;
dropReplyTo = "resolve";
registry.get("btn-reject")._listeners.click();
await flush(20); await sleep(760); await pollTick(); await flush();
check("(h) the user rejected the second; its reply was lost", sameCall(rejectsSent(sentHB), [hB.r.id, false, me]) && (await hB.pageP)?.code === "USER_REJECTED");
check("(h) the third send is on screen", reqHtml().includes("Request 1 of 2") && reqHtml().includes(">1.3 CSD<"));
check(`(h) above it, the second's could-not-be-confirmed text, in the error colour, and no longer the first's (${reqHtml().slice(0, 220)})`, reqHtml().includes(`Previous request: ${textB}`) && /class="req dim prior err"/.test(reqHtml()) && !reqHtml().includes(text));
const sentHC = sent.length, closesH = closes();
registry.get("btn-reject")._listeners.click();
await flush(20); await sleep(760); await pollTick(); await flush();
check("(h) the user rejected the third, confirmed", sameCall(rejectsSent(sentHC), [hC.r.id, false, me]) && (await hC.pageP)?.code === "USER_REJECTED");
check(`(h) the fourth send is on screen with nothing carried and an empty line, as before (${registry.get("msg").textContent})`, reqHtml().includes(">1.4 CSD<") && !reqHtml().includes("Request 1 of") && !reqHtml().includes("Previous request") && registry.get("msg").textContent === "");
registry.get("btn-reject")._listeners.click();
await flush(20);
check(`(h) rejecting the fourth closes the window, as before (${closes() - closesH} closes)`, (await hD.pageP)?.code === "USER_REJECTED" && closes() === closesH + 1);

// (i) The held line is the outcome as shown, not whatever the line says later: the window holds the handled-elsewhere
// text over an empty queue, the wallet locks, a new request arrives and the user unlocks in the window, which writes
// "Unlocked." to the line before the request paints.
const iA = await queueSend(1_50000000);
const view1i = popup("resolve", iA.r.id, true, me);
for (let i = 0; i < 50 && (await popup("pending")).result.some((p) => p.id === iA.r.id); i++) await tick();
registry.get("btn-reject")._listeners.click();
await view1i; await flush(20);
check(`(i) setup: the window holds the handled-elsewhere text over an empty queue (${registry.get("msg").textContent})`, registry.get("msg").textContent === text && registry.get("view-req").hidden === true);
await popup("lock");
const iB = await request("send", { to: TO, amount: 1_60000000, fee: 1_000_000 });
await pollTick(); await flush();
check("(i) setup: locked, the window asks to unlock", registry.get("view-locked").hidden === false);
registry.get("unlock-pw").value = PW;
registry.get("btn-unlock")._listeners.click();
// the unlock derives the vault key first, so wait for the paint and its arming rather than a fixed time
for (const end = Date.now() + 15_000; Date.now() < end && !(registry.get("btn-reject").disabled === false && reqHtml().includes(">1.6 CSD<"));) await sleep(25);
check(`(i) after the unlock the new send is on screen with the held text above it, not "Unlocked." (${reqHtml().slice(0, 220)})`, reqHtml().includes(">1.6 CSD<") && reqHtml().includes(`Previous request: ${text}`) && !reqHtml().includes("Previous request: Unlocked"));
registry.get("btn-reject")._listeners.click();
await flush(20);
check("(i) the new send is rejected as usual", (await iB.pageP)?.code === "USER_REJECTED");

done("approve-handled-elsewhere");
