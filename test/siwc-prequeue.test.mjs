// A sign-in the wallet would refuse is refused before it is queued. In 0.3.2 a nonce outside the wallet's rule (a
// crypto.randomUUID(), say) opened the approval window, the user approved, and only then the page got INTERNAL. The
// real background worker through its onMessage listener with a mock chrome; the check is src/core/siwcparams.ts
// siwcParamsRefusal, the same function signInWithCsd signs through (siwcMessageFor).
//   RED-FIRST: drop the signinWithCsd check in background.ts queueDappRequest and section 1 fails: each request queues
//   and opens the window.
//   PAIRED HONEST PATHS: an honest sign-in (a server nonce of 8+ alphanumerics, a statement, the site's own uri) queues,
//   opens the window and, approved, returns a message the canonical checks accept (2); the error text is the one the
//   wallet gave after approval before (3).
// Run: npx tsx test/siwc-prequeue.test.mjs   (offline)
import { checker } from "./helpers/check.mjs";
import { siwcMessageFor } from "../src/core/siwcparams.ts";

const { check, done } = checker("a sign-in the wallet would refuse is refused before it is queued:");
const tick = () => new Promise((r) => setTimeout(r, 0));
const settle = async () => { for (let i = 0; i < 10; i++) await tick(); };
const mem = new Map();
const created = [];
const chrome = {
  runtime: { id: "cairnwallettestid", lastError: undefined, getURL: (p) => "chrome-extension://x/" + p, onMessage: { addListener: (fn) => { chrome.listener = fn; } }, onConnect: { addListener: () => undefined } },
  storage: { local: { get: async (k) => ({ [k]: structuredClone(mem.get(k)) }), set: async (o) => { for (const k of Object.keys(o)) mem.set(k, structuredClone(o[k])); }, remove: async (k) => { mem.delete(k); } } },
  alarms: { create: () => undefined, onAlarm: { addListener: () => undefined } },
  action: { setBadgeText: () => undefined },
  windows: { create: (opts, cb) => { created.push(opts); cb?.({ id: 77 }); }, update: () => undefined, onRemoved: { addListener: () => undefined } },
};
globalThis.chrome = chrome;
globalThis.fetch = async () => ({ ok: false, status: 404, json: async () => ({}) });
await import("../src/background.ts");
const ORIGIN = "https://app.example";
const popup = (method, ...args) => new Promise((res) => chrome.listener({ kind: "popup", method, args }, { id: "cairnwallettestid", url: "chrome-extension://x/approve.html" }, res));
function signin(params, origin = ORIGIN) {
  const out = { reply: undefined };
  chrome.listener({ kind: "dapp", method: "signinWithCsd", params }, { origin, url: origin + "/" }, (r) => { out.reply = r; });
  return out;
}
const pending = async () => (await popup("pending")).result;
check("setup: a wallet", (await popup("create", "correct horse battery staple")).ok === true);

// 1. Each shape the wallet refuses after approval is refused at the door, with BAD_REQUEST, and nothing is queued.
const BAD = [
  ["a UUID nonce", { nonce: "4f0c7a52-1d2e-4b7a-9a7e-3c0b8f6f9e11" }],
  ["a 7-character nonce", { nonce: "abc1234" }],
  ["no nonce", {}],
  ["a declared domain of another site", { nonce: "abcdefgh12", domain: "bank.example" }],
  ["a uri on another host", { nonce: "abcdefgh12", uri: "https://evil.example/login" }],
  ["a two-line statement", { nonce: "abcdefgh12", statement: "one\ntwo" }],
  ["a 257-character statement", { nonce: "abcdefgh12", statement: "s".repeat(257) }],
  ["eleven resources", { nonce: "abcdefgh12", resources: Array.from({ length: 11 }, (_, i) => "https://app.example/r" + i) }],
  ["a lone surrogate in the statement", { nonce: "abcdefgh12", statement: "hi \uD800 there" }],
];
for (const [what, params] of BAD) {
  const w0 = created.length;
  const r = signin(params); await settle();
  check(`1. ${what}: refused BAD_REQUEST before queueing (${r.reply?.code}: ${String(r.reply?.error).slice(0, 70)})`, r.reply?.ok === false && r.reply.code === "BAD_REQUEST" && /^(sign-in|siwc): /.test(String(r.reply.error)) && (await pending()).length === 0 && created.length === w0);
}
{
  const r = signin({ nonce: "abcdefgh12" }, "null"); await settle();
  check(`1. an opaque origin: refused BAD_REQUEST before queueing (${r.reply?.code})`, r.reply?.code === "BAD_REQUEST" && (await pending()).length === 0);
}

// 2. Honest path: a sign-in the wallet accepts queues, opens the window, and signs once approved.
{
  const params = { nonce: "Nonce1234abcd", statement: "Sign in to App", uri: "https://app.example/login", resources: ["https://app.example/terms"] };
  const r = signin(params); await settle();
  const q = await pending();
  check("2. honest path: the sign-in is queued and the window opens", r.reply === undefined && q.length === 1 && q[0].method === "signinWithCsd" && created.length >= 1);
  const out = await popup("resolve", q[0].id, true, (await popup("status")).result.addr);
  await settle();
  const msg = String(r.reply?.result?.message ?? "");
  check(`2. honest path: approved, the page gets the signed message (${out.result?.ok})`, r.reply?.ok === true && msg.startsWith("app.example wants you to sign in") && msg.includes("Nonce: Nonce1234abcd") && /^[0-9a-f]{128}$/.test(String(r.reply.result.sig64).replace(/^0x/, "")));
}

// 3. The refusal text is the one signing would throw: one function decides both.
{
  let thrown = "";
  try { siwcMessageFor({ nonce: "4f0c7a52-1d2e-4b7a-9a7e-3c0b8f6f9e11" }, ORIGIN, "0x" + "ab".repeat(20), Date.now()); } catch (e) { thrown = e.message; }
  const r = signin({ nonce: "4f0c7a52-1d2e-4b7a-9a7e-3c0b8f6f9e11" }); await settle();
  check(`3. the pre-queue text equals the sign-time text (${thrown})`, thrown !== "" && r.reply?.error === thrown);
}
done("siwc-prequeue");
