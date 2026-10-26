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
//   H. A Confirm overtaken during its re-check by a later Confirm that sent writes nothing over that outcome. RED-FIRST:
//      drop the `gen !== confirmGen` return in runConfirm and H1 sees "Nothing was sent" over "Sent 1 CSD".
//   I. A Review the user leaves while it awaits the name lookup primes nothing: another token's sheet (the amount was
//      parsed with the first token's decimals), or Cancel on the CSD sheet. RED-FIRST: drop the `left()` checks in the
//      token Review and I1 shows a "100000000 ZZZ" card whose Confirm signs; drop `reviewCurrent` in the CSD Review and
//      I3 primes a snapshot.
//   J. Back, Review and Confirm while a send is in flight cannot start a second send: Confirm stays held until the outcome
//      lands. RED-FIRST: drop `|| submitting` from armReview and J1 sees two sends.
//   K. Two clicks on Post post once, two on Seal seal once. RED-FIRST: drop `once` in popup-publish.ts and K1 sees two.
//   L. After an account switch, while the new account's balance has not answered, the send sheet's balance after is
//      unknown, never the old account's (runs last: the second account's balance never answers). RED-FIRST: keep
//      `balanceState.last` in forgetBalance and L1 shows 98.99 CSD.
//   M. A send Confirm left during its re-check does not write "The review was closed…" over a Post's, a Seal's or a name
//      renewal's outcome that landed meanwhile (the status line is shared by every flow). RED-FIRST: drop the
//      `statusWrites() === writes` condition in runConfirm and M1-M3 see the note over the outcome.
//   N. A send outcome takes down every review card with its snapshot: no token card stays on screen, Confirm held and
//      its inputs disabled, after a CSD outcome. RED-FIRST: hide only `f`'s card in teardownReview and N1 fails.
//      A CSD Confirm is held while a token send is in flight (N3).
// HONEST PATHS: A2, C2, D2, E2, F2, H2, I2, J2, K2 and N2 sign once with the production call shape; C1 and D1 show the
// "review was closed" note when nothing else wrote the status line.
// Run: node --import tsx test/popup-confirm-snapshot-dom.test.mjs   (offline)
import { installFakeDom, installBridge, flush } from "./_fakedom.mjs";
import { checker } from "./helpers/check.mjs";

const { check, done } = checker("popup Confirm signs the frozen review once (real popup.ts):");
const { byId } = installFakeDom({ autoCreate: true });
const ME = "0x" + "ab".repeat(20), EXTERNAL = "0x" + "31".repeat(20), ALICE = "0x" + "a1".repeat(20), MOVED = "0x" + "a2".repeat(20);
const TXID = "0x" + "7e".repeat(32);
const OTHER = "0x" + "cd".repeat(20);
const sends = [], transfers = [], renews = [], posts = [], seals = [];
let confirmGate = null, confirmAddr = ALICE, resolveGate = null, sendGate = null, active = 0;
const h = {
  status: () => ({ hasVault: true, unlocked: true, addr: active ? OTHER : ME, accounts: [{ label: "A1", addr: ME }, { label: "A2", addr: OTHER }], active, rpc: "https://x", api: "https://x", tradeApi: "https://x/trade/api", explorer: "cairn", hasMnemonic: true }),
  switchAccount: (i) => { active = i; return true; },
  // the second account's balance read does not answer in these tests
  balance: () => (active ? new Promise(() => { /* never answers */ }) : { confirmed: 100e8, utxos: [] }),
  pendingMerge: () => ({ pending: false, amount: 0, maybe: false }),
  cairnxAssets: () => ({ ok: true, balances: { CAIRN: { available: "100000000000", locked: "0" }, ZZZ: { available: "100000000000", locked: "0" } }, names: ["alice"], nameDetails: [{ name: "alice", leased: true, epochsLeft: 9000 }], primaryName: null, tipHeight: 1 }),
  cairnxTokens: () => ({ ok: true, tokens: [{ ticker: "CAIRN", decimals: 8 }, { ticker: "ZZZ", decimals: 0 }] }),
  prewarmSpv: () => ({ ok: true }), pending: () => [], history: () => [], sealedClaims: () => [],
  resolveName: async () => { if (resolveGate) await resolveGate; return { ok: true, addr: ALICE, verified: true, sources: 2, depth: 10 }; },
  confirmName: async () => { if (confirmGate) await confirmGate; return { ok: true, addr: confirmAddr, verified: true, sources: 2, depth: 10 }; },
  send: async (...a) => { sends.push(a); if (sendGate) await sendGate; await new Promise((r) => setTimeout(r, 30)); return { ok: true, txid: TXID }; },
  cairnPost: async (p) => { posts.push(p); await new Promise((r) => setTimeout(r, 30)); return { ok: true, txid: TXID }; },
  sealClaim: async (p) => { seals.push(p); await new Promise((r) => setTimeout(r, 30)); return { ok: true, txid: TXID }; },
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

console.log("H. a Confirm overtaken during its re-check by a later Confirm that sent");
{
  await csdReview("alice.csd");
  confirmGate = new Promise((r) => (release = r));
  const p1 = byId("btn-send-confirm").click(); await flush();
  await byId("btn-send-back").click(); await flush();
  confirmGate = null;
  byId("s-to").value = EXTERNAL;
  await byId("btn-send").click(); await flush();
  const before = sends.length;
  await byId("btn-send-confirm").click(); await flush(40);
  const sent = text();
  release(); await p1; await flush(40);
  check(`H1 the later Confirm's outcome stays on screen ("${text().slice(0, 60)}")`, /^Sent 1 CSD/.test(text()) && text() === sent && !/Nothing was sent/.test(text()));
  check(`H2 honest: one send, the later review's (${sends.length - before}, ${JSON.stringify(sends.at(-1))})`, sends.length - before === 1 && JSON.stringify(sends.at(-1)) === JSON.stringify([EXTERNAL, 1e8, 1_000_000, ME]));
}

console.log("I. a Review left while it awaits the name lookup");
{
  await tokenRow("CAIRN").click(); await flush();
  byId("ts-to").value = "alice.csd"; byId("ts-amt").value = "1";
  resolveGate = new Promise((r) => (release = r));
  const pr = byId("btn-tsend").click(); await flush();
  await tokenRow("ZZZ").click(); await flush();      // the user opened ZZZ's send while CAIRN's Review waited
  release(); await pr; await flush(); resolveGate = null;
  const before = transfers.length;
  await byId("btn-tsend-confirm").click(); await flush(40);
  check(`I1 no card comes up on ZZZ's sheet, and its Confirm signs nothing (card shown ${!byId("tsend-confirm").hidden}, ${transfers.length - before} transfers)`,
    byId("tsend-confirm").hidden === true && transfers.length - before === 0);
  byId("ts-to").value = EXTERNAL; byId("ts-amt").value = "7";
  await byId("btn-tsend").click(); await flush();
  await byId("btn-tsend-confirm").click(); await flush(40);
  check(`I2 honest: ZZZ's own Review and Confirm sign ZZZ's amount (${JSON.stringify(transfers.at(-1))})`, JSON.stringify(transfers.at(-1)) === JSON.stringify({ ticker: "ZZZ", amount: "7", to: EXTERNAL, decimals: 0, fee: 25_000_000, expectSigner: ME }));
  // the CSD sheet: Cancel while the Review waits on the lookup
  byId("send-form").hidden = false;
  byId("s-to").value = "alice.csd"; byId("s-amt").value = "1"; byId("s-to").disabled = false; byId("s-amt").disabled = false;
  resolveGate = new Promise((r) => (release = r));
  const ps = byId("btn-send").click(); await flush();
  await byId("nav-home").click(); await flush();     // the sheet closes (the same teardown as its Cancel)
  release(); await ps; await flush(); resolveGate = null;
  check(`I3 the CSD Review primes nothing after the sheet closed (card shown ${!byId("send-confirm").hidden})`, byId("send-confirm").hidden === true);
}

console.log("J. Back, Review and Confirm while a send is in flight");
{
  await csdReview(EXTERNAL);
  sendGate = new Promise((r) => (release = r));
  const before = sends.length;
  const p1 = byId("btn-send-confirm").click(); await flush();
  await byId("btn-send-back").click(); await flush();
  await byId("btn-send").click(); await flush();
  const held = byId("btn-send-confirm").disabled;
  const p2 = byId("btn-send-confirm").click(); await flush();
  const during = sends.length - before;
  release(); await p1; await p2; await flush(40); sendGate = null;
  check(`J1 Confirm is held while the first send is in flight, and no second send starts (held ${held}, ${during} during, ${sends.length - before} in all)`, held === true && during === 1 && sends.length - before === 1);
  check(`J2 honest: the first send's outcome is shown ("${text().slice(0, 40)}")`, /^Sent 1 CSD/.test(text()));
  await csdReview(EXTERNAL);
  check("J3 once the outcome has landed, the next review arms Confirm", byId("btn-send-confirm").disabled === false);
}

console.log("K. two clicks on Post and on Seal");
{
  byId("p-domain").value = "csd:apps"; byId("p-title").value = "t"; byId("p-body").value = "b"; byId("p-fee").value = "";
  await Promise.all([byId("btn-post").click(), byId("btn-post").click()]); await flush(40);
  byId("seal-claim").value = "x"; byId("seal-domain").value = "";
  await Promise.all([byId("btn-seal").click(), byId("btn-seal").click()]); await flush(40);
  check(`K1 two clicks post once and seal once (${posts.length}, ${seals.length})`, posts.length === 1 && seals.length === 1);
  check(`K2 honest: the post and the seal as typed (${JSON.stringify(posts[0])}, ${JSON.stringify(seals[0])})`,
    JSON.stringify(posts[0]) === JSON.stringify({ domain: "csd:apps", title: "t", body: "b", fee: 25_000_000 }) && JSON.stringify(seals[0]) === JSON.stringify({ domain: "csd:sealed", claim: "x" }));
  await byId("btn-post").click(); await flush(40);
  check("K3 once its outcome landed, Post posts again", posts.length === 2);
}

console.log("M. a left send Confirm and another flow's outcome");
{
  const acts = [
    ["Post", async () => { byId("p-domain").value = "csd:apps"; byId("p-title").value = "t2"; byId("p-body").value = "b"; byId("p-fee").value = ""; await byId("btn-post").click(); }, /^Posted · /],
    ["Seal", async () => { byId("seal-claim").value = "y"; byId("seal-domain").value = ""; await byId("btn-seal").click(); }, /^Seal submitted · /],
    ["Renew", async () => {
      await byId("nav-names").click(); await flush();
      await byId("names-list").querySelectorAll("[data-name]")[0].click(); await flush();
      await byId("nd-actions").querySelectorAll("[data-nrenew]")[0].click(); await flush();
      await byId("btn-name-confirm").click();
    }, /^Renewed: alice\.csd/],
  ];
  let i = 1;
  for (const [what, act, okRe] of acts) {
    await csdReview("alice.csd");
    const before = sends.length;
    confirmGate = new Promise((r) => (release = r));
    const p = byId("btn-send-confirm").click(); await flush();
    await byId("nav-home").click(); await flush();     // leave the send sheet while its Confirm re-checks the name
    await act(); await flush(40);
    const outcome = text();
    release(); await p; await flush(40); confirmGate = null;
    check(`M${i++} ${what}: its outcome stays on screen after the left send Confirm returns ("${outcome.slice(0, 40)}", then "${text().slice(0, 40)}"; ${sends.length - before} sends)`,
      okRe.test(outcome) && text() === outcome && sends.length === before);
  }
}

console.log("N. a send outcome and the other flow's review card");
{
  await csdReview(EXTERNAL);
  const realSend = h.send;
  let releaseS; const gateS = new Promise((r) => (releaseS = r));
  h.send = async (...a) => { sends.push(a); await gateS; return { ok: false, code: "INSUFFICIENT", error: "insufficient funds" }; };
  const p1 = byId("btn-send-confirm").click(); await flush();
  await byId("nav-home").click(); await flush();     // the CSD send is in flight; the user moves on to a token send
  await tokenReview("CAIRN", EXTERNAL, "2");
  const held = byId("btn-tsend-confirm").disabled;
  releaseS(); await p1; await flush(40); h.send = realSend;   // the CSD send is refused: its teardown runs, no sheet closes
  check(`N1 after the CSD refusal no token card is left on screen, and its inputs are live again (card ${!byId("tsend-confirm").hidden}, inputs disabled ${byId("ts-to").disabled}, Confirm held while in flight ${held}; "${text().slice(0, 40)}")`,
    held === true && byId("tsend-confirm").hidden === true && byId("ts-to").disabled === false && byId("ts-amt").disabled === false && byId("ts-amt").value === "2" && /Nothing was sent/.test(text()));
  const before = transfers.length;
  await byId("btn-tsend").click(); await flush();
  await byId("btn-tsend-confirm").click(); await flush(40);
  check(`N2 honest: the token draft reviews and signs (${JSON.stringify(transfers.at(-1))})`, transfers.length - before === 1 && JSON.stringify(transfers.at(-1)) === JSON.stringify({ ticker: "CAIRN", amount: "200000000", to: EXTERNAL, decimals: 8, fee: 25_000_000, expectSigner: ME }));
  // the other direction: a token send in flight holds a CSD Confirm
  await tokenReview("CAIRN", EXTERNAL, "1");
  let releaseT; const gateT = new Promise((r) => (releaseT = r));
  const realTransfer = h.cairnxTransfer;
  h.cairnxTransfer = async (q) => { transfers.push(q); await gateT; return { ok: true, txid: TXID }; };
  const pt = byId("btn-tsend-confirm").click(); await flush();
  await byId("nav-home").click(); await flush();
  await csdReview("alice.csd");
  const csdHeld = byId("btn-send-confirm").disabled;
  releaseT(); await pt; await flush(40); h.cairnxTransfer = realTransfer;
  check(`N3 a CSD Confirm is held while a token send is in flight (${csdHeld}), and the token outcome is shown ("${text().slice(0, 30)}")`, csdHeld === true && /^Sent 1 CAIRN/.test(text()));
}

console.log("L. the send sheet's balance after an account switch");
{
  await byId("btn-send-t").click(); await flush();
  byId("s-amt").value = "1"; for (const fn of byId("s-amt")._listeners.input || []) fn();
  const mine = byId("s-after").textContent;
  await byId("nav-home").click(); await flush();
  await byId("acct-menu").querySelectorAll("[data-acct]")[1].click(); await flush();
  await byId("btn-send-t").click(); await flush();
  byId("s-amt").value = "1"; for (const fn of byId("s-amt")._listeners.input || []) fn();
  check(`L1 the other account's balance has not answered: unknown, not the first account's (${mine} before, ${byId("s-after").textContent} after)`, mine === "98.99 CSD" && byId("s-after").textContent === "Unknown");
}

done("popup-confirm-snapshot-dom");
