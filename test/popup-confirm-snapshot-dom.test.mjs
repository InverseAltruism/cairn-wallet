// A popup Confirm signs the frozen review, once, and only while that review stands (R3 section 1: "Confirm signs the
// frozen review snapshot, never the live inputs"; section 3: "one Confirm is one signature"; "any failure tears the review
// down so a second click cannot double-pay"). Driven through the REAL popup.ts against a fake DOM and a scripted
// background; the scenarios are the wave R10 code review's probe (review/wallet-code/test/probe-r10.test.mjs).
//
//   A. Two clicks on the CSD Confirm send once (S2). RED-FIRST: drop the synchronous `btn.disabled = true` and the
//      snapshot consumption in popup-send.ts and A1 sees two sends.
//   B. A throw in the success path's display code still shows the outcome, with its txid (S1). RED-FIRST: call msg
//      after closeAllPanels in sentOk and B1 sees "Sending…".
//   C. A token Confirm whose sheet was switched to another token during the confirm-time name re-check signs nothing
//      (M1). RED-FIRST: the 0.2.99 handler (ticker and decimals from the live `tsend`, no check after the await) signs
//      100000000 ZZZ.
//   D. Back during the CSD re-check sends nothing (S3). RED-FIRST: drop the `reviewState.reviewedSend !== snap` check
//      and D1 sees one send.
//   E. Two clicks on the token Confirm transfer once. F. Two clicks on the name action's Confirm sign once (it consumed
//      its snapshot before any await already; pinned so the class stays closed). G. A name that re-points between review
//      and Confirm sends nothing and tears the review down, keeping the draft.
// HONEST PATHS: A2, C2, D2, E2 and F2 sign once with the production call shape.
// Run: node --import tsx test/popup-confirm-snapshot-dom.test.mjs   (offline)
import { installFakeDom, installBridge, flush } from "./_fakedom.mjs";
import { checker } from "./helpers/check.mjs";

const { check, done } = checker("popup Confirm signs the frozen review once (real popup.ts):");
const { byId } = installFakeDom({ autoCreate: true });
const ME = "0x" + "ab".repeat(20), EXTERNAL = "0x" + "31".repeat(20), ALICE = "0x" + "a1".repeat(20), MOVED = "0x" + "a2".repeat(20);
const TXID = "0x" + "7e".repeat(32);
const sends = [], transfers = [], renews = [];
let confirmGate = null, confirmAddr = ALICE;
const h = {
  status: () => ({ hasVault: true, unlocked: true, addr: ME, accounts: [{ label: "A1", addr: ME }], active: 0, rpc: "https://x", api: "https://x", tradeApi: "https://x/trade/api", explorer: "cairn", hasMnemonic: true }),
  balance: () => ({ confirmed: 100e8, utxos: [] }),
  pendingMerge: () => ({ pending: false, amount: 0, maybe: false }),
  cairnxAssets: () => ({ ok: true, balances: { CAIRN: { available: "100000000000", locked: "0" }, ZZZ: { available: "100000000000", locked: "0" } }, names: ["alice"], nameDetails: [{ name: "alice", leased: true, epochsLeft: 9000 }], primaryName: null, tipHeight: 1 }),
  cairnxTokens: () => ({ ok: true, tokens: [{ ticker: "CAIRN", decimals: 8 }, { ticker: "ZZZ", decimals: 0 }] }),
  prewarmSpv: () => ({ ok: true }), pending: () => [], history: () => [], sealedClaims: () => [],
  resolveName: () => ({ ok: true, addr: ALICE, verified: true, sources: 2, depth: 10 }),
  confirmName: async () => { if (confirmGate) await confirmGate; return { ok: true, addr: confirmAddr, verified: true, sources: 2, depth: 10 }; },
  send: async (...a) => { sends.push(a); await new Promise((r) => setTimeout(r, 30)); return { ok: true, txid: TXID }; },
  cairnxTransfer: async (p) => { transfers.push(p); await new Promise((r) => setTimeout(r, 30)); return { ok: true, txid: TXID }; },
  cairnxNameRenewFee: () => 15e8,
  cairnxNameRenew: async (...a) => { renews.push(a); await new Promise((r) => setTimeout(r, 30)); return { ok: true, txid: TXID }; },
};
installBridge(h);
globalThis.setInterval = () => 0;
await import("../src/popup/popup.ts");
await flush();
const text = () => String(byId("msg").textContent || "");
const GONE = "The review was closed before it was signed. Nothing was sent.";
let release;

async function csdReview(to, amt = "1") {
  byId("send-form").hidden = false;
  byId("s-to").value = to; byId("s-amt").value = amt; byId("s-to").disabled = false; byId("s-amt").disabled = false;
  await byId("btn-send").click(); await flush();
}
const tokenRow = (t) => byId("assets").querySelectorAll("[data-tsend]").find((r) => r.dataset.tsend === t);
async function tokenReview(t, to, amt) {
  await tokenRow(t).click(); await flush();
  byId("ts-to").value = to; byId("ts-amt").value = amt;
  await byId("btn-tsend").click(); await flush();
}

console.log("A. two clicks on the CSD Confirm");
{
  await csdReview(EXTERNAL);
  const before = sends.length;
  await Promise.all([byId("btn-send-confirm").click(), byId("btn-send-confirm").click()]); await flush(40);
  check(`A1 two clicks send once (${sends.length - before})`, sends.length - before === 1);
  check(`A2 honest: the one send is the reviewed send, production call shape (${JSON.stringify(sends.at(-1))})`, JSON.stringify(sends.at(-1)) === JSON.stringify([EXTERNAL, 1e8, 1_000_000, ME]));
}

console.log("B. a throw in the success path's display code");
{
  await csdReview(EXTERNAL);
  const nd = byId("nd-actions");
  Object.defineProperty(nd, "innerHTML", { configurable: true, get() { return ""; }, set() { throw new Error("display failed"); } });
  let rejected = null;
  await byId("btn-send-confirm").click().catch((e) => { rejected = e.message; }); await flush(40);
  delete nd.innerHTML;
  const shown = String(byId("msg").innerHTML || "") + text();
  check(`B1 the outcome is on screen with its txid (${JSON.stringify(shown.slice(0, 120))}), not "Sending…"`, /Sent 1 CSD/.test(shown) && shown.includes(`Transaction ${TXID.slice(0, 12)}…`) && !/Sending/.test(shown));
  check(`B2 the display throw surfaced as a throw, not as a submit outcome (${rejected})`, rejected === "display failed" && !/in flight|Nothing was sent/.test(shown));
}

console.log("C. the token sheet switched to another token during the name re-check");
{
  await tokenReview("CAIRN", "alice.csd", "1");
  const before = transfers.length;
  confirmGate = new Promise((r) => (release = r));
  const pc = byId("btn-tsend-confirm").click(); await flush();
  await tokenRow("ZZZ").click(); await flush();      // the user left the review and opened ZZZ's send
  release(); await pc; await flush(40); confirmGate = null;
  check(`C1 nothing is signed, and the popup says so (${transfers.length - before} transfers, "${text()}")`, transfers.length - before === 0 && text() === GONE);
  await tokenReview("CAIRN", "alice.csd", "1");
  await byId("btn-tsend-confirm").click(); await flush(40);
  check(`C2 honest: an undisturbed token Confirm signs exactly the review (${JSON.stringify(transfers.at(-1))})`,
    JSON.stringify(transfers.at(-1)) === JSON.stringify({ ticker: "CAIRN", amount: "100000000", to: ALICE, decimals: 8, fee: 25_000_000, expectSigner: ME })
    && /^Sent 1 CAIRN = 100000000 base units/.test(text()));
}

console.log("D. Back during the CSD name re-check");
{
  await csdReview("alice.csd");
  const before = sends.length;
  confirmGate = new Promise((r) => (release = r));
  const pd = byId("btn-send-confirm").click(); await flush();
  await byId("btn-send-back").click(); await flush();
  release(); await pd; await flush(40); confirmGate = null;
  check(`D1 Back during the re-check sends nothing (${sends.length - before}, "${text()}")`, sends.length - before === 0 && text() === GONE);
  await csdReview("alice.csd");
  await byId("btn-send-confirm").click(); await flush(40);
  check(`D2 honest: a name send left alone sends once to the reviewed address (${JSON.stringify(sends.at(-1))})`, sends.length - before === 1 && JSON.stringify(sends.at(-1)) === JSON.stringify([ALICE, 1e8, 1_000_000, ME]));
}

console.log("E. two clicks on the token Confirm");
{
  await tokenReview("ZZZ", EXTERNAL, "5");
  const before = transfers.length;
  await Promise.all([byId("btn-tsend-confirm").click(), byId("btn-tsend-confirm").click()]); await flush(40);
  check(`E1 two clicks transfer once (${transfers.length - before})`, transfers.length - before === 1);
  check(`E2 honest: ZZZ's own review, 0 decimals (${JSON.stringify(transfers.at(-1))})`, JSON.stringify(transfers.at(-1)) === JSON.stringify({ ticker: "ZZZ", amount: "5", to: EXTERNAL, decimals: 0, fee: 25_000_000, expectSigner: ME }));
}

console.log("F. two clicks on the name action's Confirm");
{
  await byId("nav-names").click(); await flush();
  await byId("names-list").querySelectorAll("[data-name]")[0].click(); await flush();
  await byId("nd-actions").querySelectorAll("[data-nrenew]")[0].click(); await flush();
  const before = renews.length;
  await Promise.all([byId("btn-name-confirm").click(), byId("btn-name-confirm").click()]); await flush(40);
  check(`F1 two clicks renew once (${renews.length - before})`, renews.length - before === 1);
  check(`F2 honest: the reviewed fee and signer (${JSON.stringify(renews.at(-1))})`, JSON.stringify(renews.at(-1)) === JSON.stringify(["alice", 15e8, ME]));
}

console.log("G. a name that re-points between review and Confirm");
{
  await csdReview("alice.csd");
  const before = sends.length;
  confirmAddr = MOVED;
  await byId("btn-send-confirm").click(); await flush(40);
  confirmAddr = ALICE;
  check(`G1 nothing is sent, with the exact refusal (${sends.length - before}, "${text()}")`, sends.length - before === 0 && text() === "alice.csd changed where it points. Nothing was sent: review it again.");
  check("G2 the review is torn down and the draft kept for a re-review", byId("send-confirm").hidden === true && byId("s-to").value === "alice.csd" && byId("s-to").disabled === false);
}

done("popup-confirm-snapshot-dom");
