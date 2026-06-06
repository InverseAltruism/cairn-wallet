// Bundle the extension with esbuild (no external imports at runtime — everything,
// incl. @noble, is inlined). background + popup are ES modules; content + inpage
// run as classic scripts (IIFE).
import * as esbuild from "esbuild";
import { cpSync, mkdirSync, rmSync } from "node:fs";

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
