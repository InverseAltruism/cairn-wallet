// A raise the wallet makes re-arms the approval window. The REAL background worker (its message listener and
// focusApprovalWindow, with a mock `chrome`) and the REAL src/popup/approve.ts on helpers/approve-dom.mjs, wired as in
// Chrome: the window's calls go to the background's popup channel, the background's runtime messages reach the window's
// listener on a later turn, and chrome.windows.update records the buttons the window showed when it was raised.
// The attack: a site whose request is on screen with Approve live (a fill of its own offer needs no connection) waits
// while the user is on its page, asks for a double click, and sends a request on the first click that makes the wallet
// raise the window (a fill naming the held target is refused FILL_IN_PROGRESS and brings the window forward; a newly
// queued request raises it too); the second click then lands on the raised window's Approve.
//   RED-FIRST (src/ at 379c08b): the window was raised with Approve live, and a click right after the raise approved the
//   fill (1). Drop the re-arm in approve.ts's listener and 1 fails again; drop the arm sequence check in armButtons and 5
//   fails; drop the painted-request check and 6 fails; drop the reset of the floor mark a verdict reads and 9 fails.
//   PAIRED HONEST PATHS: a fresh request's window arms as before (0); a click after the floor approves once (2); a focus
//   the user gives the window re-arms nothing, and the click approves at once (4); the window answers a content script's
//   message with nothing (7); a window that cannot answer is still raised (8).
//   ONE HOME: chrome.windows.update appears once in src/, inside focusApprovalWindow (10).
// test/approve-raise-chrome.test.mjs runs the same raise in Chromium with the built extension loaded.
// Run: npx tsx test/approve-raise-rearm.test.mjs   (offline)
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { checker } from "./helpers/check.mjs";
import { mountApproveWindow, loadApprove, flush, sleep } from "./helpers/approve-dom.mjs";
import * as approveWindow from "../src/approve-window.ts";
import { CAIRNX_DOMAIN, TREASURY_ADDR, buildNameRenew } from "../src/core/cairnx.js";

const { check, done } = checker("a raise the wallet makes re-arms the approval window:");
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

// 1. The user is on the site's page; its first click asks for the same fill, which is refused and raises the window.
{
  const sent0 = sent.length, asks0 = asks.length, raises0 = raises.length;
  const refusal = await dapp("fillOffer", FILL);
  check(`1. the site's second fill of its held offer is refused FILL_IN_PROGRESS (${refusal?.code})`, refusal?.ok === false && refusal?.code === "FILL_IN_PROGRESS");
  await until(() => raises.length > raises0);
  const raise = raises.at(-1);
  check(`1. the refusal raised the window (${raises.length - raises0} raise)`, raises.length === raises0 + 1 && raise?.id === WIN);
  check(`1. the background asked the window before it raised it (${asks.length - asks0} asks)`, asks.length === asks0 + 1 && asks[asks0]?.kind === approveWindow.APPROVE_REARM && asks[asks0].at <= raise.at);
  check(`1. when the window was raised, Approve and Reject were off (Approve off ${raise?.approveOff}, Reject off ${raise?.rejectOff})`, raise?.approveOff === true && raise?.rejectOff === true);
  // The site's second click lands on the raised window's Approve.
  const clickAt = performance.now();
  button("btn-approve")._listeners.click();
  await flush(20);
  check(`1. a click on Approve ${Math.round(clickAt - raise.at)} ms after the raise is ignored: no approval sent, the fill still queued`, approvesSent(sent0).length === 0 && await queued(fill.r.id));
  // 2. Paired honest path: once the floor has run, a click approves the fill once.
  await sleepUntil(raise.at + 760);
  check("2. honest path: both buttons arm 700 ms after the raise", live());
  const sent2 = sent.length;
  button("btn-approve")._listeners.click();
  await flush(20);
  const answer = await Promise.race([fill.pageP, sleep(5000).then(() => null)]);
  check(`2. honest path: a click after the floor sends one approval of the fill (${JSON.stringify(approvesSent(sent2))})`, JSON.stringify(approvesSent(sent2)) === JSON.stringify([fill.r.id]) && !(await queued(fill.r.id)));
  // Every read misses here, so the approved fill's checks refuse it before anything is signed.
  check(`2. honest path: the approval ran the fill's checks, and the site gets their answer (${answer?.result?.code})`, answer?.ok === true && answer.result?.ok === false && answer.result.code === "OFFER_UNKNOWN");
}

// 3. Any request the wallet queues while the window is open raises it the same way (the class before the fill hold).
const send3 = await raisedBy("send", { to: TO, amount: 1_00000000, fee: 1_000_000 });
check(`3. a newly queued request raises the open window after asking it (${send3.raised})`, send3.raised && asks.at(-1)?.at <= send3.raise.at);

// 4. A focus the user gives the window is not a raise: the click lands at once.
{
  await painted("1 CSD");
  await sleep(760); await flush();
  check("4. setup: the send is on screen with both buttons live", live());
  const sent4 = sent.length;
  giveFocus();
  button("btn-approve")._listeners.click();
  await flush(20);
  check(`4. honest path: after a focus the user gives the window, a click at once approves the send (${JSON.stringify(approvesSent(sent4))})`, JSON.stringify(approvesSent(sent4)) === JSON.stringify([send3.r.id]));
  await Promise.race([send3.pageP, sleep(5000)]);
}

// 5. A raise during a paint's own floor holds the buttons for 700 ms from the raise, not from the paint.
{
  const t = await raisedBy("send", { to: TO, amount: 5_00000000, fee: 1_000_000 });
  const paintedAt = await painted("5 CSD");
  await sleep(350);
  const u = await raisedBy("send", { to: TO, amount: 6_00000000, fee: 1_000_000 });
  check(`5. setup: the second send raised the window ${Math.round(u.raise.at - paintedAt)} ms after the first one painted`, u.raised && u.raise.at - paintedAt < 700);
  await sleepUntil(paintedAt + 760);
  check(`5. both buttons are still off past the paint's own floor (${Math.round(performance.now() - u.raise.at)} ms after the raise)`, off());
  await sleepUntil(u.raise.at + 760);
  check("5. honest path: both arm 700 ms after the raise", live());
  // Reject the first; the second paints next.
  button("btn-reject")._listeners.click();
  await until(() => shows("6 CSD"));
  await sleep(760); await flush();
  check("5. setup: the second send is on screen with both buttons live", live() && !!t.r && !!u.r);
}

// 6. A raise while the next request is still being painted arms nothing early: the paint arms when it ends.
{
  epochGate = {}; epochGate.p = new Promise((r) => { epochGate.open = r; });
  const v = await raisedBy("propose", { domain: "example:v1", payloadHash: "0x" + "cd".repeat(32), uri: "data:,hello", expiresEpoch: 3_000, fee: 25_000_000 });
  await sleep(760); await flush();
  button("btn-reject")._listeners.click();   // the second send leaves; the propose's paint waits on its epoch read
  await until(() => sent.some(([m]) => m === "epoch"));
  await sleep(50);
  const w = await raisedBy("send", { to: TO, amount: 7_00000000, fee: 1_000_000 });
  check("6. setup: a request queued while the propose is being painted raised the window", w.raised && !shows("example:v1"));
  await sleepUntil(w.raise.at + 760);
  check("6. 700 ms after that raise, the buttons are still off: the propose is not painted yet", off() && !shows("example:v1"));
  epochGate.open(); epochGate = null;
  const paintedAt = performance.now();
  await until(() => shows("example:v1"));
  check("6. the propose paints once its read lands, with both buttons off", shows("example:v1") && off());
  await sleepUntil(paintedAt + 760);
  check("6. honest path: they arm after the paint's floor", live() && !!v.r);
  button("btn-reject")._listeners.click();
  await until(() => shows("7 CSD"));
  await sleep(760); await flush();
}

// 7. The window hears only the extension's own tabless contexts: a page's content script carries its tab.
{
  check("7. setup: the third send is on screen with both buttons live", live());
  const a = deliver({ kind: approveWindow.APPROVE_REARM }, { id: ID, url: ORIGIN + "/trade", tab: { id: 2 } });
  check(`7. a re-arm from a content script gets no answer and leaves both buttons live (${JSON.stringify(a)})`, a === undefined && live());
  const b = deliver({ kind: approveWindow.APPROVE_REARM }, WORKER);
  check(`7. the same message from the worker re-arms the request on screen and is answered (${JSON.stringify(b)})`, b !== undefined && off());
  await sleep(760); await flush();
}

// 8. A window that cannot answer is still raised: at once when nothing receives the message, after the wait when the
// page never answers.
{
  windowAnswers = "none";
  const x = await raisedBy("send", { to: TO, amount: 8_00000000, fee: 1_000_000 });
  check(`8. no receiver: the window is raised at once (${x.raised})`, x.raised);
  windowAnswers = "never";
  const n = raises.length;
  const askedAt = performance.now();
  await request("send", { to: TO, amount: 9_00000000, fee: 1_000_000 });
  await sleep(100);
  check(`8. a page that never answers: no raise within 100 ms (${raises.length - n})`, raises.length === n);
  await sleep(300);
  check(`8. a page that never answers: the window is raised after the 250 ms wait (${raises.length - n} raise, ${Math.round((raises.at(-1)?.at ?? 0) - askedAt)} ms)`, raises.length === n + 1);
  windowAnswers = "yes";
  // Clear the queue: the third send, then the two above.
  for (let i = 0; i < 3; i++) { await sleep(760); await flush(); button("btn-reject")._listeners.click(); await flush(20); await pollTick(); await flush(); }
}

// 9. A renewal's gate verdict that lands during a raise's floor does not end the floor.
{
  const RENEW = buildNameRenew({ name: "satoshi" });
  const r = await raisedBy("propose", { domain: CAIRNX_DOMAIN, payloadHash: RENEW.payloadHash, uri: RENEW.uri, expiresEpoch: Math.floor(65_000 / 30) + 1000, fee: 25_000_000, outputs: [{ to: TREASURY_ADDR, value: 100_000_000 }] });
  await painted("satoshi");
  await sleep(760); await flush();
  check(`9. setup: the renewal is on screen with Approve live and its name read pending (${nameReads.length} read)`, live() && nameReads.length === 1 && !!r.r);
  const z = await raisedBy("send", { to: TO, amount: 10_00000000, fee: 1_000_000 });
  check("9. setup: a newly queued request raised the window and the buttons are off", z.raised && off());
  nameReads.shift()({ ok: true, status: 200, json: async () => ({ name: "satoshi", owner: me }) });
  await flush(20);
  check(`9. the passing verdict that lands ${Math.round(performance.now() - z.raise.at)} ms after the raise leaves Approve off`, button("btn-approve").disabled === true);
  await sleepUntil(z.raise.at + 760);
  check("9. honest path: Approve arms when the raise's floor has run", live());
}

// 10. Every raise of an open window goes through focusApprovalWindow: a second chrome.windows.update would raise the
// window without the re-arm.
{
  const ROOT = join(import.meta.dirname, "..");
  const hits = [];
  const walk = (dir) => { for (const e of readdirSync(join(ROOT, dir))) {
    const rel = `${dir}/${e}`;
    if (statSync(join(ROOT, rel)).isDirectory()) { if (e !== "vendor") walk(rel); }
    else if (/\.(ts|js|mjs)$/.test(e)) for (const _ of readFileSync(join(ROOT, rel), "utf8").matchAll(/windows\.update\b/g)) hits.push(rel);
  } };
  walk("src");
  const bg = readFileSync(join(ROOT, "src/background.ts"), "utf8");
  const body = bg.slice(bg.indexOf("function focusApprovalWindow("), bg.indexOf("\nfunction openApprovalWindow("));
  check(`10. chrome.windows.update appears once in src/, inside focusApprovalWindow (${hits.join(", ")})`, hits.length === 1 && hits[0] === "src/background.ts" && /chrome\.windows\.update/.test(body));
}
done();
