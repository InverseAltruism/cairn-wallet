// The real background service worker registers a chrome.runtime.onInstalled listener that builds the SPV source
// (wallet.prewarmSpv) once the wallet is ready, so the one-time header store migration runs on install or update
// and not on the first fill after it (cairn docs/Plans/86 section 3.8; section 6 case 22).
//
// RED-FIRST: delete the `chrome.runtime?.onInstalled?.addListener(...)` line in src/background.ts and the
// registration and call checks fail.
// PAIRED HONEST PATH: a runtime without onInstalled still loads the background, and its message gate answers.
//
// Run: npx tsx test/background-oninstalled.test.mjs   (offline)
import { Wallet } from "../src/core/wallet.ts";
import { checker } from "./helpers/check.mjs";

const t = checker("background-oninstalled");
const tick = () => new Promise((r) => setTimeout(r, 0));

// prewarmSpv is counted, never run: the real one would build the SPV source over the network.
let prewarms = 0;
Wallet.prototype.prewarmSpv = function () { prewarms++; };

function mockChrome({ onInstalled, holdReads }) {
  const mem = new Map();
  const held = [];
  const chrome = {
    runtime: {
      id: "cairnwallettestid", lastError: undefined,
      getURL: (p) => "chrome-extension://x/" + p,
      onMessage: { addListener: (fn) => { chrome.listener = fn; } },
      onConnect: { addListener: () => {} },
      ...(onInstalled ? { onInstalled } : {}),
    },
    storage: { local: {
      get: async (k) => { if (holdReads.on) await new Promise((r) => held.push(r)); return { [k]: structuredClone(mem.get(k)) }; },
      set: async (o) => { for (const k of Object.keys(o)) mem.set(k, structuredClone(o[k])); },
      remove: async (k) => { mem.delete(k); },
    } },
    alarms: { create: () => {}, onAlarm: { addListener: () => {} } },
    action: { setBadgeText: () => {} },
    windows: { create: () => {} },
  };
  return { chrome, release: () => { holdReads.on = false; while (held.length) held.shift()(); } };
}
globalThis.fetch = async () => ({ ok: false, status: 404, json: async () => ({}) });
const popup = (chrome, method) => new Promise((res) => chrome.listener({ kind: "popup", method, args: [] },
  { id: "cairnwallettestid", url: "chrome-extension://x/popup.html" }, res));

// ── the listener is registered and calls prewarmSpv once, after ready ──
console.log("onInstalled registered:");
{
  const listeners = [];
  const holdReads = { on: true };
  const { chrome, release } = mockChrome({ onInstalled: { addListener: (fn) => listeners.push(fn) }, holdReads });
  globalThis.chrome = chrome;
  await import("../src/background.ts");
  t.check("the background registers exactly one onInstalled listener", listeners.length === 1);
  t.check("loading the background does not prewarm by itself", prewarms === 0);
  listeners[0]?.({ reason: "update", previousVersion: "0.2.73" });
  for (let i = 0; i < 20; i++) await tick();
  t.check("an install event before the wallet is ready waits for ready", prewarms === 0);
  release();
  for (let i = 0; i < 50 && prewarms === 0; i++) await tick();
  t.check("once ready, the listener calls wallet.prewarmSpv exactly once", prewarms === 1);
}

// ── a runtime without onInstalled still loads ──
console.log("runtime without onInstalled:");
{
  const holdReads = { on: false };
  const { chrome } = mockChrome({ onInstalled: null, holdReads });
  globalThis.chrome = chrome;
  let loaded = false;
  try { await import("../src/background.ts?no-oninstalled"); loaded = true; }
  catch (e) { console.log("    import threw:", e?.message ?? e); }
  t.check("the background module loads", loaded && typeof chrome.listener === "function");
  const r = await popup(chrome, "status");
  t.check("its message gate answers a popup status request", r?.ok === true && r.result?.hasVault === false);
}

t.done();
