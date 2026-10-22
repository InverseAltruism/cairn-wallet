// A lock between a send's broadcast and its history write must not drop the history row.
//
// The row is the double-pay backstop: for a SUBMIT_MAYBE_INFLIGHT answer it is the only record that a
// signed tx may already be on the wire, and the failure copy tells the user to check history before
// resending. recordTx runs on histChain, and lock() nulls this.accts synchronously, so a lock (the idle
// auto-lock alarm, or the user) landing after the submit but before the chained write made recordTx
// return without writing or parking the row.
//   RED-FIRST: restore `if (!this.accts) return;` as the first line of recordTx's chained callback and
//   cases (1) and (2) fail (history() is empty after unlock).
//   PAIRED HONEST PATH: (3) a send with no lock writes its row straight to the store, parks nothing.
//   RESET BOUNDARY: (4) a reset() in the same window still drops the row: nothing of the old wallet is
//   parked or written, so a wallet created afterwards starts with an empty history.
//
// Run: node --import tsx test/lock-midflight-history.test.mjs   (offline)
import assert from "node:assert/strict";
import { Wallet } from "../src/core/wallet.js";
import { memoryStore } from "../src/core/storage.js";
import { mkCoin, txReply } from "./_coin.js";

const PW = "pw-lock-midflight-1234";
const RCPT = "0x" + "45".repeat(20);
const settle = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };

// onSubmit runs inside the /tx/submit request, after the signed tx has left the wallet: exactly the
// window in which an idle auto-lock can fire.
function mkFetch(coins, submitAnswer, onSubmit) {
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes("/tx/submit")) {
      await onSubmit?.();
      return submitAnswer();
    }
    if (u.includes("/utxos/")) return { ok: true, status: 200, json: async () => ({ confirmed_balance: coins.reduce((s, c) => s + c.coin.value, 0), utxos: coins.map((c) => c.coin) }) };
    if (u.endsWith("/tip")) return { ok: true, status: 200, json: async () => ({ height: 65_000 }) };
    const t = txReply(u, coins);
    if (t) return t;
    return { ok: false, status: 404, json: async () => ({}) };
  };
}
// no echoed txid: the wallet records under its locally computed txid either way
const okAnswer = () => ({ ok: true, status: 200, json: async () => ({ ok: true }) });
// a gateway 502 after the body was sent: the wallet answers SUBMIT_MAYBE_INFLIGHT under its local txid
const maybeAnswer = () => ({ ok: false, status: 502, json: async () => ({ error: "bad gateway" }) });

console.log("(1) an idle lock between broadcast and record keeps an ok send's history row");
{
  const w = new Wallet(memoryStore());
  const { addr } = await w.create(PW);
  let lockNow = true;
  mkFetch([mkCoin(41_00000000)], okAnswer, async () => { if (lockNow) await w.lock(); });
  const r = await w.send(RCPT, 3_00000000, 1_000_000);
  assert.equal(r.ok, true, "(1) the send broadcast");
  assert.equal((await w.status()).unlocked, false, "(1) the wallet locked mid-flight");
  lockNow = false;
  await w.unlock(PW);
  assert.equal((await w.status()).addr, addr);
  const h = await w.history();
  assert.equal(h.length, 1, "(1) history() shows the row after unlock");
  assert.equal(h[0].txid, r.txid);
  assert.equal(h[0].type, "send");
  assert.equal(h[0].maybe, undefined);
  // the parked row was written at unlock; the next send adds its own row beside it
  const r2 = await w.send(RCPT, 1_00000000, 1_000_000);
  assert.equal(r2.ok, true);
  await settle();
  const stored = await w.history();
  assert.deepEqual(stored.map((e) => e.txid).sort(), [r.txid, r2.txid].sort(), "(1) both rows are in history after the drain");
  console.log("  ok");
}

console.log("(2) the same for a SUBMIT_MAYBE_INFLIGHT send: its maybe row is the double-pay backstop");
{
  const w = new Wallet(memoryStore());
  await w.create(PW);
  mkFetch([mkCoin(42_00000000)], maybeAnswer, async () => { await w.lock(); });
  const r = await w.send(RCPT, 3_00000000, 1_000_000);
  assert.equal(r.ok, false);
  assert.equal(r.code, "SUBMIT_MAYBE_INFLIGHT", "(2) the answer is ambiguous");
  assert.match(r.txid, /^0x[0-9a-f]{64}$/, "(2) under the locally computed txid");
  mkFetch([mkCoin(42_00000000)], maybeAnswer);
  await w.unlock(PW);
  const h = await w.history();
  assert.equal(h.length, 1, "(2) the maybe row survived the lock");
  assert.equal(h[0].txid, r.txid);
  assert.equal(h[0].maybe, true, "(2) still flagged maybe");
  console.log("  ok");
}

console.log("(3) paired: a send with no lock writes its row to the store and parks nothing");
{
  const st = memoryStore();
  const w = new Wallet(st);
  const { addr } = await w.create(PW);
  mkFetch([mkCoin(43_00000000)], okAnswer);
  const r = await w.send(RCPT, 3_00000000, 1_000_000);
  assert.equal(r.ok, true);
  const stored = await st.get("txHistory:" + addr);
  assert.equal(stored?.length, 1, "(3) the row is in the store");
  assert.equal(stored[0].txid, r.txid);
  assert.equal(w.hist.pendingHist.length, 0, "(3) nothing parked");
  console.log("  ok");
}

console.log("(4) a reset in the same window still drops the row");
{
  const st = memoryStore();
  const w = new Wallet(st);
  const { addr } = await w.create(PW);
  let resetP = null;
  mkFetch([mkCoin(44_00000000)], okAnswer, async () => { resetP = w.reset(); });
  const r = await w.send(RCPT, 3_00000000, 1_000_000);
  assert.equal(r.ok, true);
  await resetP;
  await settle();
  assert.equal(w.hist.pendingHist.length, 0, "(4) nothing parked after a reset");
  assert.equal(await st.get("txHistory:" + addr), null, "(4) nothing written under the old account");
  await w.importKey("0x" + "42".repeat(32), PW);
  assert.deepEqual(await w.history(), [], "(4) a wallet created after the reset starts with an empty history");
  console.log("  ok");
}

console.log("\nlock-midflight-history: all assertions passed");
