// WL1.1, the core half: the history row of a popup send to a .csd name keeps the name, so the next review can see where
// the name pointed when it was paid (popup-recipient.ts recipientChecks, test/name-redirect-dom.test.mjs). The
// transaction is unchanged: the same signed bytes with and without the name.
//   (1) through the background's popup channel, as the popup sends: a CSD send's fifth argument and a token send's
//       `name` land on the row, lower-cased; a send to an address carries none;
//   (2) a value that is not a plain name is not stored;
//   (3) the submitted bytes of a send with a name equal those of the same send without one.
// RED-FIRST: drop `...namedRow(name)` from Wallet.send (or args[4] in background.ts) and (1) fails.
// Run: node --import tsx test/name-redirect-history.test.mjs   (offline)
import "./helpers/backup-host.mjs";
import { Wallet } from "../src/core/wallet.js";
import { memoryStore } from "../src/core/storage.js";
import { mkCoin, txReply } from "./_coin.ts";
import { checker } from "./helpers/check.mjs";

const { check, done } = checker("=== a send to a name keeps the name on its history row ===");
const TO = "0x" + "31".repeat(20);
// every send below has its own amount: the same send twice is the same transaction, and its row is the first one
const coins = [mkCoin(1_000_000_000)];
const submits = [];
const stub = async (url, init) => {
  const u = String(url);
  if (u.includes("/tx/submit")) { submits.push(String(init?.body)); return { ok: true, status: 200, json: async () => ({ ok: true, txid: "0x" + "aa".repeat(32) }) }; }
  if (u.includes("/utxos/")) return { ok: true, status: 200, json: async () => ({ confirmed_balance: coins.reduce((a, c) => a + c.coin.value, 0), utxos: coins.map((c) => c.coin) }) };
  if (u.endsWith("/tip")) return { ok: true, status: 200, json: async () => ({ height: 65_000 }) };
  return txReply(u, coins) ?? { ok: false, status: 404, json: async () => ({}) };
};
globalThis.fetch = stub;

// ── the background's popup channel, as the popup calls it ─────────────────────────────────────────────
const noop = () => { /* a chrome call of the background this file does not observe */ };
const mem = new Map();
let listener = noop;
globalThis.chrome = {
  runtime: { id: "cairnwallettestid", lastError: undefined, getURL: (p) => "chrome-extension://x/" + p, onMessage: { addListener: (fn) => { listener = fn; } }, onConnect: { addListener: noop } },
  storage: { local: { get: async (k) => ({ [k]: structuredClone(mem.get(k)) }), set: async (o) => { for (const k of Object.keys(o)) mem.set(k, structuredClone(o[k])); }, remove: async (k) => { mem.delete(k); } } },
  alarms: { create: noop, onAlarm: { addListener: noop } },
  action: { setBadgeText: noop },
  windows: { create: noop },
};
const SENDER = { id: "cairnwallettestid", url: "chrome-extension://x/popup.html" };
const popup = (method, ...args) => new Promise((res) => listener({ kind: "popup", method, args }, SENDER, res));
await import("../src/background.ts");
await new Promise((r) => setTimeout(r, 0));
check("setup: the popup channel creates a wallet", (await popup("create", "correct horse battery staple")).ok === true);
const me = (await popup("status")).result.addr;

console.log("1. the row keeps the name");
const named = await popup("send", TO, 1e8, 1e6, me, "Alice");
check(`(1a) a CSD send with the name: sent (${named.result?.ok})`, named.ok && named.result?.ok === true);
const rowA = (await popup("history")).result[0];
check(`(1a) its row carries the name, lower-cased (${rowA?.name})`, rowA?.type === "send" && rowA.name === "alice" && rowA.to === TO);
await popup("send", TO, 1e8 + 1, 1e6, me);
const rowB = (await popup("history")).result[0];
check("(1b) honest: a send to an address keeps no name", rowB?.type === "send" && !("name" in rowB));

console.log("2. only a plain name is stored");
let n = 2;
for (const bad of ["visit evil.example", "<b>alice</b>", "a".repeat(40), 7, { name: "alice" }]) {
  await popup("send", TO, 1e8 + n++, 1e6, me, bad);
  const row = (await popup("history")).result[0];
  check(`(2) ${JSON.stringify(bad).slice(0, 24)}: no name on the row`, row?.type === "send" && !("name" in row));
}

console.log("3. the token send keeps it too");
{
  const w = new Wallet(memoryStore());
  await w.create("correct horse battery staple");
  const t = await w.cairnxTransfer({ ticker: "TKN", amount: "5", to: TO, decimals: 0, name: "bob" });
  const row = (await w.history())[0];
  check(`(3) a token send with the name: its row carries it (${row?.name})`, t?.ok === true && row?.type === "tokenSend" && row.name === "bob");
}

console.log("4. the transaction is unchanged");
{
  const w = new Wallet(memoryStore());
  const { mnemonic } = await w.create("correct horse battery staple");
  const w2 = new Wallet(memoryStore());
  await w2.restore(mnemonic, "correct horse battery staple");
  submits.length = 0;
  await w.send(TO, 2e8, 1e6, undefined, "alice");
  await w2.send(TO, 2e8, 1e6);
  check(`(4) the same send with and without the name submits the same bytes (${submits.length} submits)`, submits.length === 2 && submits[0] === submits[1]);
}
done("name-redirect-history");
