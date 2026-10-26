// One coin served in two txid spellings (`0x`-prefixed and bare, or `0X`) is one coin on the real send and
// consolidate paths: selection takes it once, spendableCoins counts it once, and a ghost recorded under one
// spelling stays skipped when the node serves the other. The node serves `0x` lower-case txids; a bare spelling
// fails the wallet's own txid recompute (VERIFY_TAMPER), so a duplicate pair refuses the whole spend.
//
// node.ts keeps a module-level ghost cache for the process, so every case uses its own coin values.
import { Wallet } from "../src/core/wallet.js";
import { memoryStore } from "../src/core/storage.js";
import { mkCoin } from "./_coin.js";
import { checker } from "./helpers/check.mjs";

const { check, done } = checker("selectinputs-spelling");
const RCPT = "0x" + "11".repeat(20);
const hexOf = (bytes) => "0x" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
const bare = (c) => ({ ...c.coin, txid: c.coin.txid.slice(2) });
const upper = (c) => ({ ...c.coin, txid: "0X" + c.coin.txid.slice(2).toUpperCase() });

// /utxos answers `list()` (re-read per request, so a case can change spellings between sends); /tx/<id> in any
// spelling answers the source body of a coin in `served`, else the node's 2xx miss; /tx/submit is captured.
function mkStub(list, served) {
  const stats = { fetches: {}, submits: [] };
  const fetch = async (url, init) => {
    const u = String(url);
    if (u.includes("/tx/submit")) {
      stats.submits.push(JSON.parse(init?.body ?? "{}"));
      return { ok: true, status: 200, json: async () => ({ ok: true, txid: "0x" + "aa".repeat(32) }) };
    }
    if (u.includes("/utxos/")) {
      const utxos = list();
      return { ok: true, status: 200, json: async () => ({ confirmed_balance: utxos.reduce((s, x) => s + x.value, 0), utxos }) };
    }
    const m = u.match(/\/tx\/((?:0[xX])?[0-9a-fA-F]{64})\b/);
    if (m) {
      const id = m[1].toLowerCase().replace(/^0x/, "");
      stats.fetches[id] = (stats.fetches[id] || 0) + 1;
      const hit = served.find((c) => c.coin.txid.slice(2) === id);
      return { ok: true, status: 200, json: async () => (hit ? { ok: true, tx: hit.body } : { ok: false, err: "not found" }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  return { fetch, stats };
}
const inputsOf = (sub) => (sub?.tx?.inputs ?? []).map((i) => hexOf(i.prevout.txid).toLowerCase());
const wallet = async () => { const w = new Wallet(memoryStore()); await w.create("super-secret-pw"); return w; };

const origFetch = globalThis.fetch;
try {
  // honest path: 0x coins, the selection and the submitted inputs are what largest-first gives
  {
    const a = mkCoin(4.1e8), b = mkCoin(3.1e8), c = mkCoin(0.1e8);
    const { fetch, stats } = mkStub(() => [c.coin, a.coin, b.coin], [a, b, c]);
    globalThis.fetch = fetch;
    const r = await (await wallet()).send(RCPT, 6e8, 1e6);
    const ins = inputsOf(stats.submits[0]);
    check("honest send succeeds", r.ok === true);
    check("honest send spends the two largest coins, largest first", ins.join(",") === [a.coin.txid, b.coin.txid].join(","));
  }

  // a coin served 0x then bare, need above one copy: one coin cannot cover it, so the refusal is INSUFFICIENT
  {
    const a = mkCoin(6.2e8);
    const { fetch, stats } = mkStub(() => [a.coin, bare(a)], [a]);
    globalThis.fetch = fetch;
    const r = await (await wallet()).send(RCPT, 9e8, 1e6);
    check("0x and bare spellings: the send refuses as INSUFFICIENT, not VERIFY_TAMPER", r.ok === false && r.code === "INSUFFICIENT");
    check("0x and bare spellings: nothing submitted", stats.submits.length === 0);
  }

  // the same with the 0X spelling first and the bare one second
  {
    const a = mkCoin(6.3e8);
    const { fetch, stats } = mkStub(() => [upper(a), bare(a)], [a]);
    globalThis.fetch = fetch;
    const r = await (await wallet()).send(RCPT, 9e8, 1e6);
    check("0X and bare spellings: the send refuses as INSUFFICIENT, not VERIFY_TAMPER", r.ok === false && r.code === "INSUFFICIENT");
    check("0X and bare spellings: nothing submitted", stats.submits.length === 0);
  }

  // an honest coin covers the need: the send spends it instead of the second spelling
  {
    const a = mkCoin(6.4e8), h = mkCoin(0.5e8);
    const { fetch, stats } = mkStub(() => [a.coin, bare(a), h.coin], [a, h]);
    globalThis.fetch = fetch;
    const r = await (await wallet()).send(RCPT, 6.5e8, 1e6);
    const ins = inputsOf(stats.submits[0]);
    check("duplicate spelling plus an honest coin: the send succeeds", r.ok === true);
    check("…spending the coin once and the honest coin", ins.join(",") === [a.coin.txid, h.coin.txid].join(","));
  }

  // a ghost first served bare, then 0x: the second send does not fetch it again
  {
    const g = mkCoin(9.7e8), h = mkCoin(2.7e8);
    let first = true;
    const { fetch, stats } = mkStub(() => (first ? [bare(g), h.coin] : [g.coin, h.coin]), [h]);
    globalThis.fetch = fetch;
    const w = await wallet();
    const r1 = await w.send(RCPT, 1e8, 1e6);
    first = false;
    const r2 = await w.send(RCPT, 1e8, 1e6);
    check("ghost seen bare: both sends succeed on the honest coin", r1.ok === true && r2.ok === true);
    check("ghost seen bare stays skipped when served 0x (one fetch)", stats.fetches[g.coin.txid.slice(2)] === 1);
  }

  // the reverse: a ghost first served 0x, then bare
  {
    const g = mkCoin(9.6e8), h = mkCoin(2.6e8);
    let first = true;
    const { fetch, stats } = mkStub(() => (first ? [g.coin, h.coin] : [bare(g), h.coin]), [h]);
    globalThis.fetch = fetch;
    const w = await wallet();
    const r1 = await w.send(RCPT, 1e8, 1e6);
    first = false;
    const r2 = await w.send(RCPT, 1e8, 1e6);
    check("ghost seen 0x: both sends succeed on the honest coin", r1.ok === true && r2.ok === true);
    check("ghost seen 0x stays skipped when served bare (one fetch)", stats.fetches[g.coin.txid.slice(2)] === 1);
  }

  // consolidate: the preview and the merge count a coin served in two spellings once
  {
    const a = mkCoin(0.31e8);
    const { fetch, stats } = mkStub(() => [a.coin, bare(a)], [a]);
    globalThis.fetch = fetch;
    const w = await wallet();
    const p = await w.consolidatePreview();
    check("consolidate preview counts one coin, not two", p.ok === true && p.coins === 1);
    const r = await w.consolidate();
    check("consolidate refuses NOTHING_TO_CONSOLIDATE, not VERIFY_TAMPER", r.ok === false && r.code === "NOTHING_TO_CONSOLIDATE");
    check("consolidate: nothing submitted", stats.submits.length === 0);
  }
} finally {
  globalThis.fetch = origFetch;
}

done("selectinputs-spelling");
