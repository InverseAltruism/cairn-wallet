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
assert.match(registry.get("msg").textContent, /^sent 0xcdcdcdcd/);
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
assert.equal(registry.get("msg").textContent, "rejected");
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
assert.match(registry.get("msg").textContent, /^sent 0xeeeeeeee/);
console.log("  ok (4) honest path: one click, no extra step");

console.log("approve-unconfirmed-dom: 5 passed, 0 failed");
process.exit(0);
