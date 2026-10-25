// The approval window in Chrome, two behaviours of its chrome around the request:
//   1. It follows a theme chosen in another extension page while it is open (theme.js on approve.html; the popup's
//      Settings writes the choice to the extension's localStorage, which fires a storage event here).
//      RED-FIRST: drop the theme.js script from approve.html, or the startSync() call in approve.ts, and 1a fails.
//      HONEST PATH: 1b, a window nobody re-themes keeps the system theme it opened with.
//   2. The 700 ms latch is visible: the bar fills while Reject is disarmed after a new request and is full once
//      both buttons arm; under reduced motion it is full from the start (no movement).
//      RED-FIRST: remove the `.ap-foot:has(#btn-reject:disabled)` rule and 2a fails; remove the .latch element and
//      every case fails.
// Needs playwright-core (PLAYWRIGHT_CORE) and a Chromium (PLAYWRIGHT_CHROMIUM); prints SKIP without them.
import { APPROVE_FRAME_PX, APPROVE_WINDOW } from "../src/approve-window.ts";
import { checker } from "./helpers/check.mjs";
import { launchOrSkip, openWalletPage } from "./helpers/walletpage.mjs";

const browser = await launchOrSkip();
if (!browser) process.exit(0);
const t = checker("approval window: live theme and the visible latch");

const ME = "0x" + "7a3f9c21".repeat(5);
const send = { id: "r-send", method: "send", origin: "https://dapp.example", params: { to: "0x" + "31".repeat(20), amount: 150_000_000, fee: 1_000_000 } };
const answers = {
  status: { hasVault: true, unlocked: true, addr: ME, active: 0, accounts: [{ addr: ME, label: "Main" }], tradeApi: "https://x.invalid" },
  balance: { confirmed: 128_473_500_000 }, history: [], pending: [send],
};
const themeOf = (page) => page.evaluate(() => ({ mode: document.documentElement.getAttribute("data-theme"), bg: getComputedStyle(document.body).backgroundColor }));

try {
  console.log("1. theme");
  {
    const { page, ctx, errors } = await openWalletPage(browser, "approve", answers, { viewport: { width: APPROVE_WINDOW.width, height: APPROVE_WINDOW.height - APPROVE_FRAME_PX }, colorScheme: "light" });
    try {
      await page.waitForSelector("#view-req:not([hidden])", { timeout: 10_000 });
      const before = await themeOf(page);
      const other = await ctx.newPage();
      await other.goto(page.url());
      // the write the popup's Settings makes through cairn-ui's theme.js (key cairn-theme in the extension's localStorage)
      await other.evaluate(() => localStorage.setItem("cairn-theme", "dark"));
      await page.waitForTimeout(600);
      const after = await themeOf(page);
      t.check(`1a a dark choice made in another page re-themes the open window (${before.mode} ${before.bg} -> ${after.mode} ${after.bg})`,
        before.mode === "light" && after.mode === "dark" && after.bg !== before.bg);
      t.check(`no page error (${errors.join(" | ") || "none"})`, errors.length === 0);
    } finally { await ctx.close(); }
  }
  {
    const { page, ctx } = await openWalletPage(browser, "approve", answers, { viewport: { width: APPROVE_WINDOW.width, height: APPROVE_WINDOW.height - APPROVE_FRAME_PX }, colorScheme: "light" });
    try {
      await page.waitForSelector("#view-req:not([hidden])", { timeout: 10_000 });
      await page.waitForTimeout(600);
      t.check("1b honest: with no choice made elsewhere the window keeps the system theme", (await themeOf(page)).mode === "light");
    } finally { await ctx.close(); }
  }

  console.log("2. latch");
  // Sample the bar's fill against Reject's state on every frame from the first paint of the request.
  const sampleLatch = (page) => page.evaluate(() => new Promise((done) => {
    const out = [];
    const start = performance.now();
    const step = () => {
      const req = document.getElementById("view-req");
      const bar = document.querySelector(".latch"), fill = document.querySelector(".latch > i");
      if (req && !req.hidden && bar && fill) {
        out.push({ ms: Math.round(performance.now() - start), disarmed: document.getElementById("btn-reject").disabled, ratio: fill.getBoundingClientRect().width / bar.getBoundingClientRect().width, h: bar.getBoundingClientRect().height });
      }
      if (performance.now() - start < 2500) requestAnimationFrame(step); else done(out);
    };
    requestAnimationFrame(step);
  }));
  for (const reduced of [false, true]) {
    const { page, ctx, errors } = await openWalletPage(browser, "approve", answers, { viewport: { width: APPROVE_WINDOW.width, height: APPROVE_WINDOW.height - APPROVE_FRAME_PX } });
    try {
      if (reduced) await page.emulateMedia({ reducedMotion: "reduce" });
      const s = await sampleLatch(page);
      const disarmed = s.filter((x) => x.disarmed), armed = s.filter((x) => !x.disarmed);
      const partial = disarmed.filter((x) => x.ratio > 0.05 && x.ratio < 0.95);
      const last = s.at(-1);
      if (!reduced) {
        t.check(`2a the bar is visible and fills while Reject is disarmed (${disarmed.length} disarmed frames, ${partial.length} part-filled, height ${s[0]?.h}px)`, s[0]?.h >= 2 && partial.length > 0);
        t.check(`2b once both buttons arm the bar is full (${armed.length} armed frames, min ratio ${Math.min(...armed.map((x) => x.ratio)).toFixed(3)})`, armed.length > 0 && armed.every((x) => x.ratio > 0.999));
        t.check(`2c the window ends armed with a full bar (${JSON.stringify(last)})`, !!last && !last.disarmed && last.ratio > 0.999);
      } else {
        t.check(`2d reduced motion: the bar never moves, full from the first frame (${disarmed.length} disarmed frames)`, s.length > 0 && s.every((x) => x.ratio > 0.999));
        t.check("2d reduced motion: the 700 ms floor still holds Reject first", disarmed.length > 0 && !last.disarmed);
      }
      t.check(`no page error (${errors.join(" | ") || "none"})`, errors.length === 0);
    } finally { await ctx.close(); }
  }
} finally {
  await browser.close();
}
t.done("approve-window-chrome");
