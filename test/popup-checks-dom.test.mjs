// Plan 89 7b, the popup's B edits, driven through the REAL popup.ts against a fake DOM and a scripted background.
//
//   1. Review checks carry a tier (W-01, W-02): the name caution is positive only where nameCautionHtml says ✓ (two
//      sources agree) at a depth that can no longer reorg (NAME_SAFE_DEPTH), caution on every other branch and below
//      that depth; the first-time and the address-poisoning warnings and a balance that does not cover the send are
//      danger.
//      RED-FIRST: give the first-time warning tier "caution" and 1d fails; make nameCheck return "ok" for every
//      verified name and 1b fails; drop the depth from nameCheck and 1b' fails at depth 1 and 2; compare with <= and
//      1b' fails at depth 3. HONEST PATH: 1a, 1b' at depth 3, 1g (a send with nothing to warn about arms Confirm and
//      signs with the production call shape).
//   2. The 1.5 s pending poll rewrites the request card only when the queue changed (W-15).
//      RED-FIRST: drop the `key === pendingShown` return and 2a fails. HONEST PATH: 2b, 2c.
//   3. History labels say what the wallet sent, not a verdict it never read (W-18, register row 124).
//      RED-FIRST: put "Filled offer" back in TX_LABEL and 3a fails. HONEST PATH: 3b.
//   4. Names (W-11, W-12): a pending reservation or a lapsed name offers no owner action; the Renew chip shows only
//      near the lease's end. RED-FIRST: render the live actions for every name in openNameDetail and 4a, 4b fail.
//      HONEST PATH: 4c-4e (a renew from the detail reviews and signs with the production call shape).
//   5. The imported-key removal warning (W-23) renders as a danger row with its R3 section 4 text (meaning kept, the
//      em dash now a colon). RED-FIRST: write it back as a plain line, or as caution, and 5a fails. HONEST PATH: 5b
//      (an HD account still removes in one click, with no password).
//   6. An account switch closes every sheet (W-23): a name's detail cannot carry account A's name into a review
//      signed by account B. RED-FIRST: drop closeAllPanels from switchAcct and 6a fails. HONEST PATH: 6b.
//   7. Token rows: the tile never shows part of a ticker (the longest legal ticker is 12 characters), a served token
//      name never shows, amounts are grouped without changing a digit. RED-FIRST: put `t.slice(0, 3)` back in the
//      tile and 7a fails; show meta name on a pinned row and 7b fails; drop groupDigits and 7c fails.
//   8. Copy on the account address copies the full raw address. RED-FIRST: copy short(addr) and 8a fails.
//   9. The send review's Name row is the name and the short address; the badge sentence lives only in the name check
//      row, word for word. RED-FIRST: put the badge back on the label and 9a fails.
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
let active = 0;
let assets = null;
const written = [];
Object.defineProperty(globalThis.navigator, "clipboard", { configurable: true, get: () => ({ writeText: async (t) => { written.push(t); } }) });
const renewed = [];
const primaried = [];
const removed = [];
const h = {
  status: () => ({ hasVault: true, unlocked: true, addr: active ? HD2 : ME, active, accounts: [{ label: "A1", addr: ME }, { label: "A2", addr: HD2 }, { label: "K", addr: IMP, imported: true }], rpc: "https://x", api: "https://x", tradeApi: "https://x/trade/api", explorer: "cairn", hasMnemonic: true }),
  balance: () => ({ confirmed: 100e8, utxos: [] }),
  pendingMerge: () => ({ pending: false, amount: 0, maybe: false, stuck: false }),
  cairnxAssets: () => assets ?? ({ ok: true, balances: {}, names: [], primaryName: "alice", tipHeight: 100,
    nameDetails: [
      { name: "alice", leased: true, epochsLeft: 6000 },
      { name: "bob", leased: true, epochsLeft: 30 },
      { name: "satoshi", pending: true, finalizeBy: 150 },
      { name: "oldname", lapsed: true },
    ] }),
  // the served list: deployer-set names, and decimals for the tokens the wallet does not pin
  cairnxTokens: () => ({ ok: true, tokens: [{ ticker: "CAIRN", decimals: 0, name: "Cairn Official Token" }, { ticker: "ABCDEFGHIJKL", decimals: 3, name: "Abc deployer text" }, { ticker: "BIGNUM", decimals: 0 }, { ticker: "ZERO", decimals: 2 }] }),
  prewarmSpv: () => ({ ok: true }),
  pending: () => pending,
  history: () => history,
  sealedClaims: () => [],
  resolveName: () => resolveAns,
  confirmName: () => resolveAns,
  send: (...args) => { sent.push(args); return { ok: true, txid: TXID }; },
  cairnxNameRenewFee: () => 15e8,
  cairnxNameRenew: (...args) => { renewed.push(args); return { ok: true, txid: TXID }; },
  cairnxSetPrimary: (...args) => { primaried.push(args); return { ok: true, txid: TXID }; },
  removeAccount: (...args) => { removed.push(args); return true; },
  switchAccount: (i) => { active = i; return true; },
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
for (const [depth, tier] of [[1, "caution"], [2, "caution"], [3, "ok"]]) {
  resolveAns = { ok: true, addr: PAID, verified: true, sources: 2, depth, via: "owner" };
  await review("alice.csd");
  const r = rows();
  check(`1b' two sources agree at depth ${depth}: the name row is ${tier}${depth < 3 ? " (it reads could still reorg)" : ""}`, r.length === 1 && r[0].tier === tier && /could still reorg/.test(r[0].html) === (depth < 3));
}
resolveAns = { ok: true, addr: PAID, verified: true, sources: 2, depth: 14, via: "owner" };
await review(LOOK);
check("1c address poisoning is a danger row with its copy", rows().length === 1 && rows()[0].tier === "danger" && /^<b>Possible address-poisoning\.<\/b>/.test(rows()[0].html) && /is <b>not<\/b> the same address/.test(rows()[0].html));
await review(NEW);
check("1d a first send is a danger row (red, as in 0.2.99), the row's icon in place of a ⚠ glyph", rows().length === 1 && rows()[0].tier === "danger" && /^First time sending to this address: check every character\. Payments are irreversible\.$/.test(rows()[0].html));
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
  check("5a the warning is a danger row with its text", /<div class="check danger">/.test(html) && html.includes("This imported key is <b>not</b> in your recovery phrase: removing it without a saved backup loses its funds forever. Export it first (More › Reveal key), then enter your password to confirm."));
  await list.querySelectorAll("[data-cancel]")[0].click(); await flush();
  await list.querySelectorAll("[data-remove]").find((b) => b.dataset.remove === HD2).click(); await flush();
  await list.querySelectorAll("[data-confirm-remove]")[0].click(); await flush();
  check("5b honest: an HD account removes in one click, with no password", JSON.stringify(removed.at(-1)) === JSON.stringify([HD2]));
}

console.log("6. an account switch closes every sheet");
{
  await byId("nav-home").click();
  await byId("nav-names").click(); await flush();
  await nl().querySelectorAll("[data-name]").find((b) => b.dataset.name === "bob").click(); await flush();
  const opened = byId("name-detail").hidden === false && /data-nprimary="bob"/.test(byId("nd-actions").innerHTML);
  await byId("acct-menu").querySelectorAll("[data-acct]").find((b) => b.dataset.acct === "1").click(); await flush();
  check("6a after a switch the detail is closed and holds no name action", opened && byId("name-detail").hidden === true && !/data-n(renew|primary)/.test(byId("nd-actions").innerHTML) && byId("name-action-form").hidden === true);
  await byId("nav-names").click(); await flush();
  await nl().querySelectorAll("[data-name]").find((b) => b.dataset.name === "bob").click(); await flush();
  await byId("nd-actions").querySelectorAll("[data-nprimary]")[0].click(); await flush();
  await byId("btn-name-confirm").click(); await flush();
  check("6b honest: under the new account a fresh detail reviews and signs as that account", renewed.length === 1 && byId("msg").className.includes("err") === false && JSON.stringify(primaried.at(-1)) === JSON.stringify(["bob", HD2]));
}

console.log("7. token rows");
{
  const LONGEST = "ABCDEFGHIJKL";
  const { isTicker, formatUnits } = await import("../src/core/cairnx.ts");
  assets = { ok: true, names: [], nameDetails: [], primaryName: null, tipHeight: 1, balances: {
    CAIRN: { available: "150000000000", locked: "250000000000" }, [LONGEST]: { available: "1234567891", locked: "0" },
    BIGNUM: { available: "123456789012345678", locked: "0" }, ZERO: { available: "0", locked: "0" } } };
  await byId("btn-refresh").click(); await flush();
  const rows = String(byId("assets").innerHTML).split('<button class="w-row"').slice(1);
  const row = (t) => rows.find((r) => r.includes(`data-tsend="${t}"`)) || "";
  const tile = (t) => (/<span class="ti">(.*?)<\/span><span class="nm">/s.exec(row(t)) || [])[1] || "";
  const val = (t) => (/<span class="vl">(.*?)<\/span>/.exec(row(t)) || [])[1] || "";
  check(`7a the longest legal ticker (${LONGEST}: ${isTicker(LONGEST)}, 13 chars: ${isTicker(LONGEST + "M")}) is the whole title, and no tile carries a letter of a ticker`,
    isTicker(LONGEST) && !isTicker(LONGEST + "M") && row(LONGEST).includes(`<b>${LONGEST}</b>`) && Object.keys(assets.balances).every((t) => !/[A-Z]/.test(tile(t).replace(/<[^>]*>/g, ""))));
  check("7b no served token name shows; the pinned row says nothing more, the others Unverified",
    !rows.join("").includes("Cairn Official Token") && !rows.join("").includes("Abc deployer text") && !/Unverified/.test(row("CAIRN")) && /Unverified/.test(row(LONGEST)));
  const grouped = { CAIRN: "1,500", [LONGEST]: "1,234,567.891", BIGNUM: "123,456,789,012,345,678", ZERO: "0" };
  const dec = { CAIRN: 8, [LONGEST]: 3, BIGNUM: 0, ZERO: 2 };
  check(`7c amounts are grouped and every digit is formatUnits' (${Object.keys(grouped).map(val).join(" | ")})`,
    Object.entries(grouped).every(([t, g]) => val(t) === g && g.replace(/,/g, "") === formatUnits(assets.balances[t].available, dec[t])) && row("CAIRN").includes("2,500 locked in offers"));
  assets = null;
}

console.log("8. copy the account address");
{
  await byId("btn-copy").click(); await flush();
  check(`8a Copy copies the full raw address (${written.at(-1)})`, written.at(-1) === HD2 && byId("addr").textContent === HD2);
}

console.log("9. the send review's Name row");
{
  resolveAns = { ok: true, addr: PAID, verified: true, sources: 2, depth: 14, via: "owner" };
  await review("alice.csd");
  const name = String(byId("c-name").textContent);
  const badge = "Chain-backed, 2 name servers agree (same operator) (14 conf).";
  check(`9a the Name row is the name and the short address (${name})`, name === "alice.csd → 0x313131…3131 (via owner)");
  check("9b the badge sentence is in the name check row, word for word, once", rows().length === 1 && rows()[0].tier === "ok" && rows()[0].html.includes(badge) && !name.includes("Chain-backed"));
  check("9c the To address is grouped in fours and its text is the raw address", String(byId("c-to").innerHTML).replace(/<[^>]*>/g, "") === PAID && (String(byId("c-to").innerHTML).match(/<span>/g) || []).length === 10);
}

done("popup-checks-dom");
