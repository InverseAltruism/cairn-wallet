// A send or a fill the wallet would refuse on its parameters alone is refused before it is queued, by the function the
// signer refuses it with, so a page cannot queue the send and fill shapes the approval window could not paint (a
// `[null]` output threw in describe() on every poll, leaving both buttons off and every request behind it hidden). The
// real background worker through its onMessage listener with a mock chrome; the signer is the real Wallet behind it on
// a fetch stub that serves one coin and records submits.
//   1. One table of bad and honest parameters through both paths: the page's request (refused BAD_REQUEST before any
//      window, or queued) and the signer, as resolvePending calls it: a send through Wallet.send or Wallet.sendMany
//      (sendFields decides which), a fill through the engine (node.fillOffer) or, for what the fill preflight refuses
//      before its lanes, through Wallet.fillOffer with the offer served open. A refused row gets the same text on both
//      paths; an honest row queues and signs. The caps sit at their boundaries: 500 and 501 outputs on a send, 100 and
//      101 on a fill.
//   2. A propose with a `[null]` output is answered BAD_REQUEST, as docs/PROVIDER.md and WALLET-ERROR-CODES.md state
//      (it was INTERNAL: validateOutputs threw).
//   3. The refusal is a function of the parameters alone: it makes no fetch and no storage read, and a locked wallet
//      gets the same answer as an unlocked one.
//   4. A refused request opens no window and takes no queue slot; honest sends approved through the real resolvePending
//      sign, and every one of the site's golden fill calls still queues (test/golden-requests-cards.test.mjs, unchanged).
//   5. Every honest row signs the bytes it signed at d562218.
//   RED-FIRST: on d562218 every bad send and fill row of section 1 queues and opens the window, `[null]` queues for both
//   methods, the decimal-string `amount` queues and is refused only at signing (BAD_FEE), and section 2 reads INTERNAL.
//   Drop the send branch from queueDappRequest and every bad send row fails; give fillTxRefusal its own cap of 101 and
//   the 101-output row disagrees between the two paths.
// Run: npx tsx test/send-fill-prequeue.test.mjs   (offline)
import { createHash } from "node:crypto";
import { checker } from "./helpers/check.mjs";
import { mkCoin, txReply } from "./_coin.ts";
import { PRIV } from "./helpers/fillworld.mjs";
import * as node from "../src/core/node.ts";
import { sendFields, fillFields } from "../src/core/signfields.ts";
import * as fillpreflight from "../src/core/fillpreflight.ts";

const { check, done } = checker("a send or fill the wallet would refuse is refused before it is queued:");
const tick = () => new Promise((r) => setTimeout(r, 0));
const settle = async () => { for (let i = 0; i < 10; i++) await tick(); };
const mem = new Map();
const created = [];
let storageReads = 0;
const chrome = {
  runtime: { id: "cairnwallettestid", lastError: undefined, getURL: (p) => "chrome-extension://x/" + p, onMessage: { addListener: (fn) => { chrome.listener = fn; } }, onConnect: { addListener: () => undefined } },
  storage: { local: { get: async (k) => { storageReads++; return { [k]: structuredClone(mem.get(k)) }; }, set: async (o) => { for (const k of Object.keys(o)) mem.set(k, structuredClone(o[k])); }, remove: async (k) => { mem.delete(k); } } },
  alarms: { create: () => undefined, onAlarm: { addListener: () => undefined } },
  action: { setBadgeText: () => undefined },
  windows: { create: (opts, cb) => { created.push(opts); cb?.({ id: 77 }); }, update: () => undefined, onRemoved: { addListener: () => undefined } },
};
globalThis.chrome = chrome;
globalThis.__CAIRN_TEST__ = true;
const coin = mkCoin(5_000e8);
const submits = [];
let fetches = 0;
const TO = "0x" + "31".repeat(20);
globalThis.fetch = async (url, init) => {
  fetches++;
  const u = String(url);
  if (u.includes("/tx/submit")) { submits.push(JSON.parse(init.body).tx); return { ok: true, status: 200, json: async () => ({ ok: true }) }; }
  if (/\/utxos\//.test(u)) return { ok: true, status: 200, json: async () => ({ confirmed_balance: coin.coin.value, utxos: [coin.coin] }) };
  if (u.endsWith("/tip")) return { ok: true, status: 200, json: async () => ({ height: 116_520 }) };
  // An open whole offer for any id, so Wallet.fillOffer's preflight reaches its per-output check.
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
check("setup: a wallet from a known key", (await popup("import", PRIV, "pw-send-fill-prequeue")).ok === true);

const ID = "0x" + "c1".repeat(32);
const ZERO = "0x" + "0".repeat(40);
const addrN = (i) => "0x" + (i + 1).toString(16).padStart(40, "4");
const outs = (n, value = 1e6) => Array.from({ length: n }, (_, i) => ({ to: addrN(i), value }));
const SIGNS = null;
// [label, method, params, the signer's nested code (or SIGNS), for a fill which signer path refuses it]
const TABLE = [
  ["a send whose outputs hold null", "send", { outputs: [null], fee: 1e6 }, "BAD_OUTPUTS"],
  ["a send whose outputs hold a number", "send", { outputs: [5], fee: 1e6 }, "BAD_OUTPUTS"],
  ["a send of 501 outputs, one past the signer's cap", "send", { outputs: outs(501) }, "BAD_OUTPUTS"],
  ["a send of no outputs", "send", { outputs: [] }, "BAD_OUTPUTS"],
  ["a send whose amount is a decimal string", "send", { to: TO, amount: "100000000" }, "BAD_FEE"],
  ["a send whose amount is 1.5", "send", { to: TO, amount: 1.5 }, "BAD_FEE"],
  ["a send whose amount is 0", "send", { to: TO, amount: 0 }, "BAD_OUTPUTS"],
  ["a send whose amount is 2^53", "send", { to: TO, amount: 2 ** 53 }, "BAD_FEE"],
  ["a send to a short address", "send", { to: "0x1234", amount: 1e8 }, "BAD_OUTPUTS"],
  ["a send with no recipient", "send", { amount: 1e8 }, "BAD_OUTPUTS"],
  ["a send to the zero address", "send", { to: ZERO, amount: 1e8 }, "ZERO_ADDR_REFUSED"],
  ["a send whose outputs pay the zero address", "send", { outputs: [{ to: TO, value: 1e6 }, { to: ZERO, value: 1e6 }] }, "ZERO_ADDR_REFUSED"],
  ["a send whose output value is 1.5 as a string", "send", { outputs: [{ to: TO, value: "1.5" }] }, "BAD_OUTPUTS"],
  ["a send with a fee of 0", "send", { to: TO, amount: 1e8, fee: 0 }, "FEE_TOO_LOW"],
  ["a send with a fee of 101 CSD, over the flat cap", "send", { to: TO, amount: 1e8, fee: 101e8 }, "FEE_CAP"],
  ["a send with a fee as a digit string", "send", { to: TO, amount: 1e8, fee: "1000000" }, "BAD_FEE"],
  ["a multi-output send with a fee of -1", "send", { outputs: outs(2), fee: -1 }, "BAD_FEE"],
  ["a fill whose outputs hold null", "fillOffer", { proposalId: ID, outputs: [null] }, "BAD_OUTPUTS", "preflight"],
  ["a fill whose output value is a decimal string", "fillOffer", { proposalId: ID, outputs: [{ to: TO, value: "2500000" }] }, "BAD_OUTPUTS", "preflight"],
  ["a fill whose output value is 0", "fillOffer", { proposalId: ID, outputs: [{ to: TO, value: 0 }] }, "BAD_OUTPUTS", "preflight"],
  ["a fill with a malformed target", "fillOffer", { proposalId: "0x1234", outputs: outs(1) }, "BAD_REQUEST", "preflight"],
  ["a fill with no target", "fillOffer", { outputs: outs(1) }, "BAD_REQUEST", "preflight"],
  ["a fill of 101 outputs, one past the signer's cap", "fillOffer", { proposalId: ID, outputs: outs(101) }, "BAD_OUTPUTS", "engine"],
  ["a fill paying a short address", "fillOffer", { proposalId: ID, outputs: [{ to: "0x12", value: 1e6 }] }, "BAD_OUTPUTS", "engine"],
  ["a fill paying the zero address", "fillOffer", { proposalId: ID, outputs: [{ to: ZERO, value: 1e6 }] }, "ZERO_ADDR_REFUSED", "engine"],
  ["a fill with a fee of 0", "fillOffer", { proposalId: ID, outputs: outs(1), fee: 0 }, "FEE_TOO_LOW", "engine"],
  ["a fill with a fee of 101 CSD", "fillOffer", { proposalId: ID, outputs: outs(1), fee: 101e8 }, "FEE_CAP", "engine"],
  ["a fill with a fee as a digit string", "fillOffer", { proposalId: ID, outputs: outs(1), fee: "5000000" }, "BAD_FEE", "engine"],
  ["honest: a send of to and amount, fee omitted", "send", { to: TO, amount: 1e8 }, SIGNS],
  ["honest: a send of to, amount and fee", "send", { to: TO, amount: 1e8, fee: 1e6 }, SIGNS],
  ["honest: a send with a fee of 100 CSD, the flat cap", "send", { to: TO, amount: 1e8, fee: 100e8 }, SIGNS],
  ["honest: a multi-output send, one value a digit string", "send", { outputs: [{ to: TO, value: 1e6 }, { to: addrN(1), value: "2500000" }], fee: 1e6 }, SIGNS],
  ["honest: a send of 500 outputs, the signer's cap", "send", { outputs: outs(500) }, SIGNS],
  ["honest: a fill of 100 outputs, the signer's cap", "fillOffer", { proposalId: ID, outputs: outs(100) }, SIGNS, "engine"],
  ["honest: a fill paying the seller and the protocol fee", "fillOffer", { proposalId: ID, outputs: [{ to: TO, value: 2_500_000_000 }, { to: "0x6b09ce74e6070ebc982ab0fb793a211c4d24f016", value: 37_500_000 }], fee: 5e6 }, SIGNS, "engine"],
  ["honest: a token-priced fill with no CSD output", "fillOffer", { proposalId: ID, outputs: [], score: 100, confidence: 1_000_000, fee: 5e6 }, SIGNS, "engine"],
  ["honest: a fill with score null and no fee", "fillOffer", { proposalId: ID, outputs: outs(1), score: null }, SIGNS, "engine"],
];

// The signer as resolvePending calls it, after approval (no submit on a refusal).
async function signer(method, params, via) {
  if (method === "send") {
    const s = sendFields(params);
    const one = s.outputs[0];
    return s.many || !one ? wallet.sendMany({ outputs: s.outputs, fee: s.fee }) : wallet.send(one.to, one.value, s.fee);
  }
  const f = fillFields(params);
  if (via === "preflight") return wallet.fillOffer(params);
  return node.fillOffer("https://rpc.test", { proposalId: f.proposalId, score: f.score, confidence: f.confidence, outputs: f.outputs, fee: f.fee }, PRIV);
}

// 1. The page's path, then the signer's, for every row. `signed` keeps what each honest row submitted.
const signed = [];
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
  if (!refused) signed.push(submits.at(-1));
  check(`1. ${label}: page ${page.refused === true ? `refused BAD_REQUEST (${page.error})` : page.refused === false ? "queued, window opened" : JSON.stringify(page.reply)}; signer ${sig.refused === true ? `refused ${want}` : sig.refused === false ? "signed" : JSON.stringify(sig.out).slice(0, 160)}`,
    page.refused === refused && sig.refused === refused && (refused ? page.error === sig.error : true));
}

// 2. A proposal with a null output: BAD_REQUEST before the queue, BAD_OUTPUTS with the same text at the signer.
{
  const p = { domain: "example:v1", payloadHash: "0x" + "ab".repeat(32), uri: "data:,hi", expiresEpoch: 9_000, outputs: [null] };
  const q0 = (await pending()).length;
  const r = dapp("propose", p); await settle();
  const s = await wallet.propose(p).catch((e) => ({ threw: e.message }));
  check(`2. a propose with outputs [null]: page ${r.reply?.code} (${r.reply?.error}), signer ${s.code} (${s.error}), nothing queued`,
    r.reply?.ok === false && r.reply.code === "BAD_REQUEST" && s.ok === false && s.code === "BAD_OUTPUTS" && s.error === r.reply.error && (await pending()).length === q0);
}

// 3. No read, no wait, no wallet state: the same answer locked and unlocked, with no fetch and no storage read.
{
  const bad = [["send", { outputs: [null] }], ["fillOffer", { proposalId: ID, outputs: [null] }], ["send", { to: TO, amount: "1" }], ["fillOffer", { proposalId: ID, outputs: outs(101) }]];
  const answers = async () => {
    const got = [];
    for (const [m, p] of bad) {
      const f0 = fetches, r0 = storageReads;
      const r = dapp(m, p);
      await tick();   // the listener awaits `ready` once; the answer must come without a read
      got.push({ reply: r.reply, fetched: fetches - f0, read: storageReads - r0 });
    }
    return got;
  };
  const unlocked = await answers();
  await popup("lock"); await settle();
  const locked = await answers();
  check(`3. refused with no fetch and no storage read (${JSON.stringify(unlocked.map((a) => [a.fetched, a.read]))})`, unlocked.every((a) => a.reply?.code === "BAD_REQUEST" && a.fetched === 0 && a.read === 0));
  check("3. a locked wallet gets the same answers as an unlocked one", JSON.stringify(locked.map((a) => a.reply)) === JSON.stringify(unlocked.map((a) => a.reply)) && locked.every((a) => a.fetched === 0 && a.read === 0));
  const sr = node.sendRefusal?.(sendFields({ outputs: [null] })), fr = fillpreflight.fillRefusal?.(fillFields({ proposalId: ID, outputs: [null] }));
  check(`3. the checks are synchronous functions of the parameters (${JSON.stringify([sr?.code, fr?.code])})`, typeof sr?.then === "undefined" && sr?.code === "BAD_OUTPUTS" && typeof fr?.then === "undefined" && fr?.code === "BAD_OUTPUTS");
  await popup("unlock", "pw-send-fill-prequeue"); await settle();
  for (const p of await pending()) await popup("resolve", p.id, false);   // nothing is queued here unless a check regressed
  await settle();
}

// 4. Refused requests take no queue slot; honest sends approved through the real resolvePending sign.
{
  const SITE = "https://busy.example";
  const replies = [];
  for (let i = 0; i < 4; i++) replies.push(dapp("send", { to: TO, amount: 1e8 }, SITE));
  for (const [, method, params] of TABLE.filter((r) => r[3] !== SIGNS).slice(0, 6)) replies.push(dapp(method, params, SITE));
  await settle();
  const fifth = dapp("send", { to: TO, amount: 1e8 }, SITE), sixth = dapp("send", { to: TO, amount: 1e8 }, SITE); await settle();
  const mine = (await pending()).filter((p) => p.origin === SITE);
  check(`4. four queued and six refused: the fifth queues, the sixth is RATE_LIMITED (${sixth.reply?.code}), ${mine.length} queued`,
    replies.slice(4).every((r) => r.reply?.code === "BAD_REQUEST") && fifth.reply === undefined && sixth.reply?.code === "RATE_LIMITED" && mine.length === 5);
  for (const p of mine) await popup("resolve", p.id, false);
  await settle();
  const honest = TABLE.filter((r) => r[1] === "send" && r[3] === SIGNS);
  let approved = 0;
  for (const [label, method, params] of honest) {
    const s0 = submits.length;
    const r = dapp(method, params); await settle();
    const q = await pending();
    const res = await popup("resolve", q.at(-1)?.id, true); await settle();
    const ok = r.reply?.ok === true && r.reply.result?.ok === true && res.result?.ok === true && submits.length === s0 + 1;
    if (ok) { approved++; signed.push(submits.at(-1)); } else check(`4. ${label}: approved through resolvePending and signed (${JSON.stringify(r.reply).slice(0, 160)})`, false);
  }
  check(`4. every honest send row approved through the real resolvePending signs (${approved} of ${honest.length})`, approved === honest.length);
}

// 5. The honest rows sign the bytes they signed before the check (sha256 over every submitted transaction, taken by
// running this file at d562218, where every honest row already signed).
{
  const digest = createHash("sha256").update(JSON.stringify(signed)).digest("hex");
  check(`5. the ${signed.length} honest transactions are byte-identical to d562218's (sha256 ${digest})`, signed.length === 14 && digest === "82fd6cc74f10c1be878a9b783de92f853de1cd6a3fd9d69c2e6500409888aa6d");
}
done("send-fill-prequeue");
