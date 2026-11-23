// The Settings theme control in the shipped popup page, in Chrome: theme-init.js marks <html> with data-theme-choice
// before the control mounts on the document, so the control must take its options from the three buttons only. When
// it took every element with the attribute, <html> joined the group: an arrow key in any popup input bubbled up to it,
// lost its caret move, sent focus to a theme button and changed and stored the theme, and a click anywhere stored the
// choice once more.
// RED-FIRST: the selector in src/popup/themectl.ts back to "[data-theme-choice]" fails the opening check (the press on
// Send stored the theme) and checks 1 to 4.
// HONEST PATH: the arrow keys on the buttons themselves still move focus and choose, with one tab stop.
// Needs playwright-core (PLAYWRIGHT_CORE) and a Chromium (PLAYWRIGHT_CHROMIUM); prints SKIP without them.
import { checker } from "./helpers/check.mjs";
import { launchOrSkip, openWalletPage } from "./helpers/walletpage.mjs";

const browser = await launchOrSkip();
if (!browser) process.exit(0);
const t = checker("theme control in Chrome");

const ME = "0x" + "7a3f9c21".repeat(5);
const answers = {
  status: { hasVault: true, unlocked: true, addr: ME, active: 0, hasMnemonic: true, rpc: "https://cairn-substrate.com/api/rpc", explorer: "cairn", api: "https://cairn-substrate.com", tradeApi: "https://cairn-substrate.com/trade/api",
    accounts: [{ addr: ME, label: "Main" }] },
  balance: { confirmed: 128_473_500_000, utxos: [] }, pendingMerge: { pending: false }, prewarmSpv: { ok: true }, pending: [],
  cairnxAssets: { ok: true, balances: {}, names: [], nameDetails: [] }, cairnxTokens: { ok: true, tokens: [] }, history: [],
  connectedSites: [], rpcList: [], explorerList: [], sealedClaims: [],
};

// Before any page script: a stored "light", and a count of every write to the theme key.
function init() {
  localStorage.setItem("cairn-theme", "light");
  globalThis.__themeWrites = 0;
  const count = (fn) => function (key, ...rest) { if (key === "cairn-theme") globalThis.__themeWrites++; return fn.call(this, key, ...rest); };
  Storage.prototype.setItem = count(Storage.prototype.setItem);
  Storage.prototype.removeItem = count(Storage.prototype.removeItem);
}

const state = (page) => page.evaluate(() => {
  const html = document.documentElement;
  const input = document.getElementById("s-to");
  return {
    stored: localStorage.getItem("cairn-theme"), writes: globalThis.__themeWrites, theme: html.getAttribute("data-theme"),
    htmlTabindex: html.getAttribute("tabindex"), htmlChecked: html.getAttribute("aria-checked"),
    focus: document.activeElement?.id || document.activeElement?.dataset?.themeChoice || document.activeElement?.tagName,
    caret: input.selectionStart, prevented: globalThis.__prevented,
  };
});

const open = () => openWalletPage(browser, "popup", answers, { viewport: { width: 360, height: 600 }, init });
try {
  const first = await open();
  try {
    const { page, errors } = first;
    await page.waitForSelector("#view-main:not([hidden])");
    await page.click("#btn-send-t");
    await page.fill("#s-to", "alice.csd");
    // Records whether the key's default was prevented once the event has passed every listener up to the window.
    await page.evaluate(() => window.addEventListener("keydown", (e) => { globalThis.__prevented = e.defaultPrevented; }));
    const before = await state(page);
    t.check(`the page opens on the stored choice (${JSON.stringify(before)})`, before.stored === "light" && before.theme === "light" && before.writes === 0);

    await page.focus("#s-to");
    await page.keyboard.press("ArrowLeft");
    await page.waitForTimeout(150);
    const left = await state(page);
    t.check(`1. ArrowLeft in a text input moves its caret and leaves the theme alone (${JSON.stringify(left)})`,
      left.prevented === false && left.focus === "s-to" && left.caret === 8 && left.stored === "light" && left.theme === "light" && left.writes === 0);
    await page.keyboard.press("ArrowRight");
    await page.waitForTimeout(150);
    const right = await state(page);
    t.check(`2. ArrowRight too (${JSON.stringify(right)})`,
      right.prevented === false && right.focus === "s-to" && right.caret === 9 && right.stored === "light" && right.theme === "light" && right.writes === 0);
    t.check(`3. <html> is not an option of the group (tabindex ${right.htmlTabindex}, aria-checked ${right.htmlChecked})`,
      right.htmlTabindex === null && right.htmlChecked === null);
    await page.click("#s-to");
    await page.waitForTimeout(150);
    const clicked = await state(page);
    t.check(`4. a click in the input stores nothing (writes ${clicked.writes})`, clicked.writes === 0 && clicked.stored === "light");

    t.check(`no page errors (${errors.join("; ")})`, errors.length === 0);
  } finally {
    await first.ctx.close();
  }

  // The group itself, on its buttons, in a fresh page.
  const second = await open();
  try {
    const { page, errors } = second;
    await page.waitForSelector("#view-main:not([hidden])");
    await page.evaluate(() => window.addEventListener("keydown", (e) => { globalThis.__prevented = e.defaultPrevented; }));
    await page.click("#btn-settings");
    await page.waitForSelector("#settings:not([hidden])");
    const group = () => page.evaluate(() => [...document.querySelectorAll("#settings [role=radio]")].map((b) => `${b.dataset.themeChoice}:${b.getAttribute("aria-checked")}:${b.getAttribute("tabindex")}`).join(" "));
    t.check(`one tab stop, on the stored choice (${await group()})`, (await group()) === "system:false:-1 light:true:0 dark:false:-1");
    await page.focus('button[data-theme-choice="light"]');
    await page.keyboard.press("ArrowRight");
    await page.waitForTimeout(700);
    const onDark = await state(page);
    t.check(`ArrowRight on Light moves to Dark and chooses it (${JSON.stringify(onDark)}; ${await group()})`,
      onDark.prevented === true && onDark.focus === "dark" && onDark.stored === "dark" && onDark.theme === "dark" && (await group()) === "system:false:-1 light:false:-1 dark:true:0");
    await page.keyboard.press("ArrowRight");
    await page.waitForTimeout(700);
    const wrapped = await state(page);
    t.check(`ArrowRight on Dark wraps to System, which clears the stored choice (${JSON.stringify(wrapped)})`,
      wrapped.focus === "system" && wrapped.stored === null && (await group()) === "system:true:0 light:false:-1 dark:false:-1");
    await page.click('button[data-theme-choice="light"]');
    await page.waitForTimeout(700);
    const pressed = await state(page);
    t.check(`a press on Light chooses it (${JSON.stringify(pressed)})`, pressed.stored === "light" && pressed.theme === "light");
    t.check(`no page errors (${errors.join("; ")})`, errors.length === 0);
  } finally {
    await second.ctx.close();
  }
} finally {
  await browser.close();
}
t.done("themectl-chrome");
