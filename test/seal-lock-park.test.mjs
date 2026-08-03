// W4 (AW-SEAL-LOCK-1): lock() must not destroy a paid commit's reveal nonce, nor the parked history rows
// behind the double-pay backstop. FUNDS, narrow.
//
// The defect: `lock()` carried `this.pendingHist = []; this.pendingSeals = [];`. Both arrays are the ONLY
// copy of a record whose on-chain fee is ALREADY PAID after a failed chrome.storage.local write:
//   pendingSeals holds the sealClaim reveal preimage (vault ciphertext, encrypted at the park site), and
//                without it a paid commit-reveal can never be revealed.
//   pendingHist  holds the parked history row that the double-pay backstop reads (wallet.ts maybeRecord /
//                pendingMerge), so losing it re-arms a retry of a spend that already went out.
// An idle auto-lock is the ordinary case, not an exotic one: it fires on a timer while the user reads.
//
// The fix is the DELETION of that one line and nothing else. doReset() clears both independently (its own
// comment calls that the belt for a park that raced lock), which case (3) asserts is still true, so reset
// discipline is unchanged.
//
// HONESTY, and it belongs in the declaration, not only here: both arrays are RAM on the MV3 service
// worker and die at SW idle kill regardless. This buys survival across a lock and unlock inside ONE
// service-worker lifetime. It is not durability.
//
//   RED-FIRST: restore the wipe line in lock() and case (2) goes red (both parked records gone).
//   PAIRED HAPPY-PATH: case (3) doReset() still clears both, and case (4) a normal seal and a normal
//   history write against WORKING storage park nothing at all.
//
// Run: node --import tsx test/seal-lock-park.test.mjs   (offline)
import { Wallet } from "../src/core/wallet.js";
import { mkCoin, txReply } from "./_coin.js";

let pass = 0, fail = 0;
const check = (n, c) => { c ? (pass++, console.log("  ✓ " + n)) : (fail++, console.error("  ✗ " + n)); };
const origFetch = globalThis.fetch;
const PW = "pw-seal-lock-park-1234";
const RCPT = "0x" + "44".repeat(20);
const histKey = (a) => "txHistory:" + a;
const sealKey = (a) => "sealedClaims:" + a;
const settle = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };

// A store whose writes can be made to fail for the history / sealed-claim keys on demand, which is the
// exact trigger the park paths exist for (a quota or serialization failure in chrome.storage.local).
function mkStore() {
  const m = new Map();
  let failing = [];
  return {
    raw: m,
    fail(prefixes) { failing = prefixes; },
    store: {
      async get(k) { return m.has(k) ? structuredClone(m.get(k)) : null; },
      async set(k, v) {
        if (failing.some((p) => k.startsWith(p))) throw new Error("QuotaExceededError (simulated storage failure)");
        m.set(k, structuredClone(v));
      },
      async del(k) { m.delete(k); },
    },
  };
}

// Distinct coin values per scenario: node.ts keeps a module-level session ghost cache and mkCoin derives
// the txid from the tx, so distinct values give distinct txids (the ghostcoin.test.mjs harness rule).
function mkFetch(coins) {
  const submits = [];
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.includes("/tx/submit")) { submits.push(JSON.parse(init?.body ?? "{}")); return { ok: true, status: 200, json: async () => ({ ok: true, txid: "0x" + "aa".repeat(32) }) }; }
    if (u.includes("/utxos/")) return { ok: true, status: 200, json: async () => ({ confirmed_balance: coins.reduce((s, c) => s + c.coin.value, 0), utxos: coins.map((c) => c.coin) }) };
    if (u.endsWith("/tip")) return { ok: true, status: 200, json: async () => ({ height: 65_000 }) };
    const t = txReply(u, coins);
    if (t) return t;
    return { ok: false, status: 404, json: async () => ({}) };
  };
  return submits;
}

console.log("W4 (AW-SEAL-LOCK-1) - a lock must not destroy a PAID commit's parked records:\n");

const st = mkStore();
const coins = [mkCoin(31_00000000), mkCoin(17_00000000), mkCoin(11_00000000)];
const submits = mkFetch(coins);
const w = new Wallet(st.store);
const { addr } = await w.create(PW);

// ── 1. park a history row AND a seal record, both with the fee already spent ───────────────────────────
st.fail(["txHistory:", "sealedClaims:"]);
const sent = await w.send(RCPT, 5_00000000, 1_000_000);
check(`(1) the send broadcast (its fee is spent, so its history row must survive) (${sent?.error ?? "ok"})`, sent?.ok === true);
const sealed = await w.sealClaim({ claim: "the sealed text whose nonce is the only reveal key" });
check(`(1) the seal commit broadcast (its 0.25 CSD anchor is spent) (${sealed?.error ?? "ok"})`, sealed?.ok === true);
check("(1) the history write FAILED and parked", w.pendingHist.length > 0);
check("(1) the seal write FAILED and parked", w.pendingSeals.length === 1);
check("(1) nothing reached the store under the history key", st.raw.get(histKey(addr)) === undefined);
check("(1) nothing reached the store under the seal key", st.raw.get(sealKey(addr)) === undefined);
const parkedHistTxids = w.pendingHist.map((p) => p.entry.txid);
const parkedSealTxid = w.pendingSeals[0].rec.txid;
check("(1) the parked records are visible through the public reads (history merge)",
  (await w.history()).filter((e) => parkedHistTxids.includes(e.txid)).length === parkedHistTxids.length);
check("(1) ...and through sealedClaims()", (await w.sealedClaims()).some((s) => s.txid === parkedSealTxid));

// ── 2. THE FIX: an idle auto-lock, then unlock. Both parked records must still be there. ───────────────
await w.lock();
await w.unlock(PW);
check("(2) W4: the parked SEAL record survived lock/unlock (the paid commit is still revealable)",
  w.pendingSeals.length === 1 && w.pendingSeals[0].rec.txid === parkedSealTxid);
check("(2) W4: the parked HISTORY rows survived lock/unlock (the double-pay backstop still sees them)",
  w.pendingHist.length === parkedHistTxids.length);
check("(2) W4: sealedClaims() still lists the paid commit after the unlock",
  (await w.sealedClaims()).some((s) => s.txid === parkedSealTxid));
check("(2) W4: revealClaim can still find the parked seal (the reveal nonce is not lost)",
  (await w.sealedClaims()).find((s) => s.txid === parkedSealTxid)?.enc != null);
check("(2) W4: history() still merges the parked rows after the unlock",
  (await w.history()).filter((e) => parkedHistTxids.includes(e.txid)).length === parkedHistTxids.length);

// ── 2b. and they DRAIN on the next write of their kind, which is what parking is for ───────────────────
st.fail([]);
await w.send(RCPT, 2_00000000, 1_000_000);
await settle();                                   // the history drain rides BEHIND the caller's own write
await w.sealClaim({ claim: "a second sealed text" });
await settle();
const storedHist = st.raw.get(histKey(addr)) || [];
const storedSeals = st.raw.get(sealKey(addr)) || [];
check("(2b) every parked history row drained to the store on the next history write",
  parkedHistTxids.every((t) => storedHist.some((e) => e.txid === t)));
check("(2b) the parked seal drained to the store on the next seal write",
  storedSeals.some((s) => s.txid === parkedSealTxid));
check("(2b) nothing is still parked", w.pendingHist.length === 0 && w.pendingSeals.length === 0);

// ── 3. PAIRED HAPPY-PATH: doReset() still clears both (reset discipline unchanged) ─────────────────────
console.log("\nPAIRED HAPPY-PATH (reset discipline and clean writes are unchanged):");
{
  const st2 = mkStore();
  mkFetch([mkCoin(29_00000000), mkCoin(13_00000000)]);
  const w2 = new Wallet(st2.store);
  const a2 = (await w2.create("pw-reset-park-1234")).addr;
  st2.fail(["txHistory:", "sealedClaims:"]);
  await w2.send(RCPT, 3_00000000, 1_000_000);
  await w2.sealClaim({ claim: "parked before a reset" });
  check("(3) NON-VACUITY: both arrays are non-empty before the reset",
    w2.pendingHist.length > 0 && w2.pendingSeals.length > 0);
  st2.fail([]);
  await w2.reset();
  check("(3) doReset() still clears pendingHist", w2.pendingHist.length === 0);
  check("(3) doReset() still clears pendingSeals", w2.pendingSeals.length === 0);
  check("(3) ...and the stored keys are gone", st2.raw.get(histKey(a2)) === undefined && st2.raw.get(sealKey(a2)) === undefined);
}

// ── 4. PAIRED HAPPY-PATH: working storage parks NOTHING (no new state on the honest path) ─────────────
{
  const st3 = mkStore();
  const s3 = mkFetch([mkCoin(23_00000000), mkCoin(7_00000000)]);
  const w3 = new Wallet(st3.store);
  const a3 = (await w3.create("pw-clean-park-1234")).addr;
  const r = await w3.send(RCPT, 4_00000000, 1_000_000);
  const sc = await w3.sealClaim({ claim: "a clean seal" });
  check(`(4) a normal send against working storage succeeds (${r?.error ?? "ok"})`, r?.ok === true);
  check(`(4) a normal seal against working storage succeeds (${sc?.error ?? "ok"})`, sc?.ok === true);
  check("(4) NOTHING was parked", w3.pendingHist.length === 0 && w3.pendingSeals.length === 0);
  check("(4) both rows are in the store directly", (st3.raw.get(histKey(a3)) || []).length === 2 && (st3.raw.get(sealKey(a3)) || []).length === 1);
  check("(4) and a lock/unlock in the middle of a clean session changes nothing", s3.length === 2);
  await w3.lock(); await w3.unlock("pw-clean-park-1234");
  check("(4) history still reads back after lock/unlock", (await w3.history()).length === 2);
}

globalThis.fetch = origFetch;
console.log(`\nseal-lock-park: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
