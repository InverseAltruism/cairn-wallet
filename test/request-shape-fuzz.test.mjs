// The approval window paints every request a page can queue. A page's params are JSON, and a field the window reads as
// text or as a number can be an object whose `toString` is not a function (Number() and String() throw on it) or a
// list (read as its elements' text). Every request that passes the checks background.ts runs before the queue
// (src/core/prequeue.ts, the function it calls) is painted here without a throw, for every method on its allowlist.
//   1. A grid: each method's honest params with each field, each output field, the params themselves and pairs of
//      fields set to odd JSON values, plus cairnx:v1 records: shapes under a fixed payloadHash (the raw card) and, each
//      committed by its own payloadHash so the window decodes what parseRecord admits, every record type's honest
//      record with each field and each nested field set to an odd JSON value.
//   2. Seeded random JSON shapes (mulberry32, seed below) for every method, bounded by a count and a time budget
//      (CAIRN_FUZZ_MS, default 20000 ms; the count run is printed).
//   For each shape that passes prequeueRefusal, describe, debitOf, requestRecipients, recipientFlags, signedFee and
//   signedOutputs run with each set of fields the window adds to a request; none may throw, and prequeueRefusal
//   itself may not throw on any shape.
//   3. The real approval window (src/popup/approve.ts on helpers/approve-dom.mjs) paints a seeded sample of the
//      passing shapes, a sample of the hash-committed records it decodes, every documented shape and every golden call,
//      each as its own card, never the "could not show" card.
//   4. Every shape docs/PROVIDER.md documents and every one of the site's golden calls passes prequeueRefusal
//      (test/request-shape-prequeue.test.mjs and test/golden-requests-cards.test.mjs queue them through the real
//      background).
//   RED-FIRST: on 8b534c5 (its inline chain in a prequeue.ts of its own) sections 1 and 2 find an attest whose
//   proposalId or score is { toString: 1 } and a revealClaim of { toString: 1 }, which pass the checks and throw
//   "Cannot convert object to primitive value" in describe, debitOf, signedFee and signedOutputs; section 3 paints two
//   of them as cards it could not show; and the checks themselves throw on such a send `to`, propose payloadHash and
//   fill proposalId (the background answered those INTERNAL). Read the seal txid with String() whatever its type in
//   signfields.ts revealFields and the revealClaim shapes come back; read score with Number() and the score shapes come
//   back. With revealFields total, dropping the revealClaim case from prequeueRefusal queues such a reveal, which the
//   window paints with an empty txid, so this file stays green and test/request-shape-prequeue.test.mjs turns red.
// Run: npx tsx test/request-shape-fuzz.test.mjs   (offline)
import "./helpers/backup-host.mjs";
import { readFileSync } from "node:fs";
import { checker } from "./helpers/check.mjs";
import { mountApproveWindow, loadApprove, flush } from "./helpers/approve-dom.mjs";
import { prequeueRefusal } from "../src/core/prequeue.ts";
import { describe, debitOf, requestRecipients, recipientFlags, signedFee, signedOutputs } from "../src/popup/clearsign.ts";
import { decodeCairnxRecord } from "../src/core/cairnx.ts";
import {
  canonicalJson, payloadHash, transfer, deploy, mint, offer, bid, offerCancelAll, nameCommitRecord, nameClaim, nameFinalize,
  nameXfer, nameSet, nameRenew, nameProfile, tokenMeta, fclaim,
} from "../src/vendor/cairnx-spv.js";

const { check, done } = checker("every request that passes the checks before the queue paints:");
const ORIGIN = "https://app.example";
const ME = "0x" + "ab".repeat(20);
const TO = "0x" + "31".repeat(20), ID = "0x" + "c1".repeat(32), HASH = "0x" + "ab".repeat(32);
const SEED = 0x5eed49;
const BUDGET_MS = Number(process.env.CAIRN_FUZZ_MS || 20_000);
const RANDOM_CASES = 200_000;
const WINDOW_SAMPLE = 400;
const RECORD_SAMPLE = 100;

// The methods the background lets a page call, read from its allowlist so a new method cannot skip this file.
const bgSrc = readFileSync(new URL("../src/background.ts", import.meta.url), "utf8");
const allow = JSON.parse(`[${bgSrc.match(/const DAPP_METHODS = new Set\(\[([^\]]*)\]\)/)?.[1] ?? ""}]`);
const BASE = {
  connect: {}, getAddress: {}, getPermissions: {}, requestPermissions: {}, revokePermissions: {}, signin: {},
  signinWithCsd: { nonce: "abcdef123456", statement: "hi", uri: ORIGIN + "/x", domain: "app.example", expirationSecs: 600, notBeforeSecs: 1, requestId: "r", resources: ["https://a.example/r"] },
  propose: { domain: "example:v1", payloadHash: HASH, uri: "data:,hi", expiresEpoch: 9000, fee: 25e6, outputs: [{ to: TO, value: 1e6 }] },
  attest: { proposalId: ID, score: 100, confidence: 100, fee: 5e6 },
  send: { to: TO, amount: 1e8, fee: 1e6 },
  fillOffer: { proposalId: ID, outputs: [{ to: TO, value: 1e6 }], score: 100, confidence: 100, fee: 5e6 },
  sealClaim: { claim: "c", domain: "csd:sealed", fee: 25e6 },
  revealClaim: ID,
};
check(`the allowlist read from background.ts has a base shape here for each of its ${allow.length} methods`, allow.length === 13 && allow.every((m) => m in BASE));
const METHODS = Object.keys(BASE);

// The shapes docs/PROVIDER.md documents, each method's at least once (optional fields present and absent).
const DOCUMENTED = [
  ["connect", undefined], ["getAddress", undefined], ["requestPermissions", undefined],
  ["signinWithCsd", { nonce: "abcdef123456" }], ["signinWithCsd", BASE.signinWithCsd],
  ["propose", { domain: "example:v1", payloadHash: HASH, uri: "data:,hi", expiresEpoch: 9000 }],
  ["propose", { domain: "example:v1", payloadHash: HASH, uri: "data:,hi", expiresEpoch: 9000, fee: 25e6, outputs: [{ to: TO, value: "1000000" }] }],
  ["attest", { proposalId: ID, score: 100, confidence: 100 }], ["attest", { proposalId: ID, score: 0, confidence: 100, fee: 5e6 }],
  ["attest", { proposalId: ID, score: 100, confidence: 1_000_000, fee: 5e6 }],
  ["send", { to: TO, amount: 1e8 }], ["send", { to: TO, amount: 1e8, fee: 1e6 }], ["send", { outputs: [{ to: TO, value: 1e6 }, { to: "0x" + "a2".repeat(20), value: "2500000" }] }],
  ["fillOffer", { proposalId: ID, outputs: [{ to: TO, value: 1e6 }] }], ["fillOffer", { proposalId: ID, outputs: [{ to: TO, value: 1e6 }], score: null, fee: 5e6 }],
  ["fillOffer", { proposalId: ID, outputs: [{ to: TO, value: 1e6 }], score: 100, confidence: 100 }], ["fillOffer", { proposalId: ID, outputs: [], score: 100, confidence: 1_000_000, fee: 5e6 }],
  ["sealClaim", { claim: "c" }], ["sealClaim", { claim: "c", domain: "example:sealed", fee: 25e6 }],
  ["revealClaim", ID],
];
const GOLDEN = JSON.parse(readFileSync(new URL("./fixtures/wallet-requests-golden-calls.json", import.meta.url), "utf8")).calls;

// What chrome messaging delivers: a JSON round trip.
const json = (v) => { try { const s = JSON.stringify(v); return s === undefined ? undefined : JSON.parse(s); } catch { return undefined; } };
const EXTRAS = [{}, { currentEpoch: 4666, currentTip: 140000, tipFloor: 0, tokenMeta: {} }, { attestTarget: { unknown: true } }];
const PAINT = [
  ["describe", describe], ["debitOf", debitOf], ["requestRecipients", requestRecipients],
  ["recipientFlags", (r) => recipientFlags(requestRecipients(r), [], [ME])], ["signedFee", signedFee], ["signedOutputs", signedOutputs],
];
let tried = 0, passed = 0;
const throws = new Map(), prequeueThrows = new Map(), passing = [];
function attempt(method, raw, how) {
  tried++;
  const params = json(raw);
  let bad;
  try { bad = prequeueRefusal(method, params, ORIGIN); } catch (e) { if (!prequeueThrows.has(method)) prequeueThrows.set(method, `${how}: ${e.message} <= ${JSON.stringify(params)?.slice(0, 120)}`); return; }
  if (bad) return;
  passed++;
  if (passing.length < 50_000) passing.push([method, params]);
  for (const extra of EXTRAS) {
    const r = { id: "x", origin: ORIGIN, method, params, first: false, ...extra };
    for (const [name, fn] of PAINT) {
      try { fn(r); } catch (e) { const k = `${method} ${name}: ${String(e?.message).slice(0, 70)}`; if (!throws.has(k)) throws.set(k, `${how} <= ${JSON.stringify(params)?.slice(0, 140)}`); }
    }
  }
}
const report = (m) => [...m].map(([k, v]) => `${k} (${v})`).join("; ");

// 1. The grid.
const ODD = [undefined, null, true, false, 0, 1, -1, 1.5, 1e21, 2 ** 53, "", "x", "0x", TO, ID, "1e8", "100", [], [null], [TO], [ID], [1], [100], {}, { a: 1 },
  { length: 1 }, { toString: 1 }, { valueOf: 1 }, { toString: 1, valueOf: 1 }, { to: TO, value: 1 }, "<b>x</b>", "‮", "a".repeat(5000)];
for (const [method, b] of Object.entries(BASE)) {
  attempt(method, b, "base");
  for (const o of ODD) attempt(method, o, "params");
  if (!b || typeof b !== "object") continue;
  const keys = Object.keys(b);
  for (const k of keys) {
    for (const o of ODD) attempt(method, { ...b, [k]: o }, `field ${k}`);
    if (k === "outputs") for (const f of ["to", "value"]) for (const o of ODD) {
      attempt(method, { ...b, outputs: [{ to: TO, value: 1e6, [f]: o }] }, `outputs[0].${f}`);
      attempt(method, { ...b, outputs: [{ to: TO, value: 1e6 }, { to: TO, value: 1e6, [f]: o }] }, `outputs[1].${f}`);
    }
  }
  for (const k1 of keys) for (const k2 of keys) if (k1 < k2) for (const o1 of ODD) for (const o2 of [null, [], {}, "x", [TO], [ID], 1, { toString: 1 }]) attempt(method, { ...b, [k1]: o1, [k2]: o2 }, `fields ${k1}+${k2}`);
}
attempt("send", { outputs: [{ to: TO, value: 1e6 }], to: [TO], amount: { toString: 1 } }, "send outputs with odd to and amount");
for (const uri of ["{}", "null", "[]", '{"t":"nprofile","name":"a","p":null}', '{"t":"offer","give":null,"want":null}', '{"t":"transfer","to":5,"amt":[]}',
  '{"t":"nprofile","name":"a","p":{"a":{"b":1}}}', '{"t":"offer","give":{"ticker":{}},"want":{"value":[]}}', '{"t":"name","name":null}',
  '{"t":"deploy","ticker":null,"decimals":"x","supply":{}}', '{"t":"bid","want":null,"give":null}', '{"t":"ocancel"}', '{"t":"tmeta","ticker":1,"hash":2}',
  '{"t":"mint","ticker":[],"amount":{}}', '{"t":"offer","give":{"ticker":"TOKA","amount":{"toString":1}},"want":{"value":{"toString":1}}}'])
  attempt("propose", { ...BASE.propose, domain: "cairnx:v1", uri }, "cairnx uri");
// Hash-committed cairnx:v1 records: canonical JSON under its own payloadHash, as parseRecord requires before it decodes.
const SALT = "5a".repeat(16);
const RECORDS = [
  transfer({ ticker: "AAA", amount: "5", to: TO }), deploy({ ticker: "NEWT", decimals: 2, supply: "100000", mint: "issuer" }),
  mint({ ticker: "AAA", amount: "10" }), offer({ give: { ticker: "AAA", amount: "10" }, want: { value: String(1e8) } }),
  offer({ give: { ticker: "AAA", amount: "50" }, want: { value: String(1e8) }, min: "10000000", taker: TO, memo: "m" }),
  offer({ give: { ticker: "AAA", amount: "10" }, want: { ticker: "PAY", amount: "7" } }),
  bid({ want: { name: "alice" }, give: { value: String(1e8) } }), offerCancelAll({ ticker: "AAA" }), nameCommitRecord({ commit: HASH }),
  nameClaim({ name: "alice", salt: SALT }), nameFinalize({ name: "alice", salt: SALT }), nameXfer({ name: "alice", to: TO }),
  nameSet({ name: "alice", addr: TO }), nameRenew({ name: "alice" }), nameProfile({ name: "alice", p: { avatar: "https://b.example/y.png", "csd.rpc": "https://rpc.example" } }),
  tokenMeta({ ticker: "AAA", hash: HASH }), fclaim({ offer: ID }),
];
let recTried = 0, recDecoded = 0;
const decodedRecords = [];
function committed(obj, how) {
  let uri, hash;
  try { uri = canonicalJson(obj); hash = payloadHash(obj); } catch { return; }
  recTried++;
  const params = { ...BASE.propose, domain: "cairnx:v1", uri, payloadHash: hash };
  if (decodeCairnxRecord(uri, hash)) { recDecoded++; if (!prequeueRefusal("propose", json(params), ORIGIN)) decodedRecords.push(["propose", json(params)]); }
  attempt("propose", params, how);
}
for (const rec of RECORDS) {
  const obj = JSON.parse(rec.uri);
  committed(obj, `cairnx ${obj.t}`);
  for (const k of Object.keys(obj)) {
    if (k === "v" || k === "t") continue;
    for (const o of ODD) committed({ ...obj, [k]: o }, `cairnx ${obj.t}.${k}`);
    const inner = obj[k];
    if (inner && typeof inner === "object" && !Array.isArray(inner)) for (const k2 of Object.keys(inner)) for (const o of ODD) committed({ ...obj, [k]: { ...inner, [k2]: o } }, `cairnx ${obj.t}.${k}.${k2}`);
  }
}
check(`1. hash-committed cairnx records: ${recTried} built, ${recDecoded} decode as records (the rest are refused by parseRecord and paint as raw proposals), ${decodedRecords.length} decoded ones pass the checks`, RECORDS.every((r) => decodeCairnxRecord(r.uri, r.payloadHash)) && recDecoded >= RECORDS.length && decodedRecords.length >= RECORDS.length);
const gridTried = tried, gridPassed = passed;
check(`1. the grid: ${gridTried} shapes, ${gridPassed} pass the checks, prequeueRefusal never throws (${report(prequeueThrows) || "none"})`, prequeueThrows.size === 0);
check(`1. no shape of the grid that passes the checks throws in the window's paint (${report(throws) || "none"})`, throws.size === 0);

// 2. Seeded random shapes.
let s = SEED >>> 0;
const rnd = () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const pick = (a) => a[Math.floor(rnd() * a.length)];
const KEYS = ["to", "value", "amount", "fee", "outputs", "proposalId", "score", "confidence", "domain", "uri", "payloadHash", "expiresEpoch", "claim", "nonce", "toString", "valueOf", "length", "0"];
const STRS = ["", "x", "0x", TO, TO.toUpperCase(), ID, HASH, "100", "1e8", "007", "-1", "1.5", "9007199254740993", "‮", "\u0000", "<i>", "csd:sealed", "cairnx:v1", "a".repeat(600)];
const NUMS = [0, 1, -1, 1.5, 100, 1e6, 1e8, 25e6, 101e8, 2 ** 32, 2 ** 53, 2 ** 53 - 1, 1e21, -0, 1_000_000];
function randJson(depth) {
  const r = rnd();
  if (r < 0.08) return undefined;
  if (r < 0.14) return null;
  if (r < 0.2) return rnd() < 0.5;
  if (r < 0.38) return pick(NUMS);
  if (r < 0.58) return pick(STRS);
  if (r < 0.64) return pick([{ toString: 1 }, { valueOf: 1 }, { toString: "x" }, { valueOf: [] }]);
  if (depth <= 0) return pick(STRS);
  if (r < 0.8) return Array.from({ length: Math.floor(rnd() * 4) }, () => randJson(depth - 1));
  const o = {};
  for (let i = Math.floor(rnd() * 4); i > 0; i--) o[pick(KEYS)] = randJson(depth - 1);
  return o;
}
function mutate(method) {
  const b = BASE[method];
  const r = rnd();
  if (r < 0.15 || !b || typeof b !== "object") return randJson(3);
  const p = structuredClone(b);
  if (r < 0.35 && Array.isArray(p.outputs)) {
    const outs = Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => ({ to: TO, value: 1e6 }));
    for (let i = 1 + Math.floor(rnd() * 2); i > 0; i--) { const o = pick(outs); o[pick(["to", "value", pick(KEYS)])] = randJson(2); }
    p.outputs = rnd() < 0.1 ? randJson(2) : outs;
  }
  for (let i = 1 + Math.floor(rnd() * 3); i > 0; i--) p[rnd() < 0.8 ? pick(Object.keys(b)) : pick(KEYS)] = randJson(2);
  return p;
}
const t0 = Date.now();
let randomRun = 0;
for (; randomRun < RANDOM_CASES && Date.now() - t0 < BUDGET_MS; randomRun++) { const m = pick(METHODS); attempt(m, mutate(m), `random #${randomRun}`); }
check(`2. ${randomRun} seeded random shapes (seed ${SEED.toString(16)}, ${passed - gridPassed} pass the checks, ${Date.now() - t0} ms), prequeueRefusal never throws (${report(prequeueThrows) || "none"})`, randomRun >= 1_000 && prequeueThrows.size === 0);
check(`2. no shape that passes the checks throws in the window's paint (${report(throws) || "none"})`, throws.size === 0);

// 4. The documented shapes and the site's golden calls pass the checks.
const docRefused = DOCUMENTED.filter(([m, p]) => prequeueRefusal(m, json(p), ORIGIN));
check(`4. all ${DOCUMENTED.length} documented shapes pass the checks (${JSON.stringify(docRefused)})`, docRefused.length === 0);
const goldenRefused = GOLDEN.filter((c) => prequeueRefusal(c.method, json(c.params), "https://cairn-substrate.com"));
check(`4. all ${GOLDEN.length} golden calls pass the checks (${goldenRefused.map((c) => c.case).join(", ") || "none"})`, GOLDEN.length === 39 && goldenRefused.length === 0);

// 3. The real window paints a seeded sample of the passing shapes, the documented shapes and the golden calls.
{
  const state = { pending: [] };
  globalThis.fetch = async () => ({ ok: false, status: 404, json: async () => ({}) });
  const { registry } = mountApproveWindow({
    status: () => ({ unlocked: true, hasVault: true, accounts: [{ label: "Main", addr: ME }], active: 0, addr: ME }),
    pending: () => state.pending,
    balance: () => ({ confirmed: 5_000_00000000 }), history: () => [], tokenDisplayMeta: () => ({}), sealedClaims: () => [],
    tip: () => 140_000, epoch: () => 4_666, tipFloor: () => 0, fillOfferView: () => null, attestTarget: () => null, tokenFillQuote: () => null,
    resolve: () => ({ done: true, ok: false, code: "USER_REJECTED" }),
  });
  let unhandled = 0;
  const late = [];
  process.on("unhandledRejection", (e) => { unhandled++; if (late.length < 3) late.push(String(e?.message ?? e).slice(0, 80)); });
  const sample = [];
  const step = Math.max(1, Math.floor(passing.length / WINDOW_SAMPLE));
  for (let i = 0; i < passing.length && sample.length < WINDOW_SAMPLE; i += step) sample.push(passing[i]);
  const recStep = Math.max(1, Math.floor(decodedRecords.length / RECORD_SAMPLE));
  for (let i = 0; i < decodedRecords.length; i += recStep) sample.push(decodedRecords[i]);
  for (const [m, p] of DOCUMENTED) sample.push([m, json(p)]);
  for (const c of GOLDEN) sample.push([c.method, json(c.params)]);
  state.pending = [{ id: "w-first", method: "send", origin: ORIGIN, params: BASE.send }];
  const tick = await loadApprove();
  await flush();
  let painted = 0;
  const failed = [];
  for (const [i, [method, params]] of sample.entries()) {
    state.pending = [{ id: `w${i}`, method, origin: ORIGIN, params, first: false }];
    let err = null;
    await tick().catch((e) => { err = e; });
    await flush(3);
    const html = registry.get("req").innerHTML;
    if (!err && !/could not show this request/.test(html) && html.length > 0) painted++;
    else if (failed.length < 5) failed.push(`${method} ${JSON.stringify(params)?.slice(0, 80)}: ${err?.message ?? "could-not-show card"}`);
  }
  await flush();
  check(`3. the real window paints all ${sample.length} sampled, documented and golden requests as their own cards (${painted} painted; ${failed.join("; ") || "no failure"})`, painted === sample.length);
  check(`3. no paint left an unhandled rejection (${unhandled}: ${late.join("; ")})`, unhandled === 0);
}
done("request-shape-fuzz");
