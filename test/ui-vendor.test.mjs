// The vendored cairn-ui copy (src/vendor/cairn-ui/) is checked byte for byte against its PROVENANCE.json, by
// scripts/check-ui-vendor.mjs and by build.mjs before it ships the files. A changed byte, a dropped file or an
// unrecorded extra file must each fail the check; the committed copy must pass it. Every ui/ file the two pages load must
// be one the build ships, or it is missing from dist/ and the page loads without it.
// Run: npx tsx test/ui-vendor.test.mjs   (offline)
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UI_SHIP, UI_VENDOR_DIR, verifyUiVendor } from "../scripts/check-ui-vendor.mjs";
import { checker } from "./helpers/check.mjs";

const { check, done } = checker("cairn-ui vendor gate");
const SCRIPT = join(import.meta.dirname, "..", "scripts", "check-ui-vendor.mjs");

const honest = verifyUiVendor();
check(`the committed copy matches PROVENANCE.json (${honest.join("; ") || "no problems"})`, honest.length === 0);
const prov = JSON.parse(readFileSync(join(UI_VENDOR_DIR, "PROVENANCE.json"), "utf8"));
check("PROVENANCE.json records every file the build ships", UI_SHIP.every((f) => f in prov.files));

// a ui/ file named by an attribute (src, href, a <use> href with its #fragment) or a CSS url(); the fragment is not
// part of the file
const UI_REF = /(?:(?:src|href)="|url\(["']?)ui\/([^"'#)]+)/g;
const uiRefs = (text) => [...text.matchAll(UI_REF)].map((m) => m[1]);
const unshipped = (text) => uiRefs(text).filter((f) => !UI_SHIP.includes(f));
for (const file of ["popup.html", "approve.html", "popup.css", "tiles.ts"]) {
  const text = readFileSync(join(import.meta.dirname, "..", "src", "popup", file), "utf8");
  const refs = uiRefs(text).length;
  const missing = unshipped(text);
  check(`${file}: each of its ${refs} ui/ references names a shipped file (${missing.join(", ") || "none missing"})`, refs > 0 && missing.length === 0);
}
check("a page loading an unshipped ui/ file is caught", unshipped('<link rel="stylesheet" href="ui/override.css" />').join() === "override.css");
check("a <use> of an unshipped ui/ file is caught, fragment dropped", unshipped('<use href="ui/stamp.svg#stamp"/>').join() === "stamp.svg");
check("a CSS url() of an unshipped ui/ file is caught", unshipped('.x{background:url("ui/logo.png")}').join() === "logo.png");

const work = mkdtempSync(join(tmpdir(), "ui-vendor-test-"));
try {
  const copy = (name) => {
    const d = join(work, name);
    cpSync(UI_VENDOR_DIR, d, { recursive: true });
    return d;
  };

  const flipped = copy("flipped");
  const css = readFileSync(join(flipped, "tokens.css"));
  css[css.length - 2] ^= 1;
  writeFileSync(join(flipped, "tokens.css"), css);
  const p1 = verifyUiVendor(flipped);
  check(`one changed byte in tokens.css fails, naming the file (${p1.join("; ")})`, p1.length === 1 && p1[0].startsWith("tokens.css: sha256"));

  const font = copy("font");
  const woff = readFileSync(join(font, "fonts/Geist-Latin.woff2"));
  woff[100] ^= 0xff;
  writeFileSync(join(font, "fonts/Geist-Latin.woff2"), woff);
  const p2 = verifyUiVendor(font);
  check(`a changed font byte fails (${p2.join("; ")})`, p2.length === 1 && p2[0].startsWith("fonts/Geist-Latin.woff2: sha256"));

  const dropped = copy("dropped");
  unlinkSync(join(dropped, "theme.js"));
  const p3 = verifyUiVendor(dropped);
  check(`a dropped file fails (${p3.join("; ")})`, p3.some((p) => p === "theme.js: recorded but missing"));

  const extra = copy("extra");
  writeFileSync(join(extra, "override.css"), ":root{--ui-ink:red}\n");
  const p4 = verifyUiVendor(extra);
  check(`an unrecorded extra file fails (${p4.join("; ")})`, p4.some((p) => p === "override.css: present but not recorded"));

  let code = 0;
  try {
    execFileSync(process.execPath, [SCRIPT], { stdio: "pipe" });
  } catch (e) {
    code = e.status ?? -1;
  }
  check(`the script exits 0 on the committed copy (exit ${code})`, code === 0);
} finally {
  rmSync(work, { recursive: true, force: true });
}

done("ui-vendor");
