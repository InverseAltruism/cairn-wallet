// The asset rows' tiles in Chrome at 360 by 600, light and dark: the CSD row draws the vendored csd-logo.jpg (loaded,
// 400 by 400) in a circle with the avatar's hairline; the pinned CAIRN draws the vendored mark (a rendered <use> of
// ui/mark.svg); a CAIRN from another deploy, a CAIRN whose token record failed to load and an unpinned token draw the
// neutral glyph. test/asset-tiles.test.mjs pins the same rules offline.
// RED-FIRST: drop the `.ti.coin-csd` rule from popup.css and the CSD tile checks fail; drop "mark.svg" from UI_SHIP
// (scripts/check-ui-vendor.mjs) and the mark renders nothing and its check fails; drop `fill: currentColor` from
// popup.css's `svg.mark` rule and the fill checks fail.
// HONEST PATH: the pinned CAIRN with the deploy id the resolver serves.
// Needs playwright-core (PLAYWRIGHT_CORE) and a Chromium (PLAYWRIGHT_CHROMIUM); prints SKIP without them.
import { PINNED_TOKENS } from "../src/core/cairnx.ts";
import { checker } from "./helpers/check.mjs";
import { launchOrSkip, openWalletPage } from "./helpers/walletpage.mjs";

const browser = await launchOrSkip();
if (!browser) process.exit(0);
const t = checker("asset tiles in Chrome");

const ME = "0x" + "7a3f9c21".repeat(5);
const base = {
  status: { hasVault: true, unlocked: true, addr: ME, active: 0, hasMnemonic: true, rpc: "https://cairn-substrate.com/api/rpc", explorer: "cairn", api: "https://cairn-substrate.com", tradeApi: "https://cairn-substrate.com/trade/api", accounts: [{ addr: ME, label: "Main" }] },
  balance: { confirmed: 128_473_500_000, utxos: [] }, pendingMerge: { pending: false }, prewarmSpv: { ok: true }, pending: [], history: [],
  connectedSites: [], rpcList: [], explorerList: [], sealedClaims: [], csdMarket: { ok: false },
  cairnxAssets: { ok: true, balances: { CAIRN: { available: "150000000000", locked: "2500000000" }, SUN: { available: "420", locked: "0" } }, names: [], nameDetails: [] },
};
const tokens = (cairnDeploy) => ({ ok: true, tokens: [{ ticker: "CAIRN", decimals: 8, deployId: cairnDeploy }, { ticker: "SUN", decimals: 0, deployId: "0x" + "5e".repeat(32) }] });

const readTiles = async () => {
  const csd = document.querySelector("#csd-row .ti");
  const cs = getComputedStyle(csd);
  const src = /url\("([^"]+)"\)/.exec(cs.backgroundImage)?.[1] ?? "";
  const img = new Image();
  img.src = src;
  await img.decode().catch(() => null); // a failed load leaves naturalWidth 0, which the check reports
  const row = (tk) => {
    const tile = document.querySelector(`#assets [data-tsend="${tk}"] .ti`);
    const use = tile?.querySelector("use");
    const box = tile?.querySelector("svg")?.getBBox?.();
    return { href: use?.getAttribute("href") ?? "", drawn: !!box && box.width > 100 && box.height > 100, text: tile?.textContent ?? "" };
  };
  return {
    csd: { src, natural: [img.naturalWidth, img.naturalHeight], round: cs.borderRadius, shadow: cs.boxShadow, size: [csd.offsetWidth, csd.offsetHeight] },
    cairn: row("CAIRN"), sun: row("SUN"),
  };
};

async function tiles(theme, cairnxTokens) {
  const { page, ctx, errors } = await openWalletPage(browser, "popup", { ...base, cairnxTokens }, { viewport: { width: 360, height: 600 }, colorScheme: theme });
  await page.waitForSelector('#assets [data-tsend="CAIRN"]');
  await page.waitForTimeout(300);
  const r = await page.evaluate(readTiles);
  await ctx.close();
  return { ...r, errors };
}

for (const theme of ["light", "dark"]) {
  const r = await tiles(theme, tokens(PINNED_TOKENS.CAIRN.deployId));
  t.check(`${theme}: no page error (${r.errors.join("; ") || "none"})`, r.errors.length === 0);
  t.check(`${theme}: the CSD tile draws ui/csd-logo.jpg, loaded at ${r.csd.natural.join(" by ")}`, r.csd.src.endsWith("/ui/csd-logo.jpg") && r.csd.natural.join() === "400,400");
  t.check(`${theme}: the CSD tile is a ${r.csd.size.join(" by ")} circle (${r.csd.round})`, r.csd.size.join() === "34,34" && /^(9999|50%|[0-9]{3,})/.test(r.csd.round));
  t.check(`${theme}: the CSD tile carries the inset hairline (${r.csd.shadow})`, r.csd.shadow.endsWith("0px 0px 0px 1px inset") && r.csd.shadow.includes("/ 0.08)"));
  t.check(`${theme}: the pinned CAIRN draws the vendored mark (${r.cairn.href}, rendered ${r.cairn.drawn})`, r.cairn.href === "ui/mark.svg#mark" && r.cairn.drawn);
  t.check(`${theme}: an unpinned token draws the neutral glyph`, r.sun.href === "icons.svg#i-coins" && r.sun.text === "");
}
const other = await tiles("light", tokens("0x" + "ab".repeat(32)));
t.check("a CAIRN from another deploy draws the neutral glyph", other.cairn.href === "icons.svg#i-coins");
const failed = await tiles("light", { ok: false });
t.check("a CAIRN whose token record failed to load draws the neutral glyph", failed.cairn.href === "icons.svg#i-coins");

// The mark sets no paint (cairn-ui's mark.svg), so every <svg> that draws it must set fill. Each one, on every page
// that draws it, must fill with its own colour, and that colour must be one of the theme's ink tokens, so the mark is
// never the default black on the dark ground. Pages: the popup's setup, locked and main views (the CAIRN tile), and
// the approval window locked and with a request (its header tile).
const readMarks = () => {
  const probe = (v) => { const d = document.createElement("div"); d.style.color = `var(${v})`; document.body.append(d); const c = getComputedStyle(d).color; d.remove(); return c; };
  const inks = [probe("--ui-ink"), probe("--ui-ink-2")];
  return [...document.querySelectorAll("svg")].filter((el) => el.querySelector('use[href="ui/mark.svg#mark"]')).filter((el) => el.checkVisibility())
    .map((el) => { const cs = getComputedStyle(el); return { cls: el.getAttribute("class"), where: el.parentElement?.className || el.parentElement?.id || "", fill: cs.fill, color: cs.color, ink: inks.includes(cs.color) }; });
};
const signed = { ...base.status, unlocked: false };
const pages = [
  ["popup setup", "popup", { ...base, status: { hasVault: false, unlocked: false, accounts: [] } }, "#view-setup:not([hidden])"],
  ["popup locked", "popup", { ...base, status: signed }, "#view-locked:not([hidden])"],
  ["popup main", "popup", { ...base, cairnxTokens: tokens(PINNED_TOKENS.CAIRN.deployId) }, '#assets [data-tsend="CAIRN"]'],
  ["approval locked", "approve", { status: signed, pending: [] }, "#view-locked:not([hidden])"],
  ["approval request", "approve", { status: { ...base.status, tradeApi: "https://x.invalid" }, balance: { confirmed: 128_473_500_000 }, history: [], tip: 128_000, epoch: 4_000, tipFloor: 0, sealedClaims: [], tokenDisplayMeta: {},
    pending: [{ id: "r1", method: "send", origin: "https://cairn-substrate.com", params: { to: "0x" + "42".repeat(20), amount: 150_000_000, fee: 1_000_000 } }] }, "#view-req:not([hidden])"],
];
for (const theme of ["light", "dark"]) {
  let drawn = 0;
  for (const [name, which, answers, ready] of pages) {
    const { page, ctx, errors } = await openWalletPage(browser, which, answers, { viewport: which === "approve" ? { width: 460, height: 716 } : { width: 360, height: 600 }, colorScheme: theme });
    await page.waitForSelector(ready);
    await page.waitForTimeout(300);
    const marks = await page.evaluate(readMarks);
    drawn += marks.length;
    const bad = marks.filter((m) => m.fill !== m.color || !m.ink);
    t.check(`${theme}, ${name}: ${marks.length} mark(s), each filled with its own ink colour (${marks.map((m) => `${m.cls}@${m.where} ${m.fill}`).join("; ")})`, marks.length > 0 && bad.length === 0 && errors.length === 0);
    await ctx.close();
  }
  t.check(`${theme}: the five pages draw the mark ${drawn} times`, drawn >= 6);
}

await browser.close();
t.done("popup-logos-chrome");
