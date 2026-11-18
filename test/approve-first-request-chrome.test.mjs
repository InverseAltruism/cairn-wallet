// The new-site line and the reveal card's sealing site in the approval window at its real size in Chrome, at both
// window heights. The line shares the header's ask line, so it costs the request no height: for the longest line (a
// connect) and the heaviest requests (the longest header, the most warnings, a queue) the window with the line has the
// ask on one line within its width, the header, the buttons and the density where they are without it, and everything
// with weight above the buttons (test/helpers/approve-measure.mjs `measure`). The reveal card, in both themes: the
// sealing site and the asking site the same (no caution); another site beside the longest claim and domain, and the
// longest asking origin (the caution and the claim above the buttons); a seal made in this wallet; a record that does
// not name the site. A 253-character sealing host with the longest asking origin, claim and domain does not fit: the
// caution comes first and stays above the buttons, and the line under them says more is below.
// Its own file because test/approve-layout-chrome.test.mjs already takes most of the runner's 180 s per-file cap.
//   RED-FIRST (2026-11-18, in a disposable worktree): a line of its own (18.6 px) on every request fails 8 checks of
//   test/approve-layout-chrome.test.mjs (fill-unconfirmed, name-nfinalize-underpaid and the profile row below the fold,
//   propose-raw no longer roomy) and 26 here: the header height and the line's words in all 12 header cases each,
//   name-nfinalize-underpaid's recipient below the fold, one density. Copy too long for one line ("A site you have never
//   approved anything from, which asks ...") fails the same 26. Drop the other-site caution (clearsign.ts sealedBy)
//   and 32 reveal checks fail.
// Needs playwright-core (PLAYWRIGHT_CORE) and a Chromium (PLAYWRIGHT_CHROMIUM); prints SKIP without them.
import * as cx from "../src/core/cairnx.ts";
import * as v from "../src/vendor/cairnx-spv.js";
import { APPROVE_FRAME_PX, APPROVE_WINDOW } from "../src/approve-window.ts";
import { checker } from "./helpers/check.mjs";
import { launchOrSkip, openWalletPage } from "./helpers/walletpage.mjs";
import { measure, settle, windowFixed, buttonsAt } from "./helpers/approve-measure.mjs";

const INNER_H = APPROVE_WINDOW.height - APPROVE_FRAME_PX;
const WIDTH = APPROVE_WINDOW.width;
const browser = await launchOrSkip();
if (!browser) process.exit(0);
const t = checker(`the new-site line and the sealing site in Chrome (${WIDTH} by ${INNER_H} and ${APPROVE_WINDOW.height})`);

const ME = "0x" + "7a3f9c21".repeat(5);
const RCPT = "0x" + "31".repeat(20), R2 = "0x" + "32".repeat(20), R3 = "0x" + "33".repeat(20);
const LOOK = "0x313131" + "9".repeat(30) + "3131";
const O = "https://cairn-substrate.com", D = "https://dapp.example";
const LONG = "https://cairn-substrate.com.account-security-verification.session-renewal.wallet-support-desk.example";
const SEALER = "https://" + "w".repeat(253);
const SELF = "http://wallet.test";   // the harness's page origin: what a seal made in this wallet records
const nfinTip = 117_000 + v.REG_COMMIT_MAX_BLOCKS + v.FINALIZE_TIP_MARGIN + 5;
const req = (id, method, origin, params) => ({ id, method, origin, params });
const sendTo = (outs, fee = 1_000_000) => ({ outputs: outs.map(([to, value]) => ({ to, value })), fee });
const prop = (rec, extra = {}) => ({ domain: cx.CAIRNX_DOMAIN, uri: rec.uri, payloadHash: rec.payloadHash, fee: 25_000_000, expiresEpoch: 4_100, ...extra });
const seen = { history: [{ type: "send", to: RCPT, amount: 1, txid: "0x" + "a1".repeat(32) }] };
const base = {
  status: { hasVault: true, unlocked: true, addr: ME, active: 0, accounts: [{ addr: ME, label: "Main" }], tradeApi: "https://x.invalid" },
  balance: { confirmed: 128_473_500_000 }, history: [], epoch: Math.floor(nfinTip / 30), tip: nfinTip, tipFloor: 0,
};

const HEADER_CASES = [
  // the longest ask line: "New site, which asks to connect to your wallet"
  ["connect", [req("c", "connect", D, {})], {}, ["origin", "cost"]],
  ["send-3-worst", [req("s3w", "send", D, sendTo([[LOOK, 100_000_000], [R2, 200_000_000], [R3, 300_000_000]], 600_000_000))], { ...seen, balance: { confirmed: 50_000_000 } }, ["Possible address-poisoning", "warn:3", "to:3", "unusually large fee", "spendable balance does not cover", "cost"]],
  ["send-short-long-origin", [req("ssl", "send", LONG, { to: RCPT, amount: 150_000_000, fee: 1_000_000 })], { balance: { confirmed: 50_000_000 } }, ["spendable balance does not cover", "cost"]],
  ["fill-2-nolisting", [req("f3", "fillOffer", O, { proposalId: "0x" + "cd".repeat(32), outputs: [{ to: RCPT, value: 500_000_000 }, { to: "0x" + "34".repeat(20), value: 7_500_000 }], fee: 5_000_000, score: 100, confidence: 100 })], {}, ["Could not load this listing", "warn:2", "named:2", "to:2", "cost"]],
  ["name-nfinalize-underpaid", [req("nfu", "propose", O, prop(v.nameFinalize({ name: "satoshi", salt: "a1".repeat(16) }), { outputs: [{ to: cx.TREASURY_ADDR, value: 1 }] }))], {}, ["is below the current price", "#nfin-note", "cost"]],
  ["queue", [req("q1", "send", D, sendTo([[RCPT, 100_000_000], [R2, 200_000_000], [R3, 300_000_000]])), req("q2", "connect", D, {}), req("q3", "send", D, { to: RCPT, amount: 1, fee: 1_000_000 })], {}, ["Request 1 of 3", "warn:3", "to:3", "cost"]],
];
const seal = (extra) => [{ txid: "0x" + "5e".repeat(32), domain: "csd:sealed", claim: "ETH > $4000 by Friday, as posted on the board at noon UTC", ...extra }];
const reveal = (origin) => [req("rv", "revealClaim", origin, "0x" + "5e".repeat(32))];
const LONGEST = { domain: "w".repeat(128), claim: "W".repeat(400) };
// [name, the queue, the stored record, what must render, what the card says, extreme]: an extreme case (the longest
// sealing host with the longest asking origin, claim and domain) runs past the fold, the caution first.
const REVEAL_CASES = [
  ["reveal, same site", reveal(O), seal({ origin: O }), ["#reveal-preview", "cost"], { caution: false, words: `Sealed by${O}` }],
  ["reveal, another site, the longest claim and domain", reveal(D), seal({ origin: LONG, ...LONGEST }), ["#reveal-preview", "This claim was sealed by", "cost"], { caution: true, words: `sealed by ${LONG}, and ${D} is asking to reveal it.` }],
  ["reveal, asked by the longest origin", reveal(LONG), seal({ origin: D, ...LONGEST }), ["#reveal-preview", "This claim was sealed by", "cost"], { caution: true, words: `sealed by ${D}, and ${LONG} is asking to reveal it.` }],
  ["reveal, sealed in this wallet", reveal(D), seal({ origin: SELF }), ["#reveal-preview", "This claim was sealed in this wallet", "cost"], { caution: true, words: `not by a site, and ${D} is asking to reveal it.` }],
  ["reveal, site not recorded", reveal(D), seal({}), ["#reveal-preview", "cost"], { caution: false, words: "Sealed bynot recorded" }],
  ["reveal, a 253-character sealing host asked by the longest origin", reveal(LONG), seal({ origin: SEALER, ...LONGEST }), ["This claim was sealed by", "cost"], { caution: true, words: `and ${LONG} is asking to reveal it.` }, true],
];
const face = (page) => page.evaluate(() => {
  const ask = document.getElementById("ap-ask");
  const range = document.createRange();
  range.selectNodeContents(ask);
  return { ask: ask.textContent, askH: ask.getBoundingClientRect().height, textW: Math.round(range.getBoundingClientRect().width * 10) / 10, roomW: Math.round((document.querySelector(".ap-site").getBoundingClientRect().right - ask.getBoundingClientRect().left) * 10) / 10, top: document.querySelector(".ap-top").getBoundingClientRect().height, density: document.getElementById("app").dataset.density };
});
async function open(queue, answers, height, theme = "light") {
  const r = await openWalletPage(browser, "approve", { ...base, ...answers, pending: queue }, { viewport: { width: WIDTH, height }, colorScheme: theme });
  await r.page.waitForSelector("#view-req:not([hidden])", { timeout: 10_000 });
  await settle(r.page);
  return r;
}
try {
  for (const [height, hTag] of [[INNER_H, "framed"], [APPROVE_WINDOW.height, "full"]]) {
    for (const [name, queue, extra, expect] of HEADER_CASES) {
      const tag = `${hTag} ${name}`;
      const plain = await open(queue.map((q) => ({ ...q, first: false })), extra, height);
      const was = { ...(await face(plain.page)), at: await buttonsAt(plain.page) };
      await plain.ctx.close();
      const { page, ctx, errors } = await open(queue.map((q) => ({ ...q, first: true })), extra, height);
      try {
        const now = { ...(await face(page)), at: await buttonsAt(page) };
        t.check(`${tag}: the line says the site is new, with what it asks for ("${now.ask}", ${now.textW} of ${now.roomW} px)`, /^New site, which asks /.test(now.ask) && now.textW <= now.roomW);
        t.check(`${tag}: the ask line stays one line (${now.askH} px, ${was.askH} without) and the header keeps its height (${now.top} px, ${was.top} without)`, now.askH === was.askH && now.top === was.top);
        t.check(`${tag}: the buttons and the density are where they are without the line (${now.at} then ${was.at}; ${now.density}, ${was.density})`, now.at.join() === was.at.join() && now.density === was.density);
        const m = await page.evaluate(measure, [expect, queue[0].origin]);
        t.check(`${tag}: everything with weight is above the buttons (missing: ${m.missing.join(", ") || "none"}; below: ${m.below.join(", ") || "none"}; late: ${m.late.join(", ") || "none"})`, m.missing.length === 0 && m.below.length === 0 && m.late.length === 0 && m.scrollTop === 0);
        t.check(`${tag}: no page error (${errors.join(" | ") || "none"})`, errors.length === 0);
      } finally { await ctx.close(); }
    }
    for (const theme of ["light", "dark"]) for (const [name, queue, sealedClaims, expect, want, extreme] of REVEAL_CASES) {
      const tag = `${hTag} ${theme} ${name}`;
      const { page, ctx, errors } = await open(queue.map((q) => ({ ...q, first: true })), { sealedClaims }, height, theme);
      try {
        const card = await page.evaluate(() => { const el = document.getElementById("reveal-preview"); return { text: el.textContent.replace(/\s+/g, " "), caution: !!el.querySelector(".check.caution") }; });
        t.check(`${tag}: the card names the sealing site${want.caution ? " and cautions" : ", no caution"} ("${card.text.slice(0, 90)}")`, card.caution === want.caution && card.text.includes(want.words));
        const m = await page.evaluate(measure, [expect, queue[0].origin]);
        if (extreme) {
          const below = m.below.filter((w) => !w.startsWith("check "));
          t.check(`${tag}: the caution stays above the buttons, the claim runs past the fold and the line says so ("${m.cue.text}"; below: ${m.below.join(", ")})`,
            m.missing.length === 0 && below.length === m.below.length && m.cue.open && m.cue.text === "More below: scroll to read the whole request" && m.scrollTop === 0);
        } else t.check(`${tag}: the card and everything with weight are above the buttons (missing: ${m.missing.join(", ") || "none"}; below: ${m.below.join(", ") || "none"})`, m.missing.length === 0 && m.below.length === 0 && m.scrollTop === 0);
        const fx = await windowFixed(page);
        t.check(`${tag}: the window itself does not scroll (document ${fx.doc.h} of ${fx.doc.inner} px)`, fx.ok);
        t.check(`${tag}: no page error (${errors.join(" | ") || "none"})`, errors.length === 0);
      } finally { await ctx.close(); }
    }
  }
} finally {
  await browser.close();
}
t.done("approve-first-request-chrome");
