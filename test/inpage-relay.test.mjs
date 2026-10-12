// The window.cairn transport: src/inpage.ts (page world) posts a request on `window`, src/content.ts relays
// it to the background and posts the reply back on `window`. Both real modules run here against one mocked
// window whose postMessage delivers to every listener, as the browser does.
//
// The per-page-load reply nonce is gone (owner decision W-2, 2026-10-12): replies are posted on `window`, so
// any page script learned it from the first reply. What stays, and is asserted here: the source check
// (ev.source === window), the target strings, the origin check in content, and postMessage to
// window.location.origin in both directions.
//   RED-FIRST (against the nonce code): (1) times out because inpage drops a reply whose nonce it never
//   received, and (5) fails because content stamps the nonce on the script element and on every reply.
//   Mutations of the kept checks: drop `ev.source !== window ||` from inpage's reply listener and (2) fails;
//   drop the target check and (3) fails; drop the source or origin check in content and (4) fails; drop the
//   source check on events or the port's kind check and (6) fails; post to "*" and (7) fails.
// Run: node --import tsx test/inpage-relay.test.mjs   (offline)
import assert from "node:assert/strict";

const ORIGIN = "https://dapp.example";
const listeners = [];
const posted = [];
const win = {
  location: { origin: ORIGIN },
  addEventListener(type, fn) { if (type === "message") listeners.push(fn); },
  dispatchEvent() { return true; },
  postMessage(data, targetOrigin) {
    posted.push({ data: structuredClone(data), targetOrigin });
    // deliver like the browser: async, to every listener, from this window, at this origin
    if (targetOrigin !== "*" && targetOrigin !== ORIGIN) return;
    setTimeout(() => { for (const fn of [...listeners]) fn({ source: win, origin: ORIGIN, data: structuredClone(data) }); }, 0);
  },
};
const fire = (data, { source = win, origin = ORIGIN } = {}) => { for (const fn of [...listeners]) fn({ source, origin, data }); };

const scripts = [];
globalThis.window = win;
globalThis.document = {
  currentScript: null,
  head: { appendChild: (el) => { scripts.push(el); } },
  documentElement: { appendChild: (el) => { scripts.push(el); } },
  createElement: () => {
    const attrs = new Map();
    return { dataset: {}, setAttribute: (k, v) => attrs.set(k, v), removeAttribute: (k) => attrs.delete(k), remove() {}, attrs };
  },
};
globalThis.__WALLET_VERSION__ = "0.0.0-test";

// The background as the content script sees it: a dApp reply per method, and the events port.
const toBackground = [];
let portListener = null;
globalThis.chrome = {
  runtime: {
    id: "cairnwallettestid",
    lastError: undefined,
    getURL: (p) => "chrome-extension://x/" + p,
    sendMessage(msg, cb) { toBackground.push(msg); setTimeout(() => cb({ ok: true, result: "0x" + "ab".repeat(20), echo: msg.method }), 0); },
    connect: () => ({ onMessage: { addListener: (fn) => { portListener = fn; } }, onDisconnect: { addListener: () => {} } }),
  },
};

await import("../src/content.ts");
await import("../src/inpage.ts");
const cairn = win.cairn;
assert.equal(cairn?.isCairn, true, "setup: window.cairn is installed");

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const settled = (p, ms = 50) => Promise.race([p.then((v) => ({ v })), tick(ms).then(() => "pending")]);

// (1) a dApp call round-trips through the real pair; the reply carries no nonce and is accepted
console.log("(1) a call round-trips content <-> inpage with no nonce");
const r1 = await settled(cairn.getAddress(), 200);
assert.notEqual(r1, "pending", "(1) the reply is accepted (it timed out)");
assert.deepEqual(r1.v, { ok: true, result: "0x" + "ab".repeat(20), echo: "getAddress" });
assert.deepEqual(toBackground.at(-1), { kind: "dapp", method: "getAddress", params: undefined }, "(1) content relayed exactly the dApp request");
console.log("  ok");

// For (2) and (3), call while the background is silent, so only the replies forged here can answer.
const quiet = async (fn) => { const real = globalThis.chrome.runtime.sendMessage; globalThis.chrome.runtime.sendMessage = (m) => { toBackground.push(m); }; try { return await fn(); } finally { globalThis.chrome.runtime.sendMessage = real; } };

// (2) a reply from another window (a frame) is ignored
console.log("(2) a reply whose source is not this window is ignored");
await quiet(async () => {
  const p = cairn.connect();
  await tick(5);
  const req = posted.filter((m) => m.data.target === "cairn-content").at(-1).data;
  fire({ target: "cairn-inpage", id: req.id, res: "forged" }, { source: {} });
  assert.equal(await settled(p), "pending", "(2) a foreign-source reply does not resolve the call");
  fire({ target: "cairn-inpage", id: req.id, res: "honest" });
  assert.deepEqual(await settled(p), { v: "honest" }, "(2) paired: the same reply from this window does");
});
console.log("  ok");

// (3) the target string is checked: a request echo or an event message never resolves a call
console.log("(3) only target 'cairn-inpage' resolves a call");
await quiet(async () => {
  const p = cairn.connect();
  await tick(5);
  const req = posted.filter((m) => m.data.target === "cairn-content").at(-1).data;
  fire({ target: "cairn-content", id: req.id, res: "wrong target" });
  fire({ target: "cairn-inpage-event", id: req.id, res: "wrong target" });
  fire({ target: "other", id: req.id, res: "wrong target" });
  assert.equal(await settled(p), "pending", "(3) wrong targets are ignored");
  fire({ target: "cairn-inpage", id: req.id, res: "right target" });
  assert.deepEqual(await settled(p), { v: "right target" });
});
console.log("  ok");

// (4) content relays only same-window, same-origin cairn-content requests to the background
console.log("(4) content's inbound checks");
const before = toBackground.length;
fire({ target: "cairn-content", id: "x1", method: "send", params: {} }, { source: {} });
fire({ target: "cairn-content", id: "x2", method: "send", params: {} }, { origin: "https://evil.example" });
fire({ target: "cairn-inpage", id: "x3", method: "send", params: {} });
await tick(5);
assert.equal(toBackground.length, before, "(4) a foreign source, a foreign origin or a wrong target reaches no background call");
fire({ target: "cairn-content", id: "x4", method: "getAddress" });
await tick(5);
assert.equal(toBackground.length, before + 1, "(4) paired: a same-window, same-origin request is relayed");
console.log("  ok");

// (5) the nonce is gone from both sides
console.log("(5) no nonce on the script element or on any message");
assert.equal(scripts.length, 1, "setup: content injected one script");
assert.equal(scripts[0].src, "chrome-extension://x/inpage.js");
assert.equal(Object.keys(scripts[0].dataset).length, 0, "(5) no data- attribute via dataset");
assert.equal(scripts[0].attrs.size, 0, "(5) no attribute set");
assert.ok(posted.every((m) => !("nonce" in m.data)), "(5) no message carries a nonce field");
console.log("  ok");

// (6) provider events: relayed from the content port, checked for source and target like replies
console.log("(6) provider events");
const got = [];
cairn.on("accountsChanged", (d) => got.push(d));
portListener({ kind: "cairn-event", event: "accountsChanged", data: [] });
portListener({ kind: "other", event: "accountsChanged", data: ["0xforged"] });
await tick(6);
assert.deepEqual(got, [[]], "(6) a background event is delivered; a non-event port message is not relayed");
fire({ target: "cairn-inpage-event", event: "accountsChanged", data: ["0xforged"] }, { source: {} });
fire({ target: "cairn-inpage", event: "accountsChanged", data: ["0xforged"] });
assert.deepEqual(got, [[]], "(6) a foreign-source or wrong-target event is ignored");
console.log("  ok");

// (7) every message either side posts (replies, requests and events) targets this page's origin, never "*"
console.log("(7) postMessage targets window.location.origin");
assert.ok(posted.some((m) => m.data.target === "cairn-content") && posted.some((m) => m.data.target === "cairn-inpage"), "setup: both directions were posted");
assert.deepEqual([...new Set(posted.map((m) => m.targetOrigin))], [ORIGIN]);
console.log("  ok");

console.log("\ninpage-relay: all assertions passed");
process.exit(0);
