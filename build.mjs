// Bundle the extension with esbuild (no external imports at runtime — everything,
// incl. @noble, is inlined). background + popup are ES modules; content + inpage
// run as classic scripts (IIFE).
import * as esbuild from "esbuild";
import { cpSync, mkdirSync, rmSync, readFileSync, readdirSync, statSync } from "node:fs";

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

// Version-sync tripwire: package.json is the single source of truth for the release version.
// The Chrome Web Store shows manifest.json's version, and dApps read window.cairn.version from
// inpage.ts — all three MUST agree. v0.2.21 shipped with a manifest/inpage left at 0.2.20 (the
// browser kept showing the old version); this guard makes that class of release-hygiene drift a
// hard build failure instead of a silent ship. (No literal "version" key match: scan structurally.)
const PKG_VERSION = JSON.parse(readFileSync("package.json", "utf8")).version;
const manifestVersion = JSON.parse(readFileSync("public/manifest.json", "utf8")).version;
// inpage.ts carries the version in MORE than one place (window.cairn.version AND getCapabilities().version);
// check EVERY `version:` string, not just the first, so a drift in only the capabilities string (which a
// dApp reads) can't slip through. (audit N2: the old single-match regex left line ~64 unguarded.)
const inpageVersions = [...readFileSync("src/inpage.ts", "utf8").matchAll(/version:\s*"([^"]+)"/g)].map((m) => m[1]);
if (inpageVersions.length === 0) { console.error("✗ build aborted: no version: string found in src/inpage.ts"); process.exit(1); }
const versionChecks = [["public/manifest.json", manifestVersion], ...inpageVersions.map((v, i) => [`src/inpage.ts (version #${i + 1})`, v])];
for (const [where, v] of versionChecks) {
  if (v !== PKG_VERSION) {
    console.error(`✗ build aborted: version drift — package.json is ${PKG_VERSION} but ${where} is ${v}. Bump them in lockstep.`);
    process.exit(1);
  }
}
console.log(`✓ version sync: ${PKG_VERSION} (package.json == manifest == inpage ×${inpageVersions.length})`);

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
