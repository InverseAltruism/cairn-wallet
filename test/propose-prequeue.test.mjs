// A proposal or a seal the wallet would refuse after approval is refused before it is queued, by the same function the
// signer refuses it with, so a malformed request costs the user no approval. The real background worker through its
// onMessage listener with a mock chrome; the signer is the real Wallet behind it (propose, sealClaim) on a fetch stub
// that serves one coin and records submits.
//   1. One table of bad and good parameters through both paths: the page's request (refused BAD_REQUEST before any
//      window, or queued) and the signer (the nested code each row names, a seal refusal it throws before any coin is
//      read, or a submitted transaction). Every row gets the same verdict on both paths, and a refusal the same text.
//   2. A refused request opens no window and takes no queue slot: a site with four queued requests and refused ones
//      queues its fifth, and the sixth is still RATE_LIMITED.
//   3. A good proposal's submitted transaction is byte-identical to the one 3350dff submitted for the same request
//      (digest taken there), so the check changes no signed byte.
//   RED-FIRST: on 3350dff every bad row of section 1 queues and opens the window (and a domain or uri of the wrong type
//   throws in the signer, INTERNAL to the page); let background.ts queue a propose without proposeRefusal and section 1
//   fails on every bad proposal row; give the pre-queue check its own copy of the domain cap at 129 and the 129-byte
//   rows disagree. Before the fee, zero-address and unpaired-surrogate checks joined proposeRefusal, those rows queued and
//   were refused only at signing (or, below the proposal minimum and for a surrogate, signed for the node to reject).
// Run: npx tsx test/propose-prequeue.test.mjs   (offline)
import { createHash } from "node:crypto";
import { checker } from "./helpers/check.mjs";
import { mkCoin, txReply } from "./_coin.ts";
import { PRIV } from "./helpers/fillworld.mjs";
import { CAIRNX_DOMAIN, buildNameXfer } from "../src/core/cairnx.ts";

const { check, done } = checker("a proposal the wallet would refuse is refused before it is queued:");
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
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u.includes("/tx/submit")) { submits.push(JSON.parse(init.body).tx); return { ok: true, status: 200, json: async () => ({ ok: true }) }; }
  if (/\/utxos\//.test(u)) return { ok: true, status: 200, json: async () => ({ confirmed_balance: coin.coin.value, utxos: [coin.coin] }) };
  if (u.endsWith("/tip")) return { ok: true, status: 200, json: async () => ({ height: 116_520 }) };
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
check("setup: a wallet from a known key", (await popup("import", PRIV, "pw-prequeue-1234")).ok === true);

const PH = "0x" + "ab".repeat(32);
const TO = "0x" + "31".repeat(20);
const ok = { domain: "example:v1", payloadHash: PH, uri: "data:,hi", expiresEpoch: 9_000 };
const outs = (n, o = {}) => Array.from({ length: n }, (_, i) => ({ to: "0x" + (0x41 + i).toString(16).repeat(20), value: 1e6, ...o }));
const nx = buildNameXfer({ name: "alice", to: TO });
// [label, method, params, what the signer does]: the nested code it refuses with, THROWN for a seal refused before any
// coin is read (wallet.sealClaim throws its sealFields refusal, INTERNAL after approval), or SIGNS.
const THROWN = "thrown", SIGNS = null;
const R = "BAD_REQUEST", O = "BAD_OUTPUTS";
const TABLE = [
  ["a payload hash of 31 bytes", "propose", { ...ok, payloadHash: "0x" + "ab".repeat(31) }, R],
  ["a payload hash without 0x", "propose", { ...ok, payloadHash: "ab".repeat(32) }, R],
  ["no payload hash", "propose", { ...ok, payloadHash: undefined }, R],
  ["expiresEpoch -1", "propose", { ...ok, expiresEpoch: -1 }, R],
  ["expiresEpoch 1.5", "propose", { ...ok, expiresEpoch: 1.5 }, R],
  ["expiresEpoch as a digit string", "propose", { ...ok, expiresEpoch: "9000" }, R],
  ["expiresEpoch 2^53", "propose", { ...ok, expiresEpoch: 2 ** 53 }, R],
  ["no expiresEpoch", "propose", { ...ok, expiresEpoch: undefined }, R],
  ["a domain that is a number", "propose", { ...ok, domain: 5 }, R],
  ["no domain", "propose", { ...ok, domain: undefined }, R],
  ["a domain of 129 bytes", "propose", { ...ok, domain: "d".repeat(129) }, R],
  ["a domain of 65 characters and 130 bytes", "propose", { ...ok, domain: "é".repeat(65) }, R],
  ["a domain with an unpaired surrogate", "propose", { ...ok, domain: "app\uD800:v1" }, R],
  ["a uri that is an object", "propose", { ...ok, uri: { a: 1 } }, R],
  ["no uri", "propose", { ...ok, uri: undefined }, R],
  ["a uri of 513 bytes", "propose", { ...ok, uri: "u".repeat(513) }, R],
  ["a uri of 257 characters and 514 bytes", "propose", { ...ok, uri: "é".repeat(257) }, R],
  ["a uri with an unpaired surrogate", "propose", { ...ok, uri: "data:,\uDC00" }, R],
  ["a fee as a digit string", "propose", { ...ok, fee: "25000000" }, "BAD_FEE"],
  ["a fee of 1.5", "propose", { ...ok, fee: 1.5 }, "BAD_FEE"],
  ["a fee of -1", "propose", { ...ok, fee: -1 }, "BAD_FEE"],
  ["a fee that is an object", "propose", { ...ok, fee: { v: 1 } }, "BAD_FEE"],
  ["a fee of 0", "propose", { ...ok, fee: 0 }, "FEE_TOO_LOW"],
  ["a fee of 0.2 CSD, below the network's proposal minimum", "propose", { ...ok, fee: 20_000_000 }, "FEE_TOO_LOW"],
  ["a fee of 101 CSD, over the flat cap", "propose", { ...ok, fee: 101e8 }, "FEE_CAP"],
  ["nine outputs", "propose", { ...ok, outputs: outs(9) }, O],
  ["an output to a short address", "propose", { ...ok, outputs: [{ to: "0x1234", value: 1e6 }] }, O],
  ["an output of 0", "propose", { ...ok, outputs: [{ to: TO, value: 0 }] }, O],
  ["an output of 1.5 as a string", "propose", { ...ok, outputs: [{ to: TO, value: "1.5" }] }, O],
  ["an output to the zero address", "propose", { ...ok, outputs: [{ to: "0x" + "0".repeat(40), value: 1e6 }] }, "ZERO_ADDR_REFUSED"],
  ["a seal whose claim is a number", "sealClaim", { claim: 5 }, THROWN],
  ["a seal with an empty claim", "sealClaim", { claim: "" }, THROWN],
  ["a seal whose domain is a number", "sealClaim", { claim: "x", domain: 5 }, THROWN],
  ["a seal whose domain is 129 bytes", "sealClaim", { claim: "x", domain: "d".repeat(129) }, THROWN],
  ["a seal whose domain has an unpaired surrogate", "sealClaim", { claim: "x", domain: "seal\uD800" }, THROWN],
  ["a seal with a fee of 0", "sealClaim", { claim: "x", fee: 0 }, "FEE_TOO_LOW"],
  ["a seal with a fee as a digit string", "sealClaim", { claim: "x", fee: "25000000" }, "BAD_FEE"],
  ["honest: a proposal in another domain", "propose", ok, SIGNS],
  ["honest: a domain of 128 bytes", "propose", { ...ok, domain: "é".repeat(64) }, SIGNS],
  ["honest: a uri of 512 bytes", "propose", { ...ok, uri: "é".repeat(256) }, SIGNS],
  ["honest: an emoji (a surrogate pair) in the domain and the uri", "propose", { ...ok, domain: "app\u{1F600}:v1", uri: "data:,\u{1F600}" }, SIGNS],
  ["honest: eight outputs, one a digit string", "propose", { ...ok, outputs: [...outs(7), { to: TO, value: "2500000" }] }, SIGNS],
  ["honest: a cairnx:v1 name transfer with an explicit fee", "propose", { domain: CAIRNX_DOMAIN, uri: nx.uri, payloadHash: nx.payloadHash, expiresEpoch: 9_000, fee: 30_000_000 }, SIGNS],
  ["honest: a fee of 0.25 CSD, the network's proposal minimum", "propose", { ...ok, fee: 25_000_000 }, SIGNS],
  ["honest: a fee of 100 CSD, the flat cap", "propose", { ...ok, fee: 100e8 }, SIGNS],
  ["honest: expiresEpoch 0", "propose", { ...ok, expiresEpoch: 0 }, SIGNS],
  ["honest: a seal with a domain of 128 bytes", "sealClaim", { claim: "x", domain: "é".repeat(64) }, SIGNS],
  ["honest: a seal, domain omitted", "sealClaim", { claim: "first" }, SIGNS],
];

// 1. The page's path, then the signer's, for every row.
const PAGE_REFUSED = /^[a-zA-Z]/;
for (const [label, method, params, want] of TABLE) {
  const refused = want !== SIGNS;
  const w0 = created.length, q0 = (await pending()).length;
  const r = dapp(method, params); await settle();
  const q = await pending();
  const page = r.reply?.ok === false && r.reply.code === "BAD_REQUEST" && PAGE_REFUSED.test(String(r.reply.error)) && q.length === q0 && created.length === w0
    ? { refused: true, error: r.reply.error }
    : r.reply === undefined && q.length === q0 + 1 ? { refused: false } : { refused: "other", reply: r.reply };
  if (r.reply === undefined && q.at(-1)) { await popup("resolve", q.at(-1).id, false); await settle(); }
  let signer;
  const s0 = submits.length;
  try {
    const out = method === "propose" ? await wallet.propose(params) : await wallet.sealClaim(params);
    signer = out?.ok === false && out.code === want && submits.length === s0 ? { refused: true, error: out.error }
      : out?.ok === true && submits.length === s0 + 1 ? { refused: false } : { refused: "other", out };
  } catch (e) {
    signer = want === THROWN && submits.length === s0 ? { refused: true, error: e.message } : { refused: "threw", error: e.message };
  }
  check(`1. ${label}: page ${page.refused === true ? `refused BAD_REQUEST (${page.error})` : page.refused === false ? "queued, window opened" : JSON.stringify(page.reply)}; signer ${signer.refused === true ? `refused ${want}` : signer.refused === false ? "signed" : JSON.stringify(signer).slice(0, 120)}`,
    page.refused === refused && signer.refused === refused && (refused ? page.error === signer.error : true));
}

// 2. Refused requests take no queue slot; the per-site cap still holds.
{
  const SITE = "https://busy.example";
  const replies = [];
  for (let i = 0; i < 4; i++) replies.push(dapp("propose", ok, SITE));
  for (const [, method, params] of TABLE.filter((r) => r[3] !== SIGNS).slice(0, 6)) replies.push(dapp(method, params, SITE));
  await settle();
  const fifth = dapp("propose", ok, SITE), sixth = dapp("propose", ok, SITE); await settle();
  const mine = (await pending()).filter((p) => p.origin === SITE);
  check(`2. four queued and six refused: the fifth queues (${JSON.stringify(fifth.reply)}), the sixth is RATE_LIMITED (${sixth.reply?.code}), ${mine.length} queued`,
    replies.slice(4).every((r) => r.reply?.code === "BAD_REQUEST") && fifth.reply === undefined && sixth.reply?.code === "RATE_LIMITED" && mine.length === 5);
  for (const p of mine) await popup("resolve", p.id, false);
  await settle();
}

// 3. A good proposal signs the bytes it signed before the check.
{
  const s0 = submits.length;
  const r = await wallet.propose({ ...ok, outputs: [{ to: TO, value: 2_500_000 }] });
  const digest = createHash("sha256").update(JSON.stringify(submits[s0] ?? null)).digest("hex");
  check(`3. a good proposal's submitted transaction is the one 3350dff submitted (sha256 ${digest})`, r.ok === true && submits.length === s0 + 1 && digest === "cb944a2236011f5fb4934f8ec1a65e2d1ac9fc383513237ad077ac74fadccc03");
}
done("propose-prequeue");
