// The approval window's reservation confirm step, driven through the REAL src/popup/approve.ts against the element
// registry in helpers/approve-dom.mjs. When the worker answers RESERVATION_UNCONFIRMED (the request stays queued),
// the window repaints the request with the warning and relabels its buttons "Sign anyway" / "Cancel"; "Sign anyway"
// re-sends the approval with an acknowledgement bound to (request id, fclaim txid); "Cancel" rejects.
//
// RED-FIRST: drop the `ack` argument from the resolve call in approve.ts resolve() and (2) fails.
// PAIRED HONEST PATH: (4) a fill the worker signs on the first approval shows no warning and one resolve call.
//
// Run: npx tsx test/approve-unconfirmed-dom.test.mjs   (offline)
import assert from "node:assert/strict";
import { mountApproveWindow, loadApprove, flush, sleep } from "./helpers/approve-dom.mjs";
import { reservationUnconfirmedHtml } from "../src/popup/clearsign.js";

const ME = "0x" + "ab".repeat(20);
const FC = "0x" + "f1".repeat(32);
const state = { pending: [], unlocked: true };
const calls = [];
let answer = () => { state.pending = []; return { done: true, ok: true, txid: "0x" + "aa".repeat(32) }; };
const handlers = {
  status: () => ({ unlocked: state.unlocked, accounts: [{ label: "Main", addr: ME }], active: 0, addr: ME }),
  pending: () => state.pending,
  balance: () => ({ confirmed: 5_000_00000000 }),
  history: () => [],
  fillOfferView: () => ({ ok: true, offerId: "0x" + "0f".repeat(32), giveTicker: "TOKA", giveAmount: "1000", giveDecimals: 0 }),
  tokenFillQuote: () => null, tokenDisplayMeta: () => ({}), sealedClaims: () => [], tip: () => 116_520, epoch: () => 3_884, tipFloor: () => 0,
  resolve: (...args) => { calls.push(args); return answer(args); },
  unlock: () => true,
};
const { registry } = mountApproveWindow(handlers);
const fill = (id) => ({ id, method: "fillOffer", origin: "https://dapp.example", params: { proposalId: FC, outputs: [{ to: "0x" + "aa".repeat(20), value: 1000e8 }], fee: 1_000_000 } });
const U = { fclaimTxid: FC, fclaimHeight: 116_490, tipHeight: 116_520 };
const UNCONFIRMED = { done: false, ok: false, code: "RESERVATION_UNCONFIRMED", error: "the second source has read the chain to block 116520 and has no record of your reservation (block 116490); confirm in the approval window to sign anyway", unconfirmed: U };
const armed = async () => { await flush(); await sleep(760); await flush(); };
const req = () => registry.get("req").innerHTML;
const labels = () => [registry.get("btn-approve").textContent, registry.get("btn-reject").textContent];
// The `primary` class carries the emphasis (the filled button); the other button is the outlined default.
const primary = () => [registry.get("btn-approve").className, registry.get("btn-reject").className];
const click = async (id) => { registry.get(id)._listeners.click(); await flush(20); };

console.log("approval window: the reservation confirm step");
state.pending = [fill("u1")];
const tick = await loadApprove();
await armed();
assert.deepEqual(labels(), ["Approve", "Reject"], "setup: the ordinary labels");
assert.deepEqual(primary(), ["primary", ""], "setup: Approve is the primary button");

// (1) unknown: the request is painted again with the warning and the confirm labels
answer = () => UNCONFIRMED;
await click("btn-approve");
await tick(); await armed();
assert.equal(calls.length, 1);
assert.deepEqual(calls[0].slice(0, 2), ["u1", true]);
assert.equal(calls[0][4], undefined, "the first approval carries no acknowledgement");
assert.ok(req().includes(reservationUnconfirmedHtml(U)), "(1) the warning is painted in the request");
assert.match(req(), /The second source has read the chain to block 116,520 and does not know the reservation this wallet found at block 116,490/);
assert.deepEqual(labels(), ["Sign anyway", "Cancel"], "(1) the buttons offer the two actions");
assert.deepEqual(primary(), ["", "primary"], "(1) Cancel is the primary action and Sign anyway the outlined one");
assert.equal(registry.get("msg").textContent, "", "(1) no failure is shown");
assert.equal(registry.get("btn-approve").disabled, false, "(1) Sign anyway arms after the anti-click-through floor");
console.log("  ok (1) the warning state reaches the window");

// (1b) an unlock repaint keeps it
state.unlocked = false; await tick(); await flush();
state.unlocked = true; await tick(); await armed();
assert.ok(req().includes(reservationUnconfirmedHtml(U)), "(1b) the warning survives the unlock repaint");
assert.deepEqual(labels(), ["Sign anyway", "Cancel"]);
console.log("  ok (1b) the unlock repaint keeps the warning");

// (2) Sign anyway re-sends with the acknowledgement for this request and this fclaim
answer = () => { state.pending = []; return { done: true, ok: true, txid: "0x" + "cd".repeat(32) }; };   // the worker settles it
await click("btn-approve");
assert.equal(calls.length, 2);
assert.deepEqual(calls[1][4], { requestId: "u1", fclaimTxid: FC }, "(2) the acknowledgement is bound to (request id, fclaim)");
assert.match(registry.get("msg").textContent, /^Sent 0xcdcdcdcd/);
console.log("  ok (2) Sign anyway re-sends the approval with the acknowledgement");

// (3) Cancel rejects
state.pending = [fill("u3")];
answer = () => UNCONFIRMED;
await tick(); await armed();
assert.deepEqual(labels(), ["Approve", "Reject"], "(3) a new request starts with the ordinary labels");
assert.deepEqual(primary(), ["primary", ""], "(3) and the ordinary emphasis");
await click("btn-approve");
await tick(); await armed();
assert.deepEqual(labels(), ["Sign anyway", "Cancel"]);
const before = calls.length;
answer = () => { state.pending = []; return { done: true, ok: false, code: "USER_REJECTED", error: "rejected by user" }; };
await click("btn-reject");
assert.deepEqual(calls[before].slice(0, 2), ["u3", false], "(3) Cancel is a rejection of the same request");
assert.equal(registry.get("msg").textContent, "Rejected. Nothing was signed.");
console.log("  ok (3) Cancel rejects the request");

// (4) honest path: signed on the first approval, no warning, one call
state.pending = [fill("u4")];
answer = () => { state.pending = []; return { done: true, ok: true, txid: "0x" + "ee".repeat(32) }; };
await tick(); await armed();
const n0 = calls.length;
await click("btn-approve");
assert.equal(calls.length - n0, 1);
assert.equal(calls[n0][4], undefined);
assert.ok(!req().includes("no record of your reservation"));
assert.match(registry.get("msg").textContent, /^Sent 0xeeeeeeee/);
console.log("  ok (4) honest path: one click, no extra step");

// (5) M1 interleaving: a `pending` poll started before the click returns its pre-approval snapshot after resolve()
// cleared renderedId, and only then RESERVATION_UNCONFIRMED arrives. The warning must be painted and armed, and a
// click on an "Approve" painted outside the warning state must carry no acknowledgement.
//   RED-FIRST: drop the renderSeq checks and the forced repaint in approve.ts and (5a) fails ("Approve", no warning).
let heldPending = null, heldResolve = null;
const defer = () => { let r; const p = new Promise((res) => { r = res; }); return { p, r }; };
state.pending = [fill("m1")];
answer = () => { state.pending = []; return { done: true, ok: true, txid: "0x" + "aa".repeat(32) }; };
await tick(); await armed();
assert.deepEqual(labels(), ["Approve", "Reject"], "(5) setup");
const realPending = handlers.pending;
handlers.pending = () => { const d = defer(); heldPending = d; return d.p; };
const pollStarted = tick();                        // the poll is now waiting on its pending reply
await flush();
answer = () => { const d = defer(); heldResolve = d; return d.p; };
await click("btn-approve");                        // resolve() clears renderedId and waits on the worker
assert.ok(heldPending && heldResolve, "(5) both replies are outstanding");
heldPending.r([fill("m1")]);                      // the stale pre-approval snapshot lands
await flush(20);
handlers.pending = realPending;
state.pending = [fill("m1")];                      // the worker re-queued it
heldResolve.r({ ...UNCONFIRMED, unconfirmed: { ...U } });
await pollStarted; await flush(20); await armed();
assert.ok(req().includes(reservationUnconfirmedHtml(U)), "(5a) the warning is visible");
assert.deepEqual(labels(), ["Sign anyway", "Cancel"], "(5a) the button reads Sign anyway");
assert.equal(registry.get("btn-approve").disabled, false, "(5a) and is armed after the delay");
console.log("  ok (5a) a stale poll reply cannot hide the warning");

// (5b) Sign anyway from the warning paint carries the acknowledgement.
const n5 = calls.length;
answer = () => { state.pending = []; return { done: true, ok: true, txid: "0x" + "ab".repeat(32) }; };
await click("btn-approve");
assert.deepEqual(calls[n5][4], { requestId: "m1", fclaimTxid: FC }, "(5b) Sign anyway carries the acknowledgement");
console.log("  ok (5b) Sign anyway from the warning paint carries the acknowledgement");

// (5c) a stale "Approve": while the first approval is in flight, a poll whose reply still lists the request paints it
// in the ordinary state; a click on that Approve sends no acknowledgement, and the warning still arrives after both
// outcomes. (The acknowledgement is taken from the warning paint, `warnedFor`, never from reviewState alone.)
state.pending = [fill("m2")];
answer = () => { state.pending = []; return { done: true, ok: true, txid: "0x" + "aa".repeat(32) }; };
await tick(); await armed();
answer = () => { const d = defer(); heldResolve = d; return d.p; };
await click("btn-approve");
const first = heldResolve;
state.pending = [fill("m2")];                      // a stale snapshot: the worker has not settled the first call yet
await tick(); await armed();
assert.deepEqual(labels(), ["Approve", "Reject"], "(5c) the stale paint shows the ordinary Approve");
const n6 = calls.length;
answer = () => ({ ...UNCONFIRMED, unconfirmed: { ...U } });
await click("btn-approve");                        // a click on the ordinary paint
assert.equal(calls.length, n6 + 1, "(5c) the click reached the worker");
assert.equal(calls[n6][4], undefined, "(5c) a click on an ordinary Approve carries no acknowledgement");
first.r({ ...UNCONFIRMED, unconfirmed: { ...U } });   // the first outcome lands late
await flush(20); await tick(); await armed();
assert.deepEqual(labels(), ["Sign anyway", "Cancel"], "(5c) the warning state is painted afterwards");
console.log("  ok (5c) a stale Approve sends no acknowledgement");

// (5d) the gate on the acknowledgement: the "unknown" outcome has landed (rs(id).unconfirmed is set) while the window
// still shows an armed, warning-less paint of the same request, painted by a poll that started after the click and
// answered before the outcome; the warning repaint waits on a busy worker. A click on that Approve sends no
// acknowledgement. Unlike (5c), the click comes after the outcome, so only the `warnedFor` check stops it.
//   RED-FIRST: make approve.ts resolve() take `rs(id).unconfirmed` without the `warnedFor === id` check and (5d) fails.
state.pending = [fill("m3")];
answer = () => { state.pending = []; return { done: true, ok: true, txid: "0x" + "aa".repeat(32) }; };
await tick(); await armed();
assert.deepEqual(labels(), ["Approve", "Reject"], "(5d) setup");
answer = () => { const d = defer(); heldResolve = d; return d.p; };
await click("btn-approve");                        // the first approval is in flight
handlers.pending = () => { const d = defer(); heldPending = d; return d.p; };
void tick(); await flush(20);                      // a poll started after the click waits on its pending reply
heldPending.r([fill("m3")]); await flush(20);     // the worker re-queued the request; the poll paints it ordinarily
handlers.pending = realPending;
state.pending = [fill("m3")];
const realStatus = handlers.status;
handlers.status = () => new Promise(() => {});    // the busy worker: the warning repaint's status read hangs
heldResolve.r({ ...UNCONFIRMED, unconfirmed: { ...U } });
await flush(20); await armed();
assert.deepEqual(labels(), ["Approve", "Reject"], "(5d) the warning-less paint is still shown");
assert.equal(registry.get("btn-approve").disabled, false, "(5d) and its Approve is armed");
assert.ok(!req().includes("no record of your reservation"), "(5d) without the warning");
const n7 = calls.length;
answer = () => ({ ...UNCONFIRMED, unconfirmed: { ...U } });
await click("btn-approve");
assert.equal(calls.length, n7 + 1, "(5d) the click reached the worker");
assert.deepEqual(calls[n7].slice(0, 2), ["m3", true]);
assert.equal(calls[n7][4], undefined, "(5d) a click on the warning-less paint carries no acknowledgement");
// Paired honest path: once the worker answers, the warning is painted and Sign anyway carries the acknowledgement.
handlers.status = realStatus;
await tick(); await armed();
assert.deepEqual(labels(), ["Sign anyway", "Cancel"], "(5d) the warning state is painted once the worker answers");
const n8 = calls.length;
answer = () => { state.pending = []; return { done: true, ok: true, txid: "0x" + "ac".repeat(32) }; };
await click("btn-approve");
assert.deepEqual(calls[n8][4], { requestId: "m3", fclaimTxid: FC }, "(5d) Sign anyway from the warning paint carries the acknowledgement");
console.log("  ok (5d) a warning-less paint after the outcome sends no acknowledgement");

console.log("approve-unconfirmed-dom: 9 passed, 0 failed");
process.exit(0);
