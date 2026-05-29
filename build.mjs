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
import { existsSync } from "node:fs";
if (existsSync("public/icons")) cpSync("public/icons", "dist/icons", { recursive: true });
console.log("✓ built dist/ — load it unpacked in chrome://extensions (Developer mode → Load unpacked → dist/)");
