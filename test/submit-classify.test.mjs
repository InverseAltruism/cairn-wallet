// One host's answer to /tx/submit, classified (src/core/submitverdict.ts), and the outcome of several hosts' answers.
//
// The node strings below are copied from compute-substrate at the fork (cairn-node v0.1.17, src/api/mod.rs tx_submit,
// src/net/mempool.rs, src/chain/utxo.rs, src/crypto.rs) and upstream main: a reword on either side is a deliberate
// update here. The duplicate rule couples to the node's wording, so it stays pinned: a conflict must never read as a
// duplicate (that would tell the user a payment that never settles "is already pending").
// End to end through Wallet.send, with the red cases against 0.3.4: test/submit-answers.test.mjs.
//
// Run: node --import tsx test/submit-classify.test.mjs   (offline)
import * as node from "../src/core/node.js";
import { classifyAnswer, decideSubmit, refusalReason } from "../src/core/submitverdict.js";
import { checker } from "./helpers/check.mjs";

const { check, done } = checker("=== submit answers: one host's verdict, the outcome of several ===");

const NODE_DUPLICATE = "already present in mempool";
const NODE_DUPLICATE_UPSTREAM = "already present or mempool conflict";
const NODE_CONFLICT = "mempool conflict: a different pending transaction spends these coins";

// ── the duplicate rule (exported from node.ts, its home is submitverdict.ts) ──
check("the node DUPLICATE string classifies as a duplicate", node.isSubmitDuplicateErr(NODE_DUPLICATE) === true);
check("upstream's combined string classifies as a duplicate", node.isSubmitDuplicateErr(NODE_DUPLICATE_UPSTREAM) === true);
check("the node CONFLICT string does NOT classify as a duplicate", node.isSubmitDuplicateErr(NODE_CONFLICT) === false);
check("a proxy-wrapped duplicate message still matches (narrow substring, case-insensitive)",
  node.isSubmitDuplicateErr("/tx/submit -> ALREADY PRESENT in mempool (via proxy)") === true);
check("a plain rejection is not a duplicate", node.isSubmitDuplicateErr("bad signature") === false);
check("empty, null and undefined are not duplicates (no throw)",
  node.isSubmitDuplicateErr("") === false && node.isSubmitDuplicateErr(null) === false && node.isSubmitDuplicateErr(undefined) === false);

// ── each node refusal text to its reason ──
const REASON_CASES = [
  ["feerate too low (0 < MIN_FEERATE_PPM=1)", "FEE"],
  ["fee too low for propose", "FEE"],
  ["fee too low for attest", "FEE"],
  ["mempool full; feerate 5 not competitive (min=9)", "BUSY"],
  ["mempool full; no lower-feerate tx available to evict (new_feerate=3)", "BUSY"],
  ["mempool bytes full; no lower-feerate tx available to evict (new_feerate=3)", "BUSY"],
  ["mempool spent index full (spent_len=10 + new_inputs=2 > max_spent=11)", "BUSY"],
  ["mempool state inconsistent: full but eviction set empty", "BUSY"],
  ["missing utxo during fee computation (prevout not found)", "SPENT"],
  ["missing utxo", "SPENT"],
  [NODE_CONFLICT, "CONFLICT"],
  ["tx too large (serialized_size overflow u32)", "INVALID"],
  ["tx too large", "INVALID"],
  ["too many inputs", "INVALID"],
  ["too many outputs", "INVALID"],
  ["tx has no inputs (coinbase-like); not allowed in mempool", "INVALID"],
  ["no inputs; cannot compute fee", "INVALID"],
  ["no outputs", "INVALID"],
  ["negative fee (in_sum < out_sum)", "INVALID"],
  ["coinbase not allowed in mempool", "INVALID"],
  ["bad scriptsig len", "INVALID"],
  ["duplicate input outpoint", "INVALID"],
  ["expected 64-byte compact sig", "INVALID"],
  ["expected 33-byte compressed pubkey", "INVALID"],
  ["pubkey must be 33 bytes compressed", "INVALID"],
  ["non-canonical signature (high-S)", "INVALID"],
  ["pubkey hash mismatch", "INVALID"],
  ["outputs exceed inputs", "INVALID"],
  ["propose domain empty", "INVALID"],
  ["propose uri too long", "INVALID"],
  ["propose expires_epoch 3 is < next-block epoch 4", "INVALID"],
  ["attest references unknown proposal 0xab", "INVALID"],
  ["attest after proposal expiry: epoch 5 > expires_epoch 4", "INVALID"],
  ["signature failed verification", "UNKNOWN"],
  ["something a newer node says", "UNKNOWN"],
];
for (const [text, reason] of REASON_CASES) check(`"${text}" is ${reason}`, refusalReason(text) === reason);

// ── one host's answer ──
const ans = (status, body) => ({ status, body });
const kind = (a) => classifyAnswer(a).kind;
check("a thrown request is unclear", kind({ thrown: true }) === "unclear");
check("200 ok:true is accepted, with the echoed txid", (() => { const v = classifyAnswer(ans(200, { ok: true, txid: "0xab" })); return v.kind === "accepted" && v.txid === "0xab"; })());
check("200 ok:false with the duplicate text is a duplicate", kind(ans(200, { ok: false, err: NODE_DUPLICATE })) === "duplicate");
check("200 ok:false with upstream's combined text is a duplicate", kind(ans(200, { ok: false, err: NODE_DUPLICATE_UPSTREAM })) === "duplicate");
check("200 ok:false with the conflict text is refused CONFLICT", (() => { const v = classifyAnswer(ans(200, { ok: false, err: NODE_CONFLICT })); return v.kind === "refused" && v.reason === "CONFLICT" && v.text === NODE_CONFLICT; })());
check("200 ok:false 'feerate too low' is refused FEE with the node's text", (() => { const v = classifyAnswer(ans(200, { ok: false, err: "feerate too low (0 < MIN_FEERATE_PPM=1)" })); return v.kind === "refused" && v.reason === "FEE"; })());
check("200 ok:false 'submit validation did not finish' is unclear (the check panicked; admission unknown)",
  kind(ans(200, { ok: false, err: "submit validation did not finish: task panicked" })) === "unclear");
check("a proxy's JSON 400 is refused PROXY", (() => { const v = classifyAnswer(ans(400, { ok: false, error: "bad body" })); return v.kind === "refused" && v.reason === "PROXY" && v.text === "bad body"; })());
check("a proxy's JSON 413 is refused PROXY", classifyAnswer(ans(413, { error: "too large" })).reason === "PROXY");
check("a proxy's JSON 429 is refused BUSY", classifyAnswer(ans(429, { ok: false, error: "rate limited" })).reason === "BUSY");
check("a 4xx carrying the duplicate text is a duplicate, as in 0.3.4", kind(ans(400, { ok: false, err: NODE_DUPLICATE_UPSTREAM })) === "duplicate" && kind(ans(408, { error: NODE_DUPLICATE })) === "duplicate");
check("a 5xx carrying the duplicate text is unclear", kind(ans(502, { error: NODE_DUPLICATE })) === "unclear");
check("a non-JSON 400 is unclear (no proxy answer to read)", kind(ans(400, undefined)) === "unclear");
check("a 502 is unclear, with its text", (() => { const v = classifyAnswer(ans(502, { ok: false, error: "node unreachable" })); return v.kind === "unclear" && v.text === "node unreachable"; })());
check("a 2xx non-JSON body is unclear", kind(ans(200, undefined)) === "unclear");
check("a 2xx null, array or number is unclear", [null, [], 7].every((b) => kind(ans(200, b)) === "unclear"));
// register row 212: the three readings that differed from cairn-sdk's classifySubmit
check("row 212: a JSON 408 is unclear (0.3.4 read it as refused)", kind(ans(408, { ok: false, error: "timeout" })) === "unclear");
check("row 212: a JSON 404 or 403 is unclear", kind(ans(404, { ok: false })) === "unclear" && kind(ans(403, { error: "x" })) === "unclear");
check("row 212: a 2xx {} is unclear (0.3.4 read it as refused)", kind(ans(200, {})) === "unclear");
check("row 212: a truthy non-boolean ok is unclear (0.3.4 read it as accepted)",
  [1, "true", {}].every((ok) => kind(ans(200, { ok })) === "unclear"));
check("ok:false without an err string is unclear", kind(ans(200, { ok: false })) === "unclear" && kind(ans(200, { ok: false, err: "" })) === "unclear" && kind(ans(200, { ok: false, error: "x" })) === "unclear");
check("an inherited ok is not the answer's own", kind(ans(200, Object.create({ ok: true }))) === "unclear");
check("a body's maybeInflight field is not read", kind(ans(200, { ok: false, err: "nope", maybeInflight: true })) === "refused");

// ── total: a hostile body gets a verdict from the closed set and never throws (cairn-sdk classifySubmit is total too) ──
// RED-FIRST: before the fix, String() of {"error":{"toString":1}} threw out of classifyAnswer on a non-2xx answer.
const throwing = { toString: 1 };
const throwingValueOf = { valueOf() { throw new Error("valueOf"); }, toString() { throw new Error("toString"); } };
const getterThrows = Object.defineProperty({}, "err", { get() { throw new Error("getter"); }, enumerable: true });
const okGetterThrows = Object.defineProperty({}, "ok", { get() { throw new Error("ok getter"); }, enumerable: true });
const proxy = new Proxy({}, { get() { throw new Error("proxy get"); }, has() { throw new Error("proxy has"); }, getOwnPropertyDescriptor() { throw new Error("proxy gopd"); } });
let deep = { err: "x" }; for (let i = 0; i < 10_000; i++) deep = { err: deep };
const big = "a".repeat(5 * 1024 * 1024);
const HOSTILE = [
  { error: throwing }, { err: throwing }, { ok: false, err: throwing }, { ok: false, error: throwing },
  { error: throwingValueOf }, { ok: false, err: throwingValueOf }, { txid: throwing, ok: true },
  getterThrows, okGetterThrows, proxy, deep, [], [1, 2], 7, -1, null, true, "text", big, { err: big }, { ok: false, err: big },
  { ok: true, txid: throwing }, Object.create(null), { ok: false, err: ["already present"] }, { error: { err: "already present" } },
];
const KINDS = new Set(["accepted", "duplicate", "refused", "unclear"]);
let totalOk = 0, totalCases = 0;
for (const status of [200, 400, 404, 413, 429, 502]) for (const body of HOSTILE) {
  totalCases++;
  try { const v = classifyAnswer(ans(status, body)); if (KINDS.has(v.kind) && typeof v.text !== "number") totalOk++; else console.log("  bad verdict", status, v); }
  catch (e) { console.log("  threw on", status, String(e?.message ?? e).slice(0, 60)); }
}
check(`every hostile body on every status gets a verdict and none throws (${totalOk} of ${totalCases})`, totalOk === totalCases);
check("a non-2xx body whose error is not a string has no served text: 400 with {error:{toString:1}} is refused PROXY with the status label",
  (() => { const v = classifyAnswer(ans(400, { error: throwing })); return v.kind === "refused" && v.reason === "PROXY" && v.text === "/tx/submit -> 400"; })());
check("502 with {error:{toString:1}} is unclear", kind(ans(502, { error: throwing })) === "unclear");
check("a 4xx whose err is an array holding the duplicate text is not a duplicate", kind(ans(400, { ok: false, err: ["already present"] })) !== "duplicate");
check("the edge's 502 with a text body (not JSON) is unclear, with the status label", (() => { const v = classifyAnswer(ans(502, undefined)); return v.kind === "unclear" && v.text === "/tx/submit -> 502"; })());

// ── the outcome of several hosts (the full table end to end: test/submit-two-hosts.test.mjs) ──
const A = { kind: "accepted" }, D = { kind: "duplicate", text: NODE_DUPLICATE };
const C = { kind: "refused", reason: "CONFLICT", text: NODE_CONFLICT }, R = { kind: "refused", reason: "FEE", text: "feerate too low" };
const U = { kind: "unclear", text: "/tx/submit -> network error" };
const out = (vs) => decideSubmit(vs)?.kind ?? "wait";
check("an acceptance decides before the other host answers", out([A, undefined]) === "sent" && out([undefined, A]) === "sent");
check("no other answer decides before every host has answered", [D, C, R, U].every((v) => out([v, undefined]) === "wait" && out([undefined, v]) === "wait"));
check("one host: each verdict decides", out([A]) === "sent" && out([D]) === "duplicate" && out([R]) === "refused" && out([U]) === "unclear");
check("refused by both is refused, with the main host's reason", (() => { const o = decideSubmit([C, R]); return o?.kind === "refused" && o.reason === "CONFLICT"; })());
check("unclear on either beats a refusal or a duplicate", out([R, U]) === "unclear" && out([U, C]) === "unclear" && out([D, U]) === "unclear");
check("a duplicate beats a refusal", out([D, R]) === "duplicate" && out([C, D]) === "duplicate");

done("submit-classify");
