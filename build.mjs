// Bundle the extension with esbuild (no external imports at runtime — everything,
// incl. @noble, is inlined). background + popup are ES modules; content + inpage
// run as classic scripts (IIFE).
import * as esbuild from "esbuild";
import { cpSync, mkdirSync, rmSync } from "node:fs";

rmSync("dist", { recursive: true, force: true });
mkdirSync("dist", { recursive: true });

const common = { bundle: true, target: "es2022", logLevel: "info", legalComments: "none" };

await esbuild.build({ ...common, entryPoints: { background: "src/background.ts", popup: "src/popup/popup.ts" }, format: "esm", outdir: "dist", splitting: false });
await esbuild.build({ ...common, entryPoints: { content: "src/content.ts", inpage: "src/inpage.ts" }, format: "iife", outdir: "dist" });

cpSync("public/manifest.json", "dist/manifest.json");
cpSync("src/popup/popup.html", "dist/popup.html");
cpSync("src/popup/popup.css", "dist/popup.css");
console.log("✓ built dist/ — load it unpacked in chrome://extensions (Developer mode → Load unpacked → dist/)");
