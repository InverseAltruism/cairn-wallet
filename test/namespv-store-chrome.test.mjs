// liveSpvSource over the real openHeaderStore() in Chrome (real IndexedDB): a fresh build persists the anchor
// chunk, the suffix and the head, and after a page reload a new build restores them with zero /api/headers
// requests. Headers come from the real-chain fixture (test/helpers/spvfixture.mjs), served to the page by route.
// Needs playwright-core (PLAYWRIGHT_CORE, see scripts/playwright-core.mjs) and a Chromium (PLAYWRIGHT_CHROMIUM, or
// playwright's own). Without playwright-core or a Chromium binary it prints SKIP; it runs where both are installed.
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { checker } from "./helpers/check.mjs";
import { serveFixture, records, hashOf, FIX_TOP, FIX_ANCHORS, NEWEST } from "./helpers/spvfixture.mjs";
import { findChromium } from "../scripts/playwright-core.mjs";

const chromium = await findChromium();
if (!chromium) {
  console.log("SKIP: playwright-core not found (set PLAYWRIGHT_CORE); runs when it is installed");
  process.exit(0);
}
const t = checker("namespv over the header store in Chrome (real IndexedDB)");
const bundle = (await build({
  stdin: {
    contents: 'export { liveSpvSource, flushSpvStoreWrites } from "./src/core/namespv.ts"; export { openHeaderStore } from "./src/core/headerstore.ts";',
    resolveDir: fileURLToPath(new URL("..", import.meta.url)), loader: "ts",
  },
  bundle: true, format: "iife", globalName: "NS", platform: "browser", target: "es2022", write: false, logLevel: "warning",
})).outputFiles[0].text;
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM || undefined, args: ["--no-sandbox"] });
} catch (e) {
  if (!/executable doesn't exist|ENOENT/i.test(String(e?.message))) throw e;
  console.log(`SKIP: no Chromium binary for playwright-core (set PLAYWRIGHT_CHROMIUM): ${String(e.message).split("\n")[0]}`);
  process.exit(0);
}

// The page's /api/headers and node RPC requests are answered by the fixture's fetch in this process.
const net = {};
serveFixture(net);
// https: crypto.subtle (the chunk digests below) exists only in a secure context, as in the extension origin.
const ORIGIN = "https://spv.test";
const sha = (b) => createHash("sha256").update(b).digest("hex");

// Wallet.spvOpts() inside the page: the real openHeaderStore(), the chrome.storage keys as in-page doubles.
async function session({ maxEventHeight, anchors }) {
  const legacy = { get: async () => null, del: async () => {}, bytes: async () => null, attempts: { get: async () => 0, set: async () => {} } };
  const floor = { get: async () => 0, set: async () => {} };
  const src = await NS.liveSpvSource({ rpcBase: location.origin + "/api/rpc", headersBase: location.origin, anchors, store: () => NS.openHeaderStore(), legacy, floor });
  const p = await src.prepare(maxEventHeight);
  await NS.flushSpvStoreWrites();
  const s = await NS.openHeaderStore();
  const hex = async (u8) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", u8))].map((x) => x.toString(16).padStart(2, "0")).join("");
  const c27 = await s.getChunk(27), c28 = await s.getChunk(28);
  const out = { tip: p.verifiedTip, keys: await s.listChunks(), head: await s.getHead(), h27: c27 && await hex(c27), h28: c28 && await hex(c28), hash: await src.hashAt(115000) };
  s.close();
  return out;
}

const ctx = await browser.newContext();
try {
  await ctx.route(`${ORIGIN}/**`, async (r) => {
    const url = r.request().url();
    if (url.endsWith("/ns.js")) return r.fulfill({ contentType: "text/javascript", body: bundle });
    if (url.includes("/api/")) {
      const res = await globalThis.fetch(url);
      return r.fulfill({ status: res.status, contentType: "application/json", body: await res.text() });
    }
    return r.fulfill({ contentType: "text/html", body: '<!doctype html><script src="/ns.js"></script>' });
  });
  const page = await ctx.newPage();
  // A hung IndexedDB call is a failure, not a stalled run.
  const run = (arg) => Promise.race([page.evaluate(session, arg), new Promise((_, rej) => setTimeout(() => rej(new Error("timed out after 20 s")), 20_000))]);
  await page.goto(`${ORIGIN}/`);
  const first = await run({ maxEventHeight: FIX_TOP - 12, anchors: [...FIX_ANCHORS] });
  const firstReqs = [...net.log];
  t.check(`a fresh build and prepare reach the real tip (${first.tip}) with the anchor chunk and one suffix page (${firstReqs.length} requests)`, first.tip === FIX_TOP && firstReqs.length === 9 && firstReqs[8] === "114688/512" && first.hash === hashOf(115000));
  t.check(`IndexedDB holds chunk 27, the suffix chunk 28 and the head (${first.keys})`, first.keys.join() === "27,28" && first.head?.v === 2 && first.head.tip === FIX_TOP && first.head.tipHash === hashOf(FIX_TOP));
  t.check("  the stored chunks are the real records", first.h27 === sha(records(110592, NEWEST)) && first.h28 === sha(records(114688, FIX_TOP)));
  net.log.length = 0;
  await page.reload();
  const second = await run({ maxEventHeight: FIX_TOP - 12, anchors: [...FIX_ANCHORS] });
  t.check(`after a reload a new build restores from IndexedDB with zero /api/headers requests (${net.log.length}) and the same tip (${second.tip})`, net.log.length === 0 && second.tip === FIX_TOP && second.hash === hashOf(115000));
  t.check("  and the store is unchanged", second.keys.join() === "27,28" && second.head?.tip === FIX_TOP && second.h27 === first.h27 && second.h28 === first.h28);
} catch (e) {
  t.check(`the Chrome session ran (${String(e?.message ?? e).split("\n")[0]})`, false);
} finally {
  await ctx.close();
  await browser.close();
}
t.done("namespv-store-chrome");
