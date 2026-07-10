#!/usr/bin/env node
// Wallet UI screenshot + invariant harness (dev-only; never shipped — scripts/ is not packaged).
//
// Standalone mode (default, headless, fast):
//   node scripts/ux-shots.mjs
// Serves dist/ over local HTTP and drives popup.html WITHOUT chrome.* (popup.ts falls back to a
// local Wallet against localStorage), walking create -> backup -> main -> send-review -> activity
// -> settings -> lock. Asserts:
//   - zero page errors / unexpected console errors (network-resource failures are allowlisted:
//     the standalone wallet talks to the live API and this harness must run offline too)
//   - every element ID referenced by src/popup/popup.ts + approve.ts exists in the served DOM
//     (a missing ID bricks the whole popup: module-top-level $()! listeners) — IDs created at
//     runtime via innerHTML are allowlisted below
//   - under prefers-reduced-motion: reduce, no animation runs on the visible view
// and captures canonical screenshots for before/after review + store-asset regeneration.
//
// Extension mode (headed; run under xvfb-run -a):
//   MODE=ext node scripts/ux-shots.mjs
// Loads dist/ as a real MV3 extension (persistent context) and screenshots
// chrome-extension://<id>/popup.html and approve.html.
//
// Env: SHOTS_DIR (default /tmp/wallet-shots) · STRICT_CONFIRM=1 (assert the send-confirm button
// is fully inside the 340x600 popup viewport — enable once the overlay layout ships) · PORT.

import http from "node:http";
import { readFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { join, extname, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(ROOT, "dist");
const SHOTS = process.env.SHOTS_DIR || "/tmp/wallet-shots";
const MODE = process.env.MODE || "standalone";
const STRICT_CONFIRM = process.env.STRICT_CONFIRM === "1";
const VIEWPORT = { width: Number(process.env.SHOT_W || 340), height: Number(process.env.SHOT_H || 600) }; // Chrome caps action popups around 600px tall; 360x640 for store raw captures

// ── deps: playwright-core is not a dependency of this repo. Resolution order: an explicit
// PLAYWRIGHT_CORE env path, this repo's own node_modules, then a normal module resolution from
// here (finds any parent/sibling install on the resolution path). No machine-specific paths.
async function loadChromium() {
  const candidates = [
    process.env.PLAYWRIGHT_CORE,
    join(ROOT, "node_modules", "playwright-core", "index.mjs"),
  ].filter(Boolean);
  for (const c of candidates) {
    if (existsSync(c)) return (await import(pathToFileURL(c).href)).chromium;
  }
  try {
    const { createRequire } = await import("node:module");
    const req = createRequire(import.meta.url);
    return (await import(pathToFileURL(req.resolve("playwright-core")).href)).chromium;
  } catch { /* fall through to the actionable error */ }
  throw new Error("playwright-core not found: set PLAYWRIGHT_CORE=/path/to/playwright-core/index.mjs or `npm i -D playwright-core`");
}
function chromiumExe() {
  const base = process.env.HOME + "/.cache/ms-playwright";
  for (const rev of ["chromium-1228", "chromium-1208", "chromium-1200"]) {
    for (const sub of ["chrome-linux64/chrome", "chrome-linux/chrome"]) {
      const p = join(base, rev, sub);
      if (existsSync(p)) return p;
    }
  }
  return undefined; // let playwright resolve its own
}

// ── ID inventory, derived from source so it tracks every phase automatically ──
// IDs that exist only after runtime innerHTML rendering (never in the static HTML):
const DYNAMIC_IDS = new Set([
  "assets-retry", "rpc-add-input", "rpc-add-btn", "exp-add-input", "exp-add-btn", // popup menus/assets
  "cost", "send-warn", "token-sim", // approve window, injected by clearsign describe()
]);
function idsFromSource(file) {
  const src = readFileSync(join(ROOT, "src", "popup", file), "utf8");
  const ids = new Set();
  for (const m of src.matchAll(/(?:\$\(|getElementById\()\s*"([\w-]+)"\s*\)/g)) ids.add(m[1]); // `)` required: skips concatenations like $("view-" + v)
  // view switcher builds "view-" + name dynamically
  if (/show\(view: string\)|"view-" \+/.test(src)) for (const v of ["setup", "backup", "locked", "main"]) ids.add("view-" + v);
  // the PANELS accordion array
  const pm = src.match(/const PANELS = \[([^\]]+)\]/);
  if (pm) for (const s of pm[1].matchAll(/"([\w-]+)"/g)) ids.add(s[1]);
  for (const d of DYNAMIC_IDS) ids.delete(d);
  return [...ids].sort();
}

// ── tiny static server for dist/ ──
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".json": "application/json", ".svg": "image/svg+xml" };
function serveDist(port) {
  const srv = http.createServer((req, res) => {
    const path = join(DIST, decodeURIComponent((req.url || "/").split("?")[0]).replace(/^\/+/, "") || "popup.html");
    if (!path.startsWith(DIST) || !existsSync(path) || !statSync(path).isFile()) { res.writeHead(404); return res.end("nf"); }
    res.writeHead(200, { "content-type": MIME[extname(path)] || "application/octet-stream" });
    res.end(readFileSync(path));
  });
  return new Promise((ok) => srv.listen(port, "127.0.0.1", () => ok(srv)));
}

const failures = [];
const notes = [];
function fail(s) { failures.push(s); console.error("  ✗ " + s); }
function pass(s) { console.log("  ✓ " + s); }
function note(s) { notes.push(s); console.log("  · " + s); }

function watchPage(page, label, errs) {
  page.on("pageerror", (e) => {
    const t = e.message;
    // standalone-mode API gaps (dev Wallet implements a subset; extension-only paths throw) — not product bugs
    if (/^unknown (history|sealedClaims|connectedSites|explorerList|cairnxNameRenewFee|openApproval)/.test(t)) return;
    if (label === "approve" && /sendMessage/.test(t)) return; // approve.ts is extension-only; standalone load is for ID sweep + styling
    errs.push(`[${label}] pageerror: ${t}`);
  });
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const t = m.text();
    // network-resource failures are environment-dependent (live API may be unreachable), and CORS
    // only bites the standalone http origin (the real extension origin has host_permissions) — allowlisted
    if (/Failed to load resource|net::ERR|status of \d{3}|blocked by CORS policy/.test(t)) return;
    errs.push(`[${label}] console.error: ${t}`);
  });
}

async function shoot(page, name) {
  await page.screenshot({ path: join(SHOTS, name + ".png") });
  console.log("  📸 " + name + ".png");
}

async function standalone() {
  if (!existsSync(join(DIST, "popup.html"))) throw new Error("dist/popup.html missing — run `npm run build` first");
  mkdirSync(SHOTS, { recursive: true });
  const port = Number(process.env.PORT || 18877);
  const srv = await serveDist(port);
  const base = `http://127.0.0.1:${port}`;
  const chromium = await loadChromium();
  const browser = await chromium.launch({ headless: true, executablePath: chromiumExe(), args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  const errs = [];
  try {
    const ctx = await browser.newContext({ viewport: VIEWPORT });
    const page = await ctx.newPage();
    watchPage(page, "popup", errs);

    // 1. fresh -> setup view
    await page.goto(base + "/popup.html");
    await page.waitForSelector("#view-setup:not([hidden])", { timeout: 15000 });
    await shoot(page, "01-setup");

    // ID sweep (static DOM): every source-referenced ID must exist
    for (const [file, doc] of [["popup.ts", page]]) {
      const missing = [];
      for (const id of idsFromSource(file)) {
        if (!(await doc.evaluate((i) => !!document.getElementById(i), id))) missing.push(id);
      }
      missing.length ? fail(`${file}: missing IDs in DOM: ${missing.join(", ")}`) : pass(`${file}: all ${idsFromSource(file).length} referenced IDs present`);
    }

    // 2. create wallet -> backup view
    await page.fill("#setup-pw", "harness-passphrase-1234");
    await page.click("#btn-create");
    await page.waitForSelector("#view-backup:not([hidden])", { timeout: 60000 });
    await page.waitForFunction(() => document.querySelectorAll("#seed-words .seed-word").length === 12, null, { timeout: 15000 });
    await shoot(page, "02-backup");

    // 3. acknowledge -> main view
    await page.check("#ack-backup");
    await page.click("#btn-backup-done");
    await page.waitForSelector("#view-main:not([hidden])", { timeout: 15000 });
    await page.waitForTimeout(1500); // let balance/assets settle (or fail soft to "—")
    await shoot(page, "03-main");

    // 4. send review with first-time warning
    await page.click("#btn-send-t");
    await page.waitForSelector("#send-form:not([hidden])", { timeout: 5000 });
    await page.fill("#s-to", "0x1111111111111111111111111111111111111111");
    await page.fill("#s-amt", "0.5");
    await page.click("#btn-send");
    await page.waitForSelector("#send-confirm:not([hidden])", { timeout: 20000 });
    const warnVisible = await page.evaluate(() => { const w = document.getElementById("c-warn"); return !!w && !w.hidden && w.offsetHeight > 0; });
    warnVisible ? pass("first-time-send warning visible in review") : fail("first-time-send warning NOT visible in review");
    const box = await page.locator("#btn-send-confirm").boundingBox();
    const inView = !!box && box.y >= 0 && box.y + box.height <= VIEWPORT.height;
    if (STRICT_CONFIRM) inView ? pass("confirm button inside 340x600 viewport") : fail(`confirm button outside viewport (y=${box?.y}, h=${box?.height})`);
    else note(`confirm button ${inView ? "inside" : "OUTSIDE"} 340x600 viewport (metric only; STRICT_CONFIRM=1 to enforce)`);
    await shoot(page, "04-send-review");
    await page.click("#btn-send-back");

    // regression: exiting an ARMED review via the panel back button must re-enable the inputs
    // (only btn-send-back used to re-enable them; a back/home exit left the form bricked)
    const pb = await page.$("#send-form .panel-back");
    if (pb) {
      await page.click("#btn-send");
      await page.waitForSelector("#send-confirm:not([hidden])", { timeout: 20000 });
      await pb.click();
      await page.waitForFunction(() => document.getElementById("send-form").hidden, null, { timeout: 5000 });
      await page.click("#btn-send-t");
      await page.waitForSelector("#send-form:not([hidden])", { timeout: 5000 });
      const editable = await page.evaluate(() => !document.getElementById("s-to").disabled && !document.getElementById("s-amt").disabled);
      editable ? pass("armed review exited via back leaves inputs editable") : fail("send inputs still DISABLED after panel-back exit");
      await page.click("#nav-home");
    }

    // 5-7. activity, settings, receive (if present), lock
    await page.click("#btn-activity-t");
    await page.waitForSelector("#activity:not([hidden])", { timeout: 5000 });
    await shoot(page, "05-activity");
    await page.click("#btn-settings");
    await page.waitForSelector("#settings:not([hidden])", { timeout: 5000 });
    await shoot(page, "06-settings");

    // panel walk: every trigger opens its panel; the panel-head back button restores home
    const WALK = [["btn-accts", "accts-panel"], ["btn-send-t", "send-form"], ["btn-post-t", "post-form"],
      ["btn-seal-t", "seal-form"], ["btn-activity-t", "activity"], ["btn-phrase", "phrase-panel"],
      ["btn-export", "reveal-panel"], ["btn-settings", "settings"], ["btn-receive", "receive-panel"]];
    let walkOk = true, walkBacks = 0;
    for (const [btn, panel] of WALK) {
      const present = await page.evaluate((b) => { const el = document.getElementById(b); return !!el && !el.hidden; }, btn);
      if (!present) continue;
      await page.click("#" + btn);
      await page.waitForSelector(`#${panel}:not([hidden])`, { timeout: 5000 });
      const back = await page.$(`#${panel} .panel-back`);
      if (!back) { note(`panel ${panel}: no back button (pre-overlay build)`); await page.click("#" + btn); continue; }
      await back.click();
      await page.waitForFunction((p) => document.getElementById(p).hidden, panel, { timeout: 5000 });
      const homeVisible = await page.evaluate(() => { const h = document.getElementById("home"); return !!h && h.offsetParent !== null; });
      if (!homeVisible) { walkOk = false; fail(`panel ${panel}: home not restored after back`); }
      walkBacks++;
    }
    if (walkOk && walkBacks) pass(`panel walk: back restores home (${walkBacks} panels)`);

    // secret-wipe on panel SWITCH (not just lock): reveal key, switch away, must be gone
    await page.click("#btn-export");
    await page.waitForSelector("#reveal-panel:not([hidden])", { timeout: 5000 });
    await page.fill("#reveal-pw", "harness-passphrase-1234");
    await page.click("#btn-reveal-go");
    await page.waitForFunction(() => { const o = document.getElementById("reveal-out"); return !!o && !o.hidden && (o.textContent || "").length > 60; }, null, { timeout: 20000 });
    await page.click("#btn-settings");
    await page.waitForSelector("#settings:not([hidden])", { timeout: 5000 });
    const wipedOnSwitch = await page.evaluate(() => { const o = document.getElementById("reveal-out"); return o.textContent === "" && o.hidden; });
    wipedOnSwitch ? pass("revealed key wiped on panel switch") : fail("revealed key NOT wiped on panel switch");
    // return to home (nav-home when the footnav exists, else toggle settings closed)
    if (await page.evaluate(() => !!document.getElementById("nav-home"))) await page.click("#nav-home");
    else await page.click("#btn-settings");
    await page.waitForFunction(() => document.getElementById("settings").hidden, null, { timeout: 5000 });
    if (await page.evaluate(() => !!document.getElementById("btn-receive") && !document.getElementById("btn-receive").hidden)) {
      await page.click("#btn-receive");
      await page.waitForSelector("#receive-panel:not([hidden])", { timeout: 5000 });
      await page.waitForTimeout(400);
      const qrState = await page.evaluate(() => {
        const c = document.getElementById("receive-qr");
        if (!c || !c.width) return "unwired"; // canvas present but never drawn (pre-QR build)
        const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
        let dark = 0; for (let i = 0; i < d.length; i += 4) if (d[i] < 128) dark++;
        return dark > 50 ? "ok" : "blank";
      });
      qrState === "ok" ? pass("receive QR canvas drawn (non-blank)")
        : qrState === "unwired" ? note("receive QR not wired yet (pre-W4)")
        : fail("receive QR canvas BLANK despite being sized");
      const addrShown = await page.evaluate(() => (document.getElementById("receive-addr")?.textContent || "").length === 42);
      addrShown ? pass("receive shows full address") : fail("receive address missing/truncated");
      await shoot(page, "08-receive");
    } else note("no btn-receive yet (pre-W4 build) — receive shot skipped");
    await page.click("#btn-lock");
    await page.waitForSelector("#view-locked:not([hidden])", { timeout: 5000 });
    await shoot(page, "07-locked");
    // secret-wipe invariant probe: reveal panel state must be reset after lock
    const wiped = await page.evaluate(() => {
      const o = document.getElementById("reveal-out");
      return !!o && o.textContent === "" && o.hidden;
    });
    wiped ? pass("reveal panel wiped after lock") : fail("reveal panel NOT wiped after lock");
    await ctx.close();

    // reduced-motion context: no animation may run
    const rctx = await browser.newContext({ viewport: VIEWPORT, reducedMotion: "reduce" });
    const rpage = await rctx.newPage();
    watchPage(rpage, "reduced", errs);
    await rpage.goto(base + "/popup.html");
    await rpage.waitForSelector("section:not([hidden])", { timeout: 15000 });
    const anim = await rpage.evaluate(() => {
      const el = document.querySelector("section:not([hidden])");
      return el ? getComputedStyle(el).animationName : "?";
    });
    anim === "none" ? pass("reduced-motion: view animation disabled") : fail(`reduced-motion: animationName=${anim}`);
    const running = await rpage.evaluate(() => document.getAnimations().length);
    running === 0 ? pass("reduced-motion: zero running animations") : fail(`reduced-motion: ${running} animations running`);
    await rctx.close();

    // approve.html static + ID sweep (locked state; request cards need a live extension)
    const actx = await browser.newContext({ viewport: { width: 380, height: 620 } });
    const apage = await actx.newPage();
    watchPage(apage, "approve", errs);
    await apage.goto(base + "/approve.html");
    await apage.waitForTimeout(800);
    const missingA = [];
    for (const id of idsFromSource("approve.ts")) {
      if (!(await apage.evaluate((i) => !!document.getElementById(i), id))) missingA.push(id);
    }
    missingA.length ? fail(`approve.ts: missing IDs: ${missingA.join(", ")}`) : pass(`approve.ts: all referenced IDs present`);
    await shoot(apage, "09-approve-locked");
    await actx.close();
  } finally {
    await browser.close();
    srv.close();
  }
  for (const e of errs) fail(e);
}

async function extensionMode() {
  mkdirSync(SHOTS, { recursive: true });
  const chromium = await loadChromium();
  const profile = join(SHOTS, ".ext-profile");
  const ctx = await chromium.launchPersistentContext(profile, {
    headless: false, executablePath: chromiumExe(), viewport: VIEWPORT,
    args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`, "--no-sandbox", "--no-first-run", "--disable-dev-shm-usage"],
  });
  try {
    // MV3 service workers can be dormant or raced; poll, then fall back to reading the
    // extension id straight out of the profile's Preferences (path-keyed unpacked install).
    let extId = null;
    for (let i = 0; i < 30 && !extId; i++) {
      const [sw] = ctx.serviceWorkers();
      if (sw) extId = new URL(sw.url()).host;
      else await new Promise((r) => setTimeout(r, 500));
    }
    if (!extId) {
      const prefs = JSON.parse(readFileSync(join(profile, "Default", "Preferences"), "utf8"));
      const exts = prefs?.extensions?.settings || {};
      extId = Object.keys(exts).find((k) => String(exts[k]?.path || "") === DIST || String(exts[k]?.path || "").endsWith("/dist"));
      if (extId) note("extension id via profile Preferences (service worker dormant)");
    }
    if (!extId) throw new Error("extension did not load (no service worker, no Preferences entry)");
    const page = await ctx.newPage();
    const errs = [];
    watchPage(page, "ext-popup", errs);
    await page.goto(`chrome-extension://${extId}/popup.html`);
    await page.waitForSelector("section:not([hidden])", { timeout: 15000 });
    await shoot(page, "ext-popup");
    try {
      await page.goto(`chrome-extension://${extId}/approve.html`);
      await page.waitForTimeout(800);
      await shoot(page, "ext-approve");
    } catch {
      // approve.html window.close()es itself when the request queue is empty — expected
      // without a live dApp request; its styling is covered by the standalone fixture.
      note("approve window self-closed (empty request queue) — expected");
    }
    for (const e of errs) fail(e);
    pass(`extension loaded as MV3 (id ${extId})`);
  } finally { await ctx.close(); }
}

console.log(`ux-shots: mode=${MODE} shots=${SHOTS}`);
await (MODE === "ext" ? extensionMode() : standalone());
if (failures.length) { console.error(`\nFAIL: ${failures.length} problem(s)`); process.exit(1); }
console.log(`\nOK${notes.length ? ` (${notes.length} note(s))` : ""}`);
