// Generate bold, padding-free Cairn toolbar icons (16/32/48/128) with no external image deps.
// A "cairn" = stacked stones. We draw 3 dark stones (decreasing width upward) on a bright
// phosphor-green rounded square that FILLS the frame — so it stays punchy and visible at 16px
// on both light and dark Chrome toolbars. Pure JS: RGBA buffer + node:zlib for the PNG IDAT.
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "icons");
mkdirSync(OUT, { recursive: true });

const GREEN = [0x57, 0xd9, 0x77]; // --green phosphor
const STONE = [0x06, 0x08, 0x07]; // near-black
const BG    = [0x06, 0x08, 0x07]; // transparent-corner fill (alpha 0 anyway)

// ---- PNG encode (8-bit RGBA) ----
const crcTable = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; }
  return t;
})();
function crc32(buf) { let c = ~0; for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return ~c >>> 0; }
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const tb = Buffer.from(type, "ascii");
  const body = Buffer.concat([tb, data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
function encodePNG(w, h, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0; // 8-bit, RGBA
  const raw = Buffer.alloc(h * (w * 4 + 1));
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4); }
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

// ---- drawing ----
function makeIcon(S) {
  const buf = Buffer.alloc(S * S * 4); // RGBA, all zero = transparent
  const set = (x, y, rgb, a = 255) => {
    if (x < 0 || y < 0 || x >= S || y >= S) return;
    const i = (y * S + x) * 4; buf[i] = rgb[0]; buf[i + 1] = rgb[1]; buf[i + 2] = rgb[2]; buf[i + 3] = a;
  };
  const r = Math.max(2, Math.round(S * 0.22)); // bg corner radius
  const inRounded = (x, y, x0, y0, x1, y1, rad) => {
    if (x < x0 || y < y0 || x > x1 || y > y1) return false;
    const cx = x < x0 + rad ? x0 + rad : x > x1 - rad ? x1 - rad : x;
    const cy = y < y0 + rad ? y0 + rad : y > y1 - rad ? y1 - rad : y;
    const dx = x - cx, dy = y - cy; return dx * dx + dy * dy <= rad * rad;
  };
  // bright green rounded square filling the frame
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) if (inRounded(x, y, 0, 0, S - 1, S - 1, r)) set(x, y, GREEN);

  // three stacked stones (cairn), centered, decreasing width upward
  const mid = (S - 1) / 2;
  const stoneH = Math.max(2, Math.round(S * 0.165));
  const gap = Math.max(1, Math.round(S * 0.075));
  const totalH = stoneH * 3 + gap * 2;
  let top = Math.round((S - totalH) / 2);
  const usable = S * 0.62;
  const widths = [usable, usable * 0.7, usable * 0.42]; // bottom→top
  const rows = [top + (stoneH + gap) * 2, top + (stoneH + gap), top]; // y of each stone top: bottom,mid,top
  for (let s = 0; s < 3; s++) {
    const w = widths[s], y0 = rows[s], y1 = y0 + stoneH - 1;
    const x0 = Math.round(mid - w / 2), x1 = Math.round(mid + w / 2);
    const rad = Math.max(1, Math.round(stoneH * 0.45));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (inRounded(x, y, x0, y0, x1, y1, rad)) set(x, y, STONE);
  }
  return encodePNG(S, S, buf);
}

for (const S of [16, 32, 48, 128]) {
  const png = makeIcon(S);
  writeFileSync(join(OUT, `icon-${S}.png`), png);
  console.log(`wrote icon-${S}.png (${png.length} bytes)`);
}
