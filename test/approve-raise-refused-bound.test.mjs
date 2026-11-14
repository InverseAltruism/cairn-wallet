// A page that repeats a refused fill cannot hold the approval window's buttons off. Each FILL_IN_PROGRESS refusal used to
// raise the window, and each raise re-arms the request on screen (both buttons off for 700 ms): a page repeating a fill
// of a held target every 300 ms kept Approve and Reject off for as long as it ran and pulled the window forward three
// times a second, and a second origin holding its own target jammed another site's painted request the same way.
// A refusal now raises the window at most once per 5 s, whichever site sends it (background.ts REFUSED_RAISE_GAP_MS).
// The REAL background worker and the REAL approve.ts on helpers/approve-dom.mjs, wired as in
// test/approve-raise-rearm.test.mjs (this file reuses its harness).
//   RED-FIRST (src/ at v0.3.2, or REFUSED_RAISE_GAP_MS set to 0): sections 1 and 2 fail: 13 or more raises in 4.2 s and
//   both buttons live in at most 7 of about 85 samples (W1a's rearm-jam PoCs).
//   PAIRED HONEST PATHS: the first refusal still raises the window with both buttons off and they arm after 700 ms (1);
//   a refusal after the gap raises and re-arms again (3); a click after the floor approves the request on screen (4).
// test/approve-raise-chrome.test.mjs runs the cross-origin case in Chromium with the built extension loaded.
// Run: npx tsx test/approve-raise-refused-bound.test.mjs   (offline)
import { checker } from "./helpers/check.mjs";
import { mountApproveWindow, loadApprove, flush, sleep } from "./helpers/approve-dom.mjs";
import * as approveWindow from "../src/approve-window.ts";

const { check, done } = checker("a refused fill raises the approval window at most once per 5 s:");
const PW = "correct horse battery staple";
const ORIGIN = "https://dapp.example", TO = "0x" + "77".repeat(20);
const ID = "cairnwallettestid";
const WINDOW_PAGE = { id: ID, url: "chrome-extension://x/approve.html", tab: { id: 1 } };
const WORKER = { id: ID, url: "chrome-extension://x/background.js" };
const WIN = 77;
let listener = () => undefined;
const popup = (method, ...args) => new Promise((res) => listener({ kind: "popup", method, args }, WINDOW_PAGE, res));
const dapp = (method, params) => new Promise((res) => listener({ kind: "dapp", method, params }, { origin: ORIGIN, url: ORIGIN + "/trade", tab: { id: 2 } }, res));
const tick = () => new Promise((r) => setTimeout(r, 0));
const until = async (cond, n = 300) => { for (let i = 0; i < n && !cond(); i++) await tick(); return cond(); };

// The window's channel is the background's popup channel; `sent` records what the window sends. `epochGate` holds the
// window's epoch read (a propose's pre-paint read) while set.
const sent = [];
let epochGate = null;
const handlers = new Proxy({}, { get: (_, method) => async (...args) => {
  sent.push([method, args]);
  if (method === "epoch" && epochGate) await epochGate.p;
  const r = await popup(method, ...args);
  if (!r?.ok) throw new Error(r?.error ?? "error");
  return r.result;
} });
const { registry, deliver } = mountApproveWindow(handlers);
// Focus and visibility listeners the window registers, so a test can give it the focus a user's click gives.
const winEvents = {}, docEvents = {};
globalThis.window.addEventListener = (type, fn) => { (winEvents[type] ||= []).push(fn); };
globalThis.document.addEventListener = (type, fn) => { (docEvents[type] ||= []).push(fn); };
const giveFocus = () => { for (const fn of winEvents.focus ?? []) fn({ type: "focus" }); for (const fn of docEvents.visibilitychange ?? []) fn({ type: "visibilitychange" }); };

// The background's messages to the window: delivered to the window's listener on a later turn, the answer back on
// another. `windowAnswers`: "yes" as above, "never" (a hung page: no answer arrives), "none" (no receiver at all).
const windowChannel = globalThis.chrome.runtime.sendMessage;
const asks = [];
let windowAnswers = "yes";
globalThis.chrome.runtime.sendMessage = (m, cb) => {
  if (m?.kind === "popup") return windowChannel(m, cb);
  asks.push({ kind: m?.kind, at: performance.now() });
  if (windowAnswers === "never") return new Promise(() => undefined);
  if (windowAnswers === "none") return Promise.reject(new Error("Could not establish connection. Receiving end does not exist."));
  return new Promise((res) => setTimeout(() => { const a = deliver(m, WORKER); setTimeout(() => res(a?.value), 0); }, 0));
};
// Each raise: when, and whether each button was off at that moment.
const raises = [];
const button = (id) => registry.get(id);
const windowOnMessage = globalThis.chrome.runtime.onMessage;
const mem = new Map();
Object.assign(globalThis.chrome.runtime, { id: ID, getURL: (p) => "chrome-extension://x/" + p, onMessage: { addListener: (fn) => { listener = fn; } }, onConnect: { addListener: () => undefined } });
Object.assign(globalThis.chrome, {
  storage: { local: { get: async (k) => ({ [k]: structuredClone(mem.get(k)) }), set: async (o) => { for (const k of Object.keys(o)) mem.set(k, structuredClone(o[k])); }, remove: async (k) => { mem.delete(k); } } },
  alarms: { create: () => undefined, onAlarm: { addListener: () => undefined } },
  action: { setBadgeText: () => undefined },
  windows: {
    create: (_opts, cb) => { cb?.({ id: WIN }); },
    update: (id) => { raises.push({ id, at: performance.now(), approveOff: button("btn-approve").disabled, rejectOff: button("btn-reject").disabled }); },
    onRemoved: { addListener: () => undefined },
  },
});
// The renewal gate's name read waits until the test answers it; every other read misses, so nothing is ever signed.
const nameReads = [];
globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes("/cairnx/name/")) return new Promise((res) => nameReads.push(res));
  if (u.endsWith("/tip")) return { ok: true, status: 200, json: async () => ({ height: 65_000 }) };
  return { ok: false, status: 404, json: async () => ({}) };
};
// The background's clock, stepped by the test past the 5 s gap between sections (pastRaiseGap).
const realNow = performance.now.bind(performance);
let clockOffset = 0;
performance.now = () => realNow() + clockOffset;
const pastRaiseGap = () => { clockOffset += 5_000; };
await import("../src/background.js");
// The background and the window are separate contexts, each with its own onMessage.
globalThis.chrome.runtime.onMessage = windowOnMessage;
await tick();
check("setup: the popup channel creates a wallet", (await popup("create", PW)).ok === true);
const me = (await popup("status")).result.addr;

// The site asks for something; returns the page's promise and the queued request (the newest of that method).
async function request(method, params) {
  const pageP = dapp(method, params);
  await tick(); await tick();
  const r = (await popup("pending")).result.filter((p) => p.method === method).pop();
  return { pageP, r };
}
const approvesSent = (from) => sent.slice(from).filter(([m, a]) => m === "resolve" && a[1] === true).map(([, a]) => a[0]);
const queued = async (id) => (await popup("pending")).result.some((p) => p.id === id);
const live = () => button("btn-approve").disabled === false && button("btn-reject").disabled === false;
const off = () => button("btn-approve").disabled === true && button("btn-reject").disabled === true;
const shows = (text) => String(registry.get("req").innerHTML).includes(text);
let pollTick;
// The window paints the head of the queue on its next poll; resolves once the paint ended and returns that moment.
async function painted(text) {
  await pollTick();
  await until(() => shows(text));
  return performance.now();
}
const sleepUntil = async (t) => { const ms = t - performance.now(); if (ms > 0) await sleep(ms); await flush(); };
// Queues a request and returns once it paints (raising the window when one is open).
async function raisedBy(method, params) {
  const n = raises.length;
  const q = await request(method, params);
  await until(() => raises.length > n);
  return { ...q, raise: raises.at(-1), raised: raises.length > n };
}

// 0. The site's fill of its own offer: the window is created for it and paints it, arming as before.
const OFFER = "0x" + "ab".repeat(32);
const FILL = { proposalId: OFFER, outputs: [{ to: TO, value: 100_000_000 }], fee: 5_000_000 };
const fill = await request("fillOffer", FILL);
check("0. setup: the fill is queued and no window was raised yet", fill.r?.origin === ORIGIN && raises.length === 0);
pollTick = await loadApprove();
await until(() => shows(OFFER.slice(0, 10)));
check("0. honest path, a fresh request: both buttons are off when its paint ends", shows(OFFER.slice(0, 10)) && off());
await sleep(760); await flush();
check("0. honest path, a fresh request: both arm after the 700 ms floor", live());


// Repeats `send` every 300 ms for 4.2 s while sampling the buttons every 50 ms; returns the counts.
async function jam(send) {
  const raises0 = raises.length;
  let samples = 0, liveSamples = 0, refused = 0;
  const fire = setInterval(() => { send().then((r) => { if (r?.code === "FILL_IN_PROGRESS") refused++; }); }, 300);
  const sample = setInterval(() => { samples++; if (!button("btn-approve").disabled && !button("btn-reject").disabled) liveSamples++; }, 50);
  await sleep(4200);
  clearInterval(fire);
  await sleep(120); clearInterval(sample); await flush();
  return { samples, liveSamples, refused, raises: raises.length - raises0, firstRaise: raises[raises0] };
}

// 1. The site repeats a fill of its own held offer: one raise, and the buttons are live for most of the run.
{
  pastRaiseGap();
  const sent1 = sent.length;
  const r = await jam(() => dapp("fillOffer", FILL));
  console.log("  same origin:", JSON.stringify({ ...r, firstRaise: undefined }));
  check(`1. every repeat is refused FILL_IN_PROGRESS (${r.refused})`, r.refused >= 12);
  check(`1. honest path: the first refusal raised the window with both buttons off (${JSON.stringify(r.firstRaise)})`, r.firstRaise?.approveOff === true && r.firstRaise?.rejectOff === true);
  check(`1. the repeats raised the window once in 4.2 s (${r.raises})`, r.raises === 1);
  check(`1. both buttons were live in most samples (${r.liveSamples} of ${r.samples})`, r.liveSamples >= r.samples * 0.7);
  check("1. nothing was approved and the fill is still queued", approvesSent(sent1).length === 0 && await queued(fill.r.id));
}

// 2. Another origin queues a fill of its own target, then repeats it while the honest site's fill is on screen.
const EVIL = "https://evil.example";
const evil = (method, params) => new Promise((res) => listener({ kind: "dapp", method, params }, { origin: EVIL, url: EVIL + "/", tab: { id: 3 } }, res));
const OTHER = { proposalId: "0x" + "cd".repeat(32), outputs: [{ to: TO, value: 100_000_000 }], fee: 5_000_000 };
{
  void evil("fillOffer", OTHER);
  await tick(); await tick();
  const q = (await popup("pending")).result;
  check("2. setup: the honest site's fill is the head of the queue, the other origin's second", q[0]?.origin === ORIGIN && q[1]?.origin === EVIL);
  await sleep(900); await flush();
  check("2. setup: the honest fill is on screen with both buttons live", shows(OFFER.slice(0, 10)) && live());
  pastRaiseGap();
  const r = await jam(() => evil("fillOffer", OTHER));
  console.log("  cross origin:", JSON.stringify({ ...r, firstRaise: undefined }));
  check(`2. the other origin's repeats are refused FILL_IN_PROGRESS (${r.refused})`, r.refused >= 12);
  check(`2. they raised the window once in 4.2 s (${r.raises})`, r.raises === 1);
  check(`2. the honest site's fill stayed on screen with both buttons live in most samples (${r.liveSamples} of ${r.samples})`, shows(OFFER.slice(0, 10)) && r.liveSamples >= r.samples * 0.7);
}

// 3. Honest path: a refusal after the gap (a user who clicks Buy again later) raises and re-arms the window again.
{
  await sleep(760); await flush();
  const n = raises.length;
  const refusal = await dapp("fillOffer", FILL);
  await sleep(400); await flush();   // past the 250 ms answer wait, so a raise would have landed
  const inGap = raises.length === n;
  pastRaiseGap();
  const again = await dapp("fillOffer", FILL);
  await until(() => raises.length > n);
  const raise = raises.at(-1);
  check(`3. a refusal inside the gap raises nothing (${refusal?.code})`, refusal?.code === "FILL_IN_PROGRESS" && inGap);
  check(`3. honest path: a refusal after the gap raises the window with both buttons off (${again?.code}, ${JSON.stringify(raise)})`, again?.code === "FILL_IN_PROGRESS" && raises.length === n + 1 && raise?.approveOff === true && raise?.rejectOff === true);
  await sleep(760); await flush();
  check("3. honest path: both buttons arm 700 ms after that raise", live());
}

// 4. Honest path: a click after the floor approves the request on screen once.
{
  const sent4 = sent.length;
  button("btn-approve")._listeners.click();
  await flush(20);
  const answer = await Promise.race([fill.pageP, sleep(5000).then(() => null)]);
  check(`4. honest path: the click sends one approval of the honest fill (${JSON.stringify(approvesSent(sent4))})`, JSON.stringify(approvesSent(sent4)) === JSON.stringify([fill.r.id]) && answer?.ok === true);
}
done();
