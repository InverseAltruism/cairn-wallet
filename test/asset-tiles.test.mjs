// The asset rows' tiles (owner's note after the go-live, 2026-10-26): the CSD row shows the CSD coin's logo (the
// owner's file, vendored from cairn-ui as csd-logo.jpg), and the CAIRN row shows the Cairn mark only for the token the
// wallet pins by deploy id (PINNED_TOKENS); every other token keeps the neutral glyph. Before 0.3.1 the CSD row drew the
// Cairn mark and CAIRN drew the neutral glyph. The token list the popup reads (/cairnx/tokens) carries each ticker's
// deploy id; the row passes it to tokenTileHtml, so a ticker alone never earns the mark.
// RED-FIRST: make tokenTileHtml ignore the deploy id (`logo ? logo : NEUTRAL_TILE`) and the other-deploy and
// unloaded-record checks fail; restore popup.html from 636f5d1 and the CSD row checks fail; drop `deployId` from the
// token meta in popup-assets.ts and the wiring check fails.
// HONEST PATH: the pinned CAIRN, with the deploy id as the resolver serves it, gets the mark.
// Run: npx tsx test/asset-tiles.test.mjs   (offline)
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PINNED_TOKENS } from "../src/core/cairnx.ts";
import { tokenTileHtml } from "../src/popup/tiles.ts";
import { checker } from "./helpers/check.mjs";

const { check, done } = checker("asset tiles");
const ROOT = join(import.meta.dirname, "..");
const read = (p) => readFileSync(join(ROOT, p), "utf8");
const PIN = PINNED_TOKENS.CAIRN.deployId;
const MARK = '<use href="ui/mark.svg#mark"/>';
const NEUTRAL = '<use href="icons.svg#i-coins"/>';

// the live resolver's record for CAIRN (https://cairn-substrate.com/trade/api/cairnx/token/CAIRN, read 2026-10-26)
check("the pinned CAIRN, its deploy id as served, gets the Cairn mark", tokenTileHtml("CAIRN", "0xdf7113afc41319b700c26f26ba657c8267533a3dd511cc59776601a9aba03517").includes(MARK));
check("the deploy id compares case-insensitively", tokenTileHtml("CAIRN", PIN.toUpperCase().replace("0X", "0x")).includes(MARK));
check("a CAIRN from another deploy gets the neutral glyph", tokenTileHtml("CAIRN", "0x" + "ab".repeat(32)).includes(NEUTRAL));
check("a CAIRN whose token record did not load (no deploy id) gets the neutral glyph", tokenTileHtml("CAIRN", undefined).includes(NEUTRAL));
for (const t of ["CAIRNX", "CAIRN2", "CAlRN", "XCAIRN", "SUN", "BTC", "constructor", "__proto__", "toString"]) {
  const html = tokenTileHtml(t, PIN);
  check(`${t} with the pinned deploy id gets the neutral glyph and no part of its ticker`, html.includes(NEUTRAL) && !html.includes(MARK) && !html.includes(t));
}
check("the mark tile draws in the vendored mark's viewBox", tokenTileHtml("CAIRN", PIN).includes('viewBox="300 330 590 530"'));

const html = read("src/popup/popup.html");
const csdRow = /<button id="csd-row"[\s\S]*?<\/button>/.exec(html)?.[0] ?? "";
check("the CSD row's tile is the coin's logo tile", csdRow.includes('<span class="ti coin-csd" aria-hidden="true"></span>'));
check("the CSD row draws no Cairn mark", !csdRow.includes("mark"));
const css = read("src/popup/popup.css");
const rule = /\.ti\.coin-csd \{([^}]*)\}/.exec(css)?.[1] ?? "";
check("popup.css draws ui/csd-logo.jpg in the CSD tile, cover, with the avatar's hairline", rule.includes('url("ui/csd-logo.jpg") center / cover') && rule.includes("inset 0 0 0 1px color-mix(in oklab, var(--ui-ink) 8%, transparent)"));
const vendor = read("src/vendor/cairn-ui/avatar.css");
check("the hairline is the avatar's (avatar.css draws the same one)", vendor.includes("box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--ui-ink) 8%, transparent)"));

const assets = read("src/popup/popup-assets.ts");
check("the token rows take their tile from tokenTileHtml with the served deploy id", assets.includes("tokenTileHtml(t, meta[t]?.deployId)"));
check("the token meta keeps the served deploy id", /deployId: typeof t\.deployId === "string" \? t\.deployId : undefined/.test(assets));
check("no token row writes a tile of its own", !assets.includes('<span class="ti"><svg'));

done("asset-tiles");
