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

const unshipped = (html) => [...html.matchAll(/(?:src|href)="ui\/([^"]+)"/g)].map((m) => m[1]).filter((f) => !UI_SHIP.includes(f));
for (const page of ["popup.html", "approve.html"]) {
  const html = readFileSync(join(import.meta.dirname, "..", "src", "popup", page), "utf8");
  const refs = [...html.matchAll(/(?:src|href)="ui\/([^"]+)"/g)].length;
  const missing = unshipped(html);
  check(`${page}: each of its ${refs} ui/ files is shipped (${missing.join(", ") || "none missing"})`, refs > 0 && missing.length === 0);
}
check("a page loading an unshipped ui/ file is caught", unshipped('<link rel="stylesheet" href="ui/override.css" />').join() === "override.css");

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
