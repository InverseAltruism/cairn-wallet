// Approve-window quote race across an idle auto-lock (src/popup/approve.ts, fillTokenSim + armButtons).
//
// The unlock repaint rebuilds the request view for the SAME request id, so a check on renderedId alone
// cannot tell the first paint's in-flight work from the repaint's. A token quote started by the first
// paint that lands after the repaint used to mark the preview `ready` (and record its quote as the
// displayed one) while writing into the detached old #token-sim, and the first paint's armButtons chain
// then re-enabled Approve with the visible preview still empty. These cases drive the real module
// through the element registry in helpers/approve-dom.mjs and assert on what is on screen and on the
// exact resolve() call the background receives.
//
//   RED-FIRST: on the pre-fix approve.ts, cases (1), (2), (3) and (7) go red. Removing only the
//   generation check in fillTokenSim turns (2), (3) and (7) red; removing only the one in armButtons
//   turns (3) red.
//   PAIRED HONEST PATHS: (4) a normal token-priced fill, (5) an unlock repaint whose own quote arrives,
//   (6) a non-token send, each approved with the production resolve() call shape.
//
// Run: node --import tsx test/approve-quote-race-dom.test.mjs   (offline)
import { checker } from "./helpers/check.mjs";
import { mountApproveWindow, loadApprove, flush, sleep } from "./helpers/approve-dom.mjs";

const { check, done } = checker("approve quote race across lock/unlock:");

const ME = "0x" + "ab".repeat(20);
const RCPT = "0x" + "31".repeat(20);
const state = { pending: [], unlocked: true };
const resolves = [];
let quoteMode = "manual";       // "manual": each tokenFillQuote call parks its resolver in quoteCalls
let autoQuote = null;
const quoteCalls = [];
const handlers = {
  status: () => ({ unlocked: state.unlocked, accounts: [{ label: "Main", addr: ME }], active: 0, addr: ME, tradeApi: "" }),
  pending: () => structuredClone(state.pending),
  balance: () => ({ confirmed: 100_00000000 }),
  history: () => [{ to: RCPT }],
  sealedClaims: () => [],
  tokenFillQuote: () => quoteMode === "auto" ? autoQuote : new Promise((r) => quoteCalls.push(r)),
  tip: () => 65_000, epoch: () => 2_166, tipFloor: () => 0, tokenDisplayMeta: () => ({}),
  fillOfferView: () => null,
  resolve: (...a) => { resolves.push(a); state.pending = state.pending.filter((p) => p.id !== a[0]); return { done: true, ok: true, txid: "0x" + "ee".repeat(32) }; },
};
const { registry } = mountApproveWindow(handlers);
const approveBtn = () => registry.get("btn-approve");
const sim = () => registry.get("token-sim");
const click = async () => { approveBtn()._listeners.click(); await flush(); await sleep(20); await flush(); };
const tokenReq = (id) => ({ id, method: "attest", origin: "https://dapp.example", params: { proposalId: "0x" + "aa".repeat(32), score: 100, confidence: 1_000_000 } });
const quote = (amount) => ({ ok: true, ticker: "PAY", amount, fee: "1", total: String(Number(amount) + 1), giveTicker: "AAA", giveAmount: "10" });
const lockThenUnlock = async (tick) => {
  state.unlocked = false; await tick(); await flush();
  state.unlocked = true; await tick(); await flush();
};
const lastResolve = () => resolves[resolves.length - 1];

state.pending = [tokenReq("r1")];
const tick = await loadApprove();
await flush();

// (1) The reviewer's sequence: quote #1 lands after the unlock repaint started quote #2.
{
  await sleep(800); await flush();
  check("(1) setup: first paint, quote #1 in flight, Approve disabled", quoteCalls.length === 1 && approveBtn().disabled === true);
  await lockThenUnlock(tick);
  check("(1) setup: the unlock repaint started quote #2", quoteCalls.length === 2);
  quoteCalls[0](quote("7")); await flush(); await sleep(50); await flush();
  check("(1) stale quote #1 does not arm Approve", approveBtn().disabled === true);
  check("(1) visible #token-sim is still empty and hidden", sim().hidden === true && sim().innerHTML === "");
  const before = resolves.length;
  await click();
  check("(1) a click on the disabled button reaches no resolve", resolves.length === before);
  quoteCalls[1](quote("9")); await flush();
  await sleep(750); await flush();
  check("(1) quote #2 painted into the visible #token-sim", sim().hidden === false && sim().innerHTML.includes("9 ask"));
  check("(1) Approve enabled once the current quote is visible", approveBtn().disabled === false);
  await click();
  const r = lastResolve();
  check("(1) resolve carries the visible quote #2, not quote #1", resolves.length === before + 1 && r[0] === "r1" && r[1] === true && r[2] === ME && r[3]?.amount === "9" && r[3]?.total === "10");
}

// (2) Quote #2 is on screen and approvable; a late quote #1 must not replace the quote the click threads.
{
  quoteCalls.length = 0;
  state.pending = [tokenReq("r2")]; await tick(); await flush();
  check("(2) setup: quote #1 in flight", quoteCalls.length === 1);
  await lockThenUnlock(tick);
  check("(2) setup: quote #2 in flight", quoteCalls.length === 2);
  quoteCalls[1](quote("9")); await flush();
  await sleep(750); await flush();
  check("(2) setup: quote #2 visible and Approve enabled", sim().innerHTML.includes("9 ask") && approveBtn().disabled === false);
  quoteCalls[0](quote("7")); await flush(); await sleep(20); await flush();
  check("(2) the visible preview still shows quote #2", sim().hidden === false && sim().innerHTML.includes("9 ask") && !sim().innerHTML.includes("7 ask"));
  await click();
  const r = lastResolve();
  check("(2) resolve carries the quote on screen (#2)", r[0] === "r2" && r[3]?.amount === "9");
}

// (3) The first paint's armButtons chain must not re-enable Approve inside the repaint's 700 ms floor,
// even when the current quote is already ready.
{
  quoteCalls.length = 0;
  state.pending = [tokenReq("r3")]; await tick(); await flush();
  await sleep(750); await flush();          // the first paint's 700 ms floor has elapsed; it waits on quote #1 only
  await lockThenUnlock(tick);
  check("(3) setup: two quotes in flight", quoteCalls.length === 2);
  quoteCalls[1](quote("9")); await flush();
  quoteCalls[0](quote("7")); await flush(); await sleep(20); await flush();
  check("(3) Approve still disabled inside the repaint's 700 ms floor", approveBtn().disabled === true);
  await sleep(750); await flush();
  check("(3) Approve enabled after the floor with quote #2 visible", approveBtn().disabled === false && sim().innerHTML.includes("9 ask"));
  await click();
  check("(3) resolve carries quote #2", lastResolve()[0] === "r3" && lastResolve()[3]?.amount === "9");
}

// (4) Honest path: a token-priced fill whose quote arrives normally paints and approves after the floor.
{
  quoteCalls.length = 0;
  state.pending = [tokenReq("r4")]; await tick(); await flush();
  quoteCalls[0](quote("5")); await flush();
  check("(4) the quote is visible as soon as it lands", sim().hidden === false && sim().innerHTML.includes("5 ask"));
  await sleep(750); await flush();
  check("(4) Approve enabled after the 700 ms floor", approveBtn().disabled === false);
  await click();
  const r = lastResolve();
  check("(4) resolve(id, true, signer, displayedQuote) with the shown quote",
    r.length === 4 && r[0] === "r4" && r[1] === true && r[2] === ME
    && JSON.stringify(r[3]) === JSON.stringify({ ticker: "PAY", amount: "5", fee: "1", total: "6", giveTicker: "AAA", giveAmount: "10" }));
}

// (5) Honest path across a lock: quote #1 already shown, the unlock repaint's own quote arrives promptly.
{
  quoteMode = "auto";
  autoQuote = quote("3");
  state.pending = [tokenReq("r5")]; await tick(); await flush();
  await sleep(750); await flush();
  check("(5) setup: first paint approvable", approveBtn().disabled === false && sim().innerHTML.includes("3 ask"));
  autoQuote = quote("4");
  await lockThenUnlock(tick);
  check("(5) the repaint's own quote is visible", sim().hidden === false && sim().innerHTML.includes("4 ask"));
  await sleep(750); await flush();
  check("(5) Approve enabled after the repaint's 700 ms floor", approveBtn().disabled === false);
  await click();
  check("(5) resolve carries the repaint's quote", lastResolve()[0] === "r5" && lastResolve()[3]?.amount === "4");
}

// (6) A non-token request: no quote fetch, approvable after the floor, no displayed quote threaded; the
// same holds across a lock/unlock repaint.
{
  const qBefore = quoteCalls.length;
  const send = (id) => ({ id, method: "send", origin: "https://dapp.example", params: { to: RCPT, amount: 1_00000000 } });
  state.pending = [send("r6")]; await tick(); await flush();
  await sleep(750); await flush();
  check("(6) send: Approve enabled after the floor", approveBtn().disabled === false);
  await lockThenUnlock(tick);
  check("(6) send: the repaint disables Approve", approveBtn().disabled === true);
  await sleep(750); await flush();
  check("(6) send: Approve enabled after the repaint's floor", approveBtn().disabled === false);
  await click();
  const r = lastResolve();
  check("(6) send: resolve(id, true, signer, undefined), no quote fetched", r[0] === "r6" && r[1] === true && r[2] === ME && r[3] === undefined && quoteCalls.length === qBefore);
}

// (7) A superseded quote that would throw while being read must not mark the current, visible quote as
// failed (that would refuse an honest click): the generation check drops it before any field is read.
{
  quoteMode = "manual";
  quoteCalls.length = 0;
  state.pending = [tokenReq("r7")]; await tick(); await flush();
  await lockThenUnlock(tick);
  check("(7) setup: two quotes in flight", quoteCalls.length === 2);
  quoteCalls[1](quote("9")); await flush();
  await sleep(750); await flush();
  check("(7) setup: quote #2 visible and Approve enabled", sim().innerHTML.includes("9 ask") && approveBtn().disabled === false);
  quoteCalls[0]({ ok: true, get ticker() { throw new Error("bad quote"); } }); await flush(); await sleep(20); await flush();
  const before = resolves.length;
  await click();
  check("(7) the click resolves with quote #2", resolves.length === before + 1 && lastResolve()[0] === "r7" && lastResolve()[3]?.amount === "9");
}

done("approve-quote-race-dom");
