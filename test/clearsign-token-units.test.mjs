// CX-35: token amounts in the approval window render in human units beside the signed base units.
//
// Live evidence: a Sunrise bid for 50 CSD asked the user to approve "463852873290 base units of CAIRN". The
// decimals come from the resolver's token record (served data), so they may only ADD a human scale: the signed
// base-unit integer stays on screen next to it, unknown or out-of-range decimals fall back to base units alone,
// and nothing about the display reaches the signed bytes.
//   RED-FIRST: drop the `meta` argument from cairnxDescribe's call in describe() (or render sideStr's token case
//   with baseAmt again) and sections 1 and 2 go red.
//   PAIRED HAPPY-PATH: section 4 signs the same bid request through the real propose engine and compares the
//   submitted bytes against a digest captured from the unmodified 0.2.72 tree (master 8ce3ed7).
// Run: node --import tsx test/clearsign-token-units.test.mjs   (offline)
import { createHash } from "node:crypto";
import { cairnxDescribe, cairnxTokenTickers, describe } from "../src/popup/clearsign.js";
import { canonicalJson, cairnxPayloadHash, CAIRNX_DOMAIN } from "../src/core/cairnx.js";
import { propose } from "../src/core/node.js";
import { bid } from "../src/vendor/cairnx-spv.js";
import { mkCoin, txReply } from "./_coin.js";
import { Wallet } from "../src/core/wallet.js";
import { memoryStore } from "../src/core/storage.js";

let pass = 0, fail = 0;
const check = (n, c) => { c ? (pass++, console.log("  ✓ " + n)) : (fail++, console.error("  ✗ " + n)); };
const text = (html) => String(html).replace(/<[^>]+>/g, "");

const CAIRN_DEPLOY = "0xdf7113afc41319b700c26f26ba657c8267533a3dd511cc59776601a9aba03517";
const LIVE = { give: { value: "5000000000" }, want: { ticker: "CAIRN", amount: "463852873290" } };   // the live Sunrise bid
const BID = bid(LIVE);
const rec = (r) => [canonicalJson(r), cairnxPayloadHash(r)];

console.log("1. decimals known: both scales, base units still visible");
{
  const html = cairnxDescribe(BID.uri, BID.payloadHash, { CAIRN: { decimals: 8, deployId: CAIRN_DEPLOY } });
  check("bid shows the human amount AND the signed base units", text(html).includes("4638.5287329 CAIRN = 463852873290 base units"));
  check("bid still shows the CSD side", text(html).includes("50 CSD"));
  check("Cairn's own deploy id raises no look-alike warning", !/not Cairn's token|Could not confirm/.test(text(html)));
  const lied = text(cairnxDescribe(BID.uri, BID.payloadHash, { CAIRN: { decimals: 0, deployId: CAIRN_DEPLOY } }));
  check("a lied decimals value cannot hide the signed integer (decimals 0 still prints = 463852873290 base units)", lied.includes("= 463852873290 base units"));
  const wrongDeploy = text(cairnxDescribe(BID.uri, BID.payloadHash, { CAIRN: { decimals: 8, deployId: "0x" + "11".repeat(32) } }));
  check("a different CAIRN deploy keeps the look-alike warning", /not Cairn's token/.test(wrongDeploy));
}

console.log("2. every token side uses the same rendering (transfer, mint, offer give/want, bid)");
{
  const meta = { TOK: { decimals: 2, deployId: "0x" + "22".repeat(32) }, AAA: { decimals: 3 } };
  const to = "0x" + "ab".repeat(20);
  const cases = [
    ["transfer", { amount: "12345", t: "transfer", ticker: "TOK", to, v: 1 }, "123.45 TOK = 12345 base units"],
    ["mint", { amount: "500", t: "mint", ticker: "TOK", v: 1 }, "5 TOK = 500 base units"],
    ["offer give", { give: { amount: "1500", ticker: "AAA" }, t: "offer", v: 1, want: { value: "100000000" } }, "1.5 AAA = 1500 base units"],
    ["offer want", { give: { amount: "1500", ticker: "AAA" }, t: "offer", v: 1, want: { amount: "250", ticker: "TOK" } }, "2.5 TOK = 250 base units"],
    ["bid want", { give: { value: "100000000" }, t: "bid", v: 1, want: { amount: "7", ticker: "TOK" } }, "0.07 TOK = 7 base units"],
  ];
  for (const [label, r, want] of cases) {
    const [uri, ph] = rec(r);
    check(`${label}: "${want}"`, text(cairnxDescribe(uri, ph, meta)).includes(want));
  }
  const [ou, oph] = rec({ give: { amount: "1500", ticker: "AAA" }, t: "offer", v: 1, want: { amount: "250", ticker: "TOK" } });
  check("cairnxTokenTickers lists both token sides of an offer", JSON.stringify(cairnxTokenTickers(ou, oph)) === '["AAA","TOK"]');
  check("cairnxTokenTickers lists the bid's token side only", JSON.stringify(cairnxTokenTickers(BID.uri, BID.payloadHash)) === '["CAIRN"]');
  const [mu, mph] = rec({ t: "mint", ticker: "TOK", v: 1 });
  check("cairnxTokenTickers: a default-lot mint has no amount to scale", cairnxTokenTickers(mu, mph).length === 0);
}

console.log("3. decimals unknown or unusable: base units only");
{
  const plain = text(cairnxDescribe(BID.uri, BID.payloadHash, {}));
  check("no meta for the ticker: base units of CAIRN, no human figure", plain.includes("463852873290 base units of CAIRN") && !plain.includes("4638.5"));
  check("...and the CAIRN record-did-not-load warning (D-1)", /Could not confirm this CAIRN/.test(plain));
  for (const bad of [9, -1, 2.5, "8", null]) {
    const t = text(cairnxDescribe(BID.uri, BID.payloadHash, { CAIRN: { decimals: bad, deployId: CAIRN_DEPLOY } }));
    check(`decimals ${JSON.stringify(bad)} is not used (base units only)`, t.includes("463852873290 base units of CAIRN") && !t.includes(" CAIRN = "));
  }
  const noMeta = text(cairnxDescribe(BID.uri, BID.payloadHash));
  check("no meta argument at all: base units only and no ticker warning (unchanged pre-CX-35 render)",
    noMeta.includes("463852873290 base units of CAIRN") && !/Could not confirm|not Cairn's token/.test(noMeta));
}

console.log("4. PAIRED HAPPY-PATH: the signed bytes of the same bid request are unchanged");
{
  const PRIV = "0x" + "11".repeat(32);
  const coin = mkCoin(10_000_000_000);
  const params = { domain: CAIRNX_DOMAIN, payloadHash: BID.payloadHash, uri: BID.uri, expiresEpoch: 3000, fee: 25_000_000 };
  const r = { id: "b1", method: "propose", origin: "https://cairn-substrate.com", params, tokenMeta: { CAIRN: { decimals: 8, deployId: CAIRN_DEPLOY } } };
  const before = JSON.stringify(params);
  check("describe() renders the human scale for the request", text(describe(r)).includes("4638.5287329 CAIRN = 463852873290 base units"));
  check("describe() leaves the signed params untouched", JSON.stringify(params) === before);
  let body = null;
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.includes("/tx/submit")) { body = init.body; return { ok: true, status: 200, json: async () => ({ ok: true, txid: "0x" + "aa".repeat(32) }) }; }
    if (/\/utxos\//.test(u)) return { ok: true, status: 200, json: async () => ({ confirmed_balance: coin.coin.value, utxos: [coin.coin] }) };
    if (u.endsWith("/tip")) return { ok: true, status: 200, json: async () => ({ height: 50000 }) };
    return txReply(u, [coin]) ?? { ok: false, status: 404, json: async () => ({}) };
  };
  const res = await propose("http://rpc.test", r.params, PRIV);
  globalThis.fetch = origFetch;
  const digest = body ? createHash("sha256").update(body).digest("hex") : "";
  check(`the bid signs and submits (txid ${res?.txid})`, res?.ok === true && res?.txid === "0x3fbbb6d242be641af60bb99893ba78855542e9e5e8d9b1ce927be30bfdfb8d7c");
  check("submitted bytes equal the digest captured on the unmodified 0.2.72 tree", digest === "100b2cd4c689448d8d5039295a1ddcb212f4a716e0a326ba5bd8dccca5a7c9ff");
}

console.log("5. Wallet.tokenDisplayMeta: one bounded read per valid ticker, fail-soft");
{
  const w = new Wallet(memoryStore());
  const asked = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    const m = u.match(/\/cairnx\/token\/([^/?]+)$/);
    if (!m) return { ok: false, status: 404, json: async () => ({}) };
    const tk = decodeURIComponent(m[1]);
    asked.push(tk);
    if (tk === "CAIRN") return { ok: true, status: 200, json: async () => ({ ticker: "CAIRN", decimals: 8, deployId: CAIRN_DEPLOY }) };
    if (tk === "ECHO") return { ok: true, status: 200, json: async () => ({ ticker: "OTHER", decimals: 2 }) };
    return { ok: false, status: 500, json: async () => ({}) };
  };
  const meta = await w.tokenDisplayMeta(["CAIRN", "CAIRN", "ECHO", "DOWN", "bad ticker", 7]);
  globalThis.fetch = origFetch;
  check("CAIRN read returns decimals + deploy id", meta.CAIRN?.decimals === 8 && meta.CAIRN?.deployId === CAIRN_DEPLOY);
  check("a record for a different ticker is not attributed (ECHO absent)", meta.ECHO === undefined);
  check("a failed read leaves the ticker absent (DOWN absent, no throw)", meta.DOWN === undefined);
  check(`invalid tickers are never fetched and duplicates are read once (${JSON.stringify(asked)})`,
    JSON.stringify(asked.slice().sort()) === '["CAIRN","DOWN","ECHO"]');
}

console.log(`\nclearsign-token-units: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
