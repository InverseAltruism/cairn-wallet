// The asset rows' tiles in Chrome at 360 by 600, light and dark: the CSD row draws the vendored csd-logo.jpg (loaded,
// 400 by 400) in a circle with the avatar's hairline; the pinned CAIRN draws the vendored mark (a rendered <use> of
// ui/mark.svg); a CAIRN from another deploy, a CAIRN whose token record failed to load and an unpinned token draw the
// neutral glyph. test/asset-tiles.test.mjs pins the same rules offline.
// RED-FIRST: drop the `.ti.coin-csd` rule from popup.css and the CSD tile checks fail; drop "mark.svg" from UI_SHIP
// (scripts/check-ui-vendor.mjs) and the mark renders nothing and its check fails.
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
  await img.decode().catch(() => {});
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

await browser.close();
t.done("popup-logos-chrome");
