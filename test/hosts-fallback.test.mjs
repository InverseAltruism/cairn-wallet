// The default RPC's second host carries the node reads when the main host fails or is slow (src/core/hosts.ts).
//
// RED-FIRST against 0.3.4: with the main host accepting connections and never answering, the balance failed after the
// 12 s read timeout and the second host got no request (measured on the rig: 12,520 ms to "Balance unavailable").
// F1 fails there; it passes when the balance comes from the second host within HEDGE_MS plus its answer.
// PAIRED UNTOUCHED CASE: with both hosts healthy the second host gets no read at all and the balance carries no `via`
// (U1), and a main answer slower than 0.3.4's typical read but inside HEDGE_MS still asks the second host nothing (U2).
// The second host is never asked for an RPC a page or a setting names: a loopback RPC sends it nothing, reads or
// submit (L1, L2), and BACKUP_RPC cannot be set as the RPC (L3, L4).
// Mutations (run in a copy): ask the second host for any RPC (hostsFor returning both for every rpc) and L1, L2 fail;
// ask it only after the main host's timeout and F1 fails.
//
// Run: node --import tsx test/hosts-fallback.test.mjs   (offline; about 20 s, the hedge waits are real time)
// routes the second host itself
import { Wallet } from "../src/core/wallet.js";
import { memoryStore } from "../src/core/storage.js";
import { DEFAULT_RPC, BACKUP_RPC, rpcAllowed } from "../src/core/endpoints.js";
import { HEDGE_MS, BACKUP_FIRST_MS, hostsFor } from "../src/core/hosts.js";
import * as node from "../src/core/node.js";
import { mkCoin, txReply } from "./_coin.js";
import { checker } from "./helpers/check.mjs";

const { check, done } = checker("=== the second host for reads ===");
const COIN = mkCoin(5e8);
const RCPT = "0x" + "11".repeat(20);
const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const realNow = Date.now.bind(Date);
let skew = 0;
Date.now = () => realNow() + skew;
const nextMinute = () => { skew += BACKUP_FIRST_MS + 1_000; };   // leaves any "second host first" window behind

// A node that answers the wallet's reads; `delay` ms before each answer.
const healthy = (delay = 0) => async (u) => {
  if (delay) await new Promise((r) => setTimeout(r, delay));
  if (u.includes("/utxos/")) return json(200, { confirmed_balance: 5e8, utxos: [COIN.coin] });
  if (u.endsWith("/tip")) return json(200, { height: 1000 });
  if (u.includes("/tx/submit")) return json(200, { ok: true });
  return txReply(u, [COIN]) ?? json(404, {});
};
const down = async () => { throw new TypeError("fetch failed"); };
// accepts the connection and never answers; ends when the wallet's own timeout aborts it. The interval keeps the event
// loop alive meanwhile (AbortSignal.timeout's timer does not).
const hang = async (_u, init) => new Promise((_r, rej) => {
  const alive = setInterval(() => undefined, 1_000);
  init?.signal?.addEventListener("abort", () => { clearInterval(alive); rej(init.signal.reason); });
});

let log = [];
function route(main, backup) {
  log = [];
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    const host = u.startsWith(BACKUP_RPC + "/") ? "backup" : u.startsWith(DEFAULT_RPC + "/") ? "main" : "other";
    log.push({ host, u, t: realNow() });
    return (host === "backup" ? backup : main)(u, init);
  };
}
const asked = (host, pred = () => true) => log.filter((e) => e.host === host && pred(e.u)).length;
async function wallet() { const w = new Wallet(memoryStore()); await w.create("super-secret-pw"); return w; }
async function timed(fn) { const t0 = realNow(); try { return { v: await fn(), ms: realNow() - t0 }; } catch (e) { return { err: e, ms: realNow() - t0 }; } }

check("the default RPC has two hosts, main first", JSON.stringify(hostsFor(DEFAULT_RPC)) === JSON.stringify([DEFAULT_RPC, BACKUP_RPC]));

// ── U1, U2: both hosts healthy ──
let w = await wallet();
route(healthy(), healthy());
let b = await timed(() => w.balance());
check(`U1: both healthy: the balance from the main host, no via, 0 requests to the second host (${b.ms} ms)`,
  b.v?.confirmed === 5e8 && b.v.via === undefined && asked("backup") === 0 && asked("main") === 1);
route(healthy(HEDGE_MS - 400), healthy());
b = await timed(() => w.balance());
check(`U2: a main answer at ${HEDGE_MS - 400} ms: no request to the second host (${b.ms} ms)`, b.v?.via === undefined && asked("backup") === 0);

// ── F1: the main host hangs ──
route(hang, healthy());
b = await timed(() => w.balance());
check(`F1: the main host hangs: the balance comes from the second host with via "backup" in ${b.ms} ms (0.3.4: failed at 12 s)`,
  b.v?.confirmed === 5e8 && b.v.via === "backup" && b.ms < HEDGE_MS + 1_000);
const second = log.find((e) => e.host === "backup");
check("F1: the second host was asked HEDGE_MS after the main host, not before", !!second && second.t - log[0].t >= HEDGE_MS - 50);

// ── F2: the main host refuses the connection: the second host at once, then first for BACKUP_FIRST_MS ──
nextMinute();
route(down, healthy());
b = await timed(() => w.balance());
check(`F2: the main host refused: the balance from the second host at once (${b.ms} ms)`, b.v?.via === "backup" && b.ms < 500);
route(healthy(), healthy());
b = await timed(() => w.balance());
check("F3: within BACKUP_FIRST_MS of a main failure the second host is asked first", b.v?.via === "backup" && log[0].host === "backup" && asked("main") === 0);
nextMinute();
route(healthy(), healthy());
b = await timed(() => w.balance());
check("F4: after BACKUP_FIRST_MS the main host is asked first again", b.v?.via === undefined && log[0].host === "main" && asked("backup") === 0);
route(down, healthy());
await w.balance().catch(() => null);
route(healthy(), down);
b = await timed(() => w.balance());
check("F5: second host first, it fails: the main host is asked at once and answers", b.v?.confirmed === 5e8 && b.v.via === undefined && b.ms < 500);
route(healthy(), healthy());
b = await timed(() => w.balance());
check("F6: a main answer ends the second-host-first window", log[0].host === "main" && b.v?.via === undefined);

// ── F7: both fail: the main host's error, as with one host ──
nextMinute();
route(async () => json(502, { ok: false, error: "node unreachable" }), down);
b = await timed(() => w.balance());
check(`F7: both fail: balance() throws the main host's error (${String(b.err?.message)})`, b.err && /\/utxos\/.* -> 502/.test(String(b.err.message)));
const tipBoth = await w.tip();
check("F7: tip() of both failing is null, as with one host", tipBoth === null);

// ── F8: the other reads fall back too ──
nextMinute();
route(down, healthy());
check("F8: tip() from the second host when the main host is down", (await w.tip()) === 1000);
nextMinute();
route(down, async (u) => (u.includes("/proposal/") ? json(200, { proposal: { payload_hash: "0xab" } }) : json(404, {})));
check("F8: getProposal from the second host when the main host is down", (await node.getProposal(DEFAULT_RPC, "0x" + "cd".repeat(32)))?.payload_hash === "0xab");

// ── L1 to L4: an RPC a setting names never reaches the second host ──
for (const local of ["http://127.0.0.1:8789", "http://localhost:3000"]) {
  nextMinute();
  const lw = await wallet();
  await lw.setRpc(local);
  globalThis.fetch = async (url) => { const u = String(url); log.push({ host: u.startsWith(BACKUP_RPC) ? "backup" : "local", u }); throw new TypeError("fetch failed"); };
  log = [];
  await lw.balance().catch(() => null);
  await lw.tip();
  const s = await lw.send(RCPT, 1e8, 1e6);
  check(`L1: RPC ${local}, every read failing: 0 requests to the second host (${asked("backup")}), the send refused before signing (${s.code})`,
    asked("backup") === 0 && s.code === "VERIFY_UNAVAILABLE" && log.length > 0);
  globalThis.fetch = async (url, init) => { const u = String(url); log.push({ host: u.startsWith(BACKUP_RPC) ? "backup" : "local", u }); return healthy()(u, init); };
  log = [];
  const s2 = await lw.send(RCPT, 1e8, 1e6);
  check(`L2: RPC ${local}, a send that goes through: 0 requests to the second host, reads or submit (${asked("backup")})`, s2.ok === true && asked("backup") === 0 && log.some((e) => e.u.endsWith("/tx/submit")));
}
check("L3: BACKUP_RPC is not an allowed RPC", rpcAllowed(BACKUP_RPC) === false);
const lw = await wallet();
let threw = false;
try { await lw.setRpc(BACKUP_RPC); } catch { threw = true; }
check("L3: setRpc(BACKUP_RPC) is refused and the RPC stays the default", threw && (await lw.status()).rpc === DEFAULT_RPC);
const st = memoryStore();
await st.set("rpc", BACKUP_RPC);
const lw2 = new Wallet(st);
await lw2.init();
check("L4: a stored RPC equal to BACKUP_RPC is replaced by the default at start", (await lw2.status()).rpc === DEFAULT_RPC);

done("hosts-fallback");
