// The popup at its real size (360 by 600) in Chrome, where an open sheet could hide something a person must see:
//  - with 1, 2 and 5 dApp requests waiting and a sheet open, the request band keeps its Review action fully visible
//    and on top, no visible control in it is cut, and an error toast does not cover it (W-15: the request must come
//    into view even while a form is open);
//  - Connected sites shows an origin in full (a look-alike's tail must not be cut), and Accounts every address;
//  - in a send review with a long name caution, Confirm sits after the caution, never over part of it;
//  - every sheet is a labelled modal dialog, Escape closes the open one, and the tabs report the selected one.
// Needs playwright-core (PLAYWRIGHT_CORE) and a Chromium (PLAYWRIGHT_CHROMIUM); prints SKIP without them.
import { checker } from "./helpers/check.mjs";
import { launchOrSkip, openWalletPage } from "./helpers/walletpage.mjs";

const browser = await launchOrSkip();
if (!browser) process.exit(0);
const t = checker("popup layout in Chrome");

const ME = "0x" + "7a3f9c21".repeat(5);
const LONG = "https://cairn-substrate.com.account-verify.evil.example";
const base = {
  status: { hasVault: true, unlocked: true, addr: ME, active: 0, hasMnemonic: true, rpc: "https://cairn-substrate.com/api/rpc", explorer: "cairn", api: "https://cairn-substrate.com", tradeApi: "https://cairn-substrate.com/trade/api",
    accounts: [{ addr: ME, label: "Main" }, { addr: "0x" + "c9d8e7f6".repeat(5), label: "Miner key", imported: true }] },
  balance: { confirmed: 128_473_500_000, utxos: [] }, pendingMerge: { pending: false }, prewarmSpv: { ok: true },
  cairnxAssets: { ok: true, balances: {}, names: [], nameDetails: [] }, cairnxTokens: { ok: true, tokens: [] }, history: [],
  connectedSites: [{ origin: LONG, addr: ME, ts: 1 }], rpcList: [], explorerList: [], sealedClaims: [],
  consolidatePreview: { ok: true, coins: 1, merge: 1, total: 1, out: 0 },
  resolveName: { ok: true, addr: "0x" + "31".repeat(20), verified: true, sources: 2, depth: 14, via: "owner" },
};
const requests = (n) => Array.from({ length: n }, (_, i) => ({ id: `p${i}`, method: ["send", "propose", "fillOffer", "attest", "signinWithCsd"][i % 5], origin: `https://dapp${i}.example` }));
const viewport = { width: 360, height: 600 };

// Geometry of the request band: Review on top and whole, every visible control whole, the toast clear of it.
const band = () => {
  const pend = document.getElementById("pending");
  const card = pend.getBoundingClientRect();
  const inside = (r) => r.top >= card.top - 0.5 && r.bottom <= card.bottom + 0.5 && r.left >= card.left - 0.5 && r.right <= card.right + 0.5 && r.bottom <= innerHeight;
  const shown = [...pend.querySelectorAll("button")].filter((b) => getComputedStyle(b).display !== "none" && b.getBoundingClientRect().height > 0);
  const review = pend.querySelector("[data-review]");
  const rr = review.getBoundingClientRect();
  const onTop = document.elementFromPoint(rr.left + rr.width / 2, rr.top + rr.height / 2);
  const msg = document.getElementById("msg");
  const ms = getComputedStyle(msg);
  const mr = msg.getBoundingClientRect();
  const toast = !!msg.textContent && ms.visibility !== "hidden" && Number(ms.opacity) > 0;
  return {
    reviewWhole: inside(rr), reviewOnTop: review === onTop || review.contains(onTop),
    cut: shown.filter((b) => !inside(b.getBoundingClientRect())).map((b) => b.textContent.trim()),
    toast, toastOverlaps: toast && mr.top < card.bottom && mr.bottom > card.top,
  };
};

try {
  for (const n of [1, 2, 5]) {
    const { page, ctx, errors } = await openWalletPage(browser, "popup", { ...base, pending: requests(n) }, { viewport });
    try {
      await page.waitForSelector("#pending:not([hidden])", { timeout: 10_000 });
      await page.click("#btn-send-t");
      await page.waitForTimeout(700);
      const a = await page.evaluate(band);
      t.check(`${n} waiting, send sheet open: Review is whole and on top`, a.reviewWhole && a.reviewOnTop);
      t.check(`${n} waiting, send sheet open: no visible control in the band is cut (${a.cut.join(", ") || "none"})`, a.cut.length === 0);
      await page.fill("#s-amt", "0");
      await page.click("#btn-send");
      await page.waitForTimeout(500);
      const b = await page.evaluate(band);
      t.check(`${n} waiting, error toast shown: it does not cover the band, Review still on top`, b.toast && !b.toastOverlaps && b.reviewOnTop);
      t.check(`${n} waiting: no page error (${errors.join(" | ") || "none"})`, errors.length === 0);
    } finally {
      await ctx.close();
    }
  }

  {
    const { page, ctx } = await openWalletPage(browser, "popup", { ...base, pending: [] }, { viewport });
    try {
      await page.waitForSelector("#view-main:not([hidden])");
      await page.click("#btn-settings");
      await page.waitForSelector("#connected-sites .addr");
      await page.waitForTimeout(600);
      const site = await page.evaluate(() => {
        const el = document.querySelector("#connected-sites .addr");
        const sheet = document.getElementById("settings").getBoundingClientRect();
        const r = el.getBoundingClientRect();
        return { text: el.textContent, clipped: el.scrollWidth > el.clientWidth + 1, inSheet: r.left >= sheet.left && r.right <= sheet.right };
      });
      t.check(`Connected sites shows the whole origin (${site.text}, clipped: ${site.clipped})`, site.text === LONG && !site.clipped && site.inSheet);
      await page.click("#settings .panel-head .panel-back");
      await page.waitForTimeout(500);
      await page.click(".act-more");
      await page.click("#btn-accts");
      await page.waitForSelector("#accts-list .tx-sub .dim");
      await page.waitForTimeout(600);
      const accts = await page.evaluate(() => [...document.querySelectorAll("#accts-list .tx-sub .dim")].map((el) => ({ text: el.textContent, clipped: el.scrollWidth > el.clientWidth + 1 })));
      t.check(`Accounts shows every address whole (${accts.map((a) => `${a.text.length} chars${a.clipped ? " CUT" : ""}`).join(", ")})`, accts.length === 2 && accts.every((a) => a.text.length === 42 && !a.clipped));
    } finally {
      await ctx.close();
    }
  }

  {
    const { page, ctx } = await openWalletPage(browser, "popup", { ...base, pending: [] }, { viewport });
    try {
      await page.waitForSelector("#view-main:not([hidden])");
      await page.click("#btn-send-t");
      await page.fill("#s-to", "alice.csd");
      await page.fill("#s-amt", "1.5");
      await page.click("#btn-send");
      await page.waitForSelector("#send-confirm:not([hidden])");
      await page.waitForTimeout(600);
      const at = (scroll) => page.evaluate((scroll) => {
        const sheet = document.getElementById("send-form");
        if (scroll === "end") sheet.scrollTop = sheet.scrollHeight;
        const w = document.getElementById("c-warn").getBoundingClientRect();
        const c = document.getElementById("btn-send-confirm").getBoundingClientRect();
        return { overlap: c.top < w.bottom && c.bottom > w.top, after: c.top >= w.bottom };
      }, scroll);
      const top = await at("top");
      const end = await at("end");
      t.check(`send review: Confirm never overlaps the caution (at the top: ${top.overlap}, scrolled to the end: ${end.overlap})`, !top.overlap && !end.overlap && top.after);
      await page.keyboard.press("Escape");
      await page.waitForTimeout(500);
      const closed = await page.evaluate(() => ({ hidden: document.getElementById("send-form").hidden, armed: !document.getElementById("send-confirm").hidden }));
      t.check("Escape closes the open sheet and drops the review", closed.hidden && !closed.armed);
      const dialogs = await page.evaluate(() => [...document.querySelectorAll("#layer > .sheet")].filter((d) => {
        const label = document.getElementById(d.getAttribute("aria-labelledby") || "");
        return !(d.getAttribute("role") === "dialog" && d.getAttribute("aria-modal") === "true" && label && d.contains(label) && label.textContent.trim());
      }).map((d) => d.id));
      t.check(`every sheet is a modal dialog labelled by its own title (unlabelled: ${dialogs.join(", ") || "none"})`, dialogs.length === 0);
      await page.click("#btn-activity-t");
      const sel = await page.evaluate(() => ["nav-home", "btn-activity-t"].map((id) => document.getElementById(id).getAttribute("aria-selected")).join());
      t.check(`the Activity tab reports itself selected (${sel})`, sel === "false,true");
    } finally {
      await ctx.close();
    }
  }
} finally {
  await browser.close();
}
t.done("popup-layout-chrome");
