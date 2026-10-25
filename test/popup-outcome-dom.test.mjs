// Plan 85 7.3a (M5, VC-01, E1-E4): the popup tells the user what actually happened to their funds.
// Drives the REAL popup.ts against a fake DOM and a scripted background bridge, and asserts on the
// status line the user reads.
//
//   - A throw the wallet answered (the background ran the method and it threw) submitted nothing, so it
//     must say "Nothing was sent", never "may already be in flight"; only a broken channel is ambiguous.
//   - Renew, set-primary, post and seal results go through the same SUBMIT_* reading as a send:
//     SUBMIT_MAYBE_INFLIGHT says "may already be in flight", SUBMIT_DUPLICATE is the pending notice, a
//     refusal says "Nothing was sent". Before this, all three read "<action> failed: ...".
//   - The merge flow's locked throw is honest and leaves Confirm usable.
//   - Sending to the wallet's own other account is not a first send.
//
//   - The popup's own send review keeps Confirm disabled while the balance-after is negative (section 9;
//     RED-FIRST: drop the `short` gate in the btn-send handler and 9a, 9b fail; 9c, 9d are the honest path).
// RED-FIRST: revert popup.ts to e67bd5f and sections 1b, 2a, 3a, 4a-4c, 5a, 6a, 7a and 8a go red.
// HONEST PATH: sections 1a, 1c, 1d, 3b, 4d and 8b run the production call shapes and keep their copy.
//
// Run: node --import tsx test/popup-outcome-dom.test.mjs   (offline)
import assert from "node:assert/strict";
import { installFakeDom, installBridge, flush } from "./_fakedom.mjs";

const { byId } = installFakeDom({ autoCreate: true });
const ME = "0x" + "ab".repeat(20);
const OTHER_OWN = "0x" + "cd".repeat(20);
const EXTERNAL = "0x" + "31".repeat(20);
const TXID = "0x" + "7e".repeat(32);
const history = [];
const h = {
  status: () => ({ hasVault: true, unlocked: true, addr: ME, accounts: [{ label: "A1", addr: ME }, { label: "A2", addr: OTHER_OWN }], active: 0, rpc: "https://x", api: "https://x", tradeApi: "https://x/trade/api", explorer: "cairn", hasMnemonic: true }),
  balance: () => ({ confirmed: 100e8, utxos: [] }),
  pendingMerge: () => ({ pending: false, amount: 0, maybe: false }),
  cairnxAssets: () => ({ ok: true, balances: { CAIRN: { available: "100000000000", locked: "0" } }, names: ["alice"], nameDetails: [{ name: "alice", leased: true, epochsLeft: 9000 }], primaryName: null, tipHeight: 1 }),
  cairnxTokens: () => ({ ok: true, tokens: [{ ticker: "CAIRN", decimals: 8 }] }),
  prewarmSpv: () => ({ ok: true }),
  pending: () => [],
  history: () => history,
  sealedClaims: () => [],
  cairnxNameRenewFee: () => 3e8,
  consolidatePreview: () => ({ ok: true, coins: 3, merge: 3, total: 3e8, out: 3e8 - 1e6 }),
};
const { breakChannel } = installBridge(h);
globalThis.setInterval = () => 0;
await import("../src/popup/popup.ts");
await flush();
let pass = 0, fail = 0;
// Each case reports on its own, so a mutation run shows every red, not only the first.
const t = (name, fn) => { try { fn(); pass++; console.log("  ✓ " + name); } catch (e) { fail++; console.error("  ✗ " + name + "\n    " + String(e?.message || e).split("\n")[0]); } };
const text = () => String(byId("msg").textContent || "") + String(byId("msg").innerHTML || "");
const IN_FLIGHT = /may already be in flight/;

async function csdReview(to) {
  byId("s-to").value = to; byId("s-amt").value = "1";
  byId("s-to").disabled = false; byId("s-amt").disabled = false;
  await byId("btn-send").click(); await flush();
}
async function csdSend(answer) {
  h.send = answer;
  await csdReview(EXTERNAL);
  await byId("btn-send-confirm").click(); await flush();
  return text();
}
const assets = () => byId("assets");
async function tokenSend(answer) {
  h.cairnxTransfer = answer;
  await assets().querySelectorAll("[data-tsend]")[0].click(); await flush();
  byId("ts-to").value = EXTERNAL; byId("ts-amt").value = "1";
  await byId("btn-tsend").click(); await flush();
  await byId("btn-tsend-confirm").click(); await flush();
  return text();
}
// A name's actions live in its detail sheet: the row opens it, the action there opens the review.
async function nameAct(sel, method, answer) {
  h[method] = answer;
  await byId("names-list").querySelectorAll("[data-name]")[0].click(); await flush();
  await byId("nd-actions").querySelectorAll(sel)[0].click(); await flush();
  await byId("btn-name-confirm").click(); await flush();
  return text();
}

console.log("1. CSD send: a throw is routed by whether anything could have been submitted");
{
  const ok = await csdSend(() => ({ ok: true, txid: TXID, sighashMatch: true }));
  t("1a honest: a successful send still reads 'sent 1 CSD'", () => {
    assert.match(ok, /^sent 1 CSD/);
  });
  const pre = await csdSend(() => { throw new Error("/utxos -> malformed response"); });
  t("1b a wallet-answered throw (VC-01 class) says 'Nothing was sent', not 'may already be in flight'", () => {
    assert.doesNotMatch(pre, IN_FLIGHT);
    assert.match(pre, /Nothing was sent/);
  });
  h.send = () => ({ ok: true, txid: TXID });
  breakChannel.add("send");
  await csdReview(EXTERNAL); await byId("btn-send-confirm").click(); await flush();
  t("1c honest: a broken channel (the service worker died mid-call) stays ambiguous", () => {
    assert.match(text(), IN_FLIGHT);
  });
  const locked = await csdSend(() => { throw new Error("locked"); });
  t("1d honest: the locked throw keeps its own copy", () => {
    assert.match(locked, /locked before anything was signed/); assert.doesNotMatch(locked, IN_FLIGHT);
  });
  const maybe = await csdSend(() => ({ ok: false, code: "SUBMIT_MAYBE_INFLIGHT", txid: TXID, error: "/tx/submit -> 502" }));
  t("1e SUBMIT_MAYBE_INFLIGHT still says 'may already be in flight' and names the history entry", () => {
    assert.match(maybe, IN_FLIGHT); assert.match(maybe, /in your history as 0x7e7e/);
  });
}

console.log("2. token send: a pre-sign builder throw");
{
  const pre = await tokenSend(() => { throw new Error("cairnx anchor fee must be ≥ 0.25 CSD"); });
  t("2a a wallet-answered throw says 'Nothing was sent'", () => {
    assert.doesNotMatch(pre, IN_FLIGHT); assert.match(pre, /Nothing was sent/);
  });
  const ok = await tokenSend(() => ({ ok: true, txid: TXID }));
  t("2b honest: a successful token send reads 'sent', settling once mined", () => {
    assert.match(ok, /^sent 1 CAIRN = 100000000 base units/); assert.match(ok, /once it is mined/);
  });
}

console.log("3. merge: the locked throw");
{
  h.consolidate = () => { throw new Error("locked"); };
  await byId("btn-consolidate-confirm").click(); await flush();
  t("3a a locked merge says nothing was signed, and Confirm stays usable", () => {
    assert.doesNotMatch(text(), IN_FLIGHT); assert.match(text(), /locked before anything was signed/);
    assert.equal(byId("btn-consolidate-confirm").disabled, false);
  });
  h.consolidate = () => ({ ok: false, code: "SUBMIT_MAYBE_INFLIGHT", txid: TXID, error: "/tx/submit -> network error" });
  await byId("btn-consolidate-confirm").click(); await flush();
  t("3b honest: an ambiguous merge submit still says 'may already be in flight' and closes the form", () => {
    assert.match(text(), IN_FLIGHT); assert.equal(byId("consolidate-form").hidden, true);
  });
}

console.log("4. renew and set-primary results through the SUBMIT_* reading");
{
  const maybe = await nameAct("[data-nrenew]", "cairnxNameRenew", () => ({ ok: false, code: "SUBMIT_MAYBE_INFLIGHT", txid: TXID, error: "/tx/submit -> 502" }));
  t("4a renew SUBMIT_MAYBE_INFLIGHT says 'may already be in flight', not 'renew failed'", () => {
    assert.match(maybe, IN_FLIGHT); assert.doesNotMatch(maybe, /renew failed/);
  });
  const dup = await nameAct("[data-nrenew]", "cairnxNameRenew", () => ({ ok: false, code: "SUBMIT_DUPLICATE", txid: TXID, error: "this transaction, or one spending the same coins, is already pending. Check your history once it is mined before sending again" }));
  t("4b renew SUBMIT_DUPLICATE is the pending notice (info), not a failure", () => {
    assert.match(dup, /already pending/); assert.doesNotMatch(dup, /failed/); assert.equal(byId("msg").className, "msg info");
  });
  const primary = await nameAct("[data-nprimary]", "cairnxSetPrimary", () => ({ ok: false, code: "SUBMIT_MAYBE_INFLIGHT", txid: TXID, error: "/tx/submit -> 502" }));
  t("4c set-primary SUBMIT_MAYBE_INFLIGHT says 'may already be in flight'", () => {
    assert.match(primary, IN_FLIGHT); assert.doesNotMatch(primary, /set primary failed/);
  });
  const ok = await nameAct("[data-nrenew]", "cairnxNameRenew", () => ({ ok: true, txid: TXID }));
  t("4d honest: a successful renew reads 'renewed', taking effect once mined", () => {
    assert.match(ok, /^renewed: alice\.csd/); assert.match(ok, /takes effect once it is mined/);
  });
  const refused = await nameAct("[data-nrenew]", "cairnxNameRenew", () => ({ ok: false, code: "INSUFFICIENT", error: "insufficient confirmed balance" }));
  t("4e a refused renew says 'Nothing was sent'", () => {
    assert.match(refused, /insufficient confirmed balance\. Nothing was sent\./);
  });
}

console.log("5. post");
{
  h.cairnPost = () => ({ ok: false, code: "SUBMIT_MAYBE_INFLIGHT", txid: TXID, error: "/tx/submit -> 502" });
  byId("p-domain").value = "csd:apps"; byId("p-title").value = "hello"; byId("p-fee").value = "";
  await byId("btn-post").click(); await flush();
  t("5a post SUBMIT_MAYBE_INFLIGHT says 'may already be in flight', not 'post failed'", () => {
    assert.match(text(), IN_FLIGHT); assert.doesNotMatch(text(), /post failed/);
  });
}

console.log("6. seal");
{
  h.sealClaim = () => ({ ok: false, code: "SUBMIT_MAYBE_INFLIGHT", txid: TXID, error: "/tx/submit -> 502" });
  byId("seal-claim").value = "a claim";
  await byId("btn-seal").click(); await flush();
  t("6a seal SUBMIT_MAYBE_INFLIGHT says 'may already be in flight', not 'seal failed'", () => {
    assert.match(text(), IN_FLIGHT); assert.doesNotMatch(text(), /seal failed/);
  });
  h.sealClaim = () => ({ ok: true, txid: TXID });
  byId("seal-claim").value = "a claim";
  await byId("btn-seal").click(); await flush();
  t("6b a submitted seal says it can be revealed once mined", () => {
    assert.match(text(), /reveal it once it is mined/); assert.doesNotMatch(text(), /whenever you like/);
  });
}

console.log("7. seal throw");
{
  h.sealClaim = () => { throw new Error("sealClaim: claim must be a non-empty string"); };
  byId("seal-claim").value = "x";
  await byId("btn-seal").click(); await flush();
  t("7a a wallet-answered seal throw says 'Nothing was sent'", () => {
    assert.match(text(), /Nothing was sent/); assert.doesNotMatch(text(), IN_FLIGHT);
  });
}

console.log("8. first-send warning");
{
  h.send = () => ({ ok: true, txid: TXID });
  await csdReview(OTHER_OWN);
  const shown = () => (byId("c-warn").hidden ? "" : String(byId("c-warn").innerHTML));
  t("8a no first-send warning for the wallet's own other account", () => {
    assert.doesNotMatch(shown(), /First time/);
  });
  await byId("btn-send-back").click();
  await csdReview(EXTERNAL);
  t("8b honest: a never-paid external address still warns", () => {
    assert.match(shown(), /First time sending to this address/);
  });
}

console.log("9. the popup's own send review with a negative balance-after (same rule as the approval window)");
{
  let sends = 0;
  h.send = () => { sends++; return { ok: true, txid: TXID }; };
  h.balance = () => ({ confirmed: 50_000_000, utxos: [] });   // 0.5 CSD spendable while a pending spend holds the rest
  await byId("btn-send-back").click();
  await csdReview(EXTERNAL);
  t("9a Confirm is disabled and the review says why", () => {
    assert.equal(byId("btn-send-confirm").disabled, true);
    assert.ok(!byId("c-warn").hidden); assert.match(byId("c-warn").innerHTML, /spendable balance does not cover this request/);
  });
  await byId("btn-send-confirm").click(); await flush();
  t("9b a click that lands anyway sends nothing", () => { assert.equal(sends, 0); });
  h.balance = () => ({ confirmed: 100e8, utxos: [] });
  await byId("btn-send-back").click();
  await csdReview(EXTERNAL);
  t("9c honest: a covered send keeps Confirm enabled", () => { assert.equal(byId("btn-send-confirm").disabled, false); });
  const before = sends;
  await byId("btn-send-confirm").click(); await flush();
  t("9d honest: and it sends", () => { assert.equal(sends, before + 1); assert.match(text(), /^sent 1 CSD/); });
}

console.log(`\npopup-outcome-dom: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
