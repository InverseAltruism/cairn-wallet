// An attest, a reveal, and an id or address of the wrong JSON type on any method are refused before the queue by the
// function the signer refuses them with, and every shape docs/PROVIDER.md documents still queues. The real background
// worker through its onMessage listener with a mock chrome; the signer is the real Wallet behind it on a fetch stub
// that serves one coin and records submits.
//   1. One table through both paths: the page's request (refused BAD_REQUEST before any window, or queued) and the
//      signer as resolvePending calls it (Wallet.attest, Wallet.send or sendMany, Wallet.propose, Wallet.fillOffer with
//      the offer served open, or the engine). A refused row gets the same text on both paths and nothing is submitted;
//      an honest row queues and signs. An id or address is read only from a string: a list holding one used to pass
//      the checks through String() and throw in the codec after approval, and an object whose toString is not a
//      function threw in the checks themselves (answered INTERNAL). A score or confidence that is an object or a list
//      is refused, never read as 0; one sent as a digit string signs as before.
//   2. A revealClaim whose txid is an object or a list is refused BAD_REQUEST before any window; a string queues.
//   3. Every documented shape of every method that opens the window queues and opens it.
//   4. The honest attest rows sign the bytes they signed at 8b534c5.
//   RED-FIRST: on 8b534c5 (24 of 31 checks fail) every refused attest row and both reveal rows queue and open the
//   window; the object-shaped rows are answered INTERNAL by the checks themselves and throw at the signer; a list
//   holding one id or address queues, and then the codec throws on it (a single send's `to`, a payloadHash) or String()
//   unwraps it and the signer signs (an attest's proposalId or confidence, an output's `to`). No documented caller
//   sends a list there (cairn-sdk types each as a string or a number; the site's golden calls). Drop the attest case
//   from prequeueRefusal and every refused attest row fails on the page path.
// Run: npx tsx test/request-shape-prequeue.test.mjs   (offline)
import { createHash } from "node:crypto";
import { checker } from "./helpers/check.mjs";
import { mkCoin, txReply } from "./_coin.ts";
import { PRIV } from "./helpers/fillworld.mjs";
import * as node from "../src/core/node.ts";
import { sendFields, fillFields } from "../src/core/signfields.ts";

const { check, done } = checker("an id, address, score or reveal of the wrong JSON type is refused before the queue:");
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
globalThis.__CAIRN_TEST__ = true;
const coin = mkCoin(5_000e8);
const submits = [];
const TO = "0x" + "31".repeat(20);
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u.includes("/tx/submit")) { submits.push(JSON.parse(init.body).tx); return { ok: true, status: 200, json: async () => ({ ok: true }) }; }
  if (/\/utxos\//.test(u)) return { ok: true, status: 200, json: async () => ({ confirmed_balance: coin.coin.value, utxos: [coin.coin] }) };
  if (u.endsWith("/tip")) return { ok: true, status: 200, json: async () => ({ height: 116_520 }) };
  const offer = u.match(/\/cairnx\/offer\/(0x[0-9a-fA-F]{64})/);
  if (offer) return { ok: true, status: 200, json: async () => ({ id: offer[1], status: "open", height: 100_000, want: { value: "100000000", payto: TO }, give: { ticker: "TOKA", amount: "1" } }) };
  return txReply(u, [coin]) ?? { ok: false, status: 404, json: async () => ({}) };
};
await import("../src/background.ts");
const wallet = globalThis.__cairnBgWallet;
const ORIGIN = "https://app.example";
const popup = (method, ...args) => new Promise((res) => chrome.listener({ kind: "popup", method, args }, { id: "cairnwallettestid", url: "chrome-extension://x/approve.html" }, res));
function dapp(method, params, origin = ORIGIN) {
  const out = { reply: undefined };
  chrome.listener({ kind: "dapp", method, params }, { origin, url: origin + "/" }, (r) => { out.reply = r; });
  return out;
}
const pending = async () => (await popup("pending")).result;
check("setup: a wallet from a known key", (await popup("import", PRIV, "pw-request-shape-prequeue")).ok === true);

const ID = "0x" + "c1".repeat(32);
const HASH = "0x" + "ab".repeat(32);
const OBJ = { toString: 1 };
const SIGNS = null;
const PROPOSE = { domain: "example:v1", payloadHash: HASH, uri: "data:,hi", expiresEpoch: 9_000 };
// [label, method, params, the signer's nested code (or SIGNS), for a fill which signer path refuses it]
const TABLE = [
  ["an attest whose proposalId is an object", "attest", { proposalId: OBJ, score: 100, confidence: 100 }, "BAD_REQUEST"],
  ["an attest whose proposalId is a list holding an id", "attest", { proposalId: [ID], score: 100, confidence: 100 }, "BAD_REQUEST"],
  ["an attest with a malformed proposalId", "attest", { proposalId: "0x1234", score: 100, confidence: 100 }, "BAD_REQUEST"],
  ["an attest whose score is an object", "attest", { proposalId: ID, score: OBJ, confidence: 100 }, "BAD_REQUEST"],
  ["an attest whose confidence is a list", "attest", { proposalId: ID, score: 100, confidence: [100] }, "BAD_REQUEST"],
  ["an attest with a fee of 0", "attest", { proposalId: ID, score: 100, confidence: 100, fee: 0 }, "FEE_TOO_LOW"],
  ["an attest with a fee of 101 CSD", "attest", { proposalId: ID, score: 100, confidence: 100, fee: 101e8 }, "FEE_CAP"],
  ["an attest with a fee as a digit string", "attest", { proposalId: ID, score: 100, confidence: 100, fee: "5000000" }, "BAD_FEE"],
  ["a token-priced attest whose target is a list", "attest", { proposalId: [ID], score: 100, confidence: 1_000_000 }, "BAD_REQUEST"],
  ["a single send whose recipient is an object", "send", { to: OBJ, amount: 1e8 }, "BAD_OUTPUTS"],
  ["a single send whose recipient is a list", "send", { to: [TO], amount: 1e8 }, "BAD_OUTPUTS"],
  ["a single send whose amount is an object", "send", { to: TO, amount: OBJ }, "BAD_OUTPUTS"],
  ["a multi-output send whose recipient is a list", "send", { outputs: [{ to: [TO], value: 1e6 }] }, "BAD_OUTPUTS"],
  ["a propose whose payloadHash is an object", "propose", { ...PROPOSE, payloadHash: OBJ }, "BAD_REQUEST"],
  ["a propose whose payloadHash is a list", "propose", { ...PROPOSE, payloadHash: [HASH] }, "BAD_REQUEST"],
  ["a propose whose output recipient is a list", "propose", { ...PROPOSE, fee: 25e6, outputs: [{ to: [TO], value: 1e6 }] }, "BAD_OUTPUTS"],
  ["a fill whose target is an object", "fillOffer", { proposalId: OBJ, outputs: [{ to: TO, value: 1e6 }] }, "BAD_REQUEST", "preflight"],
  ["a fill whose target is a list", "fillOffer", { proposalId: [ID], outputs: [{ to: TO, value: 1e6 }] }, "BAD_REQUEST", "preflight"],
  ["a fill whose score is an object", "fillOffer", { proposalId: ID, outputs: [{ to: TO, value: 1e6 }], score: OBJ }, "BAD_REQUEST", "preflight"],
  ["a fill whose confidence is a list", "fillOffer", { proposalId: ID, outputs: [{ to: TO, value: 1e6 }], confidence: [100] }, "BAD_REQUEST", "preflight"],
  ["a fill paying a recipient that is a list", "fillOffer", { proposalId: ID, outputs: [{ to: [TO], value: 1e6 }] }, "BAD_OUTPUTS", "engine"],
  ["honest: an attest as the site sends it", "attest", { proposalId: ID, score: 100, confidence: 100, fee: 5e6 }, SIGNS],
  ["honest: an attest of score 0 with the fee omitted", "attest", { proposalId: ID, score: 0, confidence: 100 }, SIGNS],
  ["honest: an attest whose score and confidence are digit strings", "attest", { proposalId: ID, score: "100", confidence: "100", fee: 5e6 }, SIGNS],
  ["honest: an attest with score null", "attest", { proposalId: ID, score: null, confidence: 100, fee: 5e6 }, SIGNS],
];

async function signer(method, params, via) {
  if (method === "attest") return wallet.attest(params);
  if (method === "propose") return wallet.propose(params);
  if (method === "send") {
    const s = sendFields(params);
    const one = s.outputs[0];
    return s.many || !one ? wallet.sendMany({ outputs: s.outputs, fee: s.fee }) : wallet.send(one.to, one.value, s.fee);
  }
  const f = fillFields(params);
  if (via === "preflight") return wallet.fillOffer(params);
  return node.fillOffer("https://rpc.test", { proposalId: f.proposalId, score: f.score, confidence: f.confidence, outputs: f.outputs, fee: f.fee }, PRIV);
}

// 1. Both paths for every row.
const signedAttest = [];
for (const [label, method, params, want, via] of TABLE) {
  const refused = want !== SIGNS;
  const w0 = created.length, q0 = (await pending()).length;
  const r = dapp(method, params); await settle();
  const q = await pending();
  const page = r.reply?.ok === false && r.reply.code === "BAD_REQUEST" && q.length === q0 && created.length === w0
    ? { refused: true, error: r.reply.error }
    : r.reply === undefined && q.length === q0 + 1 ? { refused: false } : { refused: "other", reply: r.reply };
  if (r.reply === undefined && q.at(-1)) { await popup("resolve", q.at(-1).id, false); await settle(); }
  const s0 = submits.length;
  let out;
  try { out = await signer(method, params, via); } catch (e) { out = { threw: e.message }; }
  const sig = out?.ok === false && out.code === want && submits.length === s0 ? { refused: true, error: out.error }
    : out?.ok === true && submits.length === s0 + 1 ? { refused: false } : { refused: "other", out };
  if (!refused && method === "attest") signedAttest.push(submits.at(-1));
  check(`1. ${label}: page ${page.refused === true ? `refused BAD_REQUEST (${page.error})` : page.refused === false ? "queued, window opened" : JSON.stringify(page.reply)}; signer ${sig.refused === true ? `refused ${want}` : sig.refused === false ? "signed" : JSON.stringify(sig.out).slice(0, 160)}`,
    page.refused === refused && sig.refused === refused && (refused ? page.error === sig.error : true));
}

// 2. A reveal of an object or a list is refused before the queue; a string txid queues.
for (const [label, params, refused] of [["an object", OBJ, true], ["a list holding a txid", [ID], true], ["a txid", ID, false]]) {
  const w0 = created.length, q0 = (await pending()).length;
  const r = dapp("revealClaim", params); await settle();
  const q = await pending();
  const ok = refused ? r.reply?.ok === false && r.reply.code === "BAD_REQUEST" && /seal txid must be a string/.test(r.reply.error) && q.length === q0 && created.length === w0
    : r.reply === undefined && q.length === q0 + 1;
  check(`2. a revealClaim of ${label}: ${r.reply ? `${r.reply.code} (${r.reply.error})` : "queued"}`, ok);
  if (r.reply === undefined && q.at(-1)) { await popup("resolve", q.at(-1).id, false); await settle(); }
}

// 3. Every documented shape (docs/PROVIDER.md "Methods") of every method that opens the window queues and opens it.
{
  const SIWC = { nonce: "abcdef123456", statement: "Sign in", uri: ORIGIN + "/login", domain: "app.example", expirationSecs: 600, requestId: "r1", resources: ["https://app.example/r"] };
  const DOCUMENTED = [
    ["connect", undefined], ["requestPermissions", undefined], ["signinWithCsd", { nonce: "abcdef123456" }], ["signinWithCsd", SIWC],
    ["propose", PROPOSE], ["propose", { ...PROPOSE, fee: 25e6, outputs: [{ to: TO, value: "1000000" }] }],
    ["attest", { proposalId: ID, score: 100, confidence: 100 }], ["attest", { proposalId: ID, score: 0, confidence: 100, fee: 5e6 }],
    ["attest", { proposalId: ID, score: 100, confidence: 1_000_000, fee: 5e6 }],
    ["send", { to: TO, amount: 1e8 }], ["send", { to: TO, amount: 1e8, fee: 1e6 }], ["send", { outputs: [{ to: TO, value: 1e6 }, { to: "0x" + "a2".repeat(20), value: "2500000" }] }],
    ["fillOffer", { proposalId: ID, outputs: [{ to: TO, value: 1e6 }] }], ["fillOffer", { proposalId: ID, outputs: [{ to: TO, value: 1e6 }], score: null, fee: 5e6 }],
    ["fillOffer", { proposalId: ID, outputs: [{ to: TO, value: 1e6 }], score: 100, confidence: 100 }], ["fillOffer", { proposalId: "0x" + "c2".repeat(32), outputs: [], score: 100, confidence: 1_000_000, fee: 5e6 }],
    ["sealClaim", { claim: "c" }], ["sealClaim", { claim: "c", domain: "example:sealed", fee: 25e6 }],
    ["revealClaim", ID],
  ];
  let queued = 0;
  const bad = [];
  for (const [method, params] of DOCUMENTED) {
    const r = dapp(method, params === undefined ? undefined : JSON.parse(JSON.stringify(params))); await settle();
    const mine = await pending();
    if (r.reply === undefined && mine.length === 1 && mine[0].method === method) queued++;
    else bad.push(`${method} ${JSON.stringify(params)?.slice(0, 60)}: ${JSON.stringify(r.reply)?.slice(0, 100)}`);
    for (const p of mine) await popup("resolve", p.id, false);
    await settle();
  }
  check(`3. all ${DOCUMENTED.length} documented shapes queue (${queued} queued; ${bad.join("; ") || "none refused"})`, queued === DOCUMENTED.length);
}

// 4. The honest attest rows sign the bytes they signed at 8b534c5 (sha256 over the submitted transactions, taken by
// running this file there, where every honest row already signed).
{
  const digest = createHash("sha256").update(JSON.stringify(signedAttest)).digest("hex");
  if (process.env.SHAPE_CAPTURE) console.log("CAPTURE", digest);
  check(`4. the ${signedAttest.length} honest attest transactions are byte-identical to 8b534c5's (sha256 ${digest})`, signedAttest.length === 4 && digest === "82586d446be243ca0dbd076b0213594a435b6c8ee260a0f1cb37aa954565986b");
}
done("request-shape-prequeue");
