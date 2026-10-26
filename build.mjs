// Bundle the extension with esbuild (no external imports at runtime — everything,
// incl. @noble, is inlined). background + popup are ES modules; content + inpage
// run as classic scripts (IIFE).
import * as esbuild from "esbuild";
import { assertStampedVersion, assertVersionLockstep, manifestVersionInDist } from "./scripts/package.mjs";
import { UI_SHIP, UI_VENDOR_DIR, verifyUiVendor } from "./scripts/check-ui-vendor.mjs";
import { cpSync, mkdirSync, rmSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";

// F12 tripwire: the popup-isolation argument rests on the extension having NO external message
// surface. Fail the build HARD if anything re-introduces one, so the assertion in background.ts
// can never quietly become load-bearing-but-false. (Mirrored as a test in extension-boundary.ts.)
// onConnectExternal is the PORT-based sibling of onMessageExternal: both are external-message entrypoints
// enabled by externally_connectable, and either one re-opens the surface the popup-isolation argument
// rests on. B8w adds it so a future port-based external listener is a hard build failure too.
const FORBIDDEN = ["externally" + "_connectable", "onMessage" + "External", "onConnect" + "External"]; // split so this guard never self-trips
for (const dir of ["src", "public"]) {
  const walk = (p) => { for (const e of readdirSync(p)) { const f = p + "/" + e; if (statSync(f).isDirectory()) walk(f); else {
    const txt = readFileSync(f, "utf8");
    for (const bad of FORBIDDEN) if (txt.includes(bad)) { console.error(`✗ build aborted: forbidden external-message surface "${bad}" found in ${f}`); process.exit(1); }
  } } };
  walk(dir);
}

// package.json is the only place the release version is written. The build stamps it into
// dist/manifest.json and into window.cairn (esbuild define), so the shipped copies cannot drift
// (v0.2.21 once shipped a manifest/inpage left at the previous version).
const PKG_VERSION = JSON.parse(readFileSync("package.json", "utf8")).version;

// Source-host tripwire (NSPV-CLARVIS-MANIFEST-1 / H2): every hardcoded remote host the wallet FETCHES from —
// name-history resolver sources + the SPV RPC/header origins (the `*_RPC` / `*_API` constants in wallet.ts) —
// MUST appear in BOTH the CSP `connect-src` and `host_permissions`, or the packaged MV3 worker silently
// CSP-blocks it and the verify fail-softs (clarvis was dead-on-arrival exactly this way). This makes adding a
// future source-without-permission a hard build failure. Navigation-only constants (e.g. EXPLORER) are
// intentionally NOT matched — they are opened in a tab, never fetched.
{
  const manifest = JSON.parse(readFileSync("public/manifest.json", "utf8"));
  const csp = manifest.content_security_policy?.extension_pages ?? "";
  const connectSrc = (csp.match(/connect-src([^;]*)/)?.[1] ?? "").trim().split(/\s+/);
  const hostPerms = manifest.host_permissions ?? [];
  // Scan the wallet's OWN source (NOT the vendored bundle, which takes its base URL as a parameter) for EVERY
  // hardcoded https:// host literal — so a future fetch host added in ANY form or file (not just a *_RPC/*_API
  // const in wallet.ts) is still required to be in the manifest (H2-TRIPWIRE-EVASION-1). Navigation-only hosts
  // (opened in a tab, never fetched) are explicitly allowlisted.
  const NAV_ALLOWLIST = new Set(["explorer.computesubstrate.org"]);
  const srcFiles = [];
  const walkSrc = (p) => { for (const e of readdirSync(p)) { const f = p + "/" + e; if (statSync(f).isDirectory()) { if (e !== "vendor") walkSrc(f); } else if (/\.(ts|js|mjs)$/.test(e)) srcFiles.push(f); } };
  walkSrc("src");
  const fetchedHosts = new Set();
  for (const f of srcFiles) {
    for (const m of readFileSync(f, "utf8").matchAll(/https:\/\/([a-z0-9.-]+)/gi)) {
      const host = m[1].toLowerCase().replace(/[.]+$/, "");
      // A real remote fetch host always has a dotted TLD; this skips placeholder/userinfo fragments that
      // appear in comments + the L5 validation examples ("https://user:pass@…", "https://your-node", …).
      if (host && host.includes(".") && !NAV_ALLOWLIST.has(host)) fetchedHosts.add(host);
    }
  }
  const cspCovers = (host) => connectSrc.some((tok) => {
    const m = tok.match(/^https:\/\/([^/]+?)(?::\*)?\/?$/); if (!m) return false;
    const pat = m[1];
    if (pat === host) return true;
    if (pat.startsWith("*.")) return host.endsWith(pat.slice(1)) && host !== pat.slice(2); // *.x.com covers a.x.com, not x.com
    return false;
  });
  const permCovers = (host) => hostPerms.some((p) => { try { return new URL(p.replace(/\*$/, "")).host === host; } catch { return false; } });
  const missing = [];
  for (const host of fetchedHosts) {
    const inCsp = cspCovers(host), inPerm = permCovers(host);
    if (!inCsp || !inPerm) missing.push(`${host} (connect-src:${inCsp ? "ok" : "MISSING"}, host_permissions:${inPerm ? "ok" : "MISSING"})`);
  }
  if (missing.length) {
    console.error(`✗ build aborted: wallet fetches host(s) absent from the manifest (CSP would block them → silent single-source):\n   - ${missing.join("\n   - ")}`);
    process.exit(1);
  }
  console.log(`✓ source-host coverage: ${[...fetchedHosts].join(", ")} all in connect-src + host_permissions`);
}

rmSync("dist", { recursive: true, force: true });
mkdirSync("dist", { recursive: true });

const common = { bundle: true, target: "es2022", logLevel: "info", legalComments: "none", define: { __WALLET_VERSION__: JSON.stringify(PKG_VERSION) } };

// MV3 service worker cannot dynamic-import: background + approve stay single-file.
await esbuild.build({ ...common, entryPoints: { background: "src/background.ts", approve: "src/popup/approve.ts" }, format: "esm", outdir: "dist", splitting: false });
// Popup gets its own build with splitting:true so the Wallet class lands in a dynamically
// imported chunk (a lone import() is INLINED when splitting:false).
await esbuild.build({ ...common, entryPoints: { popup: "src/popup/popup.ts" }, format: "esm", outdir: "dist", splitting: true, chunkNames: "[name]" });
await esbuild.build({ ...common, entryPoints: { content: "src/content.ts", inpage: "src/inpage.ts" }, format: "iife", outdir: "dist" });

{
  const { existsSync: _exists, readFileSync: _read, readdirSync: _ls } = await import("node:fs");
  const NEEDLE = "endpoint must be an https";
  if (!_exists("dist/popup.js")) { console.error("✗ build aborted: dist/popup.js missing after popup split"); process.exit(1); }
  const popupJs = _read("dist/popup.js", "utf8");
  const popupHits = (popupJs.match(new RegExp(NEEDLE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) || []).length;
  if (popupHits !== 0) {
    console.error(`✗ build aborted: Wallet class leaked into dist/popup.js (found ${NEEDLE} ×${popupHits}). popup entry must stay splitting:true with a dynamic Wallet import.`);
    process.exit(1);
  }
  const chunks = _ls("dist").filter((f) => f.endsWith(".js") && !["popup.js", "background.js", "approve.js", "content.js", "inpage.js"].includes(f));
  const chunkHits = chunks.reduce((n, f) => n + ((_read("dist/" + f, "utf8").match(new RegExp(NEEDLE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) || []).length), 0);
  if (chunkHits < 1) {
    console.error("✗ build aborted: Wallet/devshim chunk missing (expected endpoint-URL string in a split chunk, not popup.js)");
    process.exit(1);
  }
  console.log(`✓ popup isolation: ${NEEDLE} ×0 in popup.js, ×${chunkHits} in ${chunks.join(", ") || "(chunks)"}`);
}

writeFileSync("dist/manifest.json", JSON.stringify({ ...JSON.parse(readFileSync("public/manifest.json", "utf8")), version: PKG_VERSION }, null, 2) + "\n");
cpSync("src/popup/popup.html", "dist/popup.html");
cpSync("src/popup/approve.html", "dist/approve.html");
cpSync("src/popup/popup.css", "dist/popup.css");
cpSync("src/popup/icons.svg", "dist/icons.svg");
cpSync("src/popup/icons.LICENSE.txt", "dist/icons.LICENSE.txt");
// cairn-ui (tokens, fonts, theme scripts, the avatar's stylesheet): shipped only when every vendored byte matches its PROVENANCE.json.
{
  const problems = verifyUiVendor();
  if (problems.length) {
    console.error(`✗ build aborted: src/vendor/cairn-ui differs from its PROVENANCE.json:\n   - ${problems.join("\n   - ")}`);
    process.exit(1);
  }
  for (const f of UI_SHIP) cpSync(`${UI_VENDOR_DIR}/${f}`, `dist/ui/${f}`);
  console.log(`✓ cairn-ui: ${UI_SHIP.length} files match PROVENANCE.json, copied to dist/ui/`);
}
import { existsSync, mkdirSync as _mkdirSync } from "node:fs";
// The icons the manifest names, written by scripts/gen-icons.mjs from the vendored mark (test/extension-icons.test.mjs).
const SHIP_ICONS = ["icon-16.png", "icon-32.png", "icon-48.png", "icon-128.png"];
if (existsSync("public/icons")) {
  _mkdirSync("dist/icons", { recursive: true });
  for (const f of SHIP_ICONS) if (existsSync(`public/icons/${f}`)) cpSync(`public/icons/${f}`, `dist/icons/${f}`);
}
console.log("✓ built dist/ — load it unpacked in chrome://extensions (Developer mode → Load unpacked → dist/)");

// Output check: the stamp must have landed in every bundle and the manifest.
assertStampedVersion("dist", PKG_VERSION);
assertVersionLockstep(PKG_VERSION, manifestVersionInDist("dist"));
console.log(`✓ version stamp: ${PKG_VERSION} in dist/inpage.js and dist/manifest.json, no unreplaced placeholder`);
