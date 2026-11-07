// The approval window's outcome line reads a submit outcome the way the popup does (popup-bridge's refusedCopy and
// thrownCopy), through the REAL src/popup/approve.ts on helpers/approve-dom.mjs:
//   (1) SUBMIT_MAYBE_INFLIGHT says the transaction may already be in flight and names the history row, not "Failed";
//   (2) SUBMIT_DUPLICATE shows its own text, info style;
//   (3) a broken channel (the worker died mid-call) reads as possibly in flight, not as an answered refusal;
//   (4) a request already handled in another view: test/approve-handled-elsewhere.test.mjs drives two real views;
//   (5) honest paths unchanged: a txid shows "Sent", an answer with neither (a connect or sign-in) shows "Approved.",
//       and any other refusal, an answered throw included, keeps "Failed: ...".
// A "Failed" on an ambiguous submit invites the site's retry, which pays twice when the first transaction lands.
// Run: npx tsx test/approve-outcome-dom.test.mjs   (offline)
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
  unlock: () => true,
};
const { registry } = mountApproveWindow(handlers);
const send = (id) => ({ id, method: "send", origin: "https://dapp.example", params: { to: "0x" + "aa".repeat(20), amount: 1e8, fee: 1_000_000 } });
const armed = async () => { await flush(); await sleep(760); await flush(); };
const msgEl = () => registry.get("msg");
let n = 0;
async function outcome(ans, opts = {}) {
  state.pending = [send("o" + ++n)];
  await tick(); await armed();
  answer = () => { state.pending = []; return ans; };
  const rt = globalThis.chrome.runtime;
  const real = rt.sendMessage;
  if (opts.brokenChannel) rt.sendMessage = (m, cb) => { if (m.method !== "resolve") return real(m, cb); Promise.resolve().then(() => { state.pending = []; rt.lastError = { message: "The message port closed before a response was received." }; try { cb(undefined); } finally { rt.lastError = undefined; } }); };
  try { registry.get("btn-approve")._listeners.click(); await flush(20); } finally { rt.sendMessage = real; }
  return { text: msgEl().textContent, cls: msgEl().className };
}

state.pending = [send("o0")];
const tick = await loadApprove();
await armed();

let o = await outcome({ done: true, ok: false, code: "SUBMIT_MAYBE_INFLIGHT", error: "/tx/submit -> network error", txid: TXID });
check(`(1) maybe in flight: says so and names the history row (${o.text})`, o.text === "/tx/submit -> network error. The transaction didn't confirm; it may already be in flight. Check your history before trying again. It's in your history as 0xc4c4c4c4c4…" && o.cls === "msg err" && !/^Failed/.test(o.text));
o = await outcome({ done: true, ok: false, code: "SUBMIT_DUPLICATE", error: "this transaction, or one spending the same coins, is already pending. Check your history once it is mined before sending again." });
check(`(2) duplicate: its own text, info style (${o.text})`, o.text === "this transaction, or one spending the same coins, is already pending. Check your history once it is mined before sending again." && o.cls === "msg info");
o = await outcome(null, { brokenChannel: true });
check(`(3) broken channel: possibly in flight, not a refusal (${o.text})`, o.text === "The message port closed before a response was received. The transaction didn't confirm; it may already be in flight. Check your history before trying again." && o.cls === "msg err");

o = await outcome({ done: true, ok: true, txid: TXID });
check(`(5) a txid: Sent (${o.text})`, /^Sent 0xc4c4c4c4/.test(o.text) && o.cls === "msg ok");
o = await outcome({ done: true, ok: true });
check(`(5) neither a refusal nor a txid (connect, sign-in): Approved. (${o.text})`, o.text === "Approved." && o.cls === "msg ok");
o = await outcome({ done: true, ok: false, code: "INSUFFICIENT", error: "insufficient confirmed balance" });
check(`(5) another refusal keeps Failed (${o.text})`, o.text === "Failed: insufficient confirmed balance (INSUFFICIENT)" && o.cls === "msg err");
handlers.resolve = () => { state.pending = []; throw new Error("wallet locked"); };
o = await outcome(null);
check(`(5) an answered throw (the worker refused before any submit) keeps Failed (${o.text})`, o.text === "Failed: wallet locked" && o.cls === "msg err");

done("approve-outcome-dom");
