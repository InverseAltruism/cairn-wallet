// Consolidate + send-error-precision suite (0.2.55). Covers the three node.ts behavior changes
// shipped together (2026-07-09):
//   1. consolidate(): merge up to MAX_TX_INPUTS smallest coins into ONE self-output — every input
//      chain-verified (TXB-1), output ONLY to the signing key's own address, ghost/tamper/transient
//      handling identical in spirit to selectVerified's, popup-only (never a dApp method).
//   2. TOO_MANY_INPUTS vs INSUFFICIENT: a null selection where the spendable set COVERS the need is
//      the input-cap case and must say so — "insufficient confirmed balance" was a false statement
//      for a rich holder of many small coins.
//   3. SUBMIT_MAYBE_INFLIGHT vs SUBMIT_REJECTED: only a thrown/unreadable submit is ambiguous; a
//      server that ANSWERED a rejection definitively did NOT ingest the tx. The popup shows the
//      scary "may already be in flight" copy for the former only (source-guarded below).
// Same harness style as ghostcoin.test.mjs: URL-routed fetch stub, real Wallet + memoryStore.
// Module-level ghostSeen cache is shared across cases in this process → distinct coin VALUES per
// case (mkCoin derives the txid from the tx, so distinct values ⇒ distinct txids).
import { readFileSync } from "node:fs";
import { Wallet } from "../src/core/wallet.js";
import { memoryStore } from "../src/core/storage.js";
import { mkCoin, txReply } from "./_coin.js";

let pass = 0, fail = 0;
const check = (n, c) => { c ? pass++ : (fail++, console.error("  ✗ " + n)); if (c) console.log("  ✓ " + n); };
const hexOf = (bytes) => "0x" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
const FEE = 1_000_000; // 0.01 CSD, the popup's SEND_FEE

// URL-routed fetch stub (ghostcoin pattern): /utxos from `coins`, /tx/<id> from `served`,
// /tx/submit captured (overridable). `txDelayMs` adds a real await per /tx read and tracks the
// max number of CONCURRENT reads — the mapLimit(8) bound assertion.
function mkStub({ coins, served, overrides = {}, submit, txDelayMs = 0 }) {
  const stats = { tx: 0, submits: [], maxConcurrent: 0 };
  let inflight = 0;
  const wrapped = async (url, init) => {
    const u = String(url);
    if (u.includes("/tx/submit")) {
      stats.submits.push(JSON.parse(init?.body ?? "{}"));
      if (submit) return submit();
      return { ok: true, status: 200, json: async () => ({ ok: true, txid: "0x" + "aa".repeat(32) }) };
    }
    if (u.includes("/utxos/")) {
      return { ok: true, status: 200, json: async () => ({ confirmed_balance: coins.reduce((s, c) => s + c.coin.value, 0), utxos: coins.map((c) => c.coin) }) };
    }
    const idm = u.match(/\/tx\/(0x[0-9a-fA-F]{64})\b/);
    if (idm) {
      stats.tx++;
      if (txDelayMs) {
        inflight++;
        stats.maxConcurrent = Math.max(stats.maxConcurrent, inflight);
        await new Promise((r) => setTimeout(r, txDelayMs));
        inflight--;
      }
      const id = idm[1].toLowerCase();
      if (overrides[id]) return overrides[id]();
      return txReply(u, served);
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  return { fetch: wrapped, stats };
}
const mkWallet = async () => { const w = new Wallet(memoryStore()); const { addr } = await w.create("super-secret-pw"); return { w, addr }; };

const origFetch = globalThis.fetch;
try {
  // ── 1. happy path: 5 coins merge smallest-first into ONE output back to self ──
  {
    const coins = [7e8, 3e8, 11e8, 5e8, 9e8].map((v) => mkCoin(v));
    const { fetch, stats } = mkStub({ coins, served: coins });
    globalThis.fetch = fetch;
    const { w, addr } = await mkWallet();
    const r = await w.consolidate(FEE);
    check("consolidate succeeds", r.ok === true);
    check("merged all 5 coins", r.merged === 5 && r.remaining === 0);
    const sub = stats.submits[0];
    check("submitted tx spends 5 inputs", sub?.tx?.inputs?.length === 5);
    check("SMALLEST-first input order (3,5,7,9,11 CSD)", sub.tx.inputs.map((i) => hexOf(i.prevout.txid)).join(",") === [3e8, 5e8, 7e8, 9e8, 11e8].map((v) => String(mkCoin(v).coin.txid)).join(","));
    check("exactly ONE output", sub.tx.outputs.length === 1);
    check("output pays total − fee", sub.tx.outputs[0].value === 35e8 - FEE);
    check("output goes to the wallet's OWN address", hexOf(sub.tx.outputs[0].script_pubkey).toLowerCase() === addr.toLowerCase());
    check("history recorded the merge", (await w.history()).some((t) => t.type === "consolidate" && t.merged === 5));
  }

  // ── 2. verify fan-out is BOUNDED (mapLimit ≤ 8 concurrent /tx reads) ──
  {
    const coins = Array.from({ length: 30 }, (_, i) => mkCoin(20e8 + i * 1e6));
    const { fetch, stats } = mkStub({ coins, served: coins, txDelayMs: 5 });
    globalThis.fetch = fetch;
    const { w } = await mkWallet();
    const r = await w.consolidate(FEE);
    check("30-coin merge succeeds", r.ok === true && r.merged === 30);
    check(`verify concurrency bounded ≤ 8 (saw ${stats.maxConcurrent})`, stats.maxConcurrent <= 8);
    check("pool actually overlaps requests (> 1 concurrent)", stats.maxConcurrent > 1);
  }

  // ── 3. fewer than two coins → NOTHING_TO_CONSOLIDATE, nothing signed ──
  {
    const coins = [mkCoin(41e8)];
    const { fetch, stats } = mkStub({ coins, served: coins });
    globalThis.fetch = fetch;
    const { w } = await mkWallet();
    const r = await w.consolidate(FEE);
    check("single coin refuses with NOTHING_TO_CONSOLIDATE", r.ok === false && r.code === "NOTHING_TO_CONSOLIDATE");
    check("nothing submitted", stats.submits.length === 0);
  }

  // ── 4. fee guards ──
  {
    const coins = [mkCoin(43e8), mkCoin(44e8)];
    const { fetch, stats } = mkStub({ coins, served: coins });
    globalThis.fetch = fetch;
    const { w } = await mkWallet();
    check("fee 0 → BAD_FEE", (await w.consolidate(0)).code === "BAD_FEE");
    check("fee > 100 CSD flat cap → FEE_CAP", (await w.consolidate(101 * 1e8)).code === "FEE_CAP");
    // proportional cap: these two coins total 87 CSD → propCap = max(1, 8.7) = 8.7 CSD; a 9 CSD
    // fee is under the 100 CSD flat cap but over the 10%-of-inputs cap and must be refused (parity
    // with assembleValueTx's single-fee-chokepoint invariant).
    const rp = await w.consolidate(9 * 1e8);
    check("fee over the 10%-of-inputs propCap → FEE_CAP", rp.ok === false && rp.code === "FEE_CAP");
    check("fee just under propCap (8 CSD) is accepted", (await w.consolidate(8 * 1e8)).ok === true);
    check("no submit on the refused-fee cases", stats.submits.length === 1); // only the 8-CSD one broadcast
  }
  {
    // coins too small to cover the fee: 2 dust coins of 100 base units each vs a 1e6 fee
    const coins = [mkCoin(100, 0, { coinbase: false }), mkCoin(101)];
    const { fetch, stats } = mkStub({ coins, served: coins });
    globalThis.fetch = fetch;
    const { w } = await mkWallet();
    const r = await w.consolidate(FEE);
    check("dust-only merge refuses (total ≤ fee) with INSUFFICIENT", r.ok === false && r.code === "INSUFFICIENT");
    check("dust refusal signed nothing", stats.submits.length === 0);
  }

  // ── 5. a ghost coin is excluded and the merge proceeds with the rest ──
  {
    const ghost = mkCoin(51e8); ghost.coin.txid = "0x" + "96".repeat(32); // never served → authoritative miss
    const a = mkCoin(52e8), b = mkCoin(53e8);
    const { fetch, stats } = mkStub({ coins: [ghost, a, b], served: [a, b] });
    globalThis.fetch = fetch;
    const { w } = await mkWallet();
    const r = await w.consolidate(FEE);
    check("merge succeeds around the ghost", r.ok === true && r.merged === 2);
    const ids = stats.submits[0].tx.inputs.map((i) => hexOf(i.prevout.txid).toLowerCase());
    check("ghost outpoint NOT spent", !ids.includes(String(ghost.coin.txid).toLowerCase()));
  }

  // ── 6. tamper / transient refuse the whole merge, nothing signed ──
  {
    const a = mkCoin(61e8), b = mkCoin(62e8);
    const evil = mkCoin(63e8); // served body won't match its claimed txid
    const { fetch, stats } = mkStub({
      coins: [a, b, evil], served: [a, b],
      overrides: { [String(evil.coin.txid).toLowerCase()]: () => ({ ok: true, status: 200, json: async () => ({ ok: true, tx: mkCoin(64e8).body }) }) },
    });
    globalThis.fetch = fetch;
    const { w } = await mkWallet();
    const r = await w.consolidate(FEE);
    check("forged source body → VERIFY_TAMPER", r.ok === false && r.code === "VERIFY_TAMPER");
    check("tamper signed nothing", stats.submits.length === 0);
  }
  {
    const a = mkCoin(65e8), b = mkCoin(66e8);
    const { fetch, stats } = mkStub({
      coins: [a, b], served: [a, b],
      overrides: { [String(b.coin.txid).toLowerCase()]: () => ({ ok: false, status: 500, json: async () => ({}) }) },
    });
    globalThis.fetch = fetch;
    const { w } = await mkWallet();
    const r = await w.consolidate(FEE);
    check("node 500 during verify → VERIFY_UNAVAILABLE (retryable)", r.ok === false && r.code === "VERIFY_UNAVAILABLE");
    check("transient signed nothing", stats.submits.length === 0);
  }

  // ── 7. SUBMIT_MAYBE_INFLIGHT vs SUBMIT_REJECTED ──
  {
    const a = mkCoin(71e8), b = mkCoin(72e8);
    const { fetch } = mkStub({ coins: [a, b], served: [a, b], submit: () => { throw new Error("connection reset"); } });
    globalThis.fetch = fetch;
    const { w } = await mkWallet();
    const r = await w.consolidate(FEE);
    check("thrown submit → SUBMIT_MAYBE_INFLIGHT (genuinely ambiguous)", r.ok === false && r.code === "SUBMIT_MAYBE_INFLIGHT");
  }
  {
    const a = mkCoin(73e8), b = mkCoin(74e8);
    const { fetch } = mkStub({ coins: [a, b], served: [a, b], submit: () => ({ ok: false, status: 400, json: async () => ({ ok: false, err: "feerate too low" }) }) });
    globalThis.fetch = fetch;
    const { w } = await mkWallet();
    const r = await w.consolidate(FEE);
    check("answered rejection → SUBMIT_REJECTED with the server's reason", r.ok === false && r.code === "SUBMIT_REJECTED" && /feerate/.test(r.error));
  }

  // ── 8. cap: >512 coins merges exactly the 512 SMALLEST, reports the remainder ──
  {
    const coins = Array.from({ length: 515 }, (_, i) => mkCoin(80e8 + i * 1e4));
    const { fetch, stats } = mkStub({ coins, served: coins });
    globalThis.fetch = fetch;
    const { w } = await mkWallet();
    const r = await w.consolidate(FEE);
    check("515-coin wallet merges 512, remaining 3", r.ok === true && r.merged === 512 && r.remaining === 3);
    const ids = new Set(stats.submits[0].tx.inputs.map((i) => hexOf(i.prevout.txid).toLowerCase()));
    const largest3 = coins.slice(512).map((c) => String(c.coin.txid).toLowerCase());
    check("the 3 LARGEST coins were the ones left out", largest3.every((id) => !ids.has(id)));
  }

  // ── 9. TOO_MANY_INPUTS vs INSUFFICIENT on send() ──
  {
    // 550 coins of 50+0.01i CSD (spendable ≈ 29,010 CSD; the 512 LARGEST sum ≈ 27,103 CSD). A
    // 28,000 CSD send is coverable by the full set but NOT within the 512-input cap → the honest
    // error is the input cap, NOT "insufficient". A 30,000 CSD send IS insufficient.
    const coins = Array.from({ length: 550 }, (_, i) => mkCoin(50e8 + i * 1e6));
    const { fetch, stats } = mkStub({ coins, served: coins });
    globalThis.fetch = fetch;
    const { w } = await mkWallet();
    const r1 = await w.send("0x" + "22".repeat(20), 28_000e8, FEE);
    check("coverable-but-over-cap send → TOO_MANY_INPUTS", r1.ok === false && r1.code === "TOO_MANY_INPUTS");
    check("TOO_MANY_INPUTS message mentions consolidating", /consolidate/.test(r1.error));
    const r2 = await w.send("0x" + "22".repeat(20), 30_000e8, FEE);
    check("genuinely-short send stays INSUFFICIENT", r2.ok === false && r2.code === "INSUFFICIENT");
    check("neither refusal signed anything", stats.submits.length === 0);
  }

  // ── 10. preview reports coins/merge/total/out (display-only; REPORTED values) ──
  {
    const coins = [mkCoin(91e8), mkCoin(92e8), mkCoin(93e8)];
    const { fetch } = mkStub({ coins, served: coins });
    globalThis.fetch = fetch;
    const { w } = await mkWallet();
    const p = await w.consolidatePreview(FEE);
    check("preview shape", p.ok === true && p.coins === 3 && p.merge === 3 && p.total === 276e8 && p.out === 276e8 - FEE);
  }

  // ── 11. source guards: popup routing + dApp boundary ──
  {
    const bg = readFileSync(new URL("../src/background.ts", import.meta.url), "utf8");
    const dappLine = bg.split("\n").find((l) => l.includes("const DAPP_METHODS"));
    check("consolidate is NOT a dApp method", !!dappLine && !dappLine.includes("consolidate"));
    const popup = readFileSync(new URL("../src/popup/popup.ts", import.meta.url), "utf8");
    check("CSD send ok:false routes through sendRefused (real reason, not 'in flight')", popup.includes("else sendRefused(CSD_FLOW, r)"));
    check("token send ok:false routes through sendRefused", popup.includes("else sendRefused(TOKEN_FLOW, r)"));
    check("no bare else sendDidntConfirm remains (in-flight copy reserved for catch/maybe-inflight)", !/else sendDidntConfirm\(/.test(popup));
    check("sendRefused reserves the in-flight copy for SUBMIT_MAYBE_INFLIGHT", /SUBMIT_MAYBE_INFLIGHT/.test(popup));
  }
} finally {
  globalThis.fetch = origFetch;
}

console.log(`\nconsolidate: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
