// The popup's send review in Chrome at 360 by 600, light and dark: each review check renders in its tier's colour
// (W-01, W-02). A first send to an address is red again, as in 0.2.99: at 5788776 only `.warn:has(> code)` was red,
// so the first-time warning, which carries no <code>, read as neutral. A positive name row is green, a caution
// amber, and every row sits above Confirm.
// RED-FIRST: drop the `.check.danger` rule from popup.css and the danger checks fail; restore popup.css and
// popup.ts from 5788776 and every tier check fails; drop the `key === pendingShown` return in renderPending and the
// pending card check fails; set data-enter on every write in enterOnce and the refresh check fails.
// HONEST PATH: the positive row on a two-source name; the first fill's stagger.
// Needs playwright-core (PLAYWRIGHT_CORE) and a Chromium (PLAYWRIGHT_CHROMIUM); prints SKIP without them.
import { checker } from "./helpers/check.mjs";
import { launchOrSkip, openWalletPage } from "./helpers/walletpage.mjs";

const browser = await launchOrSkip();
if (!browser) process.exit(0);
const t = checker("popup review checks in Chrome");

const ME = "0x" + "7a3f9c21".repeat(5);
const NEW = "0x" + "42".repeat(20);
const base = {
  status: { hasVault: true, unlocked: true, addr: ME, active: 0, hasMnemonic: true, rpc: "https://cairn-substrate.com/api/rpc", explorer: "cairn", api: "https://cairn-substrate.com", tradeApi: "https://cairn-substrate.com/trade/api",
    accounts: [{ addr: ME, label: "Main" }] },
  balance: { confirmed: 128_473_500_000, utxos: [] }, pendingMerge: { pending: false }, prewarmSpv: { ok: true }, pending: [],
  cairnxAssets: { ok: true, balances: {}, names: [], nameDetails: [] }, cairnxTokens: { ok: true, tokens: [] }, history: [],
  connectedSites: [], rpcList: [], explorerList: [], sealedClaims: [],
};

// Each check row's background against the token it should carry, read through a probe so both sides resolve alike.
const readRows = () => {
  const probe = (v) => { const d = document.createElement("div"); d.style.background = `var(${v})`; document.body.append(d); const c = getComputedStyle(d).backgroundColor; d.remove(); return c; };
  const tint = { ok: probe("--ui-up-tint"), caution: probe("--ui-warn-tint"), danger: probe("--ui-down-tint") };
  const confirm = document.getElementById("btn-send-confirm").getBoundingClientRect();
  return [...document.querySelectorAll("#c-warn > .check")].map((el) => {
    const tier = ["ok", "caution", "danger"].find((x) => el.classList.contains(x));
    const r = el.getBoundingClientRect();
    return { tier, text: el.textContent.trim().slice(0, 40), tinted: getComputedStyle(el).backgroundColor === tint[tier], icon: !!el.querySelector(":scope > svg.i"), visible: r.height > 0, aboveConfirm: r.bottom <= confirm.top };
  });
};

async function review(theme, resolveName, to) {
  const { page, ctx, errors } = await openWalletPage(browser, "popup", { ...base, resolveName, confirmName: resolveName }, { viewport: { width: 360, height: 600 }, colorScheme: theme });
  await page.waitForSelector("#view-main:not([hidden])");
  await page.click("#btn-send-t");
  await page.fill("#s-to", to);
  await page.fill("#s-amt", "1.5");
  await page.click("#btn-send");
  await page.waitForSelector("#send-confirm:not([hidden])");
  await page.waitForTimeout(500);
  const rows = await page.evaluate(readRows);
  await ctx.close();
  return { rows, errors };
}

// The entrance plays once: rows stagger in on the list's first fill, a refresh rewrites them in place, and the 1.5 s
// pending poll leaves the request card (and the focus on Review) alone while the queue is unchanged.
async function entrances() {
  const answers = { ...base, cairnxAssets: { ok: true, balances: { CAIRN: { available: "1", locked: "0" }, SUN: { available: "2", locked: "0" } }, names: [], nameDetails: [] },
    pending: [{ id: "p1", method: "send", origin: "https://dapp.example" }] };
  const { page, ctx, errors } = await openWalletPage(browser, "popup", answers, { viewport: { width: 360, height: 600 } });
  await page.waitForSelector("#assets .w-row");
  const first = await page.evaluate(() => [...document.querySelectorAll("#assets > .w-row")].map((r) => r.getAnimations().map((a) => a.animationName).join()).join("|"));
  await page.waitForTimeout(1200);
  await page.click("#btn-refresh");
  await page.waitForTimeout(300);
  const again = await page.evaluate(() => ({ anims: [...document.querySelectorAll("#assets > .w-row")].map((r) => r.getAnimations().length).join(), rows: document.querySelectorAll("#assets > .w-row").length }));
  await page.waitForSelector("#pending:not([hidden]) [data-review]");
  await page.focus("#pending [data-review]");
  const card = await page.evaluateHandle(() => document.querySelector("#pending [data-review]"));
  await page.waitForTimeout(3400);
  const kept = await page.evaluate((el) => el.isConnected && document.activeElement === el && document.getElementById("pending").getAnimations().filter((a) => a.animationName === "pending-in" && a.playState === "running").length === 0, card);
  await ctx.close();
  return { first, again, kept, errors };
}

// While a sheet is open the scrim, not the account chip, takes a click at the chip's centre (an account switch under an
// open review is the path W-23 guards); the review's To address is grouped in fours and a selection copies it raw;
// the longest legal ticker (12 characters) is shown whole; the account address in More is whole.
async function layout() {
  const LONGEST = "ABCDEFGHIJKL";
  const answers = { ...base, cairnxAssets: { ok: true, balances: { [LONGEST]: { available: "123456789012345678", locked: "0" } }, names: [], nameDetails: [] },
    cairnxTokens: { ok: true, tokens: [{ ticker: LONGEST, decimals: 0 }] } };
  const { page, ctx, errors } = await openWalletPage(browser, "popup", answers, { viewport: { width: 360, height: 600 } });
  await page.waitForSelector("#assets .w-row");
  const ticker = await page.evaluate(() => { const b = document.querySelector("#assets .w-row .nm b"); return { text: b.textContent, clipped: b.scrollWidth > b.clientWidth + 1 || b.getBoundingClientRect().right > innerWidth }; });
  await page.click(".act-more");
  await page.waitForTimeout(300);
  const addr = await page.evaluate(() => { const a = document.getElementById("addr"); const r = a.getBoundingClientRect(); return { text: a.textContent, clipped: a.scrollWidth > a.clientWidth + 1, inView: r.right <= innerWidth && r.height > 0 }; });
  await page.keyboard.press("Escape");
  await page.click("#btn-send-t");
  await page.waitForTimeout(600);
  const hit = await page.evaluate(() => {
    const r = document.querySelector(".acct-chip").getBoundingClientRect();
    const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return el?.classList.contains("scrim") ? "scrim" : (el?.closest(".acct-chip") ? "chip" : el?.tagName);
  });
  await page.fill("#s-to", "0x" + "42".repeat(20));
  await page.fill("#s-amt", "1");
  await page.click("#btn-send");
  await page.waitForSelector("#send-confirm:not([hidden])");
  const to = await page.evaluate(() => {
    const el = document.getElementById("c-to");
    const range = document.createRange(); range.selectNodeContents(el);
    const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range);
    return { text: el.textContent, selected: sel.toString(), groups: el.children.length };
  });
  await ctx.close();
  return { ticker, addr, hit, to, errors, LONGEST };
}

try {
  {
    const l = await layout();
    t.check(`the longest legal ticker shows whole (${JSON.stringify(l.ticker)})`, l.ticker.text === l.LONGEST && !l.ticker.clipped);
    t.check(`More shows the account address whole (${JSON.stringify(l.addr)})`, l.addr.text === ME && !l.addr.clipped && l.addr.inView);
    t.check(`with a sheet open the scrim takes a click at the account chip's centre (${l.hit})`, l.hit === "scrim");
    t.check(`the To address shows in groups of four and a selection copies it raw (${JSON.stringify(l.to)})`, l.to.groups === 10 && l.to.text === "0x" + "42".repeat(20) && l.to.selected === l.to.text);
    t.check(`layout: no page error (${l.errors.join(" | ") || "none"})`, l.errors.length === 0);
  }
  {
    const e = await entrances();
    t.check(`rows play row-in on the list's first fill (${e.first})`, e.first === "row-in|row-in");
    t.check(`a refresh rewrites the rows without replaying it (${JSON.stringify(e.again)})`, e.again.rows === 2 && e.again.anims === "0,0");
    t.check("two pending polls later the request card is the same element, Review keeps the focus, no entrance replays", e.kept);
    t.check(`entrances: no page error (${e.errors.join(" | ") || "none"})`, e.errors.length === 0);
  }
  for (const theme of ["light", "dark"]) {
    const a = await review(theme, { ok: true, addr: NEW, verified: true, sources: 2, depth: 14, via: "owner" }, "alice.csd");
    const [name, first] = a.rows;
    t.check(`${theme}: a two-source name renders a positive row in the up tint (${JSON.stringify(name)})`, name?.tier === "ok" && name.tinted && name.icon && name.visible);
    t.check(`${theme}: a first send renders a danger row in the down tint (${JSON.stringify(first)})`, first?.tier === "danger" && first.tinted && first.icon && first.visible && /First time sending/.test(first.text));
    t.check(`${theme}: every row sits above Confirm`, a.rows.length === 2 && a.rows.every((r) => r.aboveConfirm));
    const b = await review(theme, { ok: true, addr: NEW, verified: true, sources: 2, soleSource: true, depth: 14, via: "owner" }, "alice.csd");
    t.check(`${theme}: a single-source name renders a caution row in the warn tint (${JSON.stringify(b.rows[0])})`, b.rows[0]?.tier === "caution" && b.rows[0].tinted && b.rows[0].visible);
    t.check(`${theme}: no page error (${[...a.errors, ...b.errors].join(" | ") || "none"})`, a.errors.length + b.errors.length === 0);
  }
} finally {
  await browser.close();
}
t.done("popup-checks-chrome");
