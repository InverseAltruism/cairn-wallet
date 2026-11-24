// The confirm-time name re-check in the real popup.ts has three outcomes besides the reviewed address again: another
// address refuses with [A14]; a proven lapse refuses with [A3]; a look-up that did not answer, refused for another
// reason, or no longer verifies an address that was verified at review shows [A15] with "Send anyway" / "Cancel", and
// that second click signs the reviewed address and nothing else, without a second look-up. Untouched beside them: the
// reviewed address again signs on the first click after one re-check; a new review after [A15] is checked again.
// RED-FIRST: on 68cce65 (the new sentences added so the file loads) (2a), (3a), (4a) to (4d), (5a), (6a), (6b), (8a),
// (9a) and (9b) fail: every outcome there was the one refusal "changed where it points". Mutations: [A15] treated as a
// refusal (the "unchecked" branch removed) fails (4a) to (4d), (5a), (6a), (9a); the waiver left out (the second click
// re-checks) fails (4c); the waiver kept across reviews fails (8a); "lapsed" read as "moved" fails (3a).
// Sections 10 and 11: a re-check that brings a lapse the Review did not show ([A4], served lapsed and not settled)
// shows [A4] with "Send anyway" / "Cancel", for an unverified and a verified Review alike, and the second click signs
// the reviewed address with no second look-up; a Review that showed [A4] confirms on one click. Red on fc8ec07: (10a),
// (10b), (10d), (11a), (11b); the Review's [A4] ignored at Confirm fails (10c) and (11c), and either send's snapshot
// without `lapseShown` fails its own.
// Run: node --import tsx test/name-recheck-dom.test.mjs   (offline)
import { installFakeDom, installBridge, flush } from "./_fakedom.mjs";
import { sentenceOf, LAPSE_BUTTONS } from "../src/popup/sentences.ts";
import { checker } from "./helpers/check.mjs";

const { byId } = installFakeDom({ autoCreate: true });
const { check, done } = checker("=== the name re-check at Confirm (real popup.ts) ===");
const ME = "0x" + "ab".repeat(20), ALICE = "0x" + "31".repeat(20), MOVED = "0x" + "42".repeat(20), TXID = "0x" + "7e".repeat(32);
const verifiedAlice = { ok: true, addr: ALICE, name: "alice", verified: true, sources: 2, depth: 14 };
let confirmAnswer = () => verifiedAlice;
let reviewAnswer = () => verifiedAlice;
const sends = [];
const { calls } = installBridge({
  status: () => ({ hasVault: true, unlocked: true, addr: ME, accounts: [{ label: "A1", addr: ME }], active: 0, rpc: "https://x", api: "https://x", tradeApi: "https://x/trade/api", explorer: "cairn", hasMnemonic: true }),
  balance: () => ({ confirmed: 100e8, utxos: [] }),
  pendingMerge: () => ({ pending: false, amount: 0, maybe: false }),
  cairnxAssets: () => ({ ok: true, balances: { CAIRN: { available: "100000000000", locked: "0" } }, names: [], nameDetails: [], primaryName: null, tipHeight: 1 }),
  cairnxTokens: () => ({ ok: true, tokens: [{ ticker: "CAIRN", decimals: 8 }] }),
  prewarmSpv: () => ({ ok: true }), pending: () => [], sealedClaims: () => [], history: () => [],
  resolveName: () => reviewAnswer(),
  confirmName: () => confirmAnswer(),
  send: (...args) => { sends.push(args); return { ok: true, txid: TXID }; },
  cairnxTransfer: (p) => { sends.push([p]); return { ok: true, txid: TXID }; },
});
globalThis.setInterval = () => 0;
await import("../src/popup/popup.ts");
await flush();

const nm = { name: "alice.csd" };
const A3 = sentenceOf("A3", undefined, nm).text, A14 = sentenceOf("A14", undefined, nm).text, A15 = sentenceOf("A15", undefined, nm).text;
const A4 = sentenceOf("A4", undefined, nm).text;
const count = (m) => calls.filter((x) => x === m).length;
// [A15] is the review's last row (popup-sendflow.ts); `a15` is whether it is there and last.
const lastRow = (id) => { const h = byId(id).hidden ? "" : String(byId(id).innerHTML); const i = h.lastIndexOf('<div class="check '); return i < 0 ? "" : h.slice(i); };
const a15 = (id = "c-warn") => /^<div class="check caution">/.test(lastRow(id)) && lastRow(id).includes(A15);
const a4Last = (id = "c-warn") => /^<div class="check caution">/.test(lastRow(id)) && lastRow(id).includes(A4) && !String(byId(id).innerHTML).includes(A15);
const state = () => ({ shown: !byId("send-confirm").hidden, msg: byId("msg").textContent, a15: a15(), cls: byId("msg").className, confirm: byId("btn-send-confirm").textContent, back: byId("btn-send-back").textContent, disabled: byId("btn-send-confirm").disabled });
async function review() {
  byId("btn-send-back").click(); await flush();
  byId("s-to").disabled = false; byId("s-amt").disabled = false;
  byId("s-to").value = "alice.csd"; byId("s-amt").value = "1";
  byId("btn-send").click(); await flush(20);
}
const confirm = async () => { byId("btn-send-confirm").click(); await flush(20); };

console.log("1. honest: the reviewed address again");
{
  await review();
  const c0 = count("confirmName"), s0 = sends.length;
  await confirm();
  check(`(1a) one re-check, one send to the reviewed address (confirmName +${count("confirmName") - c0})`, count("confirmName") === c0 + 1 && sends.length === s0 + 1 && sends.at(-1)?.[0] === ALICE);
}

console.log("2. another address");
{
  await review();
  confirmAnswer = () => ({ ...verifiedAlice, addr: MOVED });
  const s0 = sends.length;
  await confirm();
  const r = state();
  check(`(2a) refused with [A14], review down, nothing sent ("${r.msg}")`, r.msg === A14 && !r.shown && sends.length === s0);
}

console.log("3. a proven lapse");
{
  await review();
  confirmAnswer = () => ({ ok: false, lapsed: true, error: "alice.csd has lapsed, so we did not send." });
  const s0 = sends.length;
  await confirm();
  const r = state();
  check(`(3a) refused with [A3], review down, nothing sent ("${r.msg}")`, r.msg === A3 && !r.shown && sends.length === s0);
}

console.log("4. the look-up did not answer");
{
  await review();
  confirmAnswer = () => { throw new Error("name lookup failed"); };
  const s0 = sends.length;
  await confirm();
  const r = state();
  check(`(4a) [A15] as the review's last row, amber (caution), and no refusal in the status line ("${r.msg}")`, r.a15 && !/Nothing was sent/.test(r.msg));
  check(`(4b) the review stays on the reviewed address with "${r.confirm}" / "${r.back}", nothing sent`, r.shown && !r.disabled && r.confirm === LAPSE_BUTTONS.confirm && r.back === LAPSE_BUTTONS.back && sends.length === s0);
  const c0 = count("confirmName");
  await confirm();
  check(`(4c) "Send anyway" signs the reviewed address without a second look-up (confirmName +${count("confirmName") - c0})`, sends.length === s0 + 1 && sends.at(-1)?.[0] === ALICE && count("confirmName") === c0);
  check("(4d) one send for the two clicks", sends.length === s0 + 1);
}

console.log("5. the look-up refused for another reason (no lapse)");
{
  await review();
  confirmAnswer = () => ({ ok: false, error: "name lookup failed" });
  await confirm();
  check(`(5a) [A15], not a refusal ("${state().msg}")`, state().a15 && state().shown);
  byId("btn-send-back").click(); await flush();
}

console.log("6. verified at review, not verified now at the same address");
{
  await review();
  confirmAnswer = () => ({ ...verifiedAlice, verified: false });
  const s0 = sends.length;
  await confirm();
  check("(6a) [A15]", state().a15 && state().shown && sends.length === s0);
  await confirm();
  check("(6b) its second click signs the reviewed address", sends.length === s0 + 1 && sends.at(-1)?.[0] === ALICE);
}

console.log("7. Cancel after [A15]");
{
  await review();
  confirmAnswer = () => ({ ok: false });
  const s0 = sends.length;
  await confirm();
  byId("btn-send-back").click(); await flush();
  const r = state();
  check(`(7a) Cancel takes the review down, nothing sent, and the buttons read as before ("${r.confirm}" / "${r.back}")`, !r.shown && sends.length === s0 && r.confirm === "Confirm send" && r.back === "Back");
}

console.log("8. a new review after [A15] is checked again");
{
  await review();
  confirmAnswer = () => ({ ...verifiedAlice, addr: MOVED });
  const c0 = count("confirmName"), s0 = sends.length;
  await confirm();
  check(`(8a) its Confirm runs the re-check and refuses another address ("${state().msg}")`, count("confirmName") === c0 + 1 && state().msg === A14 && sends.length === s0);
  confirmAnswer = () => verifiedAlice;
}

console.log("10. a lapse at Confirm that the Review did not show");
{
  const unverified = { ok: true, addr: ALICE, name: "alice", verified: false, sources: 2, verifyReason: "on-chain verification unavailable" };
  const lapseAtConfirm = { ok: true, addr: ALICE, name: "alice", lapsed: false, lapseUnconfirmed: true, addrProven: false, verified: false, verifyReason: "on-chain verification unavailable" };
  reviewAnswer = () => unverified;
  await review();
  confirmAnswer = () => lapseAtConfirm;
  const s0 = sends.length;
  await confirm();
  const r = state();
  check(`(10a) an unverified Review: [A4] as the last row, nothing sent ("${r.confirm}" / "${r.back}", ${sends.length - s0} sent)`, a4Last() && r.shown && sends.length === s0);
  check("(10a) its buttons are [A4]'s", r.confirm === LAPSE_BUTTONS.confirm && r.back === LAPSE_BUTTONS.back && !r.disabled);
  const c0 = count("confirmName"), s0b = sends.length;
  await confirm();
  check(`(10b) "Send anyway" signs the reviewed address with no second look-up (${sends.length - s0b} sent, confirmName +${count("confirmName") - c0})`, sends.length === s0b + 1 && s0b === s0 && sends.at(-1)?.[0] === ALICE && count("confirmName") === c0);

  reviewAnswer = () => lapseAtConfirm;
  await review();
  const shown = state();
  const s1 = sends.length, c1 = count("confirmName");
  await confirm();
  check(`(10c) a Review that showed [A4] ("${shown.confirm}") confirms on its one click after one re-check (${sends.length - s1} sent, confirmName +${count("confirmName") - c1})`,
    shown.confirm === LAPSE_BUTTONS.confirm && sends.length === s1 + 1 && sends.at(-1)?.[0] === ALICE && count("confirmName") === c1 + 1);

  reviewAnswer = () => verifiedAlice;
  await review();
  const s2 = sends.length;
  await confirm();
  check(`(10d) a verified Review whose re-check brings the lapse shows [A4], not [A15] (${sends.length - s2} sent)`, a4Last() && state().shown && sends.length === s2);
  const s2b = sends.length;
  await confirm();
  check("(10d) its second click signs the reviewed address", s2b === s2 && sends.length === s2 + 1 && sends.at(-1)?.[0] === ALICE);

  confirmAnswer = () => verifiedAlice;
  await review();
  const s3 = sends.length;
  await confirm();
  check("(10e) honest: a verified Review re-checked verified still sends on one click", sends.length === s3 + 1 && sends.at(-1)?.[0] === ALICE);
}

console.log("9. the token send");
{
  byId("assets").querySelectorAll("[data-tsend]")[0].click(); await flush();
  byId("ts-to").value = "alice.csd"; byId("ts-amt").value = "1";
  byId("btn-tsend").click(); await flush(20);
  confirmAnswer = () => ({ ok: false });
  const s0 = sends.length;
  byId("btn-tsend-confirm").click(); await flush(20);
  check(`(9a) [A15] on the token review, "${byId("btn-tsend-confirm").textContent}" / "${byId("btn-tsend-back").textContent}"`, a15("tc-warn") && !byId("tsend-confirm").hidden && byId("btn-tsend-confirm").textContent === LAPSE_BUTTONS.confirm && sends.length === s0);
  byId("btn-tsend-confirm").click(); await flush(20);
  check("(9b) its second click sends the token to the reviewed address", sends.length === s0 + 1 && sends.at(-1)?.[0]?.to === ALICE);
}

console.log("11. the token send, a lapse at Confirm that the Review did not show");
{
  reviewAnswer = () => ({ ok: true, addr: ALICE, name: "alice", verified: false, sources: 2 });
  byId("btn-tsend-back").click(); await flush();
  byId("ts-to").disabled = false; byId("ts-amt").disabled = false;
  byId("ts-to").value = "alice.csd"; byId("ts-amt").value = "1";
  byId("btn-tsend").click(); await flush(20);
  confirmAnswer = () => ({ ok: true, addr: ALICE, name: "alice", lapsed: false, lapseUnconfirmed: true, addrProven: false, verified: false });
  const s0 = sends.length;
  byId("btn-tsend-confirm").click(); await flush(20);
  check(`(11a) [A4] on the token review, "${byId("btn-tsend-confirm").textContent}", nothing sent`, a4Last("tc-warn") && !byId("tsend-confirm").hidden && byId("btn-tsend-confirm").textContent === LAPSE_BUTTONS.confirm && sends.length === s0);
  const s0b = sends.length;
  byId("btn-tsend-confirm").click(); await flush(20);
  check("(11b) its second click sends the token to the reviewed address", s0b === s0 && sends.length === s0 + 1 && sends.at(-1)?.[0]?.to === ALICE);

  // the token twin of (10c): a token Review that showed [A4] confirms on its one click after one re-check
  const lapsed = { ok: true, addr: ALICE, name: "alice", lapsed: false, lapseUnconfirmed: true, addrProven: true, verified: false };
  reviewAnswer = () => lapsed; confirmAnswer = () => lapsed;
  byId("btn-tsend-back").click(); await flush();
  byId("ts-to").disabled = false; byId("ts-amt").disabled = false;
  byId("ts-to").value = "alice.csd"; byId("ts-amt").value = "1";
  byId("btn-tsend").click(); await flush(20);
  const shownT = byId("btn-tsend-confirm").textContent, s1 = sends.length, c1 = count("confirmName");
  byId("btn-tsend-confirm").click(); await flush(20);
  check(`(11c) a token Review that showed [A4] ("${shownT}") confirms on its one click after one re-check (${sends.length - s1} sent, confirmName +${count("confirmName") - c1})`,
    shownT === LAPSE_BUTTONS.confirm && sends.length === s1 + 1 && sends.at(-1)?.[0]?.to === ALICE && count("confirmName") === c1 + 1);
}
done("name-recheck-dom");
