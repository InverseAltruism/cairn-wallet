// Bundle the extension with esbuild (no external imports at runtime — everything,
// incl. @noble, is inlined). background + popup are ES modules; content + inpage
// run as classic scripts (IIFE).
import * as esbuild from "esbuild";
import { cpSync, mkdirSync, rmSync, readFileSync, readdirSync, statSync } from "node:fs";

// F12 tripwire: the popup-isolation argument rests on the extension having NO external message
// surface. Fail the build HARD if anything re-introduces one, so the assertion in background.ts
// can never quietly become load-bearing-but-false. (Mirrored as a test in extension-boundary.ts.)
const FORBIDDEN = ["externally" + "_connectable", "onMessage" + "External"]; // split so this guard never self-trips
for (const dir of ["src", "public"]) {
  const walk = (p) => { for (const e of readdirSync(p)) { const f = p + "/" + e; if (statSync(f).isDirectory()) walk(f); else {
    const txt = readFileSync(f, "utf8");
    for (const bad of FORBIDDEN) if (txt.includes(bad)) { console.error(`✗ build aborted: forbidden external-message surface "${bad}" found in ${f}`); process.exit(1); }
  } } };
  walk(dir);
}

// Version-sync tripwire: package.json is the single source of truth for the release version.
// The Chrome Web Store shows manifest.json's version, and dApps read window.cairn.version from
// inpage.ts — all three MUST agree. v0.2.21 shipped with a manifest/inpage left at 0.2.20 (the
// browser kept showing the old version); this guard makes that class of release-hygiene drift a
// hard build failure instead of a silent ship. (No literal "version" key match: scan structurally.)
const PKG_VERSION = JSON.parse(readFileSync("package.json", "utf8")).version;
const manifestVersion = JSON.parse(readFileSync("public/manifest.json", "utf8")).version;
const inpageMatch = readFileSync("src/inpage.ts", "utf8").match(/version:\s*"([^"]+)"/);
const inpageVersion = inpageMatch && inpageMatch[1];
for (const [where, v] of [["public/manifest.json", manifestVersion], ["src/inpage.ts", inpageVersion]]) {
  if (v !== PKG_VERSION) {
    console.error(`✗ build aborted: version drift — package.json is ${PKG_VERSION} but ${where} is ${v}. Bump them in lockstep.`);
    process.exit(1);
  }
}
console.log(`✓ version sync: ${PKG_VERSION} (package.json == manifest == inpage)`);

rmSync("dist", { recursive: true, force: true });
mkdirSync("dist", { recursive: true });

const common = { bundle: true, target: "es2022", logLevel: "info", legalComments: "none" };

await esbuild.build({ ...common, entryPoints: { background: "src/background.ts", popup: "src/popup/popup.ts", approve: "src/popup/approve.ts" }, format: "esm", outdir: "dist", splitting: false });
await esbuild.build({ ...common, entryPoints: { content: "src/content.ts", inpage: "src/inpage.ts" }, format: "iife", outdir: "dist" });

cpSync("public/manifest.json", "dist/manifest.json");
cpSync("src/popup/popup.html", "dist/popup.html");
cpSync("src/popup/approve.html", "dist/approve.html");
cpSync("src/popup/popup.css", "dist/popup.css");
import { existsSync, mkdirSync as _mkdirSync } from "node:fs";
// Ship ONLY the icons the extension actually references (the sized action icons + the popup
// logo) — not the source master `icon.png` (62KB, unreferenced) that gen-icons.mjs derives from.
const SHIP_ICONS = ["icon-16.png", "icon-32.png", "icon-48.png", "icon-128.png", "logo-white.png"];
if (existsSync("public/icons")) {
  _mkdirSync("dist/icons", { recursive: true });
  for (const f of SHIP_ICONS) if (existsSync(`public/icons/${f}`)) cpSync(`public/icons/${f}`, `dist/icons/${f}`);
}
console.log("✓ built dist/ — load it unpacked in chrome://extensions (Developer mode → Load unpacked → dist/)");
