// One host per spend and per reconcile pass: the host that answered a spend's coin list answers every source
// transaction read of that spend (src/core/node.ts selectVerified, consolidate), so the coin-value check runs on the
// second host exactly as on the main host; a reconcile pass stays on the host that answered its tip (history.ts).
//
// RED-FIRST: with the main host down, 0.3.4 read the coins from the main host only and refused VERIFY_UNAVAILABLE (P1).
// Mutation (run in a copy): verify against the wallet's RPC instead of the coin list's host, and P1 and P4 fail (the
// source reads go to the main host, which is down in P1 and serves a forged body in P4).
// The checks of the main path, on the second host: a forged source body there refuses VERIFY_TAMPER with nothing
// submitted (P2); a coin the second host cannot find is skipped and never spent (P3). P4: the main host hangs on the coin
// list (the second host answers it) and recovers mid-spend with a forged body: every source read stays on the second
// host. PAIRED UNTOUCHED CASE: both hosts healthy, every read goes to the main host (P5).
//
// Run: node --import tsx test/hosts-spend-pin.test.mjs   (offline; about 10 s, the hedge waits are real time)
// routes the second host itself
import { Wallet } from "../src/core/wallet.js";
import { memoryStore } from "../src/core/storage.js";
import { DEFAULT_RPC, BACKUP_RPC } from "../src/core/endpoints.js";
import { BACKUP_FIRST_MS } from "../src/core/hosts.js";
import { histKey } from "../src/core/history.js";
import { mkCoin, txReply } from "./_coin.js";
import { checker } from "./helpers/check.mjs";

const { check, done } = checker("=== one host per spend ===");
const RCPT = "0x" + "11".repeat(20);
const A = mkCoin(5e8), B = mkCoin(4e8, 1);
const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const realNow = Date.now.bind(Date);
let skew = 0;
Date.now = () => realNow() + skew;
// leaves the "second host first" window and the session skip caches (120 s) behind
const nextMinute = () => { skew += Math.max(BACKUP_FIRST_MS, 120_000) + 1_000; };

// A node holding `coins`; `body(id)` may override a source body; `missing` txids answer 404.
function nodeOf(coins, { forge = false, missing = new Set(), tip = 1000 } = {}) {
  return async (u) => {
    if (u.includes("/utxos/")) return json(200, { confirmed_balance: coins.reduce((s, c) => s + c.coin.value, 0), utxos: coins.map((c) => c.coin) });
    if (u.endsWith("/tip")) return json(200, { height: tip });
    if (u.includes("/tx/submit")) return json(200, { ok: true });
    const id = u.match(/\/tx\/(0x[0-9a-f]{64})/i)?.[1]?.toLowerCase();
    if (id && missing.has(id)) return json(404, {});
    if (id && forge && u.match(/\/tx\/0x[0-9a-f]{64}$/i)) {
      const hit = coins.find((c) => c.coin.txid.toLowerCase() === id);
      if (hit) return json(200, { ok: true, tx: { ...hit.body, outputs: hit.body.outputs.map((o) => ({ ...o, value: o.value + 1 })) } });
    }
    return txReply(u, coins) ?? json(404, {});
  };
}
const down = async () => { throw new TypeError("fetch failed"); };
let log = [];
function route(main, backup) {
  log = [];
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    const host = u.startsWith(BACKUP_RPC + "/") ? "backup" : u.startsWith(DEFAULT_RPC + "/") ? "main" : "other";
    log.push({ host, u, body: init?.body });
    return (typeof main === "function" && host === "main" ? main : backup)(u, init);
  };
}
const srcReads = (host) => log.filter((e) => e.host === host && /\/tx\/0x[0-9a-f]{64}$/i.test(e.u)).length;
const submitsTo = (host) => log.filter((e) => e.host === host && e.u.endsWith("/tx/submit"));
async function wallet() { const w = new Wallet(memoryStore()); await w.create("super-secret-pw"); return w; }

// ── P1: the main host down, the spend reads everything from the second host ──
let w = await wallet();
route(down, nodeOf([A]));
let r = await w.send(RCPT, 1e8, 1e6);
check(`P1: main host down: the coin list and every source read from the second host (${srcReads("backup")} there, ${srcReads("main")} at the main host), the send signed and submitted (${r.code ?? "ok"})`,
  srcReads("backup") >= 1 && srcReads("main") === 0 && log.some((e) => e.u.endsWith("/tx/submit")) && r.code !== "VERIFY_UNAVAILABLE");

// ── P2: a forged source body on the second host ──
nextMinute();
w = await wallet();
route(down, nodeOf([A], { forge: true }));
r = await w.send(RCPT, 1e8, 1e6);
check(`P2: a forged source body on the second host: VERIFY_TAMPER, nothing submitted (${r.code})`, r.code === "VERIFY_TAMPER" && submitsTo("main").length + submitsTo("backup").length === 0);

// ── P3: a coin the second host cannot find is skipped, never spent ──
nextMinute();
w = await wallet();
route(down, nodeOf([A, B], { missing: new Set([A.coin.txid.toLowerCase()]) }));
r = await w.send(RCPT, 1e8, 1e6);
const spent = [...submitsTo("main"), ...submitsTo("backup")].map((e) => JSON.parse(e.body).tx.inputs.map((i) => i.prevout.vout));
check(`P3: a coin not found on the second host is skipped: the send spends the other coin only (${JSON.stringify(spent)})`,
  spent.length >= 1 && spent.every((ins) => ins.length === 1 && ins[0] === 1));

// ── P4: the coin list from the second host, the main host recovering mid-spend with a forged body ──
nextMinute();
w = await wallet();
let mainUp = false;
const mainNode = nodeOf([A], { forge: true });
route(async (u, init) => {
  if (!mainUp) {
    // hangs on the coin list until the second host has answered it, then answers everything (forged source bodies)
    return new Promise((_res, rej) => {
      setTimeout(() => { mainUp = true; }, 1_600);
      const alive = setInterval(() => undefined, 1_000);   // AbortSignal.timeout's timer does not keep the loop alive
      init?.signal?.addEventListener("abort", () => { clearInterval(alive); rej(init.signal.reason); });
    });
  }
  return mainNode(u, init);
}, async (u, init) => { if (/\/tx\/0x/i.test(u)) await new Promise((res) => setTimeout(res, 300)); return nodeOf([A])(u, init); });
r = await w.send(RCPT, 1e8, 1e6);
check(`P4: the main host recovers mid-spend: source reads stay on the second host (${srcReads("backup")} there, ${srcReads("main")} at the main host), not VERIFY_TAMPER (${r.code ?? "ok"})`,
  mainUp && srcReads("backup") >= 1 && srcReads("main") === 0 && r.code !== "VERIFY_TAMPER");

// ── P5: both healthy, every read goes to the main host ──
nextMinute();
w = await wallet();
route(nodeOf([A]), nodeOf([A]));
r = await w.send(RCPT, 1e8, 1e6);
check(`P5: both healthy: the send reads only the main host (${log.filter((e) => e.host === "backup" && !e.u.endsWith("/tx/submit")).length} reads at the second host) and is sent`,
  r.ok === true && log.filter((e) => e.host === "backup" && !e.u.endsWith("/tx/submit")).length === 0 && srcReads("main") >= 1);

// ── P6: consolidate pins the same way ──
nextMinute();
w = await wallet();
route(down, nodeOf([A, B]));
r = await w.consolidate(1e6);
check(`P6: consolidate with the main host down verifies on the second host only (${srcReads("backup")} there, ${srcReads("main")} at the main host)`,
  srcReads("backup") === 2 && srcReads("main") === 0 && r.code !== "VERIFY_UNAVAILABLE");

// ── P7: a reconcile pass stays on the host that answered its tip ──
nextMinute();
const store7 = memoryStore();
w = new Wallet(store7);
await w.create("super-secret-pw");
const hist = [{ txid: "0x" + "ee".repeat(32), ts: Date.now(), type: "send", to: RCPT, amount: 1e8, fee: 1e6, maybe: true, inputs: [`${A.coin.txid}:0`] }];
const addr = (await w.status()).addr;
await store7.set(histKey(addr), hist);
const statusNode = (who) => async (u, init) => {
  if (u.includes("/status")) return json(200, { ok: true, state: "unknown", definite: true });
  if (u.includes("/utxos-all/")) return json(200, { utxos: [A.coin] });
  return nodeOf([A], { tip: who === "main" ? 1001 : 1000 })(u, init);
};
route(down, statusNode("backup"));
await w.pendingMerge([]);
const passHosts = new Set(log.filter((e) => /\/status$|\/utxos-all\//.test(e.u)).map((e) => e.host));
check(`P7: main host down: the tip from the second host, and the pass's status and mined set reads there only (${[...passHosts]})`,
  passHosts.size === 1 && passHosts.has("backup") && log.some((e) => e.u.includes("/status")) && log.some((e) => e.u.includes("/utxos-all/")) && log.some((e) => e.host === "backup" && e.u.endsWith("/tip")));

done("hosts-spend-pin");
