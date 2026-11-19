// The dApp method allowlist is enforced twice (AGENTS.md): before a request is queued (DAPP_METHODS in
// queueDappRequest) and again in resolvePending, which runs only the methods it names and throws for any other. The
// second line acts only if the first regresses, so this file makes the first one let three privileged methods through
// (Set.prototype.has answers true for them while the page's message is queued) and then approves each through the real
// resolvePending, as the approval window does.
//   1. An approved `reset`, `status` or `exportMnemonic` that reached the queue runs nothing: the page gets INTERNAL
//      with "unsupported dApp method", the wallet keeps its vault and stays unlocked, and no address or phrase reaches
//      the page. Each row starts from a freshly imported wallet, so each turns red on its own effect.
//   2. Paired: an approved connect, which both lines allow, still answers the address.
//   RED-FIRST: replace resolvePending's final throw with a call to the popup method (the audit's mutation of
//   2026-11-19) and every row of 1 fails: the reset erases the wallet, the status answer carries the address and the
//   exportMnemonic answer carries the phrase. Before this file no test turned red under that mutation
//   (extension-boundary 106/0, pentest 96/0).
// Run: npx tsx test/resolve-allowlist-second-line.test.mjs   (offline)
import { checker } from "./helpers/check.mjs";

const { check, done } = checker("resolvePending runs only the dApp methods it names:");
const tick = () => new Promise((r) => setTimeout(r, 0));
const settle = async () => { for (let i = 0; i < 10; i++) await tick(); };
const mem = new Map();
const chrome = {
  runtime: { id: "cairnwallettestid", lastError: undefined, getURL: (p) => "chrome-extension://x/" + p, onMessage: { addListener: (fn) => { chrome.listener = fn; } }, onConnect: { addListener: () => undefined } },
  storage: { local: { get: async (k) => ({ [k]: structuredClone(mem.get(k)) }), set: async (o) => { for (const k of Object.keys(o)) mem.set(k, structuredClone(o[k])); }, remove: async (k) => { mem.delete(k); } } },
  alarms: { create: () => undefined, onAlarm: { addListener: () => undefined } },
  action: { setBadgeText: () => undefined },
  windows: { create: (_o, cb) => cb?.({ id: 77 }), update: () => undefined, onRemoved: { addListener: () => undefined } },
};
globalThis.chrome = chrome;
globalThis.fetch = async () => ({ ok: false, status: 404, json: async () => ({}) });
await import("../src/background.ts");
const PW = "pw-allowlist-second-line";
const popup = (method, ...args) => new Promise((res) => chrome.listener({ kind: "popup", method, args }, { id: "cairnwallettestid", url: "chrome-extension://x/approve.html" }, res));
// The BIP-39 test phrase (all zero entropy), so an export would carry a phrase the checks can find.
const PHRASE = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const ME = String((await popup("restore", PHRASE, PW)).result.addr).toLowerCase();
// A wallet as the file starts it, whatever an earlier row did to it.
async function freshWallet() {
  await popup("reset"); await settle();
  const addr = String((await popup("restore", PHRASE, PW)).result?.addr).toLowerCase(); await settle();
  return addr;
}
const ORIGIN = "https://hostile.example";
function dapp(method, params) {
  const out = { reply: undefined };
  chrome.listener({ kind: "dapp", method, params }, { origin: ORIGIN, url: ORIGIN + "/" }, (r) => { out.reply = r; });
  return out;
}
// The first line regressed for `method`: DAPP_METHODS.has answers true for it while the page's message is queued.
async function queuedPastFirstLine(method, params) {
  const realHas = Set.prototype.has;
  Set.prototype.has = function (v) { return v === method ? true : realHas.call(this, v); };
  let out;
  try { out = dapp(method, params); await settle(); } finally { Set.prototype.has = realHas; }
  return out;
}

// 1. Each privileged method, queued past the first line and approved.
for (const [method, params] of [["reset", []], ["status", []], ["exportMnemonic", [PW]]]) {
  check(`1. setup: ${method} starts from a freshly imported wallet`, (await freshWallet()) === ME);
  const page = await queuedPastFirstLine(method, params);
  const q = (await popup("pending")).result;
  const req = q.find((p) => p.method === method);
  check(`1. setup: ${method} reached the queue past the first line (${JSON.stringify(page.reply)})`, page.reply === undefined && !!req);
  const outcome = (await popup("resolve", req?.id, true, ME)).result; await settle();
  const st = (await popup("status")).result;
  check(`1. ${method}, approved: the page gets INTERNAL "unsupported dApp method" (${page.reply?.code}: ${page.reply?.error})`, page.reply?.ok === false && page.reply.code === "INTERNAL" && /unsupported dApp method: /.test(String(page.reply.error)) && outcome?.ok === false);
  check(`1. ${method}, approved: nothing ran (vault kept ${st.hasVault}, unlocked ${st.unlocked}, no address or phrase reaches the page: ${JSON.stringify(page.reply?.result ?? null).slice(0, 40)})`, st.hasVault === true && st.unlocked === true && String(st.addr).toLowerCase() === ME && !JSON.stringify(page.reply ?? {}).toLowerCase().includes(ME.slice(2)) && !JSON.stringify(page.reply ?? {}).includes("abandon") && page.reply?.result === undefined);
}

// 2. Paired: connect is on both lines and still answers the address once approved.
{
  const c = dapp("connect", {}); await settle();
  const req = (await popup("pending")).result.find((p) => p.method === "connect");
  await popup("resolve", req?.id, true, ME); await settle();
  check(`2. honest: an approved connect answers the address (${c.reply?.result?.addr})`, c.reply?.ok === true && String(c.reply?.result?.addr).toLowerCase() === ME);
}
done("resolve-allowlist-second-line");
