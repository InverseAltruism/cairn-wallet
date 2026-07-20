// Ghost-coin recovery suite (Plan 65 / wallet 0.2.53): per-coin fail-closed input verification.
//
// Incident class: a node's UTXO index can hold entries whose source tx is in NO block of its own
// chain (failed reorg-undo, 2026-07-05). The old any-null-kills-all fold in verifyInputValues let ONE
// such "ghost" coin brick every spend from the wallet. The fix classifies per-input verdicts
// (verified value / notfound / transient / tamper) and re-selects around authoritative not-founds,
// bounded, with no coin ever spent unverified and the tamper refusal byte-identical to before.
//
// Harness footgun: node.ts keeps a module-level session ghost cache (ghostSeen, TTL 2 min), shared
// across cases in this one tsx process. Every case therefore uses DISTINCT coin values (=> distinct
// txids) except the final case, where the carryover IS the assertion.
import { Wallet } from "../src/core/wallet.js";
import { memoryStore } from "../src/core/storage.js";
import { selectInputs } from "../src/core/node.js";
import { mkCoin, txReply } from "./_coin.js";

let pass = 0, fail = 0;
const check = (n, c) => { c ? pass++ : (fail++, console.error("  ✗ " + n)); if (c) console.log("  ✓ " + n); };
const RCPT = "0x" + "11".repeat(20);
const hexOf = (bytes) => "0x" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

// URL-routed fetch stub (selftest.ts pattern): serve /utxos from `coins`, /tx/<id> from `served`
// (a coin in `coins` but NOT `served` answers the node's canonical miss = a ghost), count fetches,
// capture /tx/submit bodies. `overrides` lets a case break specific txids (transient / tamper).
function mkStub({ coins, served, overrides = {} }) {
  const stats = { tx: 0, txByIds: {}, submits: [] };
  const stub = async (url) => {
    const u = String(url);
    if (u.includes("/utxos/")) {
      return { ok: true, status: 200, json: async () => ({ confirmed_balance: coins.reduce((s, c) => s + c.coin.value, 0), utxos: coins.map((c) => c.coin) }) };
    }
    const idm = u.match(/\/tx\/(0x[0-9a-fA-F]{64})\b/);
    if (idm) {
      stats.tx++; const id = idm[1].toLowerCase();
      stats.txByIds[id] = (stats.txByIds[id] || 0) + 1;
      if (overrides[id]) return overrides[id]();
      return txReply(u, served);
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  // fetch(url, init) form for POST /tx/submit: capture the submitted tx
  const wrapped = async (url, init) => {
    const u = String(url);
    if (u.includes("/tx/submit")) { stats.submits.push(JSON.parse(init?.body ?? "{}")); return { ok: true, status: 200, json: async () => ({ ok: true, txid: "0x" + "aa".repeat(32) }) }; }
    return stub(url);
  };
  return { fetch: wrapped, stats };
}
const submittedInputTxids = (sub) => (sub?.tx?.inputs ?? []).map((i) => hexOf(i.prevout.txid).toLowerCase());

const origFetch = globalThis.fetch;
try {
  // ── 1. one ghost among many: spend succeeds, ghost excluded, change math intact ──
  {
    const ghost = mkCoin(50e8); ghost.coin.txid = "0x" + "97".repeat(32); // never served
    const g3 = mkCoin(3e8), g2 = mkCoin(2e8);
    const { fetch, stats } = mkStub({ coins: [ghost, g3, g2], served: [g3, g2] });
    globalThis.fetch = fetch;
    const w = new Wallet(memoryStore()); await w.create("super-secret-pw");
    const r = await w.send(RCPT, 4e8, 1e6);
    check("ghost among many: send succeeds", r.ok === true);
    const ins = submittedInputTxids(stats.submits[0]);
    check("ghost outpoint not in the submitted inputs", ins.length > 0 && !ins.includes(ghost.coin.txid.toLowerCase()));
    const outs = stats.submits[0]?.tx?.outputs ?? [];
    const changeOk = outs.some((o) => o.value === 3e8 + 2e8 - 4e8 - 1e6); // verified total − amount − fee
    check("change equals verified-total minus amount minus fee", changeOk);
  }

  // ── 2. ghost + insufficient remainder: honest skip message, nothing submitted ──
  {
    const ghost = mkCoin(51e8); ghost.coin.txid = "0x" + "96".repeat(32);
    const g1 = mkCoin(1e8);
    const { fetch, stats } = mkStub({ coins: [ghost, g1], served: [g1] });
    globalThis.fetch = fetch;
    const w = new Wallet(memoryStore()); await w.create("super-secret-pw");
    const r = await w.send(RCPT, 5e8, 1e6);
    check("ghost + shortfall: send fails", r.ok === false);
    check("…with the honest skip message (count + value + need)", /1 coin\(s\) totalling 51 CSD .*skipped/.test(r.error || ""));
    check("…carries the non-retryable GHOST_INPUTS_SKIPPED code (WS5)", r.code === "GHOST_INPUTS_SKIPPED");
    check("…and nothing was submitted", stats.submits.length === 0);
  }

  // ── 3. all-ghost: honest skip message, NOT the tamper refusal ──
  {
    const ghost = mkCoin(52e8); ghost.coin.txid = "0x" + "95".repeat(32);
    const { fetch } = mkStub({ coins: [ghost], served: [] });
    globalThis.fetch = fetch;
    const w = new Wallet(memoryStore()); await w.create("super-secret-pw");
    const r = await w.send(RCPT, 1e8, 1e6);
    check("all-ghost: fails with skip message, not the tamper string", r.ok === false && /could not be verified on the chain and were skipped/.test(r.error || "") && !/refusing to risk a burned fee/.test(r.error || ""));
    check("all-ghost: code is GHOST_INPUTS_SKIPPED (WS5)", r.code === "GHOST_INPUTS_SKIPPED");
  }

  // ── 4. transient node failure: retryable message, NO exclusion pollution, heals ──
  {
    const c = mkCoin(7e8);
    const id = String(c.coin.txid).toLowerCase();
    let broken = true;
    const { fetch, stats } = mkStub({ coins: [c], served: [c], overrides: { [id]: () => broken ? { ok: false, status: 500, json: async () => ({}) } : txReply(`/tx/${id}`, [c]) } });
    globalThis.fetch = fetch;
    const w = new Wallet(memoryStore()); await w.create("super-secret-pw");
    const r1 = await w.send(RCPT, 1e8, 1e6);
    check("transient: fails retryably (try again copy)", r1.ok === false && /try again in a moment/.test(r1.error || ""));
    check("transient: code is the retryable VERIFY_UNAVAILABLE (WS5)", r1.code === "VERIFY_UNAVAILABLE");
    broken = false;
    const r2 = await w.send(RCPT, 1e8, 1e6);
    check("transient heals: SAME coin spends after the node recovers (no ghost-cache pollution)", r2.ok === true && submittedInputTxids(stats.submits[0]).includes(id));
  }

  // ── 5. tamper: exact legacy refusal, single verify round, no retry, no submit ──
  {
    const c = mkCoin(9e8);
    const id = String(c.coin.txid).toLowerCase();
    const forged = JSON.parse(JSON.stringify(c.body)); forged.outputs[0].value = 9e8 * 2; // inflate → recompute mismatch
    const { fetch, stats } = mkStub({ coins: [c], served: [c], overrides: { [id]: () => ({ ok: true, status: 200, json: async () => ({ ok: true, tx: forged }) }) } });
    globalThis.fetch = fetch;
    const w = new Wallet(memoryStore()); await w.create("super-secret-pw");
    const r = await w.send(RCPT, 1e8, 1e6);
    check("tamper: exact legacy refusal string", r.error === "could not verify selected inputs against the chain (refusing to risk a burned fee)");
    check("tamper: code is the non-retryable VERIFY_TAMPER (WS5, string unchanged)", r.code === "VERIFY_TAMPER");
    check("tamper: single verify round (no retry against a forging RPC)", stats.txByIds[id] === 1);
    check("tamper: nothing submitted", stats.submits.length === 0);
  }

  // ── 6. happy-path regression: all coins verify, one round, no extra fetches ──
  {
    const a = mkCoin(4e8), b = mkCoin(3.5e8);
    const { fetch, stats } = mkStub({ coins: [a, b], served: [a, b] });
    globalThis.fetch = fetch;
    const w = new Wallet(memoryStore()); await w.create("super-secret-pw");
    const r = await w.send(RCPT, 6e8, 1e6);
    check("happy path: succeeds", r.ok === true);
    check("happy path: exactly one /tx fetch per selected input", stats.tx === submittedInputTxids(stats.submits[0]).length);
  }

  // ── 7. selectInputs exclude set: excluded outpoint never selected; 2-arg call identical ──
  {
    const u = (txid, value) => ({ txid, vout: 0, value, confirmations: 5 });
    const A = "0x" + "aa".repeat(32), B = "0x" + "bb".repeat(32);
    const pool = [u(A, 5e8), u(B, 5e8)];
    const selAll = selectInputs(pool, 4e8);
    check("selectInputs 2-arg unchanged (largest-first pick)", !!selAll && selAll.inputs.length === 1);
    const sel = selectInputs(pool, 4e8, new Set([`${A}:0`]));
    check("excluded outpoint never selected", !!sel && sel.inputs.length === 1 && sel.inputs[0].txid === B);
    check("exclusion can exhaust the pool", selectInputs(pool, 4e8, new Set([`${A}:0`, `${B}:0`])) === null);
  }

  // ── 8. session ghost cache: an immediate retry pre-excludes the known ghost (0 refetches) ──
  {
    const ghost = mkCoin(53e8); ghost.coin.txid = "0x" + "94".repeat(32);
    const good = mkCoin(6e8);
    const { fetch, stats } = mkStub({ coins: [ghost, good], served: [good] });
    globalThis.fetch = fetch;
    const w = new Wallet(memoryStore()); await w.create("super-secret-pw");
    await w.send(RCPT, 1e8, 1e6);                       // learns the ghost (1 probe)
    const probes1 = stats.txByIds[ghost.coin.txid.toLowerCase()] || 0;
    await w.send(RCPT, 1e8, 1e6);                       // retry within TTL: cache-seeded exclude
    const probes2 = stats.txByIds[ghost.coin.txid.toLowerCase()] || 0;
    check("ghost probed exactly once across two sends (session cache)", probes1 === 1 && probes2 === 1);
  }
  // ── 9. BN0w (W9): 503 + SCAN_HORIZON skips PER COIN; the partial send still completes ──
  // Wire contract (node v0.1.6, compute-substrate README normative table): HTTP 503 + Retry-After +
  // {ok:false, code:"SCAN_HORIZON"} means "scan budget exhausted, absence NOT proved": the coin is
  // real, the node just cannot look back far enough. Inert until such a node ships.
  const horizonReply = () => ({ ok: false, status: 503, json: async () => ({ ok: false, code: "SCAN_HORIZON", scanned: 100000, stopped_at_height: 12, retry_after_secs: 30 }) });
  {
    const hz = mkCoin(41e8);
    const a = mkCoin(5.5e8), b = mkCoin(4.5e8);
    const { fetch, stats } = mkStub({ coins: [hz, a, b], served: [hz, a, b], overrides: { [String(hz.coin.txid).toLowerCase()]: horizonReply } });
    globalThis.fetch = fetch;
    const w = new Wallet(memoryStore()); await w.create("super-secret-pw");
    const r = await w.send(RCPT, 6e8, 1e6);
    check("horizon among many: send succeeds (skippable per coin, like a ghost)", r.ok === true);
    const ins = submittedInputTxids(stats.submits[0]);
    check("horizon outpoint not in the submitted inputs", ins.length > 0 && !ins.includes(hz.coin.txid.toLowerCase()));
    const outs = stats.submits[0]?.tx?.outputs ?? [];
    check("change equals verified-total minus amount minus fee (horizon coin never counted)", outs.some((o) => o.value === 5.5e8 + 4.5e8 - 6e8 - 1e6));
  }

  // ── 10. BN0w: horizon + shortfall → VERIFY_HORIZON with HONEST copy (never defames the coin) ──
  {
    const hz = mkCoin(42e8);
    const small = mkCoin(1.5e8);
    const { fetch, stats } = mkStub({ coins: [hz, small], served: [hz, small], overrides: { [String(hz.coin.txid).toLowerCase()]: horizonReply } });
    globalThis.fetch = fetch;
    const w = new Wallet(memoryStore()); await w.create("super-secret-pw");
    const r = await w.send(RCPT, 5e8, 1e6);
    check("horizon + shortfall: send fails", r.ok === false);
    check("…with the distinct VERIFY_HORIZON code (severity above notfound, below transient/tamper)", r.code === "VERIFY_HORIZON");
    check("…with honest copy: the node cannot look back far enough", /cannot look back far enough to prove 1 coin\(s\) totalling 42 CSD/.test(r.error || ""));
    check("…which affirms the coins are real and will be spendable", /they are real and will be spendable once the node is upgraded/.test(r.error || ""));
    check("…and NEVER the defaming ghost copy", !/could not be verified/.test(r.error || ""));
    check("…and nothing was submitted", stats.submits.length === 0);
  }

  // ── 11. BN0w: a PLAIN 503 (no code) still refuses the WHOLE spend as transient, and heals ──
  {
    const c = mkCoin(43e8);
    const id = String(c.coin.txid).toLowerCase();
    let broken = true;
    const { fetch, stats } = mkStub({ coins: [c], served: [c], overrides: { [id]: () => broken ? { ok: false, status: 503, json: async () => ({ ok: false, err: "unavailable" }) } : txReply(`/tx/${id}`, [c]) } });
    globalThis.fetch = fetch;
    const w = new Wallet(memoryStore()); await w.create("super-secret-pw");
    const r1 = await w.send(RCPT, 1e8, 1e6);
    check("plain 503: whole spend refused retryably (transient, fielded behavior unchanged)", r1.ok === false && r1.code === "VERIFY_UNAVAILABLE" && /try again in a moment/.test(r1.error || ""));
    broken = false;
    const r2 = await w.send(RCPT, 1e8, 1e6);
    check("plain 503 heals: SAME coin spends after recovery (no horizon/ghost cache pollution)", r2.ok === true && submittedInputTxids(stats.submits[0]).includes(id));
  }

  // ── 12. BN0w: 503 with a DIFFERENT code (SCAN_INCOMPLETE) stays transient too ──
  {
    const c = mkCoin(44e8);
    const { fetch } = mkStub({ coins: [c], served: [c], overrides: { [String(c.coin.txid).toLowerCase()]: () => ({ ok: false, status: 503, json: async () => ({ ok: false, code: "SCAN_INCOMPLETE", at: "0x" + "00".repeat(32), why: "missing body" }) }) } });
    globalThis.fetch = fetch;
    const w = new Wallet(memoryStore()); await w.create("super-secret-pw");
    const r = await w.send(RCPT, 1e8, 1e6);
    check("SCAN_INCOMPLETE: NOT a horizon; whole spend refused as transient (the walk broke, retry)", r.ok === false && r.code === "VERIFY_UNAVAILABLE");
  }

  // ── 13. BN0w: mixed 404-ghost + horizon in ONE spend; each classifies per coin, send completes ──
  {
    const ghost = mkCoin(45e8); ghost.coin.txid = "0x" + "8f".repeat(32); // never served → 404-path ghost
    const hz = mkCoin(46e8);
    const good = mkCoin(3.3e8);
    const { fetch, stats } = mkStub({ coins: [ghost, hz, good], served: [hz, good], overrides: { [String(hz.coin.txid).toLowerCase()]: horizonReply } });
    globalThis.fetch = fetch;
    const w = new Wallet(memoryStore()); await w.create("super-secret-pw");
    const r = await w.send(RCPT, 3e8, 1e6);
    check("mixed ghost+horizon: send completes on the provable coin (0.2.53 per-coin rule intact)", r.ok === true);
    const ins = submittedInputTxids(stats.submits[stats.submits.length - 1]);
    check("…spending ONLY the provable coin", ins.length === 1 && ins[0] === String(good.coin.txid).toLowerCase());
  }

  // ── 14. BN0w: shortfall with BOTH classes skipped → VERIFY_HORIZON copy also owns the ghosts ──
  {
    const ghost = mkCoin(37e8); ghost.coin.txid = "0x" + "8e".repeat(32); // never served
    const hz = mkCoin(38e8);
    const { fetch, stats } = mkStub({ coins: [ghost, hz], served: [hz], overrides: { [String(hz.coin.txid).toLowerCase()]: horizonReply } });
    globalThis.fetch = fetch;
    const w = new Wallet(memoryStore()); await w.create("super-secret-pw");
    const r = await w.send(RCPT, 5e8, 1e6);
    check("both-classes shortfall: VERIFY_HORIZON outranks the ghost code in reporting", r.ok === false && r.code === "VERIFY_HORIZON");
    check("…and the copy still accounts for the skipped ghost honestly", /1 other coin\(s\) totalling 37 CSD could not be found on the chain and were also skipped/.test(r.error || ""));
    check("…and nothing was submitted", stats.submits.length === 0);
  }
} finally { globalThis.fetch = origFetch; }

console.log(`\nghostcoin: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
