// Plan 89 7b, the popup's B edits, driven through the REAL popup.ts against a fake DOM and a scripted background.
//
//   1. Review checks carry a tier (W-01, W-02): the name caution is positive only where nameCautionHtml says ✓ (two
//      sources agree), caution on every other branch; the first-time and the address-poisoning warnings and a balance
//      that does not cover the send are danger.
//      RED-FIRST: give the first-time warning tier "caution" and 1d fails; make nameCheck return "ok" for every
//      verified name and 1b fails. HONEST PATH: 1a, 1g (a send with nothing to warn about arms Confirm and signs
//      with the production call shape).
//   2. The 1.5 s pending poll rewrites the request card only when the queue changed (W-15).
//      RED-FIRST: drop the `key === pendingShown` return and 2a fails. HONEST PATH: 2b, 2c.
//   3. History labels say what the wallet sent, not a verdict it never read (W-18, register row 124).
//      RED-FIRST: put "Filled offer" back in TX_LABEL and 3a fails. HONEST PATH: 3b.
//   4. Names (W-11, W-12): a pending reservation or a lapsed name offers no owner action; the Renew chip shows only
//      near the lease's end. RED-FIRST: render the live actions for every name in openNameDetail and 4a, 4b fail.
//      HONEST PATH: 4c-4e (a renew from the detail reviews and signs with the production call shape).
//   5. The imported-key removal warning (W-23) renders as a caution row with its R3 section 4 text.
//      RED-FIRST: write it back as a plain line and 5a fails. HONEST PATH: 5b (an HD account still removes in one
//      click, with no password).
// Run: node --import tsx test/popup-checks-dom.test.mjs   (offline)
import { installFakeDom, installBridge, flush } from "./_fakedom.mjs";
import { checker } from "./helpers/check.mjs";

const { check, done } = checker("popup review checks, pending poll, history, names (real popup.ts):");
const { byId } = installFakeDom({ autoCreate: true });
const ME = "0x" + "ab".repeat(20);
const HD2 = "0x" + "cd".repeat(20);
const IMP = "0x" + "ef".repeat(20);
const PAID = "0x" + "31".repeat(20);
const LOOK = "0x313131" + "77".repeat(15) + "3131";
const NEW = "0x" + "42".repeat(20);
const TXID = "0x" + "7e".repeat(32);

let history = [{ type: "send", to: PAID, amount: 1e8, fee: 1e6, txid: TXID, ts: 1 }];
let pending = [];
let resolveAns = { ok: true, addr: PAID, verified: true, sources: 2, depth: 14, via: "owner" };
const sent = [];
const renewed = [];
const removed = [];
const h = {
  status: () => ({ hasVault: true, unlocked: true, addr: ME, accounts: [{ label: "A1", addr: ME }, { label: "A2", addr: HD2 }, { label: "K", addr: IMP, imported: true }], active: 0, rpc: "https://x", api: "https://x", tradeApi: "https://x/trade/api", explorer: "cairn", hasMnemonic: true }),
  balance: () => ({ confirmed: 100e8, utxos: [] }),
  pendingMerge: () => ({ pending: false, amount: 0, maybe: false, stuck: false }),
  cairnxAssets: () => ({ ok: true, balances: {}, names: [], primaryName: "alice", tipHeight: 100,
    nameDetails: [
      { name: "alice", leased: true, epochsLeft: 6000 },
      { name: "bob", leased: true, epochsLeft: 30 },
      { name: "satoshi", pending: true, finalizeBy: 150 },
      { name: "oldname", lapsed: true },
    ] }),
  cairnxTokens: () => ({ ok: true, tokens: [] }),
  prewarmSpv: () => ({ ok: true }),
  pending: () => pending,
  history: () => history,
  sealedClaims: () => [],
  resolveName: () => resolveAns,
  confirmName: () => resolveAns,
  send: (...args) => { sent.push(args); return { ok: true, txid: TXID }; },
  cairnxNameRenewFee: () => 15e8,
  cairnxNameRenew: (...args) => { renewed.push(args); return { ok: true, txid: TXID }; },
  removeAccount: (...args) => { removed.push(args); return true; },
};
installBridge(h);
let poll = null;
globalThis.setInterval = (fn) => { poll = fn; return 0; };
await import("../src/popup/popup.ts");
await flush();

const warn = () => (byId("c-warn").hidden ? "" : String(byId("c-warn").innerHTML));
const rows = () => [...warn().matchAll(/<div class="check (\w+)">.*?<div>(.*?)<\/div><\/div>/gs)].map((m) => ({ tier: m[1], html: m[2] }));
async function review(to, amt = "1") {
  await byId("btn-send-back").click();
  byId("s-to").value = to; byId("s-amt").value = amt;
  await byId("btn-send").click(); await flush();
}

console.log("1. review check tiers");
await review("alice.csd");
{
  const r = rows();
  check("1a honest: two sources agree reads as one positive row with the ✓ copy", r.length === 1 && r[0].tier === "ok" && r[0].html.startsWith("✓"));
}
const branches = [
  ["one source only", { soleSource: true }],
  ["sources disagree", { disagree: true }],
  ["bought through a fill", { viaFill: true, verified: false }],
  ["not chain-verified", { verified: false }],
  ["one source answered", { sources: 1 }],
];
for (const [label, extra] of branches) {
  resolveAns = { ok: true, addr: PAID, verified: true, sources: 2, depth: 14, via: "owner", ...extra };
  await review("alice.csd");
  const r = rows();
  check(`1b ${label}: the name row is caution, and its copy does not read ✓`, r.length === 1 && r[0].tier === "caution" && !r[0].html.startsWith("✓"));
}
resolveAns = { ok: true, addr: PAID, verified: true, sources: 2, depth: 14, via: "owner" };
await review(LOOK);
check("1c address poisoning is a danger row with its copy", rows().length === 1 && rows()[0].tier === "danger" && /Possible address-poisoning/.test(rows()[0].html));
await review(NEW);
check("1d a first send is a danger row (red, as in 0.2.99)", rows().length === 1 && rows()[0].tier === "danger" && /First time sending to this address/.test(rows()[0].html));
resolveAns = { ok: true, addr: NEW, verified: true, sources: 2, depth: 14, via: "owner" };
await review("alice.csd");
check("1e a named first send: the positive name row, then the danger row", rows().map((r) => r.tier).join() === "ok,danger");
resolveAns = { ok: true, addr: PAID, verified: true, sources: 2, depth: 14, via: "owner" };
await review(PAID, "200");
check("1f a balance that does not cover the send is a danger row and keeps Confirm down", rows()[0]?.tier === "danger" && /does not cover/.test(rows()[0].html) && byId("btn-send-confirm").disabled === true);
await review(PAID);
check("1g honest: a paid address with no name shows no row and arms Confirm", byId("c-warn").hidden === true && byId("btn-send-confirm").disabled === false);
await byId("btn-send-confirm").click(); await flush();
check("1g honest: Confirm signs the reviewed send with the production call shape", JSON.stringify(sent.at(-1)) === JSON.stringify([PAID, 1e8, 1e6, ME]));

console.log("2. the pending poll");
{
  const el = byId("pending");
  const proto = Object.getPrototypeOf(el);
  const desc = Object.getOwnPropertyDescriptor(proto, "innerHTML");
  let writes = 0;
  Object.defineProperty(el, "innerHTML", { configurable: true, get() { return desc.get.call(this); }, set(v) { writes++; desc.set.call(this, v); } });
  pending = [{ id: "p1", method: "send", origin: "https://dapp.example" }];
  await poll(); await flush();
  const first = writes;
  await poll(); await flush(); await poll(); await flush();
  check("2a two polls of the same queue write nothing", first === 1 && writes === 1 && el.hidden === false);
  pending = [...pending, { id: "p2", method: "propose", origin: "https://other.example" }];
  await poll(); await flush();
  check("2b honest: a new request rewrites the card and shows it", writes === 2 && /other\.example/.test(el.innerHTML) && /Review 2 requests/.test(el.innerHTML));
  pending = [];
  await poll(); await flush();
  check("2c honest: an empty queue hides the card", el.hidden === true && el.innerHTML === "");
}

console.log("3. history labels");
history = [
  { type: "fillOffer", to: PAID, amount: 25e7, txid: TXID, ts: 1 },
  { type: "send", to: PAID, amount: 1e8, fee: 1e6, txid: "0x" + "7f".repeat(32), ts: 1 },
];
byId("activity").hidden = true;
await byId("btn-activity-t").click(); await flush();
{
  const html = String(byId("history-list").innerHTML);
  check("3a a fill reads as sent, never as filled", /Offer fill sent/.test(html) && !/Filled offer/.test(html));
  check("3b honest: a CSD send still reads Sent", />Sent</.test(html));
}

console.log("4. names");
await byId("nav-home").click();
const nl = () => byId("names-list");
const detail = async (name) => {
  const row = nl().querySelectorAll("[data-name]").find((b) => b.dataset.name === name);
  await row.click(); await flush();
  return String(byId("nd-actions").innerHTML);
};
{
  const pend = await detail("satoshi");
  check("4a a pending reservation's detail has no renew and no set-primary, only the site", !/data-nrenew|data-nprimary/.test(pend) && /Finalize on the site/.test(pend));
  const lapsed = await detail("oldname");
  check("4b a lapsed name's detail has no owner action, only the site", !/data-nrenew|data-nprimary/.test(lapsed) && /Recapture on the site/.test(lapsed));
  const chips = nl().querySelectorAll("[data-nrenew]").map((b) => b.dataset.nrenew);
  check(`4c the Renew chip shows only on the lease near its end (${chips.join()})`, chips.join() === "bob");
  const bob = await detail("bob");
  const alice = await detail("alice");
  check("4d a live name's detail offers renew and set primary; the primary name only renew", /data-nrenew="bob"/.test(bob) && /data-nprimary="bob"/.test(bob) && /data-nrenew="alice"/.test(alice) && !/data-nprimary/.test(alice));
  await byId("nd-actions").querySelectorAll("[data-nrenew]")[0].click(); await flush();
  check("4e honest: renew from the detail opens the review priced at 15 CSD", byId("name-action-form").hidden === false && byId("nc-fee").textContent === "15 CSD");
  await byId("btn-name-confirm").click(); await flush();
  check("4e honest: Confirm signs the reviewed renew with the production call shape", JSON.stringify(renewed.at(-1)) === JSON.stringify(["alice", 15e8, ME]));
}

console.log("5. imported-key removal");
{
  await byId("btn-accts").click(); await flush();
  const list = byId("accts-list");
  await list.querySelectorAll("[data-remove]").find((b) => b.dataset.remove === IMP).click(); await flush();
  const html = String(list.innerHTML);
  check("5a the warning is a caution row with its text", /<div class="check caution">/.test(html) && html.includes("this imported key is NOT in your recovery phrase — removing it without a saved backup loses its funds forever. Export it first (More › Reveal key), then enter your password to confirm."));
  await list.querySelectorAll("[data-cancel]")[0].click(); await flush();
  await list.querySelectorAll("[data-remove]").find((b) => b.dataset.remove === HD2).click(); await flush();
  await list.querySelectorAll("[data-confirm-remove]")[0].click(); await flush();
  check("5b honest: an HD account removes in one click, with no password", JSON.stringify(removed.at(-1)) === JSON.stringify([HD2]));
}

done("popup-checks-dom");
