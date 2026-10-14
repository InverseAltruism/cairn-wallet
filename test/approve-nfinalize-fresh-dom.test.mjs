// The nfinalize approve gate must stay current while the request is open (src/popup/approve.ts).
//
// An nfinalize pays the registration fee, and the resolver credits it only inside the finalize window
// (after the freeze, before the deadline); outside it the fee burns. The window is a function of the chain
// tip, so a verdict computed once when the request painted goes wrong when the request stays open: left
// open past the deadline it still approves and burns the fee, and opened too early it stays blocked until
// a reopen. A verdict that settled while the wallet was locked was also dropped.
//
// This file drives the REAL module through helpers/approve-dom.mjs with a fake clock (Date.now) and the
// 1.2 s poll driven by hand, so the refresh cadence and the click-time age bound are deterministic.
//   RED-FIRST (origin/master): (1b) the window closes while open, Approve stays live; (2a) a click on a
//   stale verdict reaches the signer; (3b) a too-early request stays blocked; (4a)/(4b) a verdict that
//   settled while locked is missing after unlock.
//   MUTATIONS: drop `void refreshNfinalize(current.id)` in render(): (1b) and (3b) go red. Make nfinAtClick
//   return `g` unconditionally: (2a) goes red.
//   PAIRED HONEST PATHS on the production call shape (the /names site's anchorRecord propose): (5a) an
//   in-window finalize approves on the first click with no tip read and no timer at the click; (5b) a
//   running poll keeps the verdict young enough that the click never pays the re-check; (5c) a send and an
//   nrenew get no refresh reads; (6) a dead or lying RPC yields at most a refusal the user can retry.
//
// Run: npx tsx test/approve-nfinalize-fresh-dom.test.mjs   (offline)
import { CAIRNX_DOMAIN, TREASURY_ADDR, buildNameRenew } from "../src/core/cairnx.js";
import { nameFinalize, REG_COMMIT_MAX_BLOCKS, REG_FINALIZE_GRACE_BLOCKS, FINALIZE_TIP_MARGIN } from "../src/vendor/cairnx-spv.js";
import { checker } from "./helpers/check.mjs";
import { mountApproveWindow, loadApprove, flush, sleep } from "./helpers/approve-dom.mjs";

const { check, done } = checker();

const ME = "0x" + "ab".repeat(20);
const RCPT = "0x" + "31".repeat(20);
const EFF = 117_000;                                                        // the reservation's effectiveHeight
const FIRST_OK = EFF + REG_COMMIT_MAX_BLOCKS + FINALIZE_TIP_MARGIN + 1;      // first tip the gate passes
const LAST_OK = EFF + REG_COMMIT_MAX_BLOCKS + REG_FINALIZE_GRACE_BLOCKS - FINALIZE_TIP_MARGIN;   // last tip it passes

let now = 1_800_000_000_000;
Date.now = () => now;

const state = { unlocked: true, pending: [] };
let tipNow = FIRST_OK + 5;
let tipCalls = 0;
let tipHang = false;
let tipRefuse = false;
const resolves = [];
const handlers = {
  status: () => ({ unlocked: state.unlocked, accounts: [{ label: "Main", addr: ME }], active: 0, addr: ME, tradeApi: "https://cairn-substrate.com/trade/api" }),
  pending: () => structuredClone(state.pending),
  balance: () => ({ confirmed: 1_000_00000000 }),
  history: () => [],
  sealedClaims: () => [],
  tokenFillQuote: () => null,
  tokenDisplayMeta: () => ({}),
  tip: () => { tipCalls++; if (tipRefuse) throw new Error("rpc down"); return tipHang ? new Promise(() => {}) : tipNow; },
  epoch: () => Math.floor(tipNow / 30),
  tipFloor: () => 0,
  resolve: (...a) => { resolves.push(a); state.pending = state.pending.filter((r) => r.id !== a[0]); return { done: true, ok: true, txid: "0x" + "ee".repeat(32) }; },
  unlock: () => true,
};
const { registry } = mountApproveWindow(handlers);

// The name service. `nameMode`: "ok" serves the live reservation, "404" a clean 404, "500" a server error.
let nameMode = "ok";
let nameFetches = 0;
let fetchDelayMs = 0;
globalThis.fetch = async (url) => {
  if (!/\/cairnx\/name\/satoshi$/.test(String(url))) throw new Error("unexpected fetch: " + url);
  nameFetches++;
  if (fetchDelayMs) await sleep(fetchDelayMs);
  if (nameMode === "500") return { status: 500, ok: false, json: async () => null };
  if (nameMode === "404") return { status: 404, ok: false, json: async () => null };
  return { status: 200, ok: true, json: async () => ({ name: "satoshi", owner: ME, pending: true, effectiveHeight: EFF }) };
};

// Production's call shape: actions.js anchorRecord({ v: 1, t: "nfinalize", name, salt }, epochNow() + 100000,
// ..., [{ to: TREASURY, value: fee }]) raises a cairnx:v1 propose with these params.
const FIN = nameFinalize({ name: "satoshi", salt: "a1".repeat(16) });
const finReq = (id) => ({ id, method: "propose", origin: "https://cairn-substrate.com",
  params: { domain: CAIRNX_DOMAIN, payloadHash: FIN.payloadHash, uri: FIN.uri, expiresEpoch: Math.floor(tipNow / 30) + 100_000, fee: 25_000_000, outputs: [{ to: TREASURY_ADDR, value: 500_000_000 }] } });
const RENEW = buildNameRenew({ name: "satoshi" });
const renewReq = (id) => ({ id, method: "propose", origin: "https://cairn-substrate.com",
  params: { domain: CAIRNX_DOMAIN, uri: RENEW.uri, payloadHash: RENEW.payloadHash, fee: 1_000_000, outputs: [{ to: TREASURY_ADDR, value: 100_000_000 }] } });
const sendReq = (id) => ({ id, method: "send", origin: "https://dapp.example", params: { to: RCPT, amount: 1_00000000, fee: 1_000_000 } });

const approveBtn = () => registry.get("btn-approve");
const reqHtml = () => registry.get("req").innerHTML;
// the gate note as rendered: the harness keeps inserted markup on the parent, so read it from #req while
// an #nfin-note element exists
const note = () => (registry.get("nfin-note") ? reqHtml() : "");
const settle = async (ms = 800) => { await sleep(ms); await flush(); };   // 800 ms: just past the 700 ms re-enable floor
let tick;
// one poll tick `ms` of wall clock later (the real poll runs every 1.2 s)
const pollAfter = async (ms = 1200) => { now += ms; await tick(); await flush(); };
const show = async (req) => { state.pending = [req]; await tick(); await flush(); await settle(); };

state.pending = [sendReq("boot")];
tick = await loadApprove();
await flush(); await settle();

// ── 1. the window closes while the request is open and the poll is running ──────────────────────────
console.log("(1) the finalize window closes while the request is open");
tipNow = LAST_OK - 1;
await show(finReq("f1"));
check("(1a) setup: inside the window the gate passes, Approve is live and there is no gate note", approveBtn().disabled === false && note() === "");
const tipsAtPaint = tipCalls, fetchesAtPaint = nameFetches;
for (let i = 0; i < 15; i++) await pollAfter();                             // 18 s: under the refresh period
check("(1a) 15 poll ticks inside the refresh period add no tip read and no name fetch", tipCalls === tipsAtPaint && nameFetches === fetchesAtPaint);
tipNow = LAST_OK + 1;                                                        // the chain moves past the deadline
for (let i = 0; i < 3; i++) await pollAfter();                              // crosses 20 s
check("(1b) RED on master: once the tip passes the window, Approve goes down without a reopen", approveBtn().disabled === true);
check("(1b) ...and the window-closed refusal is shown in place", /window has closed/.test(note()));
check("(1b) the refresh read the tip once and refetched the reservation once (the tip moved)", tipCalls === tipsAtPaint + 1 && nameFetches === fetchesAtPaint + 1);
registry.get("btn-approve")._listeners.click();
await flush();
check("(1b) a click reaches no signer", resolves.length === 0);
check("(1b) Reject stays available", registry.get("btn-reject").disabled === false);

// ── 2. click-time re-check when the poll did not run (throttled tab, sleep) ───────────────────────────
console.log("\n(2) a click on a verdict older than the bound re-reads the tip first");
tipNow = LAST_OK - 1;
await show(finReq("f2"));
check("(2) setup: in-window verdict, Approve live", approveBtn().disabled === false);
now += 31_000;                                                               // no poll ticks: the timer was throttled
tipNow = LAST_OK + 1;
const tipsBeforeClick = tipCalls;
registry.get("btn-approve")._listeners.click();
await flush();
check("(2a) RED on master: the stale verdict is re-checked and the late finalize is refused", resolves.length === 0);
check("(2a) ...with one tip read and the window-closed reason", tipCalls === tipsBeforeClick + 1 && /window has closed/.test(registry.get("msg").textContent));
check("(2a) ...Approve goes down and the note is shown in place", approveBtn().disabled === true && /window has closed/.test(note()));
check("(2a) the request is not consumed: it is still on screen and Reject works", registry.get("view-req").hidden === false && registry.get("btn-reject").disabled === false);
registry.get("btn-reject")._listeners.click();
await flush();
check("(2a) Reject resolves it as a rejection", resolves.length === 1 && resolves[0][0] === "f2" && resolves[0][1] === false);

// 2b. paired: the stale verdict is re-checked, the tip is still inside the window, the click goes through
tipNow = LAST_OK - 3;
await show(finReq("f2b"));
now += 31_000;
tipNow = LAST_OK - 2;
registry.get("btn-approve")._listeners.click();
await flush();
check("(2b) paired: a stale verdict whose fresh tip is still in the window approves on the same click", resolves.length === 2 && resolves[1][0] === "f2b" && resolves[1][1] === true);

// ── 3. opened too early, becomes approvable without a reopen ──────────────────────────────────────────
console.log("\n(3) a request opened before the freeze becomes approvable when the window opens");
tipNow = FIRST_OK - 1;
await show(finReq("f3"));
check("(3a) setup: before the freeze the gate refuses, Approve is down", approveBtn().disabled === true && /too early/.test(note()));
tipNow = FIRST_OK;
for (let i = 0; i < 17; i++) await pollAfter();                             // 20.4 s
check("(3b) RED on master: when the window opens, Approve comes back without a reopen", approveBtn().disabled === false);
check("(3b) ...and the too-early note is gone from the screen", note() === "" && registry.get("nfin-note") == null && !/too early/.test(reqHtml()));
registry.get("btn-approve")._listeners.click();
await flush();
check("(3b) the click approves", resolves.length === 3 && resolves[2][0] === "f3" && resolves[2][1] === true);

// ── 4. a verdict that settles while the wallet is locked ──────────────────────────────────────────────
console.log("\n(4) a verdict that settles while locked is shown after unlock");
fetchDelayMs = 1200;                                                        // slower than the lock below
tipNow = LAST_OK + 4;
state.pending = [finReq("f4")];
await tick(); await flush(); await settle();                               // painted, verdict in flight
state.unlocked = false; await tick(); await flush();                       // idle auto-lock
await settle(700);                                                          // the verdict lands while locked
state.unlocked = true; await tick(); await flush(); await settle();
check("(4a) RED on master: a BLOCKING verdict that settled while locked is shown after unlock", /window has closed/.test(reqHtml()));
check("(4a) ...and Approve stays down past the repaint's 700 ms re-enable floor", approveBtn().disabled === true);

nameMode = "500";                                                            // the fail-open warning
tipNow = LAST_OK - 1;
state.pending = [finReq("f4b")];
await tick(); await flush(); await settle();
state.unlocked = false; await tick(); await flush();
await settle(700);
state.unlocked = true; await tick(); await flush(); await settle();
check("(4b) RED on master: the fail-open warning that settled while locked is shown after unlock", /could not verify this name reservation/.test(reqHtml()));
check("(4b) ...and a warning leaves Approve live (warn over block)", approveBtn().disabled === false);
fetchDelayMs = 0; nameMode = "ok";

// 4c. the window closes while locked: the unlock repaint already shows the refusal
tipNow = LAST_OK - 1;
await show(finReq("f4c"));
state.unlocked = false; await tick(); await flush();
tipNow = LAST_OK + 1;
for (let i = 0; i < 17; i++) await pollAfter();
state.unlocked = true; await tick(); await flush(); await settle();
check("(4c) the window closed while locked: after unlock Approve is down with the refusal shown", approveBtn().disabled === true && /window has closed/.test(reqHtml()));

// ── 5. honest paths ─────────────────────────────────────────────────────────────────────────────────
console.log("\n(5) honest paths");
tipNow = LAST_OK - 6;
await show(finReq("f5"));
const t5 = tipCalls, n5 = resolves.length;
registry.get("btn-approve")._listeners.click();
await flush();
check("(5a) an in-window finalize approves on the first click, with no tip read at the click and no timer wait (flush only)",
  resolves.length === n5 + 1 && resolves[n5][0] === "f5" && resolves[n5][1] === true && tipCalls === t5);
check("(5a) ...with the production resolve shape (id, true, signer, no quote)", resolves[n5].length === 4 && resolves[n5][2] === ME && resolves[n5][3] === undefined);

tipNow = LAST_OK - 10;
await show(finReq("f5b"));
const t5b = tipCalls, f5b = nameFetches;
for (let i = 0; i < 50; i++) await pollAfter();                             // 60 s of a focused window, tip unchanged
check("(5b) 60 s of polling reads the tip once per 20.4 s of 1.2 s ticks (2 reads) and never refetches an unchanged tip", tipCalls === t5b + 2 && nameFetches === f5b);
const t5bClick = tipCalls, n5b = resolves.length;
registry.get("btn-approve")._listeners.click();
await flush();
check("(5b) after a minute open, the click still pays no tip read (the poll kept the verdict young)", resolves.length === n5b + 1 && resolves[n5b][0] === "f5b" && tipCalls === t5bClick);

for (const [label, req] of [["a send", sendReq("s5")], ["an nrenew", renewReq("r5")]]) {
  await show(req);
  const tc = tipCalls, fc = nameFetches, nr = resolves.length;
  for (let i = 0; i < 50; i++) await pollAfter();
  check(`(5c) ${label}: 60 s of polling adds no tip read and no name fetch`, tipCalls === tc && nameFetches === fc);
  now += 31_000;
  registry.get("btn-approve")._listeners.click();
  await flush();
  check(`(5c) ${label}: approves on the click with no tip read`, resolves.length === nr + 1 && resolves[nr][1] === true && tipCalls === tc);
}

// ── 6. Rule B: what a dead or lying RPC can do through the refresh ───────────────────────────────────
console.log("\n(6) a dead or lying RPC");
tipNow = LAST_OK - 5;
await show(finReq("f6"));
tipHang = true;                                                              // the RPC stops answering
for (let i = 0; i < 20; i++) await pollAfter();
await settle(2600);                                                          // past the 2.5 s bound of the hung read
check("(6a) a hung tip read during refresh keeps the last verdict: Approve stays live, no note", approveBtn().disabled === false && note() === "");
now += 31_000;
const n6 = resolves.length;
registry.get("btn-approve")._listeners.click();
await settle(2600);
check("(6a) a stale click whose tip read hangs proceeds on the last verdict after the 2.5 s bound (no new refusal)", resolves.length === n6 + 1 && resolves[n6][0] === "f6" && resolves[n6][1] === true);
tipHang = false;

tipNow = LAST_OK - 5;
await show(finReq("f6b"));
const real = tipNow;
tipNow = real + 1000;                                                        // a lying RPC claims a far tip
for (let i = 0; i < 17; i++) await pollAfter();
check("(6b) a lying high tip yields a refusal (Approve down) and nothing is signed", approveBtn().disabled === true && resolves.length === n6 + 1);
check("(6b) ...Reject stays available", registry.get("btn-reject").disabled === false);
tipNow = real;                                                               // the RPC is honest again
for (let i = 0; i < 17; i++) await pollAfter();
check("(6b) ...and it is retryable in place: the next refresh at an honest tip brings Approve back", approveBtn().disabled === false && note() === "");

nameMode = "500";                                                            // the name service goes down
tipNow = LAST_OK + 1;                                                        // while the tip moves past the window
for (let i = 0; i < 17; i++) await pollAfter();
check("(6c) a name-service outage after the tip moved does not turn the window refusal into the fail-open warning", approveBtn().disabled === true && /window has closed/.test(note()));
nameMode = "ok";

// 6e. an RPC that refuses (no hang, so the bound never holds `busy`) is retried at the refresh cadence
tipNow = LAST_OK - 5;
await show(finReq("f6e"));
tipRefuse = true;
const t6e = tipCalls;
for (let i = 0; i < 34; i++) await pollAfter();                              // 40.8 s of 1.2 s ticks
check("(6e) a refused tip read is retried once per refresh period (2 reads in 40.8 s), not on every poll tick", tipCalls === t6e + 2);
check("(6e) ...and the last verdict stands: Approve stays live, no note", approveBtn().disabled === false && note() === "");
tipRefuse = false;
check("(6d) no refresh signed or broadcast anything: every resolve call above came from a click", resolves.length === n6 + 1);

done("approve-nfinalize-fresh-dom");
