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
// request is hidden or merged by CSS. The line under the buttons (#ap-state) says the latch holds both buttons, then,
// while the request does not end in view, names the recipient rows not fully shown, or says more is below, and
// otherwise whether Approve is live; it never moves the buttons or covers the request. Each paint is roomy (the approved
// design's sizes) only when the whole request fits in them, compact otherwise, and keeps its density from its first
// frame (W-3).
// RED-FIRST: with f700817's approval window (src/popup clearsign.ts, approve.ts, popup.css) 64 checks fail at this size
// (11 cases below the fold, 23 out of order, 30 with a leading ⚠); in its own 380 by 620 window, 26 cases fail the fold.
// Restore f700817's popup.css alone and 11 cases fail the fold; put a record's rows before the cost, the send's
// recipients before its cost, or the listing id first in the listing box, and the order check fails.
// RED-FIRST for the line: on e397906 (no line) 52 checks fail; drop its scroll listener and 4 fail, its MutationObserver
// 9, count every row instead of the recipient rows 6, its reserved height 2.
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
const LONG = "https://cairn-substrate.com.account-security-verification.session-renewal.wallet-support-desk.example";
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
  // a short balance from an origin that wraps the header: the note that lands after the paint has its room reserved
  ["send-short-long-origin", [req("ssl", "send", LONG, { to: RCPT, amount: 150_000_000, fee: 1_000_000 })], { balance: { confirmed: 50_000_000 } }, ["spendable balance does not cover", "cost"]],
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
  ["token-mint", [req("mi", "propose", O, prop(v.mint({ ticker: "TKN", amount: "100" })))], {}, ["cost"]],
  ["token-bid", [req("bi", "propose", O, prop(v.bid({ give: { value: "5000000000" }, want: { ticker: "TKN", amount: "4638" } })))], {}, ["cost"]],
  ["offer-cancel", [req("oc", "propose", O, prop(v.offerCancelAll({ ticker: "TKN" })))], {}, ["cost"]],
  ["token-meta", [req("tm", "propose", O, prop(v.tokenMeta({ ticker: "TKN", hash: "0x" + "ab".repeat(32) })))], {}, ["cost"]],
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
    // the recipients #send-warn names (a look-alike line also names what it resembles, which is not a recipient), or,
    // when the box only counts them, the recipient rows that carry a mark
    if (label.startsWith("warn:")) {
      const marked = [...new Set([...reqEl.querySelectorAll(".kv > div[data-to].flag")].map((r) => r.dataset.to))];
      return marked.length ? marked : [...new Set([...(document.getElementById("send-warn")?.querySelectorAll("code") ?? [])].filter((c) => !/resembles\s*$/.test(c.previousSibling?.textContent ?? "")).map((c) => c.textContent))];
    }
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
  // the line under the buttons: while the request does not end in view it names the recipient rows not fully in view,
  // otherwise it says whether Approve is live; it sits in the footer under the buttons, inside the window, so it covers
  // nothing
  const RCPT = new Set(["To", "Resolves to", "Paid to", "Only fillable by"]);
  const open = reqEl.scrollTop + reqEl.clientHeight < reqEl.scrollHeight - 1;
  const hiddenRcpt = [...reqEl.querySelectorAll(".kv > div")].filter((r) => RCPT.has(r.querySelector("dt")?.textContent ?? "") && r.getBoundingClientRect().bottom > reqEl.getBoundingClientRect().bottom + 0.5).length;
  const cueEl = document.getElementById("ap-state");
  const barBottom = Math.max(document.getElementById("btn-reject").getBoundingClientRect().bottom, document.getElementById("btn-approve").getBoundingClientRect().bottom);
  const sim = document.getElementById("token-sim");
  const approve = document.getElementById("btn-approve");
  const cue = { text: cueEl ? cueEl.textContent : null, open, hiddenRcpt, clear: !!cueEl && cueEl.getBoundingClientRect().top >= barBottom - 0.5 && cueEl.getBoundingClientRect().bottom <= innerHeight + 0.5,
    live: !approve.disabled, latched: document.getElementById("btn-reject").disabled, confirmStep: approve.textContent === "Sign anyway",
    tokenWait: !!sim && !/^Filling this debits/.test(sim.textContent) };
  // a look-alike is danger, a first send caution (owner decision 2026-10-25): each warning row's tier against its words
  const tiers = [...(document.getElementById("send-warn")?.querySelectorAll(".check") ?? [])].map((c) => {
    const tier = c.classList.contains("danger") ? "danger" : c.classList.contains("caution") ? "caution" : "other";
    const want = /address-poisoning/.test(c.textContent) ? "danger" : "caution";
    return { tier, ok: tier === want };
  });
  return { below, cue, late, marked, missing, tiers, lowest: lowest && { what: lowest.what, gap: Math.round(fold - lowest.bottom) }, scrollTop: reqEl.scrollTop, hiddenBr, lost };
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

// The line's words, written out here so a change to them fails this file (security copy: listed for the owner's sign-off).
const STATE = { arming: "Arming: both buttons wait 700 ms", ready: "Ready.", readyUnconfirmed: "Ready. Read the warning above before you sign.",
  held: "Approve is off: see the warning above.", tokenWait: "Approve waits for the token amount." };
const cueText = ({ open, hiddenRcpt, live, latched, confirmStep, tokenWait }) => latched ? STATE.arming
  : open ? (hiddenRcpt === 1 ? "1 more recipient below: scroll to see it" : hiddenRcpt > 1 ? `${hiddenRcpt} more recipients below: scroll to see them` : "More below: scroll to read the whole request")
  : live ? (confirmStep ? STATE.readyUnconfirmed : STATE.ready) : tokenWait ? STATE.tokenWait : STATE.held;
// W-3: the density each request paints in, from every frame since it first showed: one value means no jump on open and no
// shift after the latch arms. A roomy paint has the approved design's sizes and shows the whole request.
function recordFrames() {
  window.__frames = [];
  const tick = () => {
    const app = document.getElementById("app"), req = document.getElementById("req"), view = document.getElementById("view-req");
    if (app && req && view && !view.hidden && req.firstElementChild) window.__frames.push(app.dataset.density || "none");
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
const densityOf = () => {
  const app = document.getElementById("app"), req = document.getElementById("req");
  const cs = (el) => el && getComputedStyle(el);
  const amt = cs(req.querySelector(".ap-amt"));
  const oneLine = [...req.querySelectorAll(".kv > div")].find((r) => r.getClientRects().length && r.getBoundingClientRect().height < 45);
  const row = cs(req.querySelector(".kv > div"));
  const check = cs(req.querySelector(".check"));
  return { density: app.dataset.density, frames: [...new Set(window.__frames)], whole: req.scrollHeight <= req.clientHeight + 1,
    amount: amt && `${amt.fontSize} ${amt.fontWeight}`, row: row && `${row.fontSize} ${row.paddingTop}`, rowH: oneLine ? Math.round(oneLine.getBoundingClientRect().height) : null,
    check: check && `${check.fontSize} ${check.paddingTop} ${check.paddingLeft}` };
};
// The paints that must come out roomy (they fit the window whole with every mount at its tallest) and compact, at this
// size, which takes the largest frame seen; FULL_HEIGHT below repeats the common requests in the whole 716 px.
const ROOMY = new Set(["connect", "signin", "signin-mismatch", "seal", "propose-raw", "offer-cancel"]);
const COMPACT = new Set(["send-3-worst", "send-short-long-origin", "fill-unconfirmed", "queue", "name-nfinalize-underpaid", "name-ncommit"]);
const table = [];
try {
  // light, then dark: every check in both themes (a dark case is named "dark <case>")
  for (const theme of ["light", "dark"]) for (const [base_, queue, extra, expect, action] of CASES) {
    const name = theme === "light" ? base_ : `dark ${base_}`;
    const { page, ctx, errors } = await openWalletPage(browser, "approve", { ...base, pending: queue, ...extra }, { viewport: { width: WIDTH, height: INNER_H }, colorScheme: theme, init: recordFrames });
    try {
      await page.waitForSelector("#view-req:not([hidden])", { timeout: 10_000 });
      await settle(page);
      if (action === "approve") {
        await page.click("#btn-approve");
        await page.waitForFunction(() => document.getElementById("btn-approve").textContent === "Sign anyway", null, { timeout: 10_000 });
        await settle(page);
      }
      const r = await page.evaluate(measure, [expect, queue[0].origin]);
      if (theme === "light") table.push([name, r.lowest]);
      t.check(`${name}: what must render is there (missing: ${r.missing.join(", ") || "none"})`, r.missing.length === 0);
      t.check(`${name}: every element with weight is above the buttons, unscrolled (lowest: ${r.lowest?.what}, ${r.lowest?.gap} px above; below: ${r.below.join(", ") || "none"})`, r.below.length === 0 && r.scrollTop === 0);
      t.check(`${name}: the cost and the warnings come before the recipients and the rows without weight (late: ${r.late.join(", ") || "none"})`, r.late.length === 0);
      t.check(`${name}: no check row starts with a ⚠ mark (${r.marked})`, r.marked === 0);
      t.check(`${name}: each warning row has its tier, danger for a look-alike, caution for a first send (${r.tiers.map((x) => x.tier).join(",") || "none"})`, r.tiers.every((x) => x.ok));
      t.check(`${name}: the line under the buttons matches the latch and what is below the fold ("${r.cue.text}", ${r.cue.hiddenRcpt} recipient rows hidden) and covers nothing`, r.cue.text === cueText(r.cue) && r.cue.clear);
      t.check(`${name}: no <br> in the request is hidden (${r.hiddenBr}) and the text breaks at every one (${r.lost.join("; ") || "all kept"})`, r.hiddenBr === 0 && r.lost.length === 0);
      const d = await page.evaluate(densityOf);
      if (theme === "light") table.at(-1).push(d.density);
      // the confirm step is a second paint after a click, which decides again
      const one = action === "approve" ? d.frames.at(-1) === d.density : d.frames.length === 1 && d.frames[0] === d.density;
      t.check(`${name}: one density from the first frame that shows the request to the end (${d.frames.join(",")})`, one && (d.density === "roomy" || d.density === "compact"));
      if (d.density === "roomy") {
        t.check(`${name}: roomy shows the whole request and the approved sizes (amount ${d.amount}, row ${d.row}, one-line row ${d.rowH} px, check ${d.check})`,
          d.whole && (d.amount === null || d.amount === "36px 500") && (d.row === null || d.row === "13.5px 9px") && (d.rowH === null || d.rowH === 40) && (d.check === null || d.check === "12.5px 10px 12px"));
      }
      if (ROOMY.has(base_)) t.check(`${name}: paints roomy (${d.density})`, d.density === "roomy");
      if (COMPACT.has(base_)) t.check(`${name}: paints compact (${d.density})`, d.density === "compact");
      t.check(`${name}: no page error (${errors.join(" | ") || "none"})`, errors.length === 0);
    } finally {
      await ctx.close();
    }
  }

  // The common requests in a window with no frame (Linux draws none): the approved design's request, a send to a new
  // address, paints roomy; a balance that does not cover it lands in the room reserved for its note, so the paint stays
  // roomy and nothing moves (one density in every frame). RED-FIRST: return no reserves from reservesFor and
  // send-short-long-origin above paints roomy, and its balance note, landing after the paint, pushes its recipient past
  // the fold; return "compact" from chooseDensity and every roomy pin fails; decide the density a moment after the
  // paint and the one-density checks fail; drop the roomy row rule from popup.css and the size checks fail.
  console.log("full height:");
  for (const [name, queue, extra, want] of [
    ["send", [req("h1", "send", D, { to: RCPT, amount: 150_000_000, fee: 1_000_000 })], {}, "roomy"],
    ["send-poison", [req("h2", "send", D, { to: LOOK, amount: 150_000_000, fee: 1_000_000 })], seen, "roomy"],
    ["send-short", [req("h4", "send", D, { to: RCPT, amount: 150_000_000, fee: 1_000_000 })], { balance: { confirmed: 50_000_000 } }, "roomy"],
  ]) {
    const { page, ctx, errors } = await openWalletPage(browser, "approve", { ...base, pending: queue, ...extra }, { viewport: { width: WIDTH, height: APPROVE_WINDOW.height }, init: recordFrames });
    try {
      await page.waitForSelector("#view-req:not([hidden])", { timeout: 10_000 });
      await settle(page);
      const r = await page.evaluate(measure, [[], queue[0].origin]);
      const d = await page.evaluate(densityOf);
      t.check(`full height ${name}: paints ${want} (${d.density}), one density in every frame (${d.frames.join(",")})`, d.density === want && d.frames.length === 1 && d.frames[0] === want);
      t.check(`full height ${name}: the whole request in view, the approved sizes (amount ${d.amount}, row ${d.row}, one-line row ${d.rowH} px, check ${d.check})`,
        d.whole && d.amount === "36px 500" && d.row === "13.5px 9px" && d.rowH === 40 && (d.check === null || d.check === "12.5px 10px 12px"));
      t.check(`full height ${name}: everything with weight above the buttons (below: ${r.below.join(", ") || "none"})`, r.below.length === 0 && r.scrollTop === 0);
      t.check(`full height ${name}: no page error (${errors.join(" | ") || "none"})`, errors.length === 0);
    } finally {
      await ctx.close();
    }
  }

  // A request longer than the window: the line counts the hidden recipients, leaves the buttons where they are and
  // Approve armed, goes once the request is scrolled to its end, and comes back when the request grows.
  console.log("more below:");
  const many = (n) => sendTo(Array.from({ length: n }, (_, i) => ["0x" + (0x41 + i).toString(16).repeat(20), 10_000_000]));
  // where the buttons are and where the request area ends: neither moves when the line comes or goes
  const buttonsAt = (page) => page.evaluate(() => [document.getElementById("btn-reject").getBoundingClientRect().top, document.getElementById("btn-approve").getBoundingClientRect().top, document.getElementById("req").getBoundingClientRect().bottom]);
  let ordinary = null;
  // five recipients fit at this size; twelve from a look-alike origin long enough to wrap the header do not
  for (const [name, queue] of [["send-1", [req("m1", "send", D, { to: RCPT, amount: 150_000_000, fee: 1_000_000 })]], ["send-5", [req("m5", "send", D, many(5))]],
    ["send-12-long-origin", [req("m12o", "send", LONG, many(12))]], ["send-13", [req("m13", "send", D, many(13))]]]) {
    const { page, ctx, errors } = await openWalletPage(browser, "approve", { ...base, pending: queue }, { viewport: { width: WIDTH, height: INNER_H } });
    try {
      await page.waitForSelector("#view-req:not([hidden])", { timeout: 10_000 });
      await settle(page);
      const r = await page.evaluate(measure, [[], queue[0].origin]);
      const at = await buttonsAt(page);
      const approve = await page.evaluate(() => !document.getElementById("btn-approve").disabled);
      if (name === "send-1" || name === "send-5") {
        ordinary ??= at;
        t.check(`${name}: a request that ends in view says Approve is ready ("${r.cue.text}"), everything with weight above the buttons (below: ${r.below.join(", ") || "none"})`, !r.cue.open && r.cue.text === STATE.ready && r.below.length === 0 && at.join() === ordinary.join());
        continue;
      }
      t.check(`${name}: the line names the hidden recipients ("${r.cue.text}", ${r.cue.hiddenRcpt} rows not in view)`, r.cue.open && r.cue.hiddenRcpt > 0 && r.cue.text === cueText(r.cue));
      // scroll until the last recipient row is the only one not fully in view: the count follows the scroll
      const one = await page.evaluate(() => {
        const q = document.getElementById("req");
        const rows = [...q.querySelectorAll(".kv > div")].filter((r) => r.querySelector("dt")?.textContent === "To");
        q.scrollTop += rows.at(-2).getBoundingClientRect().bottom - q.getBoundingClientRect().bottom + 1;
        return new Promise((done) => setTimeout(() => done(document.getElementById("ap-state")?.textContent ?? null), 200));
      });
      t.check(`${name}: scrolled until one recipient row is left below, the line says so ("${one}")`, one === "1 more recipient below: scroll to see it");
      t.check(`${name}: the buttons and the end of the request area sit where an ordinary request has them (${at} vs ${ordinary}) and Approve is armed (${approve})`, at.join() === ordinary.join() && approve);
      await page.evaluate(() => { const q = document.getElementById("req"); q.scrollTop = q.scrollHeight; });
      await page.waitForTimeout(200);
      const end = await page.evaluate(() => document.getElementById("ap-state")?.textContent ?? null);
      t.check(`${name}: scrolled to its end, the line says Approve is ready ("${end}") and neither the buttons nor the request area moved`, end === STATE.ready && (await buttonsAt(page)).join() === ordinary.join());
      // content added under the end, as an async row does: the line comes back
      await page.evaluate(() => document.querySelector("#req > .req:not(.dim)").insertAdjacentHTML("beforeend", '<p class="ap-lede">added</p>'));
      await page.waitForTimeout(200);
      const back = await page.evaluate(() => document.getElementById("ap-state")?.textContent ?? null);
      t.check(`${name}: when the request grows past the end, the line comes back ("${back}")`, back === "More below: scroll to read the whole request");
      t.check(`${name}: no page error (${errors.join(" | ") || "none"})`, errors.length === 0);
    } finally {
      await ctx.close();
    }
  }

  // W-8: a site can send to hundreds of recipients. The engine signs up to 500 outputs on a send and 100 on a fill (the
  // 100 KB transaction cap would allow more; validateOutputs refuses them before signing), so those are the largest
  // requests that reach a signature. Every recipient is listed; the warning box counts past NAMED_WARNINGS and the
  // flagged rows carry the marks, so the cost, the balance after, every warning and what a fill buys stay above the
  // buttons, and the line names the recipient rows below. The first recipient is a look-alike of one paid before.
  // RED-FIRST: name every flagged recipient in the box (no NAMED_WARNINGS bound) and the 13, 20 and 500 cases fail the
  // fold; put the listing after the recipient rows and fill-100 fails it.
  // S5: whenever a request has more than one recipient row, each flagged row carries its mark (a tint and a bar), also
  // when the box names the flagged recipient by head and tail, and the mark adds no height.
  // RED-FIRST: mark rows only when the box counts (more than NAMED_WARNINGS flagged) and these checks fail.
  console.log("row marks:");
  {
    const r = req("mk", "send", D, sendTo([[RCPT, 10_000_000], [LOOK, 10_000_000], [RCPT, 20_000_000], [RCPT, 30_000_000]]));
    const { page, ctx, errors } = await openWalletPage(browser, "approve", { ...base, ...seen, pending: [r] }, { viewport: { width: WIDTH, height: INNER_H } });
    try {
      await page.waitForSelector("#view-req:not([hidden])", { timeout: 10_000 });
      await settle(page);
      const m = await page.evaluate(([look]) => {
        const rows = [...document.querySelectorAll("#req .kv > div[data-to]")];
        const flagged = rows.filter((x) => x.classList.contains("flag"));
        const h = (x) => Math.round(x.getBoundingClientRect().height);
        return { rows: rows.length, flagged: flagged.map((x) => [x.dataset.to === look, x.classList.contains("danger"), x.querySelector(".row-flag")?.textContent]), heights: [...new Set(rows.map(h))],
          named: !!document.getElementById("send-warn")?.querySelector("code") };
      }, [LOOK]);
      t.check(`row marks: one look-alike among four rows is named in the box and its row alone is marked danger (${JSON.stringify(m)})`,
        m.rows === 4 && m.named && m.flagged.length === 1 && m.flagged[0][0] && m.flagged[0][1] && m.flagged[0][2] === "Look-alike");
      t.check(`row marks: the marked row is as tall as the others (${m.heights.join(",")} px)`, m.heights.length === 1);
      t.check(`row marks: no page error (${errors.join(" | ") || "none"})`, errors.length === 0);
    } finally {
      await ctx.close();
    }
  }

  console.log("many recipients:");
  const addrN = (i) => "0x" + (0x5000 + i).toString(16).padStart(40, "0");
  const crowd = (n) => [[LOOK, 10_000_000], ...Array.from({ length: n - 1 }, (_, i) => [addrN(i), 10_000_000])];
  const RCPT_ROW = /^row (To|Resolves to|Paid to) /;
  for (const [name, n, r] of [["send-13", 13, req("w13", "send", D, sendTo(crowd(13)))], ["send-20", 20, req("w20", "send", D, sendTo(crowd(20)))],
    ["send-500", 500, req("w500", "send", D, sendTo(crowd(500)))], ["fill-100", 100, req("w100", "fillOffer", O, fill(crowd(100)))]]) {
    const { page, ctx, errors } = await openWalletPage(browser, "approve", { ...base, ...seen, fillOfferView: view, pending: [r] }, { viewport: { width: WIDTH, height: INNER_H } });
    try {
      await page.waitForSelector("#view-req:not([hidden])", { timeout: 20_000 });
      await settle(page);
      const m = await page.evaluate(measure, [["cost", "#send-warn", `warn:${n}`, `to:${n}`, ...(name.startsWith("fill") ? ["#fill-view"] : [])], r.origin]);
      const weightBelow = m.below.filter((w) => !RCPT_ROW.test(w));
      t.check(`${name}: the cost, the balance after, every warning${name.startsWith("fill") ? " and the listing" : ""} sit above the buttons, unscrolled (below, besides recipient rows: ${weightBelow.join(", ") || "none"})`, weightBelow.length === 0 && m.scrollTop === 0);
      t.check(`${name}: all ${n} recipients are listed and each is flagged (missing: ${m.missing.join(", ") || "none"})`, m.missing.length === 0);
      t.check(`${name}: the warning rows count, danger then caution, and name no recipient`, m.tiers.map((x) => x.tier).join() === "danger,caution" && m.tiers.every((x) => x.ok)
        && await page.evaluate(() => document.getElementById("send-warn").querySelectorAll("code").length === 0));
      t.check(`${name}: the line names the recipient rows below ("${m.cue.text}", ${m.cue.hiddenRcpt} rows not in view)`, m.cue.open && m.cue.hiddenRcpt > 0 && m.cue.text === cueText(m.cue) && m.cue.clear);
      t.check(`${name}: no page error (${errors.join(" | ") || "none"})`, errors.length === 0);
    } finally {
      await ctx.close();
    }
  }

  // The queue advances while the request is scrolled to its end (the user read it, then rejected): the next request
  // must open at its top, with its amount, fee and warnings in view and the line counting its own hidden rows.
  console.log("queue advance:");
  {
    const first = req("q1", "send", D, many(13)), second = req("q2", "send", LONG, many(13));
    const { page, ctx, errors } = await openWalletPage(browser, "approve", { ...base, pending: [first, second] }, { viewport: { width: WIDTH, height: INNER_H } });
    try {
      await page.waitForSelector("#view-req:not([hidden])", { timeout: 10_000 });
      await settle(page);
      await page.evaluate(() => { const q = document.getElementById("req"); q.scrollTop = q.scrollHeight; });
      const scrolled = await page.evaluate(() => document.getElementById("req").scrollTop);
      // the background resolved the first request: the 1.2 s poll now reads a queue holding only the second
      await page.evaluate((next) => {
        const send = chrome.runtime.sendMessage;
        chrome.runtime.sendMessage = (m, cb) => m.method === "pending" ? setTimeout(() => cb({ ok: true, result: [next] }), 5) : send(m, cb);
      }, second);
      await page.waitForFunction(() => document.getElementById("app")?.textContent.includes("account-security-verification"), null, { timeout: 5_000 });
      await settle(page);
      const r = await page.evaluate(measure, [[], second.origin]);
      const amountTop = await page.evaluate(() => {
        const q = document.getElementById("req"), a = q.querySelector(".ap-amt");
        return a ? Math.round(a.getBoundingClientRect().top - q.getBoundingClientRect().top) : null;
      });
      t.check(`queue advance: the next request opens at its top (scrollTop ${r.scrollTop}, was ${scrolled}) with its amount in view (${amountTop} px below the area's top)`, scrolled > 0 && r.scrollTop === 0 && amountTop !== null && amountTop >= 0);
      t.check(`queue advance: the line counts the next request's hidden recipients ("${r.cue.text}")`, r.cue.open && r.cue.hiddenRcpt > 0 && r.cue.text === cueText(r.cue));
      t.check(`queue advance: no page error (${errors.join(" | ") || "none"})`, errors.length === 0);
    } finally {
      await ctx.close();
    }
  }

  // W-10: a request painted into the open window enters as the approved design's body does (320 ms, rising 8 px; a
  // crossfade with reduced motion), and the line under the buttons says the latch holds both, then that Approve is
  // ready. RED-FIRST: drop enterBody() from render() and the entrance checks fail; drop the arming branch in
  // updateState and the first line check fails.
  console.log("new request:");
  for (const reducedMotion of ["no-preference", "reduce"]) {
    const a = req("n1", "connect", D, {}), b = req("n2", "send", D, { to: RCPT, amount: 150_000_000, fee: 1_000_000 });
    const { page, ctx, errors } = await openWalletPage(browser, "approve", { ...base, pending: [a, b] }, { viewport: { width: WIDTH, height: INNER_H }, reducedMotion });
    try {
      await page.waitForSelector("#view-req:not([hidden])", { timeout: 10_000 });
      await settle(page);
      const ready = await page.evaluate(() => document.getElementById("ap-state").textContent);
      await page.evaluate((next) => {
        const send = chrome.runtime.sendMessage;
        chrome.runtime.sendMessage = (m, cb) => m.method === "pending" ? setTimeout(() => cb({ ok: true, result: [next] }), 5) : send(m, cb);
      }, b);
      const at = await page.waitForFunction(() => {
        const q = document.getElementById("req");
        if (!q.querySelector(".ap-amt")) return null;
        const an = q.getAnimations()[0];
        const k = an?.effect?.getKeyframes() ?? [];
        return { line: document.getElementById("ap-state").textContent, rejectOff: document.getElementById("btn-reject").disabled,
          duration: an?.effect?.getTiming().duration ?? null, moves: k.some((f) => f.transform && f.transform !== "none"), fades: Number(k[0]?.opacity) === 0 };
      }, null, { timeout: 5_000, polling: "raf" }).then((h) => h.jsonValue());
      await settle(page);
      const after = await page.evaluate(() => document.getElementById("ap-state").textContent);
      const tag = reducedMotion === "reduce" ? "reduced motion" : "motion";
      t.check(`${tag}: before the new request the line says Approve is ready ("${ready}")`, ready === STATE.ready);
      t.check(`${tag}: the new request's first frame: the line says the latch holds both buttons ("${at.line}", Reject off ${at.rejectOff})`, at.line === STATE.arming && at.rejectOff);
      t.check(`${tag}: the request body enters over 320 ms from transparent (${at.duration} ms, fades ${at.fades})`, at.duration === 320 && at.fades);
      t.check(`${tag}: ${reducedMotion === "reduce" ? "a crossfade, no movement" : "it rises as it enters"} (moves ${at.moves})`, at.moves === (reducedMotion !== "reduce"));
      t.check(`${tag}: once armed the line says Approve is ready ("${after}")`, after === STATE.ready);
      t.check(`${tag}: no page error (${errors.join(" | ") || "none"})`, errors.length === 0);
    } finally {
      await ctx.close();
    }
  }
} finally {
  await browser.close();
}
console.log("\nfold table (lowest element with weight, px above the fold; negative is below; the paint's density):");
for (const [name, l, density] of table) console.log(`  ${name.padEnd(28)} ${String(l?.gap).padStart(5)}  ${String(density).padEnd(8)} ${l?.what}`);
t.done("approve-layout-chrome");
