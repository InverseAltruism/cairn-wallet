// The Cairn mark has one home, the vendored cairn-ui mark.svg (src/vendor/cairn-ui/, checked byte for byte against
// PROVENANCE.json). The pages draw it through <use href="ui/mark.svg#mark"> in the file's own viewBox, the sprite
// icons.svg holds no copy, and no script or page carries its geometry: before 0.3.1 scripts/build-icons.mjs kept a
// hand copy of the six parts (traced from a PNG) and wrote it into the sprite, so a change to the mark in cairn-ui
// could not reach the wallet. scripts/mark.mjs is the one reader (the extension icons, the store images).
// RED-FIRST: restore src/popup/icons.svg and scripts/build-icons.mjs from 636f5d1 and the sprite and copy checks
// fail; give one use site another viewBox and its check fails.
// Run: npx tsx test/mark-home.test.mjs   (offline)
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readMark } from "../scripts/mark.mjs";
import { checker } from "./helpers/check.mjs";

const { check, done } = checker("the Cairn mark's one home");
const ROOT = join(import.meta.dirname, "..");
const read = (p) => readFileSync(join(ROOT, p), "utf8");
const mark = readMark();

const sprite = read("src/popup/icons.svg");
check("the sprite icons.svg holds no mark symbol", !/id="mark"/.test(sprite));

// every <svg> that draws the mark, in the pages and in the markup the scripts write
const sources = ["src/popup/popup.html", "src/popup/approve.html", ...execFileSync("git", ["ls-files", "src/popup/*.ts"], { cwd: ROOT, encoding: "utf8" }).split("\n").filter(Boolean)];
let uses = 0;
for (const f of sources) {
  const text = read(f);
  check(`${f}: no reference to a mark in the sprite`, !text.includes("icons.svg#mark"));
  for (const m of text.matchAll(/<svg\b([^>]*)>\s*<use href="ui\/mark\.svg#mark"\s*\/>/g)) {
    uses++;
    const vb = /\sviewBox="([^"]+)"/.exec(m[1])?.[1];
    check(`${f}: a mark drawn in the vendored viewBox (${vb})`, vb === mark.viewBox);
  }
  const loose = (text.match(/ui\/mark\.svg#mark/g) || []).length - [...text.matchAll(/<svg\b[^>]*>\s*<use href="ui\/mark\.svg#mark"\s*\/>/g)].length;
  check(`${f}: every mark <use> sits directly in its <svg> (${loose} loose)`, loose === 0);
}
check(`the pages and scripts draw the vendored mark (${uses} places)`, uses >= 5);

// no tracked file outside the vendored copy and its reader holds the mark's coordinates
const PROBES = ["586,378", "M323 417", "457,708"];
const tracked = execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" }).split("\n").filter((f) => f && /\.(m?js|ts|html|css|svg)$/.test(f));
const copies = tracked.filter((f) => f !== "src/vendor/cairn-ui/mark.svg" && f !== "test/mark-home.test.mjs" && PROBES.some((p) => read(f).includes(p)));
check(`no copy of the mark's geometry outside src/vendor/cairn-ui/mark.svg (${copies.join(", ") || "none"})`, copies.length === 0);
check("the copy probe finds the vendored file itself", PROBES.every((p) => read("src/vendor/cairn-ui/mark.svg").includes(p)));

done("mark-home");
