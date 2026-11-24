// The approval window's outcome line reads a submit outcome the way the popup does (popup-bridge's refusedCopy and
// thrownCopy), through the REAL src/popup/approve.ts on helpers/approve-dom.mjs:
//   (1) SUBMIT_MAYBE_INFLIGHT says the transaction may already be in flight and names the history row, not "Failed";
//   (2) SUBMIT_DUPLICATE shows its own text, info style;
//   (3) a broken channel (the worker died mid-call) reads as possibly in flight, not as an answered refusal;
//   (4) a request already handled in another view: test/approve-handled-elsewhere.test.mjs drives two real views;
//   (5) honest paths unchanged: a txid shows "Sent", an answer with neither (a connect or sign-in) shows "Approved.",
//       and a request other than a send keeps "Failed: ..." for a code or throw its slice has not worded;
//   (7) a page's send: every refusal is the sheet's line ([S4], [S12], [R1] with the engine's text under Details);
//   (8) a refused first-party sign-in is [R11]; (9) a reveal the content server refused is [Q3], SEAL_UNKNOWN [Q4];
//   (10) a fill refused VERIFY_UNAVAILABLE (its offer or its proofs could not be read yet) keeps the engine's sentence
//        and code, not [S9]'s "Could not load your coins"; a page's send refused VERIFY_UNAVAILABLE keeps [S9], and so
//        does a renew, read as popup-nameaction.ts reads it; (10f) a token fill (an attest signed as a fill) reads as
//        a fillOffer does. (10a), (10d) and (10f) red on fc8ec07.
// A "Failed" on an ambiguous submit invites the site's retry, which pays twice when the first transaction lands.
// Run: npx tsx test/approve-outcome-dom.test.mjs   (offline)
import { SENTENCES } from "../src/popup/sentences.ts";
import { refusedCopy } from "../src/popup/popup-outcome.ts";
import { checker } from "./helpers/check.mjs";
import { mountApproveWindow, loadApprove, flush, sleep } from "./helpers/approve-dom.mjs";

const { check, done } = checker("approval window: the outcome line");
const ME = "0x" + "ab".repeat(20);
const TXID = "0x" + "c4".repeat(32);
const state = { pending: [] };
let answer = () => ({ done: true, ok: true, txid: TXID });
const handlers = {
  status: () => ({ unlocked: true, accounts: [{ label: "Main", addr: ME }], active: 0, addr: ME }),
  pending: () => state.pending,
  balance: () => ({ confirmed: 5_000_00000000 }),
  history: () => [],
  tokenDisplayMeta: () => ({}), sealedClaims: () => [], tip: () => 116_520, epoch: () => 3_884, tipFloor: () => 0,
  resolve: () => answer(),
  tokenFillQuote: () => ({ ok: true, ticker: "PAY", amount: "10", fee: "1", total: "11", giveTicker: "AAA", giveAmount: "10" }),
  unlock: () => true,
};
const { registry } = mountApproveWindow(handlers);
const send = (id) => ({ id, method: "send", origin: "https://dapp.example", params: { to: "0x" + "aa".repeat(20), amount: 1e8, fee: 1_000_000 } });
const armed = async () => { await flush(); await sleep(760); await flush(); };
const msgEl = () => registry.get("msg");
let n = 0;
async function outcome(ans, opts = {}) {
  state.pending = [(opts.req ?? send)("o" + ++n)];
  await tick(); await armed();
  answer = () => { state.pending = []; return ans; };
  const rt = globalThis.chrome.runtime;
  const real = rt.sendMessage;
  if (opts.brokenChannel) rt.sendMessage = (m, cb) => { if (m.method !== "resolve") return real(m, cb); Promise.resolve().then(() => { state.pending = []; rt.lastError = { message: "The message port closed before a response was received." }; try { cb(undefined); } finally { rt.lastError = undefined; } }); };
  try { registry.get("btn-approve")._listeners.click(); await flush(20); } finally { rt.sendMessage = real; }
  // the line without its Details, and the Details text
  const html = String(msgEl().innerHTML ?? ""), d = /<details[^>]*>([\s\S]*?)<\/details>/.exec(html);
  const text = d ? html.replace(/<details[\s\S]*?<\/details>/, "").replace(/<[^>]*>/g, "").replace(/&#39;/g, "'") : msgEl().textContent;
  return { text, cls: msgEl().className, details: d ? d[1].replace(/<[^>]*>/g, "") : "" };
}
const signin = (id) => ({ id, method: "signin", origin: "https://cairn-substrate.com", params: {} });
const reveal = (id) => ({ id, method: "revealClaim", origin: "https://dapp.example", params: { txid: "0x" + "5e".repeat(32) } });
const attest = (id) => ({ id, method: "attest", origin: "https://dapp.example", params: { proposalId: "0x" + "77".repeat(32), score: 1, confidence: 1, fee: 1_000_000 } });
// a token-priced fill is an attest the signer signs as a fill (signfields.ts fillOf); it arms once its quote is shown
const tokenFill = (id) => ({ id, method: "attest", origin: "https://dapp.example", params: { proposalId: "0x" + "79".repeat(32), score: 100, confidence: 1_000_000 } });
const fill = (id) => ({ id, method: "fillOffer", origin: "https://cairn-substrate.com", params: { proposalId: "0x" + "78".repeat(32), score: 100, confidence: 100, fee: 5_000_000, outputs: [{ to: "0x" + "aa".repeat(20), value: 100_000_000 }] } });

state.pending = [send("o0")];
const tick = await loadApprove();
await armed();

let o = await outcome({ done: true, ok: false, code: "SUBMIT_MAYBE_INFLIGHT", error: "/tx/submit -> network error", txid: TXID });
// WL1.2: the lines are the sentence module's (src/popup/sentences.ts); no server text and no code on the line.
check(`(1) maybe in flight: [R2], no server text (${o.text})`, o.text === SENTENCES.R2.text && o.cls === "msg err" && !/^Failed/.test(o.text));
o = await outcome({ done: true, ok: false, code: "SUBMIT_DUPLICATE", error: "this transaction, or one spending the same coins, is already pending. Check your history once it is mined before sending again." });
check(`(2) duplicate: [R3], info style (${o.text})`, o.text === SENTENCES.R3.text && o.cls === "msg info");
o = await outcome(null, { brokenChannel: true });
check(`(3) broken channel: possibly in flight, not a refusal: [R2] (${o.text})`, o.text === SENTENCES.R2.text && o.cls === "msg err");

o = await outcome({ done: true, ok: true, txid: TXID });
check(`(5) a txid: Sent (${o.text})`, /^Sent 0xc4c4c4c4/.test(o.text) && o.cls === "msg ok");
o = await outcome({ done: true, ok: true });
check(`(5) neither a refusal nor a txid (connect, sign-in): Approved. (${o.text})`, o.text === "Approved." && o.cls === "msg ok");
o = await outcome({ done: true, ok: false, code: "INSUFFICIENT", error: "insufficient confirmed balance" });
check(`(7) a page's send refused INSUFFICIENT is [S4], the code under Details (${o.text})`, o.text === SENTENCES.S4.text && o.cls === "msg err" && o.details.includes("(INSUFFICIENT)"));
o = await outcome({ done: true, ok: false, code: "FEE_CAP", feeCap: 250_000_000, error: "fee exceeds 2.5 CSD (10% of the coins this spend uses); refusing" });
check(`(7) a page's send refused FEE_CAP is [S12] with the cap (${o.text})`, o.text === "The fee is above what the wallet allows (2.5 CSD here). Nothing was sent.");
o = await outcome({ done: true, ok: false, code: "BAD_OUTPUTS", error: "each amount must be a positive safe integer" });
check(`(7) a page's send refused with a code without its own line is [R1], the engine's text under Details (${o.text})`, o.text === SENTENCES.R1.text && o.details.includes("each amount must be a positive safe integer") && o.details.includes("(BAD_OUTPUTS)"));
o = await outcome({ done: true, ok: false, code: "INSUFFICIENT", error: "insufficient confirmed balance" }, { req: attest });
check(`(5) honest: any other request keeps Failed for a code its slice has not worded (${o.text})`, o.text === "Failed: insufficient confirmed balance (INSUFFICIENT)" && o.cls === "msg err");
o = await outcome({ done: true, ok: false, error: "sign-in failed" }, { req: signin });
check(`(8) a refused first-party sign-in is [R11] (${o.text})`, o.text === SENTENCES.R11.text && !/Failed/.test(o.text));
o = await outcome({ done: true, ok: true, addr: ME, session: "s" }, { req: signin });
check(`(8) honest: an accepted sign-in reads Approved. (${o.text})`, o.text === "Approved.");
o = await outcome({ done: true, ok: false, error: "/api/content -> 413", status: 413 }, { req: reveal });
check(`(9) a reveal the content server did not take is [Q3], the status under Details (${o.text})`, o.text === SENTENCES.Q3.text && o.details.includes("HTTP 413"));
o = await outcome({ done: true, ok: false, code: "SEAL_UNKNOWN", error: "no sealed claim with that txid in this account" }, { req: reveal });
check(`(9) SEAL_UNKNOWN is [Q4] (${o.text})`, o.text === SENTENCES.Q4.text);
o = await outcome({ done: true, ok: false, code: "SUBMIT_REJECTED", reason: "FEE", error: "every server refused this transaction (FEE)" });
check(`(6) a refused submit is [R4] by its reason, no code on the line (${o.text})`, o.text === SENTENCES.R4.text && !/SUBMIT_REJECTED|Failed/.test(o.text));
// fillpreflight.ts's own sentence for an offer whose payment recipient could not be proven yet
const OFFER_UNPROVEN = "couldn't prove this offer's on-chain payment recipient yet; try again in a moment";
o = await outcome({ done: true, ok: false, code: "VERIFY_UNAVAILABLE", error: OFFER_UNPROVEN, sighashMatch: false }, { req: fill });
check(`(10a) a fill refused VERIFY_UNAVAILABLE keeps the engine's sentence and code (${o.text})`, o.text === `Failed: ${OFFER_UNPROVEN} (VERIFY_UNAVAILABLE)` && o.cls === "msg err" && o.text !== SENTENCES.S9.text);
o = await outcome({ done: true, ok: false, code: "VERIFY_UNAVAILABLE", error: "couldn't read the coin list from the node; try again in a moment" });
check(`(10b) honest: a page's send refused VERIFY_UNAVAILABLE is [S9], the code under Details (${o.text})`, o.text === SENTENCES.S9.text && o.details.includes("(VERIFY_UNAVAILABLE)"));
const COINS_UNREAD = "couldn't fetch your coins (node unreachable or erroring); nothing was signed, try again in a moment";
o = await outcome({ done: true, ok: false, code: "VERIFY_UNAVAILABLE", error: COINS_UNREAD, sighashMatch: false }, { req: fill });
check(`(10d) a fill whose coins could not be read keeps the engine's own sentence about the coins (${o.text})`, o.text === `Failed: ${COINS_UNREAD} (VERIFY_UNAVAILABLE)`);
o = await outcome({ done: true, ok: false, code: "VERIFY_TAMPER", error: "a coin's source transaction does not match" }, { req: fill });
check(`(10c) honest: a fill's other worded codes keep their line ([S10]: ${o.text})`, o.text === SENTENCES.S10.text);
o = await outcome({ done: true, ok: false, code: "VERIFY_UNAVAILABLE", error: OFFER_UNPROVEN, sighashMatch: false }, { req: tokenFill });
check(`(10f) a token fill refused VERIFY_UNAVAILABLE keeps the engine's sentence too (${o.text})`, o.text === `Failed: ${OFFER_UNPROVEN} (VERIFY_UNAVAILABLE)`);
const renew = refusedCopy({ ok: false, code: "VERIFY_UNAVAILABLE", error: COINS_UNREAD }, "renewal");
check(`(10e) honest: a renew refused VERIFY_UNAVAILABLE is [S9] (${renew.text})`, renew.key === "S9" && renew.text === SENTENCES.S9.text);
handlers.resolve = () => { state.pending = []; throw new Error("wallet locked"); };
o = await outcome(null);
check(`(5) an answered lock throw (the worker refused before any submit) is [R8], without Failed (${o.text})`, o.text === SENTENCES.R8.text && o.cls === "msg err");
handlers.resolve = () => { state.pending = []; throw new Error("something internal"); };
o = await outcome(null);
check(`(7) an answered throw on a page's send is [R1], its text under Details (${o.text})`, o.text === SENTENCES.R1.text && o.details.includes("something internal"));
o = await outcome(null, { req: attest });
check(`(5) honest: an answered throw on any other request keeps its own text until its slice words it (${o.text})`, o.text === "Failed: something internal" && o.cls === "msg err");

done("approve-outcome-dom");
