// The real background service worker's approval queue caps and the window-close rejection, driven through its
// onMessage listener with a mock chrome: the 6th pending request from one site and the 33rd overall are refused
// RATE_LIMITED without queueing, and closing the approval window settles every queued request APPROVAL_CLOSED.
//
// RED-FIRST: raise MAX_PENDING_PER_ORIGIN or MAX_PENDING_GLOBAL in src/background.ts by one and the matching
// refusal check fails; remove the onRemoved settlement loop and the APPROVAL_CLOSED checks fail. The window opens at
// APPROVE_WINDOW, the size test/approve-layout-chrome.test.mjs measures its page at: put a literal size back in
// background.ts and the window-size check fails.
// PAIRED HONEST PATHS: the 5th request from a site queues; a site under its own cap queues while another site is
// full; another window closing leaves the queue alone; after the close the queue takes requests again.
//
// Run: npx tsx test/background-queue-caps.test.mjs   (offline)
import assert from "node:assert/strict";
import { APPROVE_WINDOW } from "../src/approve-window.ts";

let n = 0;
const test = async (name, fn) => { await fn(); n++; console.log("  ok " + name); };
const tick = () => new Promise((r) => setTimeout(r, 0));
const settle = async () => { for (let i = 0; i < 10; i++) await tick(); };

const WIN = 77;
const mem = new Map();
const badges = [];
const created = [];
let onRemoved = null;
const chrome = {
  runtime: {
    id: "cairnwallettestid", lastError: undefined,
    getURL: (p) => "chrome-extension://x/" + p,
    onMessage: { addListener: (fn) => { chrome.listener = fn; } },
    onConnect: { addListener: () => {} },
  },
  storage: { local: {
    get: async (k) => ({ [k]: structuredClone(mem.get(k)) }),
    set: async (o) => { for (const k of Object.keys(o)) mem.set(k, structuredClone(o[k])); },
    remove: async (k) => { mem.delete(k); },
  } },
  alarms: { create: () => {}, onAlarm: { addListener: () => {} } },
  action: { setBadgeText: ({ text }) => { badges.push(text); } },
  windows: {
    create: (opts, cb) => { created.push(opts); cb?.({ id: WIN }); },
    update: () => {},
    onRemoved: { addListener: (fn) => { onRemoved = fn; } },
  },
};
globalThis.chrome = chrome;
globalThis.fetch = async () => ({ ok: false, status: 404, json: async () => ({}) });
await import("../src/background.ts");

const popup = (method, ...args) => new Promise((res) => chrome.listener({ kind: "popup", method, args }, { id: "cairnwallettestid", url: "chrome-extension://x/popup.html" }, res));
/** A dApp request as the content script relays it; `reply` holds the answer once the worker responds. */
const queued = [];
function dapp(origin, method = "send", params = { to: "0x" + "11".repeat(20), amount: 1e7, fee: 1e6 }) {
  const out = { origin, reply: undefined };
  chrome.listener({ kind: "dapp", method, params }, { origin }, (r) => { out.reply = r; });
  return out;
}
const pendingCount = async () => (await popup("pending")).result.length;
const PER_ORIGIN = { ok: false, code: "RATE_LIMITED", error: "too many pending requests from this site; approve or reject the queued ones first" };
const GLOBAL = { ok: false, code: "RATE_LIMITED", error: "too many pending wallet requests; approve or reject the queued ones first" };
const CLOSED = { ok: false, code: "APPROVAL_CLOSED", error: "rejected (approval window closed)" };
const site = (i) => `https://site${i}.test`;

console.log("approval queue caps (32 overall, 5 per site) and APPROVAL_CLOSED:");

await test("the first five requests from one site queue (honest path) and the sixth is refused RATE_LIMITED without queueing", async () => {
  for (let i = 0; i < 5; i++) queued.push(dapp(site(1)));
  await settle();
  assert.ok(queued.every((r) => r.reply === undefined), "queued requests have no answer yet");
  assert.equal(await pendingCount(), 5);
  const sixth = dapp(site(1));
  await settle();
  assert.deepEqual(sixth.reply, PER_ORIGIN);
  assert.equal(await pendingCount(), 5, "the refused request was not queued");
});

await test("the approval window opens once, as a popup at APPROVE_WINDOW (the size its layout is measured at)", async () => {
  assert.equal(created.length, 1);
  assert.deepEqual([created[0].type, created[0].width, created[0].height], ["popup", APPROVE_WINDOW.width, APPROVE_WINDOW.height]);
});

await test("honest path: a second site under its own cap queues while the first site is full", async () => {
  const r = dapp(site(2));
  await settle();
  assert.equal(r.reply, undefined);
  queued.push(r);
  assert.equal(await pendingCount(), 6);
});

await test("the 32nd request overall queues and the 33rd is refused RATE_LIMITED with the global reason", async () => {
  for (let i = 1; i < 5; i++) queued.push(dapp(site(2)));
  for (let s = 3; s <= 6; s++) for (let i = 0; i < 5; i++) queued.push(dapp(site(s)));
  await settle();
  assert.equal(await pendingCount(), 30);
  queued.push(dapp(site(7)), dapp(site(7)));
  await settle();
  assert.ok(queued.every((r) => r.reply === undefined));
  assert.equal(await pendingCount(), 32);
  const over = dapp(site(7));
  await settle();
  assert.deepEqual(over.reply, GLOBAL);
  assert.equal(await pendingCount(), 32);
  assert.equal(badges[badges.length - 1], "32", "the badge shows the queue size");
});

await test("honest path: another window closing leaves the queue alone", async () => {
  assert.equal(typeof onRemoved, "function", "the background listens for the approval window closing");
  onRemoved(WIN + 1);
  await settle();
  assert.equal(await pendingCount(), 32);
  assert.ok(queued.every((r) => r.reply === undefined));
});

await test("closing the approval window settles all 32 queued requests APPROVAL_CLOSED and empties the queue", async () => {
  onRemoved(WIN);
  await settle();
  assert.equal(queued.length, 32);
  for (const r of queued) assert.deepEqual(r.reply, CLOSED, `${r.origin} was settled`);
  assert.equal(await pendingCount(), 0);
  assert.equal(badges[badges.length - 1], "", "the badge is cleared");
});

await test("honest path: after the close the queue takes requests again", async () => {
  const r = dapp(site(1));
  await settle();
  assert.equal(r.reply, undefined);
  assert.equal(await pendingCount(), 1);
});

console.log(`background-queue-caps: ${n} passed, 0 failed`);
