// The Cairn mark as the vendored cairn-ui file draws it (src/vendor/cairn-ui/mark.svg, its one home): the viewBox
// the pages draw it in and its six parts. The extension icons (scripts/gen-icons.mjs), the store images
// (store/gen-assets.mjs) and test/mark-home.test.mjs read it here; nothing else holds the mark's geometry.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { UI_VENDOR_DIR } from "./check-ui-vendor.mjs";

export const MARK_FILE = join(UI_VENDOR_DIR, "mark.svg");

/** The mark's root viewBox, its parts as markup (ids dropped) and each part as a closed polygon of [x, y] points.
 *  Throws on a part this reader cannot turn into a polygon (a path command other than M, L or Z), so a changed mark
 *  fails loudly instead of drawing wrong. */
export function readMark(svg = readFileSync(MARK_FILE, "utf8")) {
  const viewBox = /<svg\b[^>]*\sviewBox="([^"]+)"/.exec(svg)?.[1];
  if (!viewBox) throw new Error("mark.svg: no viewBox on the root <svg>");
  const parts = svg.match(/<(path|rect|polygon)\b[^>]*\/>/g) || [];
  if (parts.length !== 6) throw new Error(`mark.svg: expected the mark's 6 parts, found ${parts.length}`);
  const attr = (el, name) => {
    const v = new RegExp(`\\s${name}="([^"]*)"`).exec(el)?.[1];
    if (v === undefined) throw new Error(`mark.svg: ${el} has no ${name}`);
    return v;
  };
  const num = (s) => {
    const n = Number(s);
    if (!Number.isFinite(n)) throw new Error(`mark.svg: ${s} is not a number`);
    return n;
  };
  const polygons = parts.map((el) => {
    if (el.startsWith("<rect")) {
      const [x, y, w, h] = ["x", "y", "width", "height"].map((a) => num(attr(el, a)));
      return [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
    }
    if (el.startsWith("<polygon")) {
      const xs = attr(el, "points").trim().split(/[\s,]+/).map(num);
      return Array.from({ length: xs.length / 2 }, (_, i) => [xs[2 * i], xs[2 * i + 1]]);
    }
    const tokens = attr(el, "d").trim().split(/\s+|(?=[A-Za-z])|(?<=[A-Za-z])/).filter(Boolean);
    const pts = [];
    for (let i = 0; i < tokens.length;) {
      const c = tokens[i++];
      if (c === "Z") break;
      if (c !== "M" && c !== "L") throw new Error(`mark.svg: path command ${c} is not M, L or Z`);
      pts.push([num(tokens[i++]), num(tokens[i++])]);
    }
    return pts;
  });
  return { viewBox, parts: parts.map((p) => p.replace(/\s+id="[^"]*"/, "")), polygons };
}
