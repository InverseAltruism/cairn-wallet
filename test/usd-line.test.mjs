// The USD line under the balance (wallet 0.3.1, owner decision 2026-10-25): the balance times the CSD/USD rate the
// Cairn API serves at /api/market/csd, with the venue named. Display only: no send, fee or check reads it, and it is
// absent, never a guess, when the route answers 503 (the site's market data off), fails, or serves no usable price.
// The fixture is the live body read on 2026-10-26.
// RED-FIRST: let parseCsdMarket accept any source (drop the SOURCES lookup) and the unnamed-venue checks fail; return
// a rate on a non-2xx answer in csdMarket and the 503 check fails; import market.js from any other file under src/
// (node.ts, a popup module, a new file) and the importer scan fails.
// HONEST PATH: the live body gives "≈ $79.14 · USD via SafeTrade" for 1,284.735 CSD at 0.0616.
// Run: npx tsx test/usd-line.test.mjs   (offline)
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { csdMarket, parseCsdMarket, usdLine } from "../src/core/market.ts";
import { checker } from "./helpers/check.mjs";

const { check, done } = checker("the balance's USD line");
const ROOT = join(import.meta.dirname, "..");
const read = (p) => readFileSync(join(ROOT, p), "utf8");
const live = JSON.parse(read("test/fixtures/market-csd-2026-10-26.json"));

const m = parseCsdMarket(live);
check("the live body parses to its last price from SafeTrade", m.ok === true && m.rate === 0.0616 && m.source === "SafeTrade" && m.stale === false);
check("the line for 1,284.735 CSD", usdLine(128_473_500_000, m) === "≈ $79.14 · USD via SafeTrade");
check("thousands are grouped", usdLine(5_000_000 * 1e8, m) === "≈ $308,000.00 · USD via SafeTrade");
check("a zero balance reads $0.00", usdLine(0, m) === "≈ $0.00 · USD via SafeTrade");
check("a balance under a cent says so", usdLine(1000, m) === "< $0.01 · USD via SafeTrade");
check("a CoinPaprika price names CoinPaprika", parseCsdMarket({ ...live, price: { ...live.price, source: "coinpaprika" } }).source === "CoinPaprika");
const stale = parseCsdMarket({ ...live, stale: true, ageSecs: 1260 });
check("a stale price carries its age", usdLine(128_473_500_000, stale) === "≈ $79.14 · USD via SafeTrade · stale, 21 min ago");
check("disagreeing venues are said", usdLine(128_473_500_000, parseCsdMarket({ ...live, disagree: true })) === "≈ $79.14 · USD via SafeTrade · sources differ");

for (const [why, body] of [
  ["the 503 body", { ok: false, error: "market data off" }], ["no body", null], ["a string", "0.06"], ["no price", { ok: true }],
  ["a zero price", { ...live, price: { ...live.price, last: 0 } }], ["a negative price", { ...live, price: { ...live.price, last: -1 } }],
  ["a price as text", { ...live, price: { ...live.price, last: "0.0616" } }], ["an unnamed venue", { ...live, price: { ...live.price, source: "elsewhere" } }],
  ["a venue named __proto__", { ...live, price: { ...live.price, source: "__proto__" } }], ["no venue", { ...live, price: { last: 0.06 } }],
]) {
  const r = parseCsdMarket(body);
  check(`${why}: no rate, so no line`, r.ok === false && usdLine(128_473_500_000, r) === null);
}
check("no balance, no line", usdLine(null, m) === null);
check("an out-of-range balance, no line", usdLine(Number.MAX_SAFE_INTEGER + 2, m) === null && usdLine(-1, m) === null);

// the read: the route under the configured Cairn API, 503 and failures give no rate
const seen = [];
const origFetch = globalThis.fetch;
const serve = (status, body) => { globalThis.fetch = async (url) => { seen.push(String(url)); return { ok: status >= 200 && status < 300, status, json: async () => body }; }; };
try {
  serve(200, live);
  const r = await csdMarket("https://cairn-substrate.com");
  check("csdMarket reads /api/market/csd under the Cairn API", seen.at(-1) === "https://cairn-substrate.com/api/market/csd" && r.ok === true && r.rate === 0.0616);
  await csdMarket("http://127.0.0.1:7777/");
  check("a trailing slash on the API base is not doubled", seen.at(-1) === "http://127.0.0.1:7777/api/market/csd");
  serve(503, { ok: false, error: "market data off" });
  check("a 503 (market data off) gives no rate", (await csdMarket("https://cairn-substrate.com")).ok === false);
  serve(503, live);
  check("a 503 gives no rate even when its body carries a price", (await csdMarket("https://cairn-substrate.com")).ok === false);
  serve(200, { ok: true, price: { last: 0.06, source: "safetrade" } });
  check("a 200 with a usable price still reads (the honest path under the guard)", (await csdMarket("https://cairn-substrate.com")).ok === true);
  globalThis.fetch = async () => { throw new TypeError("network"); };
  check("a network failure gives no rate and does not throw", (await csdMarket("https://cairn-substrate.com")).ok === false);
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError("bad json"); } });
  check("an unreadable body gives no rate", (await csdMarket("https://cairn-substrate.com")).ok === false);
} finally { globalThis.fetch = origFetch; }

// display only: the rate reaches the balance hero and nothing on a signing path
// every file under src/ (the vendored bundle included), so a new importer anywhere is caught
const ALLOWED = ["src/core/wallet.ts", "src/popup/popup-balance.ts"];
const srcFiles = [];
const walk = (d) => { for (const e of readdirSync(join(ROOT, d), { withFileTypes: true })) { const f = `${d}/${e.name}`; if (e.isDirectory()) walk(f); else if (/\.(ts|js|mjs)$/.test(e.name)) srcFiles.push(f); } };
walk("src");
const importers = srcFiles.filter((f) => /from\s+["'][^"']*\bmarket(\.js|\.ts)?["']|import\(\s*["'][^"']*\bmarket(\.js|\.ts)?["']/.test(read(f))).sort();
check(`market.ts is imported only by ${ALLOWED.join(" and ")}, of ${srcFiles.length} files under src/ (${importers.join(", ")})`, srcFiles.length > 50 && importers.join() === ALLOWED.join());
const wallet = read("src/core/wallet.ts");
check("wallet.ts uses it only in its csdMarket read", (wallet.match(/\bcsdMarket\b/g) || []).length === 3 && wallet.includes("  csdMarket() { return csdMarket(this.api); }"));
const bg = read("src/background.ts");
const dapp = /const DAPP_METHODS = new Set\(\[([^\]]*)\]\)/.exec(bg)?.[1] ?? "";
check("csdMarket is not a dApp method", dapp.length > 0 && !dapp.includes('"csdMarket"'));
check("csdMarket is a read-only popup method (it does not extend the idle lock)", /const READ_ONLY_METHODS = new Set\(\[[^\]]*"csdMarket"/.test(bg) && bg.includes('case "csdMarket": return wallet.csdMarket();'));
check("the market read fetches no host of its own (it reads the configured Cairn API)", !/["'`]https?:/.test(read("src/core/market.ts")) && read("src/core/market.ts").includes("${apiBase.replace("));

done("usd-line");
