// What the approval window shows before a signature (R3 section 3), at its real size (380 by 620, scrolled to the
// top), for every request type: no line break inside the request is hidden by CSS, and every warning, origin and cost
// line that wallet 0.2.99 (dee68d7) showed above the action bar is still fully above it. The expectations below were
// measured on that build; the stylesheet may show more, never less.
// Needs playwright-core (PLAYWRIGHT_CORE) and a Chromium (PLAYWRIGHT_CHROMIUM); prints SKIP without them.
import * as cx from "../src/core/cairnx.ts";
import * as v from "../src/vendor/cairnx-spv.js";
import { checker } from "./helpers/check.mjs";
import { launchOrSkip, openWalletPage } from "./helpers/walletpage.mjs";

const browser = await launchOrSkip();
if (!browser) process.exit(0);
const t = checker("approval window layout in Chrome");

const ME = "0x" + "7a3f9c21".repeat(5);
const RCPT = "0x" + "31".repeat(20);
const LOOK = "0x313131" + "9".repeat(30) + "3131";
const O = "https://cairn-substrate.com";
const T = cx.TREASURY_ADDR;
const prop = (rec, extra = {}) => ({ domain: cx.CAIRNX_DOMAIN, uri: rec.uri, payloadHash: rec.payloadHash, fee: 25_000_000, expiresEpoch: 4_100, ...extra });
const nfinTip = 117_000 + v.REG_COMMIT_MAX_BLOCKS + v.FINALIZE_TIP_MARGIN + 5;
const R = {
  connect: { id: "r-connect", method: "connect", origin: O, params: {} },
  signin: { id: "r-signin", method: "signinWithCsd", origin: O, params: { nonce: "n0nce-7f3a9c21e5b84d10", statement: "Sign in to Cairn", expirationSecs: 600, uri: `${O}/trade` } },
  "signin-mismatch": { id: "r-signin2", method: "signinWithCsd", origin: "https://dapp.example", params: { nonce: "abc123", domain: "cairn-substrate.com" } },
  send: { id: "r-send", method: "send", origin: "https://dapp.example", params: { to: RCPT, amount: 150_000_000, fee: 1_000_000 } },
  "send-poison": { id: "r-send-p", method: "send", origin: "https://dapp.example", params: { to: LOOK, amount: 150_000_000, fee: 1_000_000 } },
  "fill-csd": { id: "r-fill", method: "fillOffer", origin: O, params: { proposalId: "0x" + "ab".repeat(32), outputs: [{ to: RCPT, value: 250_000_000 }, { to: T, value: 3_750_000 }], fee: 1_000_000, score: 100, confidence: 100 } },
  "fill-token": { id: "r-fillt", method: "fillOffer", origin: O, params: { proposalId: "0x" + "cd".repeat(32), outputs: [], fee: 1_000_000, score: 100, confidence: cx.CONF_TOKEN_FILL } },
  "propose-transfer": { id: "r-xfer", method: "propose", origin: O, params: prop(cx.buildTransfer({ ticker: "CAIRN", amount: "1500000000", to: RCPT })) },
  "propose-raw": { id: "r-raw", method: "propose", origin: "https://dapp.example", params: { domain: "csd:apps", payloadHash: "0x" + "77".repeat(32), uri: "https://dapp.example/p/42", fee: 25_000_000 } },
  "name-nset": { id: "r-nset", method: "propose", origin: O, params: prop(cx.buildNameSet({ name: "alice", addr: RCPT })) },
  "name-nrenew": { id: "r-nrenew", method: "propose", origin: O, params: prop(cx.buildNameRenew({ name: "alice" }), { outputs: [{ to: T, value: 1_500_000_000 }] }) },
  "name-nxfer": { id: "r-nxfer", method: "propose", origin: O, params: prop(cx.buildNameXfer({ name: "alice", to: RCPT })) },
  "name-nprofile": { id: "r-nprof", method: "propose", origin: O, params: prop(cx.buildNameProfile({ name: "alice", profile: { bio: "builder", url: "https://example.org" } })) },
  "name-nfinalize": { id: "r-nfin", method: "propose", origin: O, params: prop(v.nameFinalize({ name: "satoshi", salt: "a1".repeat(16) }), { outputs: [{ to: T, value: 500_000_000 }] }) },
  seal: { id: "r-seal", method: "sealClaim", origin: O, params: { domain: "csd:sealed", claim: "ETH > $4000 by Friday", fee: 25_000_000 } },
  reveal: { id: "r-reveal", method: "revealClaim", origin: O, params: "0x" + "5e".repeat(32) },
  reserve: { id: "r-reserve", method: "attest", origin: O, params: { proposalId: "0x" + "ef".repeat(32), score: 50, confidence: 0, fee: 1_000_000 } },
};
const view = { ok: true, giveTicker: "CAIRN", giveAmount: "100000000", giveDecimals: 8, expiresAt: nfinTip + 300 };
const CASES = [
  // [name, request, extra answers, the lines 0.2.99 showed above the action bar]
  ["connect", R.connect, {}, ["origin", "cost"]],
  ["signin", R.signin, {}, ["origin", "cost"]],
  ["signin-mismatch", R["signin-mismatch"], {}, ["this page asked to sign in as", "origin", "cost"]],
  ["send", R.send, {}, ["First time sending to", "origin", "cost"]],
  ["send-poison", R["send-poison"], {}, ["First time sending to", "origin", "cost"]],
  ["fill-csd", R["fill-csd"], {}, ["could not load this listing", "First time sending to"]],
  ["fill-token", R["fill-token"], {}, ["TOKEN-PRICED FILL", "origin"]],
  ["propose-transfer", R["propose-transfer"], {}, ["First time sending tokens to", "origin"]],
  ["propose-raw", R["propose-raw"], {}, ["origin", "cost"]],
  ["name-nset", R["name-nset"], {}, ["First time pointing a name at", "origin"]],
  ["name-nrenew", R["name-nrenew"], {}, ["origin"]],
  ["name-nxfer", R["name-nxfer"], {}, ["First time transferring a name to", "origin"]],
  ["name-nprofile", R["name-nprofile"], {}, ["origin", "cost"]],
  ["name-nfinalize", R["name-nfinalize"], {}, ["transfers funds OUT of your wallet", "b=5 CSD"]],
  ["seal", R.seal, {}, ["origin", "cost"]],
  ["reveal", R.reveal, {}, ["origin", "cost"]],
  ["reserve", R.reserve, {}, ["origin", "cost"]],
  ["fill-csd+view", R["fill-csd"], { fillOfferView: view }, ["First time sending to"]],
  ["send-poison+hist", R["send-poison"], { history: [{ type: "send", to: RCPT, amount: 1, txid: "0x" + "a1".repeat(32) }] }, ["Possible address-poisoning", "origin", "cost"]],
  ["send-short", R.send, { balance: { confirmed: 50_000_000 } }, ["First time sending to", "origin", "cost"]],
];

const base = {
  status: { hasVault: true, unlocked: true, addr: ME, active: 0, accounts: [{ addr: ME, label: "Main" }], tradeApi: "https://x.invalid" },
  balance: { confirmed: 128_473_500_000 }, history: [], tokenDisplayMeta: { CAIRN: { decimals: 8, deployId: cx.PINNED_TOKENS.CAIRN.deployId } },
  epoch: Math.floor(nfinTip / 30), tip: nfinTip, tipFloor: 0, sealedClaims: [{ txid: "0x" + "5e".repeat(32), domain: "csd:sealed", claim: "ETH > $4000 by Friday" }],
};

try {
  for (const [name, req, extra, expect] of CASES) {
    const { page, ctx, errors } = await openWalletPage(browser, "approve", { ...base, pending: [req], ...extra }, { viewport: { width: 380, height: 620 } });
    try {
      await page.waitForSelector("#view-req:not([hidden])", { timeout: 10_000 });
      await page.waitForTimeout(1_800);
      const r = await page.evaluate((expect) => {
        const req = document.getElementById("req");
        const bar = document.querySelector("#view-req .actions");
        const fold = Math.min(req.getBoundingClientRect().bottom, bar.getBoundingClientRect().top, innerHeight);
        const hiddenBr = [...req.querySelectorAll("br")].filter((b) => getComputedStyle(b).display === "none").length;
        // Every <br> of the describe block must end a line in what is shown: walk the markup (br as a break, hidden
        // elements skipped), then find each segment in innerText in order with a line break between neighbours.
        const desc = [...req.children].find((k) => k.classList.contains("req") && !k.classList.contains("dim"));
        let marked = "";
        const walk = (node) => {
          for (const c of node.childNodes) {
            if (c.nodeType === 3) marked += c.textContent;
            else if (c.nodeName === "BR") marked += "\n";
            else if (c.nodeType === 1 && getComputedStyle(c).display !== "none") walk(c);
          }
        };
        if (desc) walk(desc);
        const squeeze = (s) => s.replace(/[^\S\n]+/g, "");
        const segs = squeeze(marked).split("\n").filter(Boolean);
        // innerText also breaks around block elements, so search it without breaks and remember where they were
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
        const kids = [...req.children];
        const target = (label) => {
          if (label === "origin") return kids.find((k) => k.textContent.startsWith("from "));
          if (label === "cost") return document.getElementById("cost");
          if (label.startsWith("b=")) return [...req.querySelectorAll("b")].find((b) => b.textContent === label.slice(2));
          const walker = document.createTreeWalker(req, NodeFilter.SHOW_TEXT);
          for (let n = walker.nextNode(); n; n = walker.nextNode()) {
            if (n.textContent.includes(label)) return n.parentElement.closest("#send-warn, .err, b") || n.parentElement;
          }
          return null;
        };
        const missing = expect.filter((label) => {
          const el = target(label);
          return !el || el.getBoundingClientRect().height === 0 || el.getBoundingClientRect().bottom > fold + 0.5;
        });
        return { hiddenBr, lost, missing };
      }, expect);
      t.check(`${name}: no <br> in the request is hidden (${r.hiddenBr})`, r.hiddenBr === 0);
      t.check(`${name}: the request text breaks at every <br> (${r.lost.join("; ") || "all kept"})`, r.lost.length === 0);
      t.check(`${name}: everything 0.2.99 showed above the buttons is still there (missing: ${r.missing.join(", ") || "none"})`, r.missing.length === 0);
      t.check(`${name}: no page error (${errors.join(" | ") || "none"})`, errors.length === 0);
    } finally {
      await ctx.close();
    }
  }
} finally {
  await browser.close();
}
t.done("approve-layout-chrome");
