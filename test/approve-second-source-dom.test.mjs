// The approval window's "second source not consulted" line, driven through the REAL src/popup/approve.ts against the
// element registry in helpers/approve-dom.mjs, with the outcome the worker returns from `resolve` (background.ts
// finish(): `secondSource` is "pending" or "failed" when clarvis's record read had not answered at the verdict).
//
//   (1) pending: "sent" is shown with the line, and the window stays open so it can be read.
//   (2) failed: the same with the failed wording.
//   (3) honest path: an outcome without the field shows "sent" alone and the window closes as before.
//   (4) a new request clears the line and the hold.
// RED-FIRST: drop the secondSourceNote paint in approve.ts resolve() and (1) and (2) fail; drop `holdOutcome = true`
// there and (1) fails on the window closing.
// Run: npx tsx test/approve-second-source-dom.test.mjs   (offline)
import assert from "node:assert/strict";
import { mountApproveWindow, loadApprove, flush, sleep } from "./helpers/approve-dom.mjs";
import { secondSourceNote, escapeHtml } from "../src/popup/clearsign.js";

const ME = "0x" + "ab".repeat(20);
const FC = "0x" + "f1".repeat(32);
const state = { pending: [] };
let answer = () => ({ done: true, ok: true, txid: "0x" + "aa".repeat(32) });
const handlers = {
  status: () => ({ unlocked: true, accounts: [{ label: "Main", addr: ME }], active: 0, addr: ME }),
  pending: () => state.pending,
  balance: () => ({ confirmed: 5_000_00000000 }),
  history: () => [],
  fillOfferView: () => ({ ok: true, offerId: "0x" + "0f".repeat(32), giveTicker: "TOKA", giveAmount: "1000", giveDecimals: 0 }),
  tokenFillQuote: () => null, tokenDisplayMeta: () => ({}), sealedClaims: () => [], tip: () => 116_520, epoch: () => 3_884, tipFloor: () => 0,
  resolve: () => answer(),
  unlock: () => true,
};
const { registry, closes } = mountApproveWindow(handlers);
const fill = (id) => ({ id, method: "fillOffer", origin: "https://dapp.example", params: { proposalId: FC, outputs: [{ to: "0x" + "aa".repeat(20), value: 1000e8 }], fee: 1_000_000 } });
const armed = async () => { await flush(); await sleep(760); await flush(); };
const click = async (id) => { registry.get(id)._listeners.click(); await flush(20); };
const msgEl = () => registry.get("msg");
const PENDING = "⚠ Second source not consulted: the second source (clarvis) had not answered yet when this fill was signed, so its check of your reservation did not run. Check on the explorer that the fill delivered.";
const FAILED = "⚠ Second source not consulted: the second source (clarvis) did not give a usable answer when this fill was signed, so its check of your reservation did not run. Check on the explorer that the fill delivered.";

console.log("approval window: second source not consulted");
assert.equal(secondSourceNote("pending"), PENDING);
assert.equal(secondSourceNote("failed"), FAILED);
for (const v of [undefined, null, "", "answered", 1, {}]) assert.equal(secondSourceNote(v), null, `no line for ${JSON.stringify(v)}`);

state.pending = [fill("s1")];
const tick = await loadApprove();
await armed();

// (1) pending
answer = () => { state.pending = []; return { done: true, ok: true, txid: "0x" + "cd".repeat(32), secondSource: "pending" }; };
let c0 = closes();
await click("btn-approve");
await tick(); await flush();
assert.match(msgEl().textContent, /^sent 0xcdcdcdcd/, "(1) sent is shown");
assert.equal(msgEl().className, "msg ok");
assert.ok(msgEl().innerHTML.includes(`<b class="err">${escapeHtml(PENDING)}</b>`), "(1) the line is shown under it");
assert.equal(closes(), c0, "(1) the window stays open so the line can be read");
console.log("  ok (1) pending: sent, the line, the window kept open");

// (4) a new request clears the line and the hold
state.pending = [fill("s2")];
await tick(); await armed();
assert.equal(msgEl().textContent, "", "(4) the next request starts with an empty message");
assert.ok(!msgEl().innerHTML.includes("Second source not consulted"), "(4) and without the line");
console.log("  ok (4) a new request clears it");

// (2) failed
answer = () => { state.pending = []; return { done: true, ok: true, txid: "0x" + "ce".repeat(32), secondSource: "failed" }; };
c0 = closes();
await click("btn-approve");
await tick(); await flush();
assert.match(msgEl().textContent, /^sent 0xcececece/);
assert.ok(msgEl().innerHTML.includes(`<b class="err">${escapeHtml(FAILED)}</b>`), "(2) the failed wording");
assert.equal(closes(), c0, "(2) the window stays open");
console.log("  ok (2) failed: sent, the line, the window kept open");

// (3) honest path
state.pending = [fill("s3")];
await tick(); await armed();
answer = () => { state.pending = []; return { done: true, ok: true, txid: "0x" + "ee".repeat(32) }; };
c0 = closes();
await click("btn-approve");
await tick(); await flush();
assert.match(msgEl().textContent, /^sent 0xeeeeeeee/);
assert.ok(!msgEl().innerHTML.includes("Second source not consulted"), "(3) no line");
assert.ok(closes() > c0, "(3) the window closes as before");
console.log("  ok (3) honest path: sent alone, the window closes");

console.log("approve-second-source-dom: 4 passed, 0 failed");
process.exit(0);
