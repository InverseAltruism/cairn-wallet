#!/usr/bin/env node
// Writes the extension icons public/icons/icon-{16,32,48,128}.png (the manifest's action and app icons; icon-128 is also
// the store icon) from the vendored Cairn mark (scripts/mark.mjs) and the light theme's ink tokens: the mark in
// --ui-on-ink on an --ui-ink tile with rounded corners. Pure JavaScript, so the pixels do not depend on a browser:
// each pixel's coverage is counted on a fixed 16 by 16 sample grid, and the same input gives the same bytes.
// test/extension-icons.test.mjs decodes the committed files and compares their pixels with iconPixels().
// Run: node scripts/gen-icons.mjs
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { deflateSync } from "node:zlib";
import { UI_VENDOR_DIR } from "./check-ui-vendor.mjs";
import { readMark } from "./mark.mjs";

const OUT = join(import.meta.dirname, "..", "public", "icons");
export const ICON_SIZES = [16, 32, 48, 128];
const SS = 16;

/** Each size's tile inset (transparent margin, px) and the share of the tile's side the mark's longer side takes. The
 *  128 px icon keeps Chrome's 16 px margin for store and management-page icons; the toolbar sizes fill the frame, and
 *  the mark grows at 16 px so its stones stay apart. */
const LAYOUT = { 16: { inset: 0, fill: 0.8 }, 32: { inset: 0, fill: 0.74 }, 48: { inset: 0, fill: 0.72 }, 128: { inset: 16, fill: 0.68 } };
const RADIUS = 0.22; // corner radius as a share of the tile's side (the site's favicon-32 uses 7 of 32)

/** --ui-ink and --ui-on-ink from the light block of tokens.css, as [r, g, b]. */
export function lightInks(tokensCss = readFileSync(join(UI_VENDOR_DIR, "tokens.css"), "utf8")) {
  const start = tokensCss.indexOf('[data-theme="light"]');
  const block = tokensCss.slice(start, tokensCss.indexOf("}", start));
  const read = (name) => {
    const m = new RegExp(`${name}:\\s*#([0-9A-Fa-f]{6})\\b`).exec(block);
    if (start < 0 || !m) throw new Error(`${name} not found in the light block of tokens.css`);
    return [0, 2, 4].map((i) => Number.parseInt(m[1].slice(i, i + 2), 16));
  };
  return { ink: read("--ui-ink"), onInk: read("--ui-on-ink") };
}

/** Nonzero-winding point-in-polygon test. */
function inside(poly, x, y) {
  let wind = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [x0, y0] = poly[j], [x1, y1] = poly[i];
    if (y0 <= y) { if (y1 > y && (x1 - x0) * (y - y0) - (x - x0) * (y1 - y0) > 0) wind++; }
    else if (y1 <= y && (x1 - x0) * (y - y0) - (x - x0) * (y1 - y0) < 0) wind--;
  }
  return wind !== 0;
}

/** The icon at `size` px as straight-alpha RGBA rows. */
export function iconPixels(size, mark = readMark(), inks = lightInks()) {
  const { inset, fill } = LAYOUT[size] ?? (() => { throw new Error(`no layout for ${size} px`); })();
  const side = size - 2 * inset, rad = side * RADIUS;
  const all = mark.polygons.flat();
  const minX = Math.min(...all.map((p) => p[0])), maxX = Math.max(...all.map((p) => p[0]));
  const minY = Math.min(...all.map((p) => p[1])), maxY = Math.max(...all.map((p) => p[1]));
  const scale = (side * fill) / Math.max(maxX - minX, maxY - minY);
  const ox = inset + (side - (maxX - minX) * scale) / 2, oy = inset + (side - (maxY - minY) * scale) / 2;
  // the mark in pixel space, with each part's bounding box for a cheap reject
  const polys = mark.polygons.map((poly) => {
    const pts = poly.map(([x, y]) => [ox + (x - minX) * scale, oy + (y - minY) * scale]);
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    return { pts, x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
  });
  const inTile = (x, y) => {
    const lx = x - inset, ly = y - inset;
    if (lx < 0 || ly < 0 || lx > side || ly > side) return false;
    const cx = Math.min(Math.max(lx, rad), side - rad), cy = Math.min(Math.max(ly, rad), side - rad);
    return (lx - cx) ** 2 + (ly - cy) ** 2 <= rad * rad;
  };
  const rgba = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let tile = 0, ink = 0;
      for (let sy = 0; sy < SS; sy++) {
        const y = py + (sy + 0.5) / SS;
        for (let sx = 0; sx < SS; sx++) {
          const x = px + (sx + 0.5) / SS;
          if (!inTile(x, y)) continue;
          tile++;
          if (polys.some((p) => x >= p.x0 && x <= p.x1 && y >= p.y0 && y <= p.y1 && inside(p.pts, x, y))) ink++;
        }
      }
      const i = (py * size + px) * 4;
      if (!tile) continue;
      for (let c = 0; c < 3; c++) rgba[i + c] = Math.round((inks.ink[c] * (tile - ink) + inks.onInk[c] * ink) / tile);
      rgba[i + 3] = Math.round((255 * tile) / (SS * SS));
    }
  }
  return rgba;
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4), crc = Buffer.alloc(4), body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  len.writeUInt32BE(data.length);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
/** An 8-bit RGBA PNG, every row with filter type 0. */
export function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  mkdirSync(OUT, { recursive: true });
  const mark = readMark(), inks = lightInks();
  for (const s of ICON_SIZES) {
    const png = encodePng(s, iconPixels(s, mark, inks));
    writeFileSync(join(OUT, `icon-${s}.png`), png);
    console.log(`wrote public/icons/icon-${s}.png (${png.length} bytes)`);
  }
}
