// Serves the popup or the approval window in Chrome the way the extension ships them (the page, popup.css,
// icons.svg, the vendored cairn-ui files, the entry bundled by esbuild) on a routed origin, with a scripted
// chrome.runtime that answers each popup method from a fixed map. Used by the *-chrome tests; they print SKIP
// without playwright-core or a Chromium, like the other Chrome tests.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { build } from "esbuild";
import { UI_SHIP, UI_VENDOR_DIR } from "../../scripts/check-ui-vendor.mjs";
import { findChromium } from "../../scripts/playwright-core.mjs";

const ROOT = join(import.meta.dirname, "..", "..");
const ORIGIN = "http://wallet.test";

/** A launched Chromium, or null after printing the SKIP line. */
export async function launchOrSkip() {
  const chromium = await findChromium();
  if (!chromium) {
    console.log("SKIP: playwright-core not found (set PLAYWRIGHT_CORE); runs when it is installed");
    return null;
  }
  try {
    return await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM || undefined, args: ["--no-sandbox"] });
  } catch (e) {
    if (!/executable doesn't exist|ENOENT/i.test(String(e?.message))) throw e;
    console.log(`SKIP: no Chromium binary for playwright-core (set PLAYWRIGHT_CHROMIUM): ${String(e.message).split("\n")[0]}`);
    return null;
  }
}

const bundles = new Map();
async function bundle(entry) {
  if (!bundles.has(entry)) {
    const r = await build({
      entryPoints: [join(ROOT, "src", "popup", `${entry}.ts`)], bundle: true, format: "esm", platform: "browser", target: "es2022",
      write: false, logLevel: "warning", define: { __WALLET_VERSION__: '"0.0.0-test"' },
    });
    bundles.set(entry, r.outputFiles[0].text);
  }
  return bundles.get(entry);
}

const TYPES = { html: "text/html", css: "text/css", js: "text/javascript", svg: "image/svg+xml", woff2: "font/woff2", txt: "text/plain" };
function file(path) {
  if (path === "/popup.css" || path === "/icons.svg" || path === "/popup.html" || path === "/approve.html") return readFileSync(join(ROOT, "src", "popup", path.slice(1)));
  const ui = path.startsWith("/ui/") ? path.slice(4) : null;
  if (ui && UI_SHIP.includes(ui)) return readFileSync(join(UI_VENDOR_DIR, ui));
  return null;
}

// Runs in the page before any script: each popup method answers `answers[method]`, or the background's error shape.
function installRuntime(answers) {
  globalThis.chrome = {
    runtime: {
      lastError: undefined,
      sendMessage(m, cb) {
        setTimeout(() => cb(m.method in answers ? { ok: true, result: answers[m.method] } : { ok: false, error: `no ${m.method} in this fixture` }), 5);
      },
    },
    permissions: { contains: async () => true, request: async () => true },
  };
}

/** Opens `page` ("popup" or "approve") in a fresh context; returns { page, ctx, errors }. */
export async function openWalletPage(browser, which, answers, { viewport, colorScheme = "light", deviceScaleFactor = 1 } = {}) {
  const js = await bundle(which);
  const ctx = await browser.newContext({ viewport, colorScheme, deviceScaleFactor });
  await ctx.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== ORIGIN) return route.abort();
    const body = url.pathname === `/${which}.js` ? js : file(url.pathname);
    if (body === null) return route.fulfill({ status: 404, body: "" });
    return route.fulfill({ status: 200, contentType: TYPES[url.pathname.split(".").pop()] || "application/octet-stream", body });
  });
  await ctx.addInitScript(installRuntime, answers);
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${ORIGIN}/${which}.html`);
  return { page, ctx, errors };
}
