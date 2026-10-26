// The tile at the start of a token row (the CSD row's, popup.html `.ti.coin-csd`, is static). Markup only (no DOM), so
// test/asset-tiles.test.mjs runs it offline.
import { isPinnedDeploy } from "../core/cairnx.js";

const NEUTRAL_TILE = `<span class="ti"><svg class="i" aria-hidden="true"><use href="icons.svg#i-coins"/></svg></span>`;
// The logos of tokens the wallet pins (PINNED_TOKENS), by ticker. The Cairn mark is the CAIRN token's.
const TOKEN_LOGOS: Readonly<Record<string, string>> = Object.freeze({
  CAIRN: `<span class="ti"><svg class="mark" viewBox="300 330 590 530" aria-hidden="true"><use href="ui/mark.svg#mark"/></svg></span>`,
});

/** A token row's tile. A logo is drawn only for a token whose served deploy id is the one the wallet pins for that
 *  ticker; any other token, a same-ticker token from another deploy and a token whose record did not load (no deploy
 *  id) get the neutral glyph. No tile shows part of a ticker: that would be a look-alike, and the full ticker is the
 *  row's title. */
export function tokenTileHtml(ticker: string, deployId: unknown): string {
  const logo = Object.prototype.hasOwnProperty.call(TOKEN_LOGOS, ticker) ? TOKEN_LOGOS[ticker] : undefined;
  return logo && isPinnedDeploy(ticker, deployId) ? logo : NEUTRAL_TILE;
}
