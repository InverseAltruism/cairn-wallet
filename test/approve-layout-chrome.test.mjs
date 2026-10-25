// What the approval window shows before a signature, at its real size and scrolled to the top, for every request type
// and for the worst cases a site can build: every element with security weight sits fully above the top of Reject and
// Approve, so nothing that decides the signature needs a scroll. Weight, as this test reads it from what renders: the
// requesting origin and the signer in the header, the queue line, the amount, the cost block (fee, total, balance after
// and its note), every check row (danger, caution, positive) and refusal span in the request, every recipient row with
// its amount and the other money rows (WEIGHT_ROWS), what a fill's listing gives and its expiry, the token debit quote
// (#token-sim), the secret a reveal publishes (#reveal-preview) and a name action's verdict (#nfin-note). Offer and
// listing ids, attestations, payload hashes, expiry epochs and raw record fields have no weight and may sit below.
// The page is measured at APPROVE_WINDOW (the size background.ts opens) less APPROVE_FRAME_PX for the browser's frame.
// Each case also names what must render, so a missing row cannot pass as "not below"; check rows carry their tier in
// the icon and tint, with no leading ⚠; the cost and the warnings come before the first recipient and the cost before
// any row without weight, so a request a site makes longer than the window keeps them in view; and no <br> inside the
// request is hidden or merged by CSS.
// RED-FIRST: with f700817's approval window (src/popup clearsign.ts, approve.ts, popup.css) 64 checks fail at this size
// (11 cases below the fold, 23 out of order, 30 with a leading ⚠); in its own 380 by 620 window, 26 cases fail the fold.
// Restore f700817's popup.css alone and 11 cases fail the fold; put a record's rows before the cost, the send's
// recipients before its cost, or the listing id first in the listing box, and the order check fails.
// Needs playwright-core (PLAYWRIGHT_CORE) and a Chromium (PLAYWRIGHT_CHROMIUM); prints SKIP without them.
import * as cx from "../src/core/cairnx.ts";
import * as v from "../src/vendor/cairnx-spv.js";
import { APPROVE_FRAME_PX, APPROVE_WINDOW } from "../src/approve-window.ts";
import { checker } from "./helpers/check.mjs";
import { launchOrSkip, openWalletPage } from "./helpers/walletpage.mjs";

const INNER_H = APPROVE_WINDOW.height - APPROVE_FRAME_PX;
const WIDTH = APPROVE_WINDOW.width;
const browser = await launchOrSkip();
if (!browser) process.exit(0);
const t = checker(`approval window layout in Chrome (${WIDTH} by ${INNER_H})`);

const ME = "0x" + "7a3f9c21".repeat(5);
const RCPT = "0x" + "31".repeat(20);
const R2 = "0x" + "32".repeat(20);
const R3 = "0x" + "33".repeat(20);
const LOOK = "0x313131" + "9".repeat(30) + "3131";
const O = "https://cairn-substrate.com";
const D = "https://dapp.example";
const T = cx.TREASURY_ADDR;
const pick = (b) => ({ uri: b.uri, payloadHash: b.payloadHash });
const prop = (rec, extra = {}) => ({ domain: cx.CAIRNX_DOMAIN, ...pick(rec), fee: 25_000_000, expiresEpoch: 4_100, ...extra });
const nfinTip = 117_000 + v.REG_COMMIT_MAX_BLOCKS + v.FINALIZE_TIP_MARGIN + 5;
const PID = "0x" + "cd".repeat(32);
const req = (id, method, origin, params) => ({ id, method, origin, params });
const sendTo = (outs, fee = 1_000_000) => ({ outputs: outs.map(([to, value]) => ({ to, value })), fee });
const fill = (outs, extra = {}) => ({ proposalId: PID, outputs: outs.map(([to, value]) => ({ to, value })), fee: 1_000_000, score: 100, confidence: 100, ...extra });

const view = { ok: true, giveTicker: "CAIRN", giveAmount: "100000000", giveDecimals: 8, expiresAt: nfinTip + 300 };
// a reservation of a listing (the claim lane) whose expiry is too close to mine: the longest listing block
const viewReserved = { ok: true, offerId: "0x" + "ab".repeat(32), giveName: "satoshi", expiresAt: nfinTip + 2 };
const quote = { ok: true, ticker: "CAIRN", amount: "150000000000", fee: "1500000000", total: "151500000000", wantDecimals: 8, giveName: "quay", expiresAt: nfinTip + 300 };
const seen = { history: [{ type: "send", to: RCPT, amount: 1, txid: "0x" + "a1".repeat(32) }] };
const unconfirmed = { resolve: { ok: false, code: "RESERVATION_UNCONFIRMED", error: "reservation unconfirmed", unconfirmed: { fclaimTxid: "0x" + "f1".repeat(32), fclaimHeight: nfinTip - 3, tipHeight: nfinTip } } };

// [name, the queue, extra answers, what must render (each is also weight, so above the buttons), an action]
const CASES = [
  ["connect", [req("c", "connect", O, {})], {}, ["origin", "cost"]],
  ["signin", [req("s", "signinWithCsd", O, { nonce: "n0nce-7f3a9c21e5b84d10", statement: "Sign in to Cairn", expirationSecs: 600, uri: `${O}/trade` })], {}, ["origin", "cost"]],
  ["signin-mismatch", [req("s2", "signinWithCsd", D, { nonce: "abc123", domain: "cairn-substrate.com" })], {}, ["This page asked to sign in as", "cost"]],
  ["send", [req("s1", "send", D, { to: RCPT, amount: 150_000_000, fee: 1_000_000 })], {}, ["First time sending to", "to:1", "cost"]],
  ["send-poison", [req("sp", "send", D, { to: LOOK, amount: 150_000_000, fee: 1_000_000 })], seen, ["Possible address-poisoning", "to:1", "cost"]],
  ["send-2", [req("s2r", "send", D, sendTo([[RCPT, 100_000_000], [R2, 200_000_000]]))], {}, ["warn:2", "to:2", "cost"]],
  ["send-3", [req("s3", "send", D, sendTo([[RCPT, 100_000_000], [R2, 200_000_000], [R3, 300_000_000]]))], {}, ["warn:3", "to:3", "cost"]],
  // the worst send: three recipients, one a look-alike, a fee past the warning line, and a balance that does not cover it
  ["send-3-worst", [req("s3w", "send", D, sendTo([[LOOK, 100_000_000], [R2, 200_000_000], [R3, 300_000_000]], 600_000_000))], { ...seen, balance: { confirmed: 50_000_000 } }, ["Possible address-poisoning", "warn:3", "to:3", "unusually large fee", "spendable balance does not cover", "cost"]],
  ["send-short", [req("ss", "send", D, { to: RCPT, amount: 150_000_000, fee: 1_000_000 })], { balance: { confirmed: 50_000_000 } }, ["spendable balance does not cover", "cost"]],
  ["token-send", [req("tx", "propose", O, prop(cx.buildTransfer({ ticker: "CAIRN", amount: "1500000000", to: RCPT })))], {}, ["First time sending tokens to", "to:1", "cost"]],
  ["token-send-lookalike-ticker", [req("tx2", "propose", O, prop(cx.buildTransfer({ ticker: "USDT", amount: "1500000000", to: RCPT })))], { tokenDisplayMeta: { USDT: { decimals: 6 } } }, ["well-known or Cairn-like ticker", "First time sending tokens to", "cost"]],
  ["fill-csd", [req("f1", "fillOffer", O, fill([[RCPT, 250_000_000], [T, 3_750_000]]))], { fillOfferView: view }, ["#fill-view", "First time sending to", "to:2", "cost"]],
  ["fill-partial-reserved", [req("f2", "fillOffer", O, fill([[RCPT, 50_000_000], [T, 750_000]]))], { fillOfferView: viewReserved }, ["#fill-view", "the wallet will refuse this fill", "to:2", "cost"]],
  // a two-recipient CSD fill whose listing does not load: both first-time warnings and the listing failure
  ["fill-2-nolisting", [req("f3", "fillOffer", O, fill([[RCPT, 500_000_000], ["0x" + "34".repeat(20), 7_500_000]], { fee: 5_000_000 }))], {}, ["Could not load this listing", "warn:2", "to:2", "cost"]],
  ["fill-token", [req("ft", "fillOffer", O, fill([], { confidence: cx.CONF_TOKEN_FILL }))], { tokenFillQuote: quote }, ["Token-priced fill", "#token-sim", "cost"]],
  ["fill-token-noquote", [req("ft2", "fillOffer", O, fill([], { confidence: cx.CONF_TOKEN_FILL }))], {}, ["Token-priced fill", "Could not compute the token debit", "cost"]],
  ["fill-unconfirmed", [req("fu", "fillOffer", O, fill([[RCPT, 250_000_000], [T, 3_750_000]]))], { fillOfferView: view, ...unconfirmed }, ["second source has no record", "#fill-view", "to:2", "cost"], "approve"],
  ["attest-token", [req("at", "attest", O, { proposalId: PID, score: 100, confidence: cx.CONF_TOKEN_FILL, fee: 1_000_000 })], { tokenFillQuote: quote }, ["Token-priced fill", "#token-sim", "cost"]],
  ["propose-outputs", [req("po", "propose", D, { domain: "csd:apps", payloadHash: "0x" + "77".repeat(32), uri: `${D}/p/42`, fee: 25_000_000, outputs: [{ to: RCPT, value: 100_000_000 }, { to: R2, value: 200_000_000 }] })], {}, ["transfers funds out of your wallet", "warn:2", "to:2", "cost"]],
  ["propose-deploy", [req("pd", "propose", O, prop(v.deploy({ ticker: "TKN", decimals: 8, supply: "2100000000000000", mint: "open", mintLimit: "100000000" }), { outputs: [{ to: T, value: Number(v.DEPLOY_FEE) }] }))], {}, ["transfers funds out of your wallet", "to:1", "cost"]],
  ["propose-raw", [req("pr", "propose", D, { domain: "csd:apps", payloadHash: "0x" + "77".repeat(32), uri: `${D}/p/42`, fee: 25_000_000 })], {}, ["origin", "cost"]],
  ["offer-payto", [req("of", "propose", O, prop(v.offer({ give: { name: "alice" }, want: { value: "500000000", payto: R2 } })))], {}, ["First time using this payout address", "cost"]],
  ["seal", [req("sl", "sealClaim", O, { domain: "csd:sealed", claim: "ETH > $4000 by Friday", fee: 25_000_000 })], {}, ["cost"]],
  ["reveal", [req("rv", "revealClaim", O, "0x" + "5e".repeat(32))], {}, ["#reveal-preview", "cost"]],
  ["reveal-missing", [req("rv2", "revealClaim", O, "0x" + "5f".repeat(32))], {}, ["holds <no> sealed claim", "cost"]],
  ["name-ncommit", [req("nc", "propose", O, prop(v.nameCommitRecord({ commit: v.nameCommit("satoshi", "a1".repeat(16), ME) })))], {}, ["cost"]],
  ["name-reserve", [req("nr", "propose", O, prop(v.nameClaim({ name: "satoshi", salt: "a1".repeat(16) })))], {}, ["cost"]],
  ["name-nfinalize", [req("nf", "propose", O, prop(v.nameFinalize({ name: "satoshi", salt: "a1".repeat(16) }), { outputs: [{ to: T, value: 500_000_000 }] }))], {}, ["transfers funds out of your wallet", "#nfin-note", "cost"]],
  ["name-nfinalize-underpaid", [req("nfu", "propose", O, prop(v.nameFinalize({ name: "satoshi", salt: "a1".repeat(16) }), { outputs: [{ to: T, value: 1 }] }))], {}, ["is below the current price", "#nfin-note", "cost"]],
  ["name-nrenew", [req("nn", "propose", O, prop(cx.buildNameRenew({ name: "alice" }), { outputs: [{ to: T, value: 1_500_000_000 }] }))], {}, ["#nfin-note", "cost"]],
  ["name-nrenew-underpaid", [req("nnu", "propose", O, prop(cx.buildNameRenew({ name: "alice" }), { outputs: [{ to: T, value: 1 }] }))], {}, ["is below the current price", "#nfin-note", "cost"]],
  ["name-nset", [req("ns", "propose", O, prop(cx.buildNameSet({ name: "alice", addr: LOOK })))], seen, ["Possible address-poisoning", "#nfin-note", "Resolves to", "cost"]],
  ["name-nset-unpoint", [req("ns0", "propose", O, prop(cx.buildNameSet({ name: "alice", addr: "0x" + "0".repeat(40) })))], {}, ["#nfin-note", "cost"]],
  ["name-nxfer", [req("nx", "propose", O, prop(cx.buildNameXfer({ name: "alice", to: RCPT })))], {}, ["First time transferring a name to", "to:1", "cost"]],
  ["name-nprofile", [req("np", "propose", O, prop(cx.buildNameProfile({ name: "alice", profile: { bio: "builder", url: "https://example.org", wallet: RCPT } })))], {}, ["is cosmetic text", "cost"]],
  ["reserve-legacy", [req("rs", "attest", O, { proposalId: "0x" + "ef".repeat(32), score: 50, confidence: 0, fee: 1_000_000 })], { tipFloor: cx.V28_HEIGHT + 10 }, ["legacy reservation type is", "cost"]],
  ["reserve-fclaim", [req("fc", "propose", O, prop(v.fclaim({ offer: "0x" + "ab".repeat(32) })))], {}, ["cost"]],
  ["queue", [req("q1", "send", D, sendTo([[RCPT, 100_000_000], [R2, 200_000_000], [R3, 300_000_000]])), req("q2", "connect", D, {}), req("q3", "send", D, { to: RCPT, amount: 1, fee: 1_000_000 })], {}, ["Request 1 of 3", "warn:3", "to:3", "cost"]],
];

const base = {
  status: { hasVault: true, unlocked: true, addr: ME, active: 0, accounts: [{ addr: ME, label: "Main" }], tradeApi: "https://x.invalid" },
  balance: { confirmed: 128_473_500_000 }, history: [], tokenDisplayMeta: { CAIRN: { decimals: 8, deployId: cx.PINNED_TOKENS.CAIRN.deployId } },
  epoch: Math.floor(nfinTip / 30), tip: nfinTip, tipFloor: 0, sealedClaims: [{ txid: "0x" + "5e".repeat(32), domain: "csd:sealed", claim: "ETH > $4000 by Friday, as posted on the board at noon UTC" }],
};

// Runs in the page once the request has settled. `gap` is the distance from the lowest element with weight to the fold
// (the top of the buttons, or the bottom of the scroll area when that is higher); negative is below it.
function measure([expect, origin]) {
  const reqEl = document.getElementById("req");
  const barTop = Math.min(document.getElementById("btn-reject").getBoundingClientRect().top, document.getElementById("btn-approve").getBoundingClientRect().top);
  const fold = Math.min(reqEl.getBoundingClientRect().bottom, barTop, innerHeight);
  const shown = (el) => !!el && el.getClientRects().length > 0 && el.getBoundingClientRect().height > 0;
  const WEIGHT_ROWS = new Set(["To", "Resolves to", "Paid to", "Only fillable by", "You receive", "Amount", "Token", "Give", "Want", "Bidding", "For", "Name", "Claim"]);
  const weight = [];
  const add = (el, what) => { if (shown(el)) weight.push([el, what]); };
  add(document.getElementById("ap-origin"), "origin");
  add(document.getElementById("ap-signer"), "signer");
  const q = reqEl.querySelector(":scope > .req.dim");
  if (q && /^Request 1 of/.test(q.textContent)) add(q, "queue line");
  for (const el of reqEl.querySelectorAll(".ap-amt")) add(el, "amount");
  add(document.getElementById("cost"), "cost block");
  for (const el of reqEl.querySelectorAll(".check")) add(el, `check "${el.textContent.trim().slice(0, 32)}"`);
  for (const el of reqEl.querySelectorAll(".err")) add(el, `refusal "${el.textContent.trim().slice(0, 32)}"`);
  for (const row of reqEl.querySelectorAll(".kv > div")) {
    const dt = row.querySelector("dt")?.textContent ?? "";
    if (WEIGHT_ROWS.has(dt)) add(row, `row ${dt} "${row.querySelector("dd")?.textContent.slice(0, 20)}"`);
  }
  for (const id of ["token-sim", "reveal-preview", "nfin-note", "send-warn"]) add(document.getElementById(id), "#" + id);
  // the listing a fill buys: what it gives (a row above), a failed read (a check row above) and the offer's expiry
  for (const el of reqEl.querySelectorAll("#fill-view > .ap-lede")) if (/^Offer expire/.test(el.textContent)) add(el, "listing expiry");
  let lowest = null;
  for (const [el, what] of weight) {
    const b = el.getBoundingClientRect().bottom;
    if (!lowest || b > lowest.bottom) lowest = { what, bottom: b };
  }
  const below = weight.filter(([el]) => el.getBoundingClientRect().bottom > fold + 0.5).map(([, what]) => what);
  const marked = [...reqEl.querySelectorAll(".check > div")].filter((d) => /^\s*⚠/.test(d.textContent)).length;
  // Weight first, so a request a site makes longer than the window still shows the cost and every warning: the cost
  // block, the first-time and look-alike warnings, a name action's verdict and the balance note all come before the
  // first recipient row in the page,
  const firstRcpt = [...reqEl.querySelectorAll(".kv > div")].find((r) => ["To", "Resolves to", "Paid to"].includes(r.querySelector("dt")?.textContent));
  const short = [...reqEl.querySelectorAll(".check")].find((c) => /spendable balance does not cover/.test(c.textContent));
  const late = !firstRcpt ? [] : [["cost", document.getElementById("cost")], ["#send-warn", document.getElementById("send-warn")], ["#nfin-note", document.getElementById("nfin-note")], ["balance note", short]]
    .filter(([, el]) => shown(el) && !(el.compareDocumentPosition(firstRcpt) & Node.DOCUMENT_POSITION_FOLLOWING)).map(([what]) => what);
  // and the cost comes before every row without weight (ids, hashes, a site's text), whose length a site controls
  const firstPlain = [...reqEl.querySelectorAll(".kv > div")].find((r) => !r.closest("#cost, #fill-view, #token-sim, #reveal-preview") && !WEIGHT_ROWS.has(r.querySelector("dt")?.textContent ?? ""));
  const cost = document.getElementById("cost");
  if (firstPlain && !(cost.compareDocumentPosition(firstPlain) & Node.DOCUMENT_POSITION_FOLLOWING)) late.push(`cost after "${firstPlain.querySelector("dt").textContent}"`);
  // inside the listing box, the listing id (a reservation's) comes after what the listing gives and its expiry
  const box = document.getElementById("fill-view");
  const listing = [...(box?.querySelectorAll(".kv > div") ?? [])].find((r) => r.querySelector("dt")?.textContent === "Listing");
  const boxWeight = [...(box?.querySelectorAll(".kv > div, .ap-lede, .check") ?? [])].filter((el) => el.querySelector("dt")?.textContent === "You receive" || /^Offer expire/.test(el.textContent) || el.matches(".check"));
  if (listing && boxWeight.some((el) => !(listing.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_PRECEDING))) late.push("listing id before what the listing gives");

  // what must render
  const find = (label) => {
    if (label === "origin") { const o = document.getElementById("ap-origin"); return o && o.textContent === origin ? [o] : []; }
    if (label === "cost") return [document.getElementById("cost")];
    if (label.startsWith("#")) return [document.getElementById(label.slice(1))];
    if (label.startsWith("to:")) return [...reqEl.querySelectorAll(".kv > div")].filter((r) => r.querySelector("dt")?.textContent === "To");
    // the recipients #send-warn names (a look-alike line also names what it resembles, which is not a recipient)
    if (label.startsWith("warn:")) return [...new Set([...(document.getElementById("send-warn")?.querySelectorAll("code") ?? [])].filter((c) => !/resembles\s*$/.test(c.previousSibling?.textContent ?? "")).map((c) => c.textContent))];
    if (label === "Resolves to") return [...reqEl.querySelectorAll(".kv > div")].filter((r) => r.querySelector("dt")?.textContent === label);
    const words = label.replace(/[<>]/g, "");
    const walker = document.createTreeWalker(reqEl, NodeFilter.SHOW_ELEMENT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) if (n.matches(".check, .err, .ap-box, .kv > div, .req.dim") && n.textContent.replace(/\s+/g, " ").includes(words)) return [n];
    return [];
  };
  const missing = [];
  for (const label of expect) {
    const els = find(label);
    const want = /^(to|warn):(\d+)$/.exec(label);
    if (want) { if (els.length !== Number(want[2])) missing.push(`${label} (found ${els.length})`); continue; }
    if (!els.length || !els.every((el) => shown(el))) missing.push(label);
  }

  // every <br> of the describe block ends a line in what is shown (CSS that hides or merges lines changes the meaning)
  const hiddenBr = [...reqEl.querySelectorAll("br")].filter((b) => getComputedStyle(b).display === "none").length;
  const desc = [...reqEl.children].find((k) => k.classList.contains("req") && !k.classList.contains("dim"));
  let text = "";
  const walk = (node) => {
    for (const c of node.childNodes) {
      if (c.nodeType === 3) text += c.textContent;
      else if (c.nodeName === "BR") text += "\n";
      else if (c.nodeType === 1 && getComputedStyle(c).display !== "none") walk(c);
    }
  };
  if (desc) walk(desc);
  const squeeze = (s) => s.replace(/[^\S\n]+/g, "");
  const segs = squeeze(text).split("\n").filter(Boolean);
  let flat = "";
  const breakAt = new Set();
  for (const ch of desc ? squeeze(desc.innerText) : "") {
    if (ch === "\n") breakAt.add(flat.length);
    else flat += ch;
  }
  const lost = [];
  let at = 0;
  for (let i = 0; i < segs.length; i++) {
    const found = flat.indexOf(segs[i], at);
    if (found === -1) { lost.push(`"${segs[i].slice(0, 24)}" not shown`); break; }
    let broke = false;
    for (let k = at; k <= found; k++) if (breakAt.has(k)) broke = true;
    if (i > 0 && !broke) lost.push(`no break before "${segs[i].slice(0, 24)}"`);
    at = found + segs[i].length;
  }
  return { below, late, marked, missing, lowest: lowest && { what: lowest.what, gap: Math.round(fold - lowest.bottom) }, scrollTop: reqEl.scrollTop, hiddenBr, lost };
}

// Wait until Reject is armed, every mount the request carries is painted (the listing, the token quote, the reveal
// preview) and the request has not changed for 400 ms (the warnings and a name action's verdict land after the arm).
const settle = (page) => page.evaluate(() => new Promise((done) => {
  let last = performance.now();
  const mo = new MutationObserver(() => { last = performance.now(); });
  mo.observe(document.getElementById("req"), { subtree: true, childList: true, characterData: true, attributes: true });
  const start = performance.now();
  const tick = () => {
    const armed = !document.getElementById("btn-reject").disabled
      && !["fill-view", "token-sim", "reveal-preview"].some((id) => document.getElementById(id)?.hidden);
    if ((armed && performance.now() - last > 400) || performance.now() - start > 9000) { mo.disconnect(); done(); } else setTimeout(tick, 50);
  };
  tick();
}));

const table = [];
try {
  for (const [name, queue, extra, expect, action] of CASES) {
    const { page, ctx, errors } = await openWalletPage(browser, "approve", { ...base, pending: queue, ...extra }, { viewport: { width: WIDTH, height: INNER_H } });
    try {
      await page.waitForSelector("#view-req:not([hidden])", { timeout: 10_000 });
      await settle(page);
      if (action === "approve") {
        await page.click("#btn-approve");
        await page.waitForFunction(() => document.getElementById("btn-approve").textContent === "Sign anyway", null, { timeout: 10_000 });
        await settle(page);
      }
      const r = await page.evaluate(measure, [expect, queue[0].origin]);
      table.push([name, r.lowest]);
      t.check(`${name}: what must render is there (missing: ${r.missing.join(", ") || "none"})`, r.missing.length === 0);
      t.check(`${name}: every element with weight is above the buttons, unscrolled (lowest: ${r.lowest?.what}, ${r.lowest?.gap} px above; below: ${r.below.join(", ") || "none"})`, r.below.length === 0 && r.scrollTop === 0);
      t.check(`${name}: the cost and the warnings come before the recipients and the rows without weight (late: ${r.late.join(", ") || "none"})`, r.late.length === 0);
      t.check(`${name}: no check row starts with a ⚠ mark (${r.marked})`, r.marked === 0);
      t.check(`${name}: no <br> in the request is hidden (${r.hiddenBr}) and the text breaks at every one (${r.lost.join("; ") || "all kept"})`, r.hiddenBr === 0 && r.lost.length === 0);
      t.check(`${name}: no page error (${errors.join(" | ") || "none"})`, errors.length === 0);
    } finally {
      await ctx.close();
    }
  }
} finally {
  await browser.close();
}
console.log("\nfold table (lowest element with weight, px above the fold; negative is below):");
for (const [name, l] of table) console.log(`  ${name.padEnd(28)} ${String(l?.gap).padStart(5)}  ${l?.what}`);
t.done("approve-layout-chrome");
