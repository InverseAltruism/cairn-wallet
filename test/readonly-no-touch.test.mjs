// A read on the popup channel does not extend the idle auto-lock (background.ts: wallet.touch() runs only for a method
// outside READ_ONLY_METHODS). The approval window polls `status` and `pending` every 1.2 s, so if a read touched the
// timer, a site that keeps one request queued would keep the wallet unlocked for as long as the window stays open. The
// real background worker with a mock chrome and a controlled clock; the auto-lock is the worker's own alarm handler.
//   1. Unlock at t, poll reads at t + 10 min, fire the alarm at t + 16 min: the wallet locks (16 min idle).
//   2. Paired: the same with a user action at t + 10 min (a resolve, as the window's Reject sends) instead: the wallet
//      stays unlocked at t + 16 min (6 min idle) and locks at t + 26 min.
//   3. `nameCheck` (the send review's poll) answers the popup only: refused from a page and from a content script
//      posing as the popup. Take it out of READ_ONLY_METHODS and 1 fails.
//   RED-FIRST: make every popup method touch the timer (`if (true) wallet.touch()`) and 1 fails. The check in
//   test/extension-boundary.ts polls without moving the clock, so it stays green under that mutation (the audit of
//   2026-11-19), and test/pentest.ts pins it by the source text only.
// Run: npx tsx test/readonly-no-touch.test.mjs   (offline)
import "./helpers/backup-host.mjs";
import { checker } from "./helpers/check.mjs";
import { PRIV } from "./helpers/fillworld.mjs";
import { AUTO_LOCK_MS } from "../src/core/wallet.ts";

const { check, done } = checker("a read on the popup channel does not extend the idle auto-lock:");
let NOW = 1_800_000_000_000;
Date.now = () => NOW;
const MIN = 60_000;
const tick = () => new Promise((r) => setTimeout(r, 0));
const settle = async () => { for (let i = 0; i < 10; i++) await tick(); };
const mem = new Map();
let alarm = () => undefined;
const chrome = {
  runtime: { id: "cairnwallettestid", lastError: undefined, getURL: (p) => "chrome-extension://x/" + p, onMessage: { addListener: (fn) => { chrome.listener = fn; } }, onConnect: { addListener: () => undefined } },
  storage: { local: { get: async (k) => ({ [k]: structuredClone(mem.get(k)) }), set: async (o) => { for (const k of Object.keys(o)) mem.set(k, structuredClone(o[k])); }, remove: async (k) => { mem.delete(k); } } },
  alarms: { create: () => undefined, onAlarm: { addListener: (fn) => { alarm = fn; } } },
  action: { setBadgeText: () => undefined },
  windows: { create: (_o, cb) => cb?.({ id: 77 }), update: () => undefined, onRemoved: { addListener: () => undefined } },
};
globalThis.chrome = chrome;
globalThis.fetch = async () => ({ ok: false, status: 404, json: async () => ({}) });
await import("../src/background.ts");
const PW = "pw-readonly-no-touch";
const popup = (method, ...args) => new Promise((res) => chrome.listener({ kind: "popup", method, args }, { id: "cairnwallettestid", url: "chrome-extension://x/approve.html" }, res));
const unlocked = async () => (await popup("status")).result.unlocked === true;
const autolock = async () => { alarm({ name: "cairn-autolock" }); await settle(); };
check(`setup: the idle window is 15 minutes (${AUTO_LOCK_MS / MIN})`, AUTO_LOCK_MS === 15 * MIN);
check("setup: a wallet from a known key", (await popup("import", PRIV, PW)).ok === true);
// The approval window's poll and the popup's reads, each one of READ_ONLY_METHODS.
// `nameCheck` is the send review's 250 ms poll while a name check runs (popup-namecheck.ts).
const READS = [["status"], ["pending"], ["history"], ["tipFloor"], ["sealedClaims"], ["connectedSites"], ["rpcList"], ["nameCheck", "alice"]];

// 1. Reads ten minutes after the unlock do not move the idle start.
{
  await popup("unlock", PW);
  NOW += 10 * MIN;
  for (let i = 0; i < 20; i++) for (const [m, ...a] of READS) await popup(m, ...a);
  NOW += 6 * MIN;
  await autolock();
  check("1. reads at +10 min, alarm at +16 min: the wallet locks (the reads did not touch the timer)", !(await unlocked()));
}

// 2. Paired: a user action at +10 min does move it.
{
  await popup("unlock", PW);
  NOW += 10 * MIN;
  await popup("resolve", "no-such-request", false);   // what the window sends on a click; not a read
  NOW += 6 * MIN;
  await autolock();
  check("2. honest: a user action at +10 min keeps the wallet unlocked at +16 min", await unlocked());
  NOW += 10 * MIN;
  await autolock();
  check("2. ...and it locks 16 minutes after that action", !(await unlocked()));
}
// 3. The name check's read is the popup's only: a page's request for it (through the content script, kind "dapp") is
//    not a dApp method, and a content script posing as the popup is refused by its sender; the popup's own call answers.
{
  const page = { id: "cairnwallettestid", url: "https://dapp.test/", origin: "https://dapp.test", tab: { id: 3 } };
  const send = (msg, sender) => new Promise((res) => chrome.listener(msg, sender, res));
  // a dApp method would be queued for approval and not answer; 500 ms of no answer reads as that
  const viaPage = await Promise.race([send({ kind: "dapp", method: "nameCheck", params: ["alice"] }, page), new Promise((r) => setTimeout(() => r({ queued: true }), 500))]);
  check(`3. a page's nameCheck is refused as no dApp method (${viaPage.code})`, viaPage.ok === false && viaPage.code === "UNSUPPORTED_METHOD");
  const forged = await send({ kind: "popup", method: "nameCheck", args: ["alice"] }, page);
  check(`3. a content script's forged popup nameCheck is refused (${forged.code})`, forged.ok === false && forged.code === "FORBIDDEN" && forged.result === undefined);
  const own = await popup("nameCheck", "alice");
  check(`3. honest: the popup's nameCheck answers the served answer and progress (${JSON.stringify(own.result)})`, own.ok === true && own.result.served === null && "progress" in own.result);
}
done("readonly-no-touch");
