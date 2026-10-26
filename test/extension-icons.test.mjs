// The extension icons are the Cairn mark on an ink tile, drawn from the vendored cairn-ui mark.svg by
// scripts/gen-icons.mjs. The committed PNGs must hold exactly the pixels the script computes from the vendored mark
// and the light ink tokens (decoded and compared pixel by pixel, so the check does not depend on the zlib build), and
// the manifest and the build name exactly these four files. Before 0.3.1 the icons were a hand-drawn green tile with
// three bars, kept by no test; the owner saw it in the toolbar after the redesign went live.
// RED-FIRST: restore public/icons/ from 636f5d1 and every pixel check fails; change --ui-on-ink in the vendored
// tokens.css (or move one point of mark.svg) and the pixel checks fail until the script is re-run.
// Run: npx tsx test/extension-icons.test.mjs   (offline)
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { ICON_SIZES, iconPixels, lightInks } from "../scripts/gen-icons.mjs";
import { readMark } from "../scripts/mark.mjs";
import { checker } from "./helpers/check.mjs";

const { check, done } = checker("extension icons");
const ROOT = join(import.meta.dirname, "..");

/** A PNG this repo's encoder wrote, decoded to { size, rgba }: 8-bit RGBA, one IDAT, filter type 0 on every row. */
function decode(buf) {
  if (buf.toString("latin1", 1, 4) !== "PNG") return null;
  let at = 8, w = 0, h = 0, kind = "", idat = [];
  while (at < buf.length) {
    const len = buf.readUInt32BE(at), type = buf.toString("latin1", at + 4, at + 8), data = buf.subarray(at + 8, at + 8 + len);
    if (type === "IHDR") { w = data.readUInt32BE(0); h = data.readUInt32BE(4); kind = `${data[8]}/${data[9]}`; }
    if (type === "IDAT") idat.push(data);
    at += 12 + len;
  }
  if (kind !== "8/6" || w !== h) return null;
  const raw = inflateSync(Buffer.concat(idat)), stride = w * 4 + 1, rgba = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    if (raw[y * stride] !== 0) return null;
    raw.copy(rgba, y * w * 4, y * stride + 1, (y + 1) * stride);
  }
  return { size: w, rgba };
}

const mark = readMark(), inks = lightInks();
check(`the mark reads from the vendored mark.svg: viewBox ${mark.viewBox}, ${mark.polygons.length} parts`, mark.viewBox === "300 330 590 530" && mark.polygons.length === 6);
check(`the tile is the light ink ${inks.ink.join(",")} and the mark the light on-ink ${inks.onInk.join(",")}`, inks.ink.join() === "12,12,11" && inks.onInk.join() === "255,255,255");

for (const s of ICON_SIZES) {
  const want = iconPixels(s, mark, inks);
  check(`icon-${s}: the script is deterministic (two runs, same pixels)`, want.equals(iconPixels(s, mark, inks)));
  const got = decode(readFileSync(join(ROOT, "public", "icons", `icon-${s}.png`)));
  check(`icon-${s}.png is a ${s} by ${s} RGBA PNG`, !!got && got.size === s);
  check(`icon-${s}.png holds the pixels gen-icons.mjs draws from the vendored mark`, !!got && got.rgba.equals(want));
  // the old icon was a phosphor-green tile: no pixel of the new one is green-dominant
  const px = got ? got.rgba : Buffer.alloc(0);
  let green = 0, opaqueInk = 0, white = 0;
  for (let i = 0; i < px.length; i += 4) {
    if (px[i + 3] > 0 && px[i + 1] > px[i] + 20) green++;
    if (px[i + 3] === 255 && px[i] === 12 && px[i + 1] === 12 && px[i + 2] === 11) opaqueInk++;
    if (px[i + 3] === 255 && px[i] === 255 && px[i + 1] === 255 && px[i + 2] === 255) white++;
  }
  check(`icon-${s}: no green pixel (${green}), an ink tile (${opaqueInk} px) and the white mark (${white} px)`, green === 0 && opaqueInk > s * s * 0.25 && white > 0);
}
const corner = iconPixels(128, mark, inks);
check("icon-128 keeps Chrome's 16 px transparent margin", corner[(8 * 128 + 64) * 4 + 3] === 0 && corner[(64 * 128 + 8) * 4 + 3] === 0 && corner[(64 * 128 + 20) * 4 + 3] === 255);
const c16 = iconPixels(16, mark, inks);
check("icon-16 fills its frame, with rounded corners", c16[3] < 255 && c16[(8 * 16 + 0) * 4 + 3] === 255);

const manifest = JSON.parse(readFileSync(join(ROOT, "public", "manifest.json"), "utf8"));
const names = ICON_SIZES.map((s) => `icons/icon-${s}.png`);
for (const key of ["icons"]) check(`manifest ${key} names exactly the four icons`, JSON.stringify(Object.values(manifest[key])) === JSON.stringify(names));
check("manifest action.default_icon names exactly the four icons", JSON.stringify(Object.values(manifest.action.default_icon)) === JSON.stringify(names));
const build = readFileSync(join(ROOT, "build.mjs"), "utf8");
check("build.mjs ships the four icons", ICON_SIZES.every((s) => build.includes(`"icon-${s}.png"`)));

done("extension-icons");
