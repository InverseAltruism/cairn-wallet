// WL1.3 (D12) in the real popup.ts, on a virtual clock: while a send's Review waits for the name check the sheet shows
// [A16] from 0.3 s ("Checking alice.csd..."), the header share while headers sync, and from 10 s, once the name
// service has answered, "Send without check". That choice arms the review on the served address with [A17] and
// "Send anyway" / "Wait"; its Confirm signs the reviewed address without waiting for the check and asks nothing again.
// The address signed equals the address reviewed in every case: the check passed before Confirm, failed before it,
// still running at Confirm, ended at D12's limit unverified, and another answer arriving after the review was shown.
// RED-FIRST: on the commit before this one (with only the new sentences added so the file loads), 2b to 2e, 3a to 3c,
// 6a, 7, 9a, 9b and 10a to 10c fail; 1 passes there (the honest path), and so do the cases the old wait reaches after
// the check answers.
// Mutations: the line from 0 s fails (1b); the choice before 10 s fails (2d); Confirm on the choice re-running the
// check (nameRecheck) fails (3c); Confirm signing the check's later answer instead of the review fails (6b);
// the choice armed with the default buttons fails (3b).
// Section 12 is the table of the lines that apply together; on 68cce65 (the new sentences added so the file loads) the
// six rows with [A9], [A10] or [A17] beside [A4] fail, since [A4] stood alone there.
// Sections 13 and 14 (d): on 68cce65 (13a), (13b) and (14d) fail: a check left while its progress read was in flight
// showed its line over the next review, and the line outlived its closed sheet. The rest of 14 pins edges that already
// held (a served zero address, a check rejecting after the choice, a broken channel, Confirm after "Wait").
// Run: node --import tsx test/name-check-wait-dom.test.mjs   (offline)
import { installFakeDom, installBridge, flush } from "./_fakedom.mjs";
import { SENTENCES, sentenceOf, UNCHECKED_BUTTONS, LAPSE_BUTTONS, REDIRECT_BUTTONS, SKIP_CHECK } from "../src/popup/sentences.ts";
import { SPV_NEWEST_HEIGHT } from "../src/core/spvnewest.ts";
import { checker } from "./helpers/check.mjs";

// The virtual clock: a timer of 0 ms runs on the real loop (flush), any longer one only when `advance` passes it.
const realSetTimeout = globalThis.setTimeout;
let now = 1_000_000;
let timers = [];
let nextId = 1;
Date.now = () => now;
globalThis.setTimeout = (fn, ms = 0, ...a) => {
  if (!(ms > 0)) return realSetTimeout(fn, 0, ...a);
  const id = nextId++; timers.push({ id, at: now + ms, fn: () => fn(...a) }); return id;
};
const realClear = globalThis.clearTimeout;
globalThis.clearTimeout = (id) => { timers = timers.filter((t) => t.id !== id); realClear(id); };
globalThis.setInterval = () => 0;
async function advance(ms) {
  const end = now + ms;
  for (;;) {
    timers.sort((a, b) => a.at - b.at);
    const t = timers[0];
    if (!t || t.at > end) break;
    timers.shift(); now = t.at; t.fn(); await flush(6);
  }
  now = end; await flush(6);
}

const { byId } = installFakeDom({ autoCreate: true });
const { check, done } = checker("=== the name check while a send's Review waits (real popup.ts) ===");
const ME = "0x" + "ab".repeat(20), SERVED = "0x" + "31".repeat(20), OTHER = "0x" + "42".repeat(20), TXID = "0x" + "7e".repeat(32);
let pending = null, served = null, progress = null, history = [];
const deferred = () => { let res, rej; const p = new Promise((r, j) => { res = r; rej = j; }); return { p, res, rej }; };
let ncHold = null;   // { name, d }: that name's progress reads wait for d (the read in flight while the user moves on)
const servedFor = {};   // a served answer per name for the progress read; `served` for any other
const sends = [];
const { calls, breakChannel } = installBridge({
  status: () => ({ hasVault: true, unlocked: true, addr: ME, accounts: [{ label: "A1", addr: ME }], active: 0, rpc: "https://x", api: "https://x", tradeApi: "https://x/trade/api", explorer: "cairn", hasMnemonic: true }),
  balance: () => ({ confirmed: 100e8, utxos: [] }),
  pendingMerge: () => ({ pending: false, amount: 0, maybe: false }),
  cairnxAssets: () => ({ ok: true, balances: { CAIRN: { available: "100000000000", locked: "0" } }, names: [], nameDetails: [], primaryName: null, tipHeight: 1 }),
  cairnxTokens: () => ({ ok: true, tokens: [{ ticker: "CAIRN", decimals: 8 }] }),
  prewarmSpv: () => ({ ok: true }), pending: () => [], sealedClaims: () => [], history: () => history,
  resolveName: () => { pending = deferred(); return pending.p; },
  nameCheck: async (nm) => { if (ncHold && ncHold.name === nm) await ncHold.d.p; return { served: servedFor[nm] ?? served, progress }; },
  confirmName: () => ({ ok: true, addr: SERVED, verified: true }),
  send: (...args) => { sends.push(args); return { ok: true, txid: TXID }; },
  cairnxTransfer: (p) => { sends.push([p]); return { ok: true, txid: TXID }; },
});
await import("../src/popup/popup.ts");
await flush();
for (const id of ["s-check", "s-check-skip", "ts-check", "ts-check-skip"]) byId(id).hidden = true;   // as popup.html has them

const A17 = SENTENCES.A17.text;
const line = () => ({ shown: !byId("s-check").hidden, text: byId("s-check-text").textContent, skip: !byId("s-check-skip").hidden, skipText: byId("s-check-skip").textContent });
const review = () => ({ shown: !byId("send-confirm").hidden, to: String(byId("c-to").innerHTML).replace(/<[^>]*>|\s/g, "").toLowerCase(), warn: byId("c-warn").hidden ? "" : String(byId("c-warn").innerHTML), confirm: byId("btn-send-confirm").textContent, back: byId("btn-send-back").textContent });
const count = (m) => calls.filter((x) => x === m).length;
async function startReview(name = "alice.csd") {
  byId("btn-send-back").click(); await flush();
  byId("s-to").disabled = false; byId("s-amt").disabled = false;
  byId("s-to").value = name; byId("s-amt").value = "1";
  served = null; progress = null;
  byId("btn-send").click(); await flush();
}
const verified = (addr) => ({ ok: true, addr, name: "alice", verified: true, sources: 2, depth: 14 });
const choose = async () => { byId("s-check-skip").onclick?.(); await flush(); };
const confirm = async () => { byId("btn-send-confirm").click(); await flush(); await advance(50); };

console.log("1. a check that answers inside 0.3 s: nothing new");
{
  await startReview();
  await advance(200);
  pending.res(verified(SERVED)); await flush();
  await advance(400);
  const r = review();
  check(`(1a) the review is armed as before, "Confirm send" / "Back", no line (${r.confirm})`, r.shown && r.confirm === "Confirm send" && r.back === "Back" && !line().shown);
  check(`(1b) the line never showed and no progress read was made (${count("nameCheck")} reads)`, count("nameCheck") === 0);
  const c0 = count("confirmName");
  await confirm();
  check("(1c) its Confirm re-checks as 0.3.4 does (confirmName) and signs the reviewed address", count("confirmName") === c0 + 1 && sends.at(-1)?.[0] === SERVED);
}

console.log("2. a held check: the line from 0.3 s, the share, the choice from 10 s");
{
  await startReview();
  await advance(299);
  check("(2a) at 0.299 s no line", !line().shown);
  await advance(1);
  check(`(2b) at 0.3 s: [A16] "${line().text}"`, line().shown && line().text === sentenceOf("A16", undefined, { name: "alice.csd", pct: "" }).text && !line().skip);
  progress = { done: 650, total: 1000 };
  await advance(250);
  check(`(2c) while headers sync, the share: "${line().text}"`, line().text === "Checking alice.csd... 65%");
  progress = null; served = { addr: SERVED, lapsed: false };
  await advance(9_000);
  check(`(2d) at 9.8 s no choice yet`, line().shown && !line().skip);
  await advance(500);
  check(`(2e) from 10 s the choice "${line().skipText}"`, line().skip && line().skipText === SKIP_CHECK);
  check("(2f) the Review is not armed meanwhile", !review().shown && count("resolveName") >= 1);
}

console.log("3. Send without check, then Send anyway while the check runs");
{
  const r0 = count("resolveName"), c0 = count("confirmName"), s0 = sends.length;
  await choose();
  const r = review();
  check(`(3a) the review shows the served address with [A17] alone (${r.to.slice(0, 12)})`, r.shown && r.to === SERVED && r.warn.includes(A17) && !/chain-backed|verify the full address/i.test(r.warn) && !line().shown);
  check(`(3b) Confirm reads "${r.confirm}", Back "${r.back}"`, r.confirm === UNCHECKED_BUTTONS.confirm && r.back === UNCHECKED_BUTTONS.back);
  await confirm();
  check(`(3c) Send anyway signs the reviewed address without waiting, and asks nothing again (confirmName ${count("confirmName") - c0}, resolveName ${count("resolveName") - r0})`, sends.length === s0 + 1 && sends.at(-1)?.[0] === SERVED && count("confirmName") === c0 && count("resolveName") === r0);
  // 7. the check still running at Confirm then answers another address: the send already went to the reviewed one
  pending.res(verified(OTHER)); await flush(); await advance(50);
  check("(7) a later answer with another address changes nothing sent (one send, to the reviewed address)", sends.length === s0 + 1 && sends.at(-1)?.[0] === SERVED);
}

async function chooseAt10() {
  await startReview(); served = { addr: SERVED, lapsed: false };
  await advance(10_300); await choose();
}

console.log("4. the check finishes and passes after the choice, before Confirm");
{
  await chooseAt10();
  pending.res(verified(SERVED)); await flush(); await advance(50);
  const s0 = sends.length;
  check("(4a) the review stays, nothing refused", review().shown && review().to === SERVED);
  await confirm();
  check("(4b) Confirm signs the reviewed address", sends.length === s0 + 1 && sends.at(-1)?.[0] === SERVED);
}

console.log("5. the check finishes and fails after the choice, before Confirm");
{
  await chooseAt10();
  const s0 = sends.length;
  pending.res({ ok: false, lapsed: true, error: "alice.csd has lapsed, so we did not send. Send to the owner's 0x address directly, or ask them to renew the name before sending again." }); await flush(); await advance(50);
  check(`(5a) the review is taken down with the check's refusal (${byId("msg").textContent.slice(0, 40)})`, !review().shown && /has lapsed/.test(byId("msg").textContent));
  await confirm();
  check("(5b) nothing is signed", sends.length === s0);
}

console.log("6. another answer arrives after the review was shown");
{
  await chooseAt10();
  const s0 = sends.length;
  const snapTo = review().to;
  pending.res(verified(OTHER)); await flush(); await advance(50);
  check(`(6a) the review is taken down with [A14] (${byId("msg").textContent.slice(0, 50)})`, !review().shown && byId("msg").textContent === sentenceOf("A14", undefined, { name: "alice.csd" }).text);
  await confirm();
  check(`(6b) nothing is signed, and never the other address (reviewed ${snapTo.slice(0, 10)})`, sends.length === s0 && !sends.some((s) => s[0] === OTHER));
}

console.log("8. the check ends at D12's limit unverified, same address");
{
  await chooseAt10();
  const s0 = sends.length;
  pending.res({ ok: true, addr: SERVED, name: "alice", verified: false, verifyReason: "on-chain verification unavailable" }); await flush(); await advance(50);
  check("(8a) refuses nothing", review().shown);
  await confirm();
  check("(8b) Confirm signs the reviewed address", sends.length === s0 + 1 && sends.at(-1)?.[0] === SERVED);
}

console.log("9. Wait goes back to the same check");
{
  await chooseAt10();
  const r0 = count("resolveName");
  byId("btn-send-back").click(); await flush(); await advance(0);
  check(`(9a) Wait: the review is gone and the line and the choice are back at once (${line().text})`, !review().shown && line().shown && line().skip);
  pending.res(verified(SERVED)); await flush(); await advance(50);
  const r = review();
  check(`(9b) when the check answers, the review arms as a checked one ("${r.confirm}"), with no new lookup`, r.shown && r.confirm === "Confirm send" && !r.warn.includes(A17) && count("resolveName") === r0);
}

console.log("10. the token send");
{
  byId("btn-send-back").click(); await flush();
  byId("assets").querySelectorAll("[data-tsend]")[0].click(); await flush();
  byId("ts-to").value = "alice.csd"; byId("ts-amt").value = "1";
  served = { addr: SERVED, lapsed: false }; progress = null;
  byId("btn-tsend").click(); await flush();
  await advance(10_300);
  check("(10a) the token sheet shows the line and the choice", !byId("ts-check").hidden && !byId("ts-check-skip").hidden);
  byId("ts-check-skip").onclick?.(); await flush();
  check(`(10b) the token review: [A17], "${byId("btn-tsend-confirm").textContent}" / "${byId("btn-tsend-back").textContent}"`, String(byId("tc-warn").innerHTML).includes(A17) && byId("btn-tsend-confirm").textContent === UNCHECKED_BUTTONS.confirm && byId("btn-tsend-back").textContent === UNCHECKED_BUTTONS.back);
  const s0 = sends.length;
  byId("btn-tsend-confirm").click(); await flush(); await advance(50);
  check("(10c) Send anyway sends the token to the reviewed address", sends.length === s0 + 1 && sends.at(-1)?.[0]?.to === SERVED);
}
console.log("11. [A17] and [A19] together: both lines on the review, [A17]'s buttons");
{
  byId("btn-tsend-back").click(); await flush();
  history = [{ type: "send", to: OTHER, amount: 1e8, fee: 1e6, txid: "0x" + "0a".repeat(32), ts: 10, name: "alice" }];   // last paid at OTHER
  await chooseAt10();
  const r = review();
  const A19 = sentenceOf("A19", undefined, { name: "alice.csd" }).text;
  check(`(11a) the review shows [A19] first and [A17] beside it (${r.warn.indexOf(A19)} < ${r.warn.indexOf(A17)})`, r.shown && r.warn.indexOf(A19) >= 0 && r.warn.indexOf(A17) > r.warn.indexOf(A19));
  check(`(11b) with "Send anyway" / "Wait" (${r.confirm} / ${r.back})`, r.confirm === UNCHECKED_BUTTONS.confirm && r.back === UNCHECKED_BUTTONS.back);
  history = [];
  pending.res(verified(SERVED)); await flush();
}

console.log("12. every line that can apply together: all on screen, in one order, with the strictest buttons");
{
  const nm = { name: "alice.csd" };
  const T = { A4: sentenceOf("A4", undefined, nm).text, A9: SENTENCES.A9.text, A10: SENTENCES.A10.text, A17, A18: SENTENCES.A18.text, A19: sentenceOf("A19", undefined, nm).text };
  const ORDER = ["A19", "A17", "A9", "A10", "A4", "A18"];
  const lapse = (extra) => ({ ok: true, addr: SERVED, name: "alice", lapsed: false, lapseUnconfirmed: true, verified: false, ...extra });
  const rows = [
    // [lines from the check, how the review is reached, its answer or the served flag, the buttons without [A19]]
    [["A4"], "answer", lapse({ addrProven: true }), LAPSE_BUTTONS],
    [["A9", "A4"], "answer", lapse({ addrProven: false }), LAPSE_BUTTONS],
    [["A10", "A4"], "answer", lapse({ addrProven: false, viaFill: true }), LAPSE_BUTTONS],
    [["A18"], "answer", { ...verified(SERVED), completedAt: SPV_NEWEST_HEIGHT + 1 }, null],
    [["A17"], "choose", false, UNCHECKED_BUTTONS],
    [["A17", "A4"], "choose", true, UNCHECKED_BUTTONS],
  ];
  const DEFAULT = { confirm: "Confirm send", back: "Back" };
  for (const redirect of [false, true]) for (const [lines, how, arg, buttons] of rows) {
    if (pending && !pending.settled) { pending.res(verified(SERVED)); pending.settled = true; await flush(); }
    history = redirect ? [{ type: "send", to: OTHER, amount: 1e8, fee: 1e6, txid: "0x" + "0b".repeat(32), ts: 10, name: "alice" }] : [];
    await startReview();
    if (how === "answer") { pending.res(arg); pending.settled = true; await flush(); await advance(50); }
    else { served = { addr: SERVED, lapsed: arg }; await advance(10_300); await choose(); }
    const want = [...(redirect ? ["A19"] : []), ...lines];
    const r = review();
    const at = ORDER.map((k) => [k, r.warn.indexOf(T[k])]).filter(([, i]) => i >= 0);
    const shown = at.sort((a, b) => a[1] - b[1]).map(([k]) => k);
    const exp = buttons === UNCHECKED_BUTTONS ? UNCHECKED_BUTTONS : redirect ? REDIRECT_BUTTONS : buttons ?? DEFAULT;
    check(`(12) ${want.join(" + ")}: on screen ${shown.join(", ")}; buttons "${r.confirm}" / "${r.back}"`, r.shown && shown.join() === want.join() && r.confirm === exp.confirm && r.back === exp.back);
  }
  if (pending && !pending.settled) { pending.res(verified(SERVED)); await flush(); }
  history = [];
}

console.log("13. a check left while its progress read is in flight shows nothing over the next review");
{
  const BOB = "0x" + "b0".repeat(20);
  // (a) the next Review answers at once and arms; the left check's read then returns
  ncHold = { name: "alice", d: deferred() };
  await startReview("alice.csd");
  await advance(300);                                    // alice's first progress read is in flight
  byId("s-to").value = "bob.csd"; byId("btn-send").click(); await flush();
  pending.res({ ...verified(BOB), name: "bob" }); pending.settled = true; await flush(); await advance(50);
  ncHold.d.res(); await flush(); await advance(0);
  check(`(13a) the armed review of bob.csd has no checking line over it (${line().shown ? line().text : "hidden"})`, review().shown && review().to === BOB && !line().shown);
  // (b) the next Review is itself waiting with its choice offered; the left check's read then returns
  ncHold = { name: "alice", d: deferred() };
  await startReview("alice.csd");
  await advance(300);
  byId("s-to").value = "bob.csd"; servedFor.bob = { addr: BOB, lapsed: false };
  byId("btn-send").click(); await flush();
  await advance(10_300);
  const before = line();
  ncHold.d.res(); await flush(); await advance(0);
  const after = line();
  check(`(13b) bob.csd's line and choice stay ("${before.text}" -> "${after.text}", choice ${after.skip})`, before.shown && /bob\.csd/.test(before.text) && after.shown && after.text === before.text && after.skip);
  await choose();
  check(`(13c) its choice arms bob.csd's review on bob's served address (${review().to.slice(0, 10)})`, review().shown && review().to === BOB);
  pending.res({ ...verified(BOB), name: "bob" }); pending.settled = true; await flush(); await advance(50);
  ncHold = null; delete servedFor.bob;
  byId("btn-send-back").click(); await flush(); await advance(50);   // "Wait": the settled check arms a checked review
  byId("btn-send-back").click(); await flush();
}

console.log("14. the check's edges");
{
  const ZERO = "0x" + "00".repeat(20);
  // (a) the name service serves the zero address: "Send without check" refuses it, nothing is armed
  await startReview(); served = { addr: ZERO, lapsed: false };
  await advance(10_300); await choose();
  check(`(14a) a served zero address is refused at the choice (${byId("msg").textContent.slice(0, 40)})`, !review().shown && /zero address/.test(byId("msg").textContent));
  pending.res(verified(SERVED)); pending.settled = true; await flush(); await advance(50);

  // (b) the check rejects (the service worker restarted, or resolveName threw) after the choice: down, nothing signed
  await chooseAt10();
  let s0 = sends.length;
  pending.rej(new Error("The message port closed before a response was received.")); pending.settled = true; await flush(); await advance(50);
  check(`(14b) a check that rejects after the choice takes the review down (${byId("msg").textContent})`, !review().shown && byId("msg").textContent === "Name lookup failed.");
  await confirm();
  check("(14b) and Confirm signs nothing", sends.length === s0);

  // (c) the channel breaks at the lookup itself: no review
  byId("btn-send-back").click(); await flush();
  breakChannel.add("resolveName");
  byId("s-to").value = "alice.csd"; byId("s-amt").value = "1"; byId("btn-send").click(); await flush(); await advance(50);
  check(`(14c) a lookup whose channel broke arms nothing (${byId("msg").textContent})`, !review().shown && byId("msg").textContent === "Name lookup failed.");

  // (d) the sheet closes while the line shows: the line goes with it, and the answer then arms nothing
  await startReview();
  await advance(400);
  const shownBefore = line().shown;
  const { closeAllPanels } = await import("../src/popup/popup-panels.ts");
  closeAllPanels(); await flush();
  check(`(14d) the line closes with the sheet (${shownBefore} -> ${line().shown})`, shownBefore && !line().shown);
  pending.res(verified(SERVED)); pending.settled = true; await flush(); await advance(300);
  check("(14d) the check's answer after that arms no review and shows no line", !review().shown && !line().shown);
  byId("btn-send-t").click(); await flush();

  // (e) Confirm after "Wait": the check finishes, the review arms as a checked one, and its Confirm re-checks as 0.3.4
  await chooseAt10();
  byId("btn-send-back").click(); await flush(); await advance(0);   // "Wait"
  pending.res(verified(SERVED)); pending.settled = true; await flush(); await advance(50);
  const c0 = count("confirmName"); s0 = sends.length;
  await confirm();
  check(`(14e) Confirm after "Wait" runs the confirm-time re-check and signs the reviewed address (confirmName +${count("confirmName") - c0})`, count("confirmName") === c0 + 1 && sends.length === s0 + 1 && sends.at(-1)?.[0] === SERVED);
}
done("name-check-wait-dom");
