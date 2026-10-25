// The popup's type on the real chrome-extension:// origin. Chrome gives every extension page a built-in stylesheet
// that sets the body's font-family and font-size: 75% as unlayered author styles; those outrank every cascade layer
// in popup.css, so the popup rendered in the platform font at 12 px while a plain http origin showed Geist at 14 px.
// This loads the shipped popup page, its stylesheet and the vendored cairn-ui files as an unpacked MV3 extension with
// the manifest's own CSP, and checks the body font and that the page itself loads Geist and Geist Mono faces.
// Needs playwright-core (PLAYWRIGHT_CORE, see scripts/playwright-core.mjs) and a Chromium (PLAYWRIGHT_CHROMIUM, or
// playwright's own). Without playwright-core or a Chromium binary it prints SKIP; it runs where both are installed.
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UI_SHIP, UI_VENDOR_DIR } from "../scripts/check-ui-vendor.mjs";
import { findChromium } from "../scripts/playwright-core.mjs";
import { checker } from "./helpers/check.mjs";

const chromium = await findChromium();
if (!chromium) {
  console.log("SKIP: playwright-core not found (set PLAYWRIGHT_CORE); runs when it is installed");
  process.exit(0);
}
const t = checker("popup type on chrome-extension://");
const ROOT = join(import.meta.dirname, "..");
const work = mkdtempSync(join(tmpdir(), "popup-font-"));
const ext = join(work, "ext");
mkdirSync(join(ext, "ui"), { recursive: true });
const manifest = JSON.parse(readFileSync(join(ROOT, "public", "manifest.json"), "utf8"));
writeFileSync(join(ext, "manifest.json"), JSON.stringify({ manifest_version: 3, name: "popup font test", version: "1.0.0", content_security_policy: manifest.content_security_policy }));
// The page without its module script: the type comes from the stylesheets alone.
writeFileSync(join(ext, "popup.html"), readFileSync(join(ROOT, "src", "popup", "popup.html"), "utf8").replace(/<script type="module"[^>]*><\/script>/, ""));
for (const f of ["popup.css", "icons.svg"]) cpSync(join(ROOT, "src", "popup", f), join(ext, f));
for (const f of UI_SHIP) cpSync(join(UI_VENDOR_DIR, f), join(ext, "ui", f));

let ctx;
try {
  try {
    ctx = await chromium.launchPersistentContext(join(work, "profile"), {
      headless: false, executablePath: process.env.PLAYWRIGHT_CHROMIUM || undefined,
      args: ["--headless=new", `--disable-extensions-except=${ext}`, `--load-extension=${ext}`, "--no-sandbox", "--no-first-run"],
    });
  } catch (e) {
    if (!/executable doesn't exist|ENOENT/i.test(String(e?.message))) throw e;
    console.log(`SKIP: no Chromium binary for playwright-core (set PLAYWRIGHT_CHROMIUM): ${String(e.message).split("\n")[0]}`);
    process.exit(0);
  }
  const page = await ctx.newPage();
  const csp = [];
  page.on("console", (m) => { if (/Content Security Policy|Refused to/i.test(m.text())) csp.push(m.text()); });
  // An unpacked extension's id is derived from its path; the page is opened on that origin.
  let id = null;
  await page.goto("chrome://extensions/");
  id = await page.evaluate(async () => (await chrome.management.getAll()).find((x) => x.name === "popup font test")?.id ?? null).catch(() => null);
  t.check(`the test extension loaded (id ${id})`, !!id);
  if (id) {
    await page.goto(`chrome-extension://${id}/popup.html`);
    // Show text in both faces and let the page load what it uses; document.fonts.check() alone is true when no face
    // matches at all, so the test reads the loaded faces themselves.
    const r = await page.evaluate(async () => {
      document.getElementById("view-main").hidden = false;
      document.getElementById("acct-select").innerHTML = '<span class="acct-cur">Main</span><span class="acct-addr">0x7a3f9c…9c21</span>';
      document.getElementById("balance").textContent = "1,284.735";
      await new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(ok)));
      await document.fonts.ready;
      const s = getComputedStyle(document.body);
      const loaded = (family) => [...document.fonts].some((f) => f.family.replace(/"/g, "") === family && f.status === "loaded");
      return { family: s.fontFamily.split(",")[0].replace(/"/g, "").trim(), size: s.fontSize, geist: loaded("Geist"), mono: loaded("Geist Mono") };
    });
    t.check(`body text is Geist, not the platform font Chrome sets for extension pages (got ${r.family})`, r.family === "Geist");
    t.check(`body text is 16 px (--ui-text-md), not Chrome's 75% (got ${r.size})`, r.size === "16px");
    t.check(`the page loads a Geist face and a Geist Mono face under the manifest CSP (font-src 'self'): ${r.geist}, ${r.mono}`, r.geist && r.mono);
    t.check(`no CSP refusal on the page (${csp.join(" | ") || "none"})`, csp.length === 0);
  }
} finally {
  await ctx?.close();
  rmSync(work, { recursive: true, force: true });
}
t.done("popup-font-chrome");
