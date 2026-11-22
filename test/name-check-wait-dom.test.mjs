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
// check (nameStillPointsTo) fails (3c); Confirm signing the check's later answer instead of the review fails (6b);
// the choice armed with the default buttons fails (3b).
// Run: node --import tsx test/name-check-wait-dom.test.mjs   (offline)
import { installFakeDom, installBridge, flush } from "./_fakedom.mjs";
import { SENTENCES, sentenceOf, UNCHECKED_BUTTONS, SKIP_CHECK } from "../src/popup/sentences.ts";
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
let pending = null, served = null, progress = null;
const deferred = () => { let res; const p = new Promise((r) => { res = r; }); return { p, res }; };
const sends = [];
const { calls } = installBridge({
  status: () => ({ hasVault: true, unlocked: true, addr: ME, accounts: [{ label: "A1", addr: ME }], active: 0, rpc: "https://x", api: "https://x", tradeApi: "https://x/trade/api", explorer: "cairn", hasMnemonic: true }),
  balance: () => ({ confirmed: 100e8, utxos: [] }),
  pendingMerge: () => ({ pending: false, amount: 0, maybe: false }),
  cairnxAssets: () => ({ ok: true, balances: { CAIRN: { available: "100000000000", locked: "0" } }, names: [], nameDetails: [], primaryName: null, tipHeight: 1 }),
  cairnxTokens: () => ({ ok: true, tokens: [{ ticker: "CAIRN", decimals: 8 }] }),
  prewarmSpv: () => ({ ok: true }), pending: () => [], sealedClaims: () => [], history: () => [],
  resolveName: () => { pending = deferred(); return pending.p; },
  nameCheck: () => ({ served, progress }),
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
done("name-check-wait-dom");
