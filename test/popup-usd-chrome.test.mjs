// The balance's USD line in Chrome at 360 by 600, light and dark: under the amount, in the muted caption, with the
// venue named, as the approved design draws it (`.w-bal .usd`); absent when the market read has no rate (the route's
// 503) and when the balance read failed. test/usd-line.test.mjs pins the parse and the text offline.
// RED-FIRST: drop the paintUsd() call after a balance read in popup-balance.ts and the present checks fail; drop the
// `balanceState.stale ? null :` guard and the failed-read check fails.
// Needs playwright-core (PLAYWRIGHT_CORE) and a Chromium (PLAYWRIGHT_CHROMIUM); prints SKIP without them.
import { checker } from "./helpers/check.mjs";
import { launchOrSkip, openWalletPage } from "./helpers/walletpage.mjs";

const browser = await launchOrSkip();
if (!browser) process.exit(0);
const t = checker("the balance's USD line in Chrome");

const ME = "0x" + "7a3f9c21".repeat(5);
const RATE = { ok: true, rate: 0.0616, source: "SafeTrade", stale: false, ageSecs: 213, disagree: false };
const base = {
  status: { hasVault: true, unlocked: true, addr: ME, active: 0, hasMnemonic: true, rpc: "https://cairn-substrate.com/api/rpc", explorer: "cairn", api: "https://cairn-substrate.com", tradeApi: "https://cairn-substrate.com/trade/api", accounts: [{ addr: ME, label: "Main" }] },
  balance: { confirmed: 128_473_500_000, utxos: [] }, pendingMerge: { pending: false }, prewarmSpv: { ok: true }, pending: [], history: [],
  cairnxAssets: { ok: true, balances: {}, names: [], nameDetails: [] }, cairnxTokens: { ok: true, tokens: [] },
  connectedSites: [], rpcList: [], explorerList: [], sealedClaims: [],
};

// the second balance read fails (a refresh after a good read): the amount stays, dimmed, as the earlier read
function failSecondBalance() {
  const send = chrome.runtime.sendMessage;
  let n = 0;
  chrome.runtime.sendMessage = (m, cb) => (m.method === "balance" && ++n > 1 ? setTimeout(() => cb({ ok: false, error: "node unreachable" }), 5) : send(m, cb));
}

async function line(theme, answers, { refreshFails = false } = {}) {
  const { page, ctx, errors } = await openWalletPage(browser, "popup", answers, { viewport: { width: 360, height: 600 }, colorScheme: theme, init: refreshFails ? failSecondBalance : undefined });
  await page.waitForSelector("#view-main:not([hidden])");
  await page.waitForTimeout(700);
  if (refreshFails) { await page.click("#btn-refresh"); await page.waitForTimeout(700); }
  const r = await page.evaluate(() => {
    const el = document.getElementById("bal-usd"), amt = document.getElementById("balance");
    const probe = document.createElement("div"); probe.style.color = "var(--ui-muted)"; document.body.append(probe);
    const muted = getComputedStyle(probe).color; probe.remove();
    const cs = getComputedStyle(el), a = el.getBoundingClientRect(), b = amt.getBoundingClientRect();
    return { shown: !el.hidden && a.height > 0, text: el.textContent, muted: cs.color === muted, size: cs.fontSize, below: a.top >= b.bottom, gap: Math.round(a.top - b.bottom) };
  });
  await ctx.close();
  return { ...r, errors };
}

for (const theme of ["light", "dark"]) {
  const r = await line(theme, { ...base, csdMarket: RATE });
  t.check(`${theme}: no page error (${r.errors.join("; ") || "none"})`, r.errors.length === 0);
  t.check(`${theme}: the line reads "${r.text}"`, r.shown && r.text === "≈ $79.14 · USD via SafeTrade");
  t.check(`${theme}: under the amount (${r.gap} px), muted, ${r.size}`, r.below && r.muted && r.size === "13px");
}
const off = await line("light", { ...base, csdMarket: { ok: false } });
t.check("the market route off (no rate): the line is absent", !off.shown && off.text === "");
const failed = await line("light", { ...base, balance: undefined, csdMarket: RATE });
t.check("a failed balance read: the line is absent", !failed.shown);
const stale = await line("light", { ...base, csdMarket: RATE }, { refreshFails: true });
t.check("a failed refresh after a good read (the amount is the earlier read): the line is absent", !stale.shown);

await browser.close();
t.done("popup-usd-chrome");
