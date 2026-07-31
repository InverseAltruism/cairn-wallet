// P75-6 CLASS A durability: storage write chains + guarded post-broadcast writes.
//
// The wallet awaits maybeRecord before send() returns (the double-pay backstop), so a storage throw
// AFTER a successful broadcast used to turn a SUCCEEDED send into a REPORTED FAILURE (real double-pay on
// retry). This suite drives the real Wallet + a scriptable store to prove:
//   * post-broadcast history/seal writes NEVER reject the flow (parked + retried, still visible via the
//     history()/sealedClaims() merge);
//   * two writers cannot interleave a get..set and clobber each other (histChain / sealChain);
//   * the balance/network fetch never sits inside a write chain (the send hot path stays free);
//   * reset()/lock()/removeAccount cannot be defeated OR resurrected by a parked write.
// Plus the accepted folds: F1 non-string-claim refusal, F2 unrevealed-preimage-safe seal cap, F3 backward-
// clock auto-lock clamp, F4 chained removeAccount deletes, F5 cairnPost content-queue guard.
//
// Harness = existing house patterns (consolidate.test URL-routed stub, persistvault-race gated store,
// seal-encrypt money assertion). Every case runs in isolation; a throw is recorded as a failure, never
// aborts the file, so ALL red cases are visible in one unfixed run.
import { readFileSync } from "node:fs";
import { Wallet } from "../src/core/wallet.js";
import { memoryStore } from "../src/core/storage.js";
import { cairnPayloadHash } from "../src/core/csdtx.js";
import { checker } from "./_check.ts";
import { mkCoin, txReply } from "./_coin.js";

const { check, done } = checker("P75-6 storage durability (write chains + guarded post-broadcast writes):");
const PW = "super-secret-pw";
const FEE = 1_000_000;
const TO = (b) => "0x" + b.repeat(20);
const hexOf = (bytes) => "0x" + Array.from(bytes ?? [], (b) => Number(b).toString(16).padStart(2, "0")).join("");
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

// distinct coin values across ALL cases (mkCoin derives txid from value; the node's process-level ghost
// cache is keyed by txid, so distinct values keep cases independent).
let bigSeq = 21, dustSeq = 101;
const bigCoin = () => mkCoin(bigSeq++ * 1e8);   // 21e8, 22e8, ... spendable
const dustCoin = () => mkCoin(dustSeq++);       // 101, 102, ... tiny, present in /utxos but never selected

const origFetch = globalThis.fetch;

// ── URL-routed fetch stub (consolidate.test pattern) + a one-shot /utxos gate for case J ──
function mkStub({ coins, served, submit, gateUtxosOnce = false }) {
  const stats = { submits: [], utxos: 0, content: null };
  let utxoGate = null;
  const armUtxoGate = () => {
    let release = () => {}, hitResolve = () => {};
    const promise = new Promise((r) => { release = r; });
    const hit = new Promise((r) => { hitResolve = r; });
    utxoGate = { promise, release, hitResolve };
    return { hit, release: () => release() };
  };
  const wrapped = async (url, init) => {
    const u = String(url);
    if (u.includes("/tx/submit")) {
      stats.submits.push(JSON.parse(init?.body ?? "{}"));
      return submit ? submit() : { ok: true, status: 200, json: async () => ({ ok: true, txid: "0x" + "aa".repeat(32) }) };
    }
    if (u.includes("/utxos/")) {
      stats.utxos++;
      if (gateUtxosOnce && utxoGate) { const g = utxoGate; utxoGate = null; g.hitResolve(); await g.promise; }
      return { ok: true, status: 200, json: async () => ({ confirmed_balance: coins.reduce((s, c) => s + c.coin.value, 0), utxos: coins.map((c) => c.coin) }) };
    }
    if (u.endsWith("/tip")) return { ok: true, status: 200, json: async () => ({ height: 50_000 }) };
    if (u.includes("/api/content")) { stats.content = JSON.parse(init?.body ?? "{}"); return { ok: true, status: 200, json: async () => ({ ok: true }) }; }
    const idm = u.match(/\/tx\/(0x[0-9a-fA-F]{64})\b/);
    if (idm) return txReply(u, served);
    return { ok: false, status: 404, json: async () => ({}) };
  };
  return { fetch: wrapped, stats, armUtxoGate };
}

// ── a memoryStore that can THROW (failSet/failGet) or PARK (gatePrefix) writes by key prefix ──
function scriptedStore() {
  const inner = memoryStore();
  const failSet = [], failGet = [];
  let gate = null; // { prefix, skip, count, promise, release, hitResolve }
  const store = {
    async get(k) {
      for (const p of failGet) if (k.startsWith(p)) throw new Error("scripted get failure: " + k);
      return inner.get(k);
    },
    async set(k, v) {
      if (gate && k.startsWith(gate.prefix)) {
        if (gate.count === gate.skip) { const g = gate; gate = null; g.hitResolve(); await g.promise; }
        else gate.count++;
      }
      for (const p of failSet) if (k.startsWith(p)) throw new Error("scripted set failure: " + k);
      return inner.set(k, v);
    },
    async del(k) { return inner.del(k); },
  };
  return {
    store,
    failSet: (p) => failSet.push(p),
    healSet: (p) => { const i = failSet.indexOf(p); if (i >= 0) failSet.splice(i, 1); },
    failGet: (p) => failGet.push(p),
    healGet: (p) => { const i = failGet.indexOf(p); if (i >= 0) failGet.splice(i, 1); },
    gatePrefix(prefix, skip = 0) {
      let release = () => {}, hitResolve = () => {};
      const promise = new Promise((r) => { release = r; });
      const hit = new Promise((r) => { hitResolve = r; });
      gate = { prefix, skip, count: 0, promise, release, hitResolve };
      return { hit, release: () => release() };
    },
  };
}

async function runCase(name, fn) {
  try { await fn(); }
  catch (e) { check(`[case ${name}] threw unexpectedly: ${(e && e.message) || e}`, false); }
  finally { globalThis.fetch = origFetch; }
}

const hk = (addr) => "txHistory:" + addr;
const sk = (addr) => "sealedClaims:" + addr;

// ── Case A (C1): a post-broadcast history-write failure must NOT convert a succeeded broadcast into a
//    reported failure. The send RESOLVES ok; the entry is parked and stays visible via the history() merge. ──
await runCase("A", async () => {
  const coins = [bigCoin(), bigCoin()];
  const { fetch } = mkStub({ coins, served: coins });
  globalThis.fetch = fetch;
  const sc = scriptedStore();
  const w = new Wallet(sc.store);
  const { addr } = await w.create(PW);
  sc.failSet("txHistory:");
  let r = null, threw = false;
  try { r = await w.send(TO("22"), 5e8, FEE); } catch { threw = true; }
  check("A: send() RESOLVES ok despite the history-write throw (no succeeded->failed misreport)", threw === false && !!r && r.ok === true);
  check("A: the send is still visible via the history() pending-merge", (await w.history()).some((x) => x.type === "send" && x.txid === r?.txid));
});

// ── Case A2 (paired happy): healthy store, exact production send shape lands the entry in the store ──
await runCase("A2", async () => {
  const coins = [bigCoin(), bigCoin()];
  const { fetch } = mkStub({ coins, served: coins });
  globalThis.fetch = fetch;
  const store = memoryStore();
  const w = new Wallet(store);
  const { addr } = await w.create(PW);
  const r = await w.send(TO("33"), 6e8, 1_000_000);
  check("A2 happy: healthy send returns ok", r.ok === true);
  check("A2 happy: the entry LANDS in the store with type:send", ((await store.get(hk(addr))) || []).some((x) => x.type === "send" && x.txid === r.txid));
});

// ── Case C (pinned by M3): the drain rides BEHIND the caller's own write and is NOT part of the promise the
//    caller awaits (recordTx returns its own RMW only). send #2 is MAYBE-INFLIGHT so maybeRecord awaits ONLY
//    recordTx (no latchSpentMerges): send #2 must resolve while the drain's store write is still parked. Under
//    M3 (drain moved INSIDE the awaited work) send #2 hangs behind the parked drain. ──
await runCase("C", async () => {
  const coins = [bigCoin(), bigCoin(), bigCoin(), bigCoin()];
  let submitMode = "ok";
  const submit = async () => submitMode === "ok"
    ? { ok: true, status: 200, json: async () => ({ ok: true, txid: "0x" + "aa".repeat(32) }) }
    : { ok: false, status: 502, json: async () => { throw new Error("gateway"); } };
  const { fetch } = mkStub({ coins, served: coins, submit });
  globalThis.fetch = fetch;
  const sc = scriptedStore();
  const w = new Wallet(sc.store);
  const { addr } = await w.create(PW);
  // 1) park an entry: fail the first history write (send #1 still broadcasts ok)
  sc.failSet("txHistory:");
  let r1 = null; try { r1 = await w.send(TO("22"), 5e8, FEE); } catch { r1 = null; }
  if (!r1?.ok) { check("C: (park mechanism absent on this tree; pinned by M3)", false); return; }
  // 2) heal; gate the DRAIN's write. send #2 (maybe-inflight) awaits ONLY its own RMW (1st set); the drain
  //    (of the parked entry1) is the 2nd set -> gate the 2nd.
  sc.healSet("txHistory:");
  submitMode = "maybe";
  const gate = sc.gatePrefix("txHistory:", 1);
  let send2Done = false;
  const p2 = w.send(TO("33"), 6e8, FEE).then((r) => { send2Done = true; return r; });
  await tick(30);
  check("C (M3): send #2 RESOLVES while the drain's write is still parked (drain not on the caller's awaited promise)", send2Done === true);
  gate.release();
  const r2 = await p2;
  check("C: send #2 recorded its own entry", ((await sc.store.get(hk(addr))) || []).some((x) => x.txid === r2.txid));
});

// ── Case D (pinned by M1): a rejected chained write-back must NOT poison the queue. pendingMerge's chained
//    write-back throws; the NEXT send must still record and resolve. ──
await runCase("D", async () => {
  const seed = dustCoin();
  const coins = [bigCoin(), bigCoin(), seed];
  const { fetch } = mkStub({ coins, served: coins });
  globalThis.fetch = fetch;
  const sc = scriptedStore();
  const w = new Wallet(sc.store);
  const { addr } = await w.create(PW);
  await sc.store.set(hk(addr), [{ txid: seed.coin.txid, ts: Date.now(), type: "consolidate", merged: 2, amount: 42e8, fee: FEE, maybe: true }]);
  sc.failSet("txHistory:"); // pendingMerge's reconcile write-back will throw
  try { await w.pendingMerge([{ txid: seed.coin.txid }]); } catch { /* unfixed pendingMerge rejects on write-back throw; the chain-poison assertion is the send below */ }
  sc.healSet("txHistory:");
  let r = null; try { r = await w.send(TO("22"), 40e8, FEE); } catch { r = null; }
  check("D (M1): after a rejected chained write-back, the NEXT send still records + resolves (queue not poisoned)",
    !!r && r.ok === true && ((await sc.store.get(hk(addr))) || []).some((x) => x.type === "send" && x.txid === r.txid));
});

// ── Case E (C2): sealChain serialization. Seal A parks at its sealedClaims write; seal B completes meanwhile;
//    on release both survive (A's stale write-back cannot clobber B). ──
await runCase("E", async () => {
  const coins = [bigCoin()];
  const { fetch } = mkStub({ coins, served: coins });
  globalThis.fetch = fetch;
  const sc = scriptedStore();
  const w = new Wallet(sc.store);
  const { addr } = await w.create(PW);
  const gate = sc.gatePrefix("sealedClaims:", 0);
  const pA = w.sealClaim({ domain: "csd:sealed", claim: "seal-A prediction" });
  await gate.hit;
  const pB = w.sealClaim({ domain: "csd:sealed", claim: "seal-B prediction" });
  await tick(30);
  gate.release();
  const [rA, rB] = await Promise.all([pA, pB]);
  const raw = (await sc.store.get(sk(addr))) || [];
  check("E: seal A survives", raw.some((x) => x.txid === rA.txid));
  check("E: seal B survives the interleave (A's stale write-back did not clobber it)", raw.some((x) => x.txid === rB.txid));
});

// ── Case F (C2 + SEAL-WRITE-02): a sealedClaims write throw after a successful commit broadcast must neither
//    reject sealClaim nor destroy the nonce. The record parks; history still records; the next seal drains it.
//    Happy continuation: the drained record reveals and recomputes the committed on-chain hash (money check). ──
await runCase("F", async () => {
  const coins = [bigCoin()];
  const { fetch, stats } = mkStub({ coins, served: coins });
  globalThis.fetch = fetch;
  const sc = scriptedStore();
  const w = new Wallet(sc.store);
  const { addr } = await w.create(PW);
  sc.failSet("sealedClaims:");
  let r = null, threw = false;
  try { r = await w.sealClaim({ domain: "csd:sealed", claim: "case-F secret preimage" }); } catch { threw = true; }
  check("F: sealClaim RESOLVES ok despite the seal-write throw (commit was broadcast)", threw === false && !!r && r.ok === true);
  check("F: a history row was still recorded for the PAID commit", (await w.history()).some((x) => x.type === "seal" && x.txid === r?.txid));
  check("F: the encrypted preimage stays visible via the pending-seal merge (nonce not destroyed)", (await w.sealedClaims()).some((x) => x.txid === r?.txid));
  const committed = hexOf(stats.submits[0]?.tx?.app?.Propose?.payload_hash);
  // heal: the next seal drains the parked record to disk with ciphertext intact and no plaintext.
  sc.healSet("sealedClaims:");
  const r2 = await w.sealClaim({ domain: "csd:sealed", claim: "case-F drain trigger" });
  check("F happy: the second seal returns ok", r2.ok === true);
  const drained = ((await sc.store.get(sk(addr))) || []).find((x) => x.txid === r?.txid);
  check("F happy: the parked record DRAINED to disk with ciphertext intact and NO plaintext", !!drained && !!drained.enc && drained.claim === undefined && drained.nonce === undefined);
  const rr = await w.revealClaim(r.txid);
  check("F happy: revealClaim returns ok on the drained record", !!rr && rr.ok === true);
  const recomputed = cairnPayloadHash({ v: 1, sealed: 1, domain: "csd:sealed", claim: stats.content?.claim, nonce: stats.content?.nonce });
  check("F happy: the drained preimage recomputes the committed on-chain hash (money assertion)", String(recomputed).toLowerCase() === String(committed).toLowerCase());
});

// ── Case G (C4): reset() must not race a parked history write. Park a send's history set, reset(), release:
//    the wipe holds (no resurrection). ──
await runCase("G", async () => {
  const coins = [bigCoin(), bigCoin()];
  const { fetch } = mkStub({ coins, served: coins });
  globalThis.fetch = fetch;
  const sc = scriptedStore();
  const w = new Wallet(sc.store);
  const { addr } = await w.create(PW);
  const gate = sc.gatePrefix("txHistory:", 0);
  const pSend = w.send(TO("22"), 4e8, FEE);
  await gate.hit;
  const pReset = w.reset();
  await tick(0);
  gate.release();
  await Promise.allSettled([pSend, pReset]);
  const hist = await sc.store.get(hk(addr));
  check("G: reset() leaves NO history after a racing parked send write (wipe holds)", hist === null || (Array.isArray(hist) && hist.length === 0));
  check("G: reset() wiped the vault ciphertext", (await sc.store.get("vault")) === null);
});

// ── Case G2 (C4): same for a parked sealedClaims write. ──
await runCase("G2", async () => {
  const coins = [bigCoin()];
  const { fetch } = mkStub({ coins, served: coins });
  globalThis.fetch = fetch;
  const sc = scriptedStore();
  const w = new Wallet(sc.store);
  const { addr } = await w.create(PW);
  const gate = sc.gatePrefix("sealedClaims:", 0);
  const pSeal = w.sealClaim({ domain: "csd:sealed", claim: "G2 secret" });
  await gate.hit;
  const pReset = w.reset();
  await tick(0);
  gate.release();
  await Promise.allSettled([pSeal, pReset]);
  const raw = await sc.store.get(sk(addr));
  check("G2: reset() leaves NO sealed-claims after a racing parked seal write", raw === null || (Array.isArray(raw) && raw.length === 0));
});

// ── Case H (pinned by M5): a SUBMIT that lands AFTER reset() completes must not re-create history (the
//    chained WRITE callback bails on !this.accts). ──
await runCase("H", async () => {
  const coins = [bigCoin(), bigCoin()];
  let releaseSubmit = () => {};
  const submitGate = new Promise((r) => { releaseSubmit = r; });
  const { fetch } = mkStub({ coins, served: coins, submit: async () => { await submitGate; return { ok: true, status: 200, json: async () => ({ ok: true, txid: "0x" + "aa".repeat(32) }) }; } });
  globalThis.fetch = fetch;
  const sc = scriptedStore();
  const w = new Wallet(sc.store);
  const { addr } = await w.create(PW);
  const pSend = w.send(TO("22"), 5e8, FEE); // parks at the submit network call
  await tick(20);
  await w.reset();       // completes fully (nothing storage-parked)
  releaseSubmit();
  await pSend.catch(() => {});
  await tick(10);
  check("H (M5): a submit landing after reset() does NOT re-create history (the !accts bail holds)", (await sc.store.get(hk(addr))) === null);
  check("H: the wallet stays wiped after the late submit", (await sc.store.get("vault")) === null);
});

// ── Case I (pinned by M9): parked retries are cleared in lock(); an entry parked pre-lock must not resurface
//    after unlock + the next send's drain. ──
await runCase("I", async () => {
  const coins = [bigCoin(), bigCoin()];
  const { fetch } = mkStub({ coins, served: coins });
  globalThis.fetch = fetch;
  const sc = scriptedStore();
  const w = new Wallet(sc.store);
  const { addr } = await w.create(PW);
  sc.failSet("txHistory:");
  let rFail = null; try { rFail = await w.send(TO("22"), 5e8, FEE); } catch { rFail = null; }
  if (!check("I setup: the failed-write send resolved ok (park mechanism present)", !!rFail && rFail.ok === true)) return;
  sc.healSet("txHistory:");
  await w.lock();
  await w.unlock(PW);
  await w.send(TO("33"), 4e8, FEE); // its drain (under M9) would flush the pre-lock parked entry
  const hist = (await sc.store.get(hk(addr))) || [];
  check("I (M9): a parked entry cleared at lock() does NOT resurface after unlock + next send", !hist.some((x) => x.txid === rFail.txid));
});

// ── Case J (C3 + pinned by M4): pendingMerge re-reads history INSIDE the chain and keeps the balance fetch
//    OUTSIDE it. A send that completes while the balance fetch is parked (a) resolves immediately (network is
//    not inside the chain) and (b) survives pendingMerge's write-back (fresh re-read, no stale clobber). ──
await runCase("J", async () => {
  const seed = dustCoin();
  const coins = [bigCoin(), bigCoin(), seed];
  const { fetch, armUtxoGate } = mkStub({ coins, served: coins, gateUtxosOnce: true });
  globalThis.fetch = fetch;
  const sc = scriptedStore();
  const w = new Wallet(sc.store);
  const { addr } = await w.create(PW);
  await sc.store.set(hk(addr), [{ txid: seed.coin.txid, ts: Date.now(), type: "consolidate", merged: 2, amount: 42e8, fee: FEE, maybe: true }]);
  const ug = armUtxoGate();
  const pmP = w.pendingMerge();       // no utxos -> fetches balance -> first /utxos gated (parked)
  await ug.hit;                       // pendingMerge parked at the balance fetch (OUTSIDE the chain)
  let sendDone = false;
  const sendP = w.send(TO("22"), 40e8, FEE).then((r) => { sendDone = true; return r; });
  await tick(30);
  check("J (M4): send RESOLVES while the balance fetch is still parked (network stays OUTSIDE the chain)", sendDone === true);
  ug.release();
  const sr = await sendP;
  await pmP;
  const hist = (await sc.store.get(hk(addr))) || [];
  check("J: the send recorded during the balance fetch SURVIVES pendingMerge's write-back (fresh re-read, no clobber)", hist.some((x) => x.type === "send" && x.txid === sr.txid));
  const e = hist.find((x) => x.txid === seed.coin.txid);
  check("J: pendingMerge still reconciled the seeded entry (maybe cleared, confirmed latched)", !!e && e.maybe === undefined && e.confirmed === true);
});

// ── Case K (F3 + pinned by M7): a backward wall-clock jump must still eventually auto-lock (clamp restarts
//    the idle window rather than leaving now-lastActive negative forever). Forward-clock behavior unchanged. ──
await runCase("K", async () => {
  const realNow = Date.now;
  try {
    {
      let clock = 1_700_000_000_000;
      Date.now = () => clock;
      const w = new Wallet(memoryStore(), memoryStore());
      await w.create(PW);               // touch at t0 (lastActive = clock)
      clock -= 60 * 60 * 1000;          // wall clock jumps BACK 1h
      await w.autoLock(15 * 60 * 1000); // fixed: clamp lastActive to now; does NOT lock instantly
      check("K: a backward jump does not instantly lock (idle window restarts, no UX regression)", (await w.status()).unlocked === true);
      clock += 16 * 60 * 1000;          // 16 min elapse past the 15-min window
      await w.autoLock(15 * 60 * 1000);
      check("K (M7): after a backward clock jump the vault DOES eventually auto-lock (no stuck-unlocked)", (await w.status()).unlocked === false);
    }
    {
      let clock = 1_800_000_000_000;
      Date.now = () => clock;
      const w = new Wallet(memoryStore(), memoryStore());
      await w.create(PW);
      clock += 10 * 60 * 1000;          // within the 15-min window
      await w.autoLock(15 * 60 * 1000);
      check("K happy: within-window forward idle stays UNLOCKED", (await w.status()).unlocked === true);
      clock += 6 * 60 * 1000;           // now 16 min total, past the window
      await w.autoLock(15 * 60 * 1000);
      check("K happy: past-window forward idle LOCKS (existing behavior preserved)", (await w.status()).unlocked === false);
    }
  } finally { Date.now = realNow; }
});

// ── Case L (F2 + pinned by M6): the 500 cap must never evict an UNREVEALED preimage (the only copy of a paid
//    commit's nonce). Oldest = unrevealed, rest revealed: adding one seal evicts an old REVEALED entry, keeps
//    the unrevealed one. Happy: an all-unrevealed list is kept whole. ──
await runCase("L", async () => {
  const coins = [bigCoin()];
  const { fetch } = mkStub({ coins, served: coins });
  globalThis.fetch = fetch;
  const sc = scriptedStore();
  const w = new Wallet(sc.store);
  const { addr } = await w.create(PW);
  const oldestUnrevealed = "0x" + "e0".repeat(32);
  const recs = [];
  for (let i = 0; i < 499; i++) recs.push({ txid: "0x" + String(i).padStart(64, "0"), domain: "csd:sealed", committedTs: 1000 - i, revealed: true });
  recs.push({ txid: oldestUnrevealed, domain: "csd:sealed", committedTs: 0, revealed: false }); // oldest, unrevealed
  await sc.store.set(sk(addr), recs); // 500 records, newest-first, only the oldest is unrevealed
  await w.sealClaim({ domain: "csd:sealed", claim: "L over-cap seal" }); // 501 -> cap
  const raw = (await sc.store.get(sk(addr))) || [];
  check("L (M6): the sealed cap kept the oldest UNREVEALED preimage (evicted an old REVEALED one instead)", raw.some((x) => x.txid === oldestUnrevealed) && raw.length === 500);

  // happy: 500 UNREVEALED + 1 new (also unrevealed) -> all 501 kept whole (nothing droppable).
  const sc2 = scriptedStore();
  const w2 = new Wallet(sc2.store);
  const { addr: addr2 } = await w2.create(PW);
  const un = [];
  for (let i = 0; i < 500; i++) un.push({ txid: "0x" + ("f" + String(i).padStart(63, "0")), domain: "csd:sealed", committedTs: i, revealed: false });
  await sc2.store.set(sk(addr2), un);
  await w2.sealClaim({ domain: "csd:sealed", claim: "L all-unrevealed seal" });
  const raw2 = (await sc2.store.get(sk(addr2))) || [];
  check("L happy: an all-unrevealed list is kept whole (501 records, none evicted)", raw2.length === 501);
});

// ── Case M (F1): a non-string claim would be hashed as-is on commit but String()-normalized on reveal, so
//    the paid commit could never be revealed. Refuse BEFORE any fee is spent. A string claim still seals. ──
await runCase("M", async () => {
  const coins = [bigCoin()];
  const { fetch, stats } = mkStub({ coins, served: coins });
  globalThis.fetch = fetch;
  const w = new Wallet(memoryStore());
  await w.create(PW);
  const before = stats.submits.length;
  let threwObj = false, threwNum = false;
  try { await w.sealClaim({ claim: { evil: 1 } }); } catch { threwObj = true; }
  try { await w.sealClaim({ claim: 42 }); } catch { threwNum = true; }
  check("M: a non-string (object) claim is REFUSED", threwObj === true);
  check("M: a non-string (number) claim is REFUSED", threwNum === true);
  check("M: neither refused seal broadcast anything (0 submits)", stats.submits.length === before);
  const r = await w.sealClaim({ domain: "csd:sealed", claim: "a legit string prediction" });
  check("M happy: a normal string claim still seals ok", r.ok === true);
});

// ── Case O (F4 + pinned by M10): removeAccount rides the chains so a parked write for the removed account
//    cannot land after the delete (no resurrection); and it purges the account's parked retries so a later
//    drain cannot re-create its key. ──
await runCase("O", async () => {
  // (a) a parked history write for B cannot resurrect txHistory:B after removeAccount(B).
  const coins = [bigCoin(), bigCoin()];
  const { fetch } = mkStub({ coins, served: coins });
  globalThis.fetch = fetch;
  const sc = scriptedStore();
  const w = new Wallet(sc.store);
  await w.create(PW);
  const { addr: addrB } = await w.addAccount("B");
  const { addr: addrA } = { addr: (await w.accounts())[0].addr };
  await w.switchAccount(addrB);
  const gate = sc.gatePrefix("txHistory:" + addrB, 0);
  const pSend = w.send(TO("22"), 4e8, FEE); // signs as B; recordTx parks at B's history set
  await gate.hit;
  await w.switchAccount(addrA);
  const pRemove = w.removeAccount(addrB);   // schedules the chained del BEHIND the parked send write
  gate.release();
  await Promise.allSettled([pSend, pRemove]);
  await tick(10);
  const histB = await sc.store.get(hk(addrB));
  check("O: removeAccount(B) purges B's history even against a parked send write (no resurrection)", histB === null || (Array.isArray(histB) && histB.length === 0));

  // (b, M10) a PARKED retry for B must be purged, so a later drain cannot re-create txHistory:B.
  const sc2 = scriptedStore();
  const w2 = new Wallet(sc2.store);
  await w2.create(PW);
  const { addr: b2 } = await w2.addAccount("B");
  const a2 = (await w2.accounts())[0].addr;
  await w2.switchAccount(b2);
  sc2.failSet("txHistory:" + b2);
  let rB = null; try { rB = await w2.send(TO("44"), 4e8, FEE); } catch { rB = null; }
  if (!rB?.ok) { check("O-purge: (park mechanism absent on this tree; pinned by M10)", false); return; }
  sc2.healSet("txHistory:" + b2);
  await w2.switchAccount(a2);
  await w2.removeAccount(b2);                 // must purge B's parked retry
  await w2.send(TO("55"), 4e8, FEE);          // its drain must NOT resurrect txHistory:B
  const histB2 = await sc2.store.get(hk(b2));
  check("O-purge (M10): removeAccount(B) purges B's parked retry so a later drain cannot resurrect its key", histB2 === null || (Array.isArray(histB2) && histB2.length === 0));
});

// ── Case F5 (optional fold, same PCD-2 class): a pendingContent write throw after a PAID propose must not
//    make cairnPost reject; the propose is still recorded. ──
await runCase("F5", async () => {
  const coins = [bigCoin()];
  const { fetch } = mkStub({ coins, served: coins });
  globalThis.fetch = fetch;
  const sc = scriptedStore();
  const w = new Wallet(sc.store);
  const { addr } = await w.create(PW);
  sc.failSet("pendingContent");
  let r = null, threw = false;
  try { r = await w.cairnPost({ domain: "csd:apps", title: "t", body: "b", fee: 25_000_000 }); } catch { threw = true; }
  check("F5: cairnPost RESOLVES despite a pendingContent write throw (propose was broadcast)", threw === false && !!r && (r.ok === true || r.code === "SUBMIT_MAYBE_INFLIGHT"));
  check("F5: a history row was still recorded for the paid propose", (await w.history()).some((x) => x.type === "post" && x.txid === r?.txid));
});

// ── Source pins (pinned by M1/M2): both chains settle BOTH paths, so a rejection can never poison the queue. ──
await runCase("source-pins", async () => {
  const src = readFileSync(new URL("../src/core/wallet.ts", import.meta.url), "utf8");
  check("SRC: histChain settles both paths (this.histChain = run.then(() => {}, () => {}))", src.includes("this.histChain = run.then(() => {}, () => {});"));
  check("SRC: sealChain settles both paths (this.sealChain = run.then(() => {}, () => {}))", src.includes("this.sealChain = run.then(() => {}, () => {});"));
});

done("storage-durability");
