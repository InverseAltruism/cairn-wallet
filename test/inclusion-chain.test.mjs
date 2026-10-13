// A history row whose inclusion is open (a submit answer lost, maybe:true, or a merge not yet confirmed) is
// settled from chain state by Wallet.pendingMerge, the reconcile the popup runs on every balance refresh.
// The clock decides nothing: a row stays open until its txid is in the utxo set or the node reports it
// mined (included), or no node holds it and one of its inputs is spent elsewhere (gone). Ten blocks past
// the tip at submit an open row is `stuck`, which the popup shows as the standing notice. Nothing here
// ever submits a transaction.
//   RED-FIRST: put the 60-minute window back into isMergeCandidate (`&& Date.now() - (x.ts || 0) <=
//   3_600_000`) and (1) fails: the 61-minute-old merge stops being pending while it is still in the mempool.
//   PAIRED HONEST PATH: (5) the node reports the txid mined and the row is settled: maybe cleared, merge
//   confirmed, no notice. Every call uses the popup's shape: pendingMerge(<the utxos the balance fetch got>).
// Run: node --import tsx test/inclusion-chain.test.mjs   (offline)
import { Wallet } from "../src/core/wallet.ts";
import { memoryStore } from "../src/core/storage.ts";
import { inclusionMark } from "../src/core/inclusion.ts";
import { mkCoin, txReply } from "./_coin.ts";
import { checker } from "./helpers/check.mjs";

const { check, done } = checker("inclusion of sent transactions, from chain state:");
const FEE = 1_000_000;
const TO = "0x" + "66".repeat(20);
const MIN = 60_000;

// The node as the wallet sees it through the proxy. `available` is /utxos?available=true; `status` answers
// /tx/:id/status by txid; `statusRoute: false` models a loopback node (404 there, /tx/:id says mined).
function mkChain(coins) {
  const c = { tip: 1_000, available: coins.map((x) => x.coin), status: new Map(), mined: new Map(), statusRoute: true,
    submit: "maybe", submits: 0, statusReads: 0 };
  c.fetch = async (url) => {
    const u = String(url);
    if (u.includes("/tx/submit")) {
      c.submits++;
      if (c.submit === "maybe") return { ok: false, status: 502, json: async () => ({ ok: false, error: "node unreachable" }) };
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }
    if (u.includes("/utxos/")) return { ok: true, status: 200, json: async () => ({ confirmed_balance: c.available.reduce((s, x) => s + x.value, 0), utxos: c.available }) };
    if (u.endsWith("/tip")) return { ok: true, status: 200, json: async () => ({ height: c.tip }) };
    const st = u.match(/\/tx\/(0x[0-9a-f]{64})\/status$/i);
    if (st) {
      c.statusReads++;
      if (!c.statusRoute) return { ok: false, status: 404, json: async () => ({}) };
      const s = c.status.get(st[1].toLowerCase()) ?? { state: "pending" };
      return { ok: true, status: 200, json: async () => ({ ok: true, txid: st[1], ...s }) };
    }
    const tx = u.match(/\/tx\/(0x[0-9a-f]{64})$/i);
    if (tx && c.mined.has(tx[1].toLowerCase())) return { ok: true, status: 200, json: async () => ({ ok: true, txid: tx[1], height: c.mined.get(tx[1].toLowerCase()) }) };
    return txReply(u, coins) ?? { ok: false, status: 404, json: async () => ({}) };
  };
  return c;
}
async function mkWallet(chain) {
  globalThis.fetch = chain.fetch;
  const store = memoryStore();
  const w = new Wallet(store);
  const { addr } = await w.create("inclusion-pw");
  const rows = async () => (await store.get("txHistory:" + addr)) || [];
  const row = async (txid) => (await rows()).find((x) => x.txid === txid);
  const setRow = async (txid, patch) => { const h = await rows(); Object.assign(h.find((x) => x.txid === txid), patch); await store.set("txHistory:" + addr, h); };
  const refresh = () => w.pendingMerge(chain.available);   // the popup: pendingMerge(b.utxos)
  const seed = (h) => store.set("txHistory:" + addr, h);
  return { w, row, setRow, refresh, seed };
}
const origFetch = globalThis.fetch;

try {
  // ── (1) red-first: a 61-minute-old merge still in the mempool stays pending ─────────────────────────────
  {
    const coins = [mkCoin(101e8), mkCoin(102e8), mkCoin(103e8)];
    const chain = mkChain(coins);
    chain.submit = "ok";
    const { w, row, setRow, refresh } = await mkWallet(chain);
    const r = await w.consolidate(FEE);
    check("(1) setup: the merge was accepted", r.ok === true && typeof r.txid === "string");
    chain.available = [];                                   // its inputs are spent by the merge in the mempool
    await setRow(r.txid, { ts: Date.now() - 61 * MIN });
    const p = await refresh();
    check("(1) a 61-minute-old merge the node still holds is pending", p.pending === true && p.amount === r.total - FEE);
    check("(1) ...with no notice yet (0 blocks since submit)", p.stuck === false);
    const e = await row(r.txid);
    check("(1) the tip at submit is stamped from the chain", e.subTip === 1_000);
    check("(1) the merge row keeps up to 8 input outpoints", Array.isArray(e.inputs) && e.inputs.length === 3 && e.inputs.every((op) => /^0x[0-9a-f]{64}:\d+$/.test(op)));
  }

  // ── (2) a lost submit answer: the row says "sent, not yet included" whatever its age ───────────────────
  // ── (3) ten blocks past submit: the standing notice; (4) never a rebroadcast; one read per block ────────
  // ── (5) paired honest path: the node reports it mined and the row clears ───────────────────────────────
  {
    const coins = [mkCoin(201e8), mkCoin(202e8)];
    const chain = mkChain(coins);
    const { w, row, setRow, refresh } = await mkWallet(chain);
    const r = await w.send(TO, 1e8, FEE);
    check("(2) setup: a 502 on submit is SUBMIT_MAYBE_INFLIGHT", r.code === "SUBMIT_MAYBE_INFLIGHT" && /^0x[0-9a-f]{64}$/.test(r.txid));
    let e = await row(r.txid);
    check("(2) the maybe row keeps the input it spent", e.maybe === true && Array.isArray(e.inputs) && e.inputs.length === 1 && e.inputs[0] === coins[1].coin.txid.toLowerCase() + ":0");
    chain.available = [coins[0].coin];                     // its input is held by the pending tx
    await setRow(r.txid, { ts: Date.now() - 24 * 60 * MIN });
    await refresh();
    e = await row(r.txid);
    check("(2) a day-old row the node still holds stays open: sent, not yet included", e.maybe === true && inclusionMark(e) === "sent");
    const submitsBefore = chain.submits;

    chain.tip = 1_009;
    await refresh();
    e = await row(r.txid);
    check("(3) nine blocks past submit: still 'sent', no notice", inclusionMark(e) === "sent" && !e.stuck);
    chain.tip = 1_010;
    await refresh();
    e = await row(r.txid);
    check("(3) ten blocks past submit: the standing notice", e.maybe === true && e.stuck === true && inclusionMark(e) === "stuck");
    const reads = chain.statusReads;
    await refresh();
    check("(4) a second refresh at the same tip reads no status again", chain.statusReads === reads);
    check("(4) no reconcile ever submitted a transaction", chain.submits === submitsBefore);

    chain.status.set(r.txid, { state: "mined", height: 1_011 });
    chain.tip = 1_011;
    await refresh();
    e = await row(r.txid);
    check("(5) paired: a mined txid clears the row (no maybe, no notice, no marker)", e.maybe === undefined && e.stuck === undefined && inclusionMark(e) === null);
  }

  // ── (6) gone: no node holds it and its input was spent by another transaction ──────────────────────────
  {
    const coins = [mkCoin(301e8), mkCoin(302e8)];
    const chain = mkChain(coins);
    const { w, row, refresh } = await mkWallet(chain);
    const r = await w.send(TO, 1e8, FEE);
    chain.status.set(r.txid, { state: "unknown", definite: true });
    await refresh();                                        // its input is still available: the tx was never ingested
    let e = await row(r.txid);
    check("(6) unknown everywhere, but its input is still unspent: stays open", e.maybe === true && !e.gone);
    chain.tip = 1_001;
    chain.status.set(r.txid, { state: "unknown", definite: false });
    chain.available = [coins[0].coin];
    await refresh();
    e = await row(r.txid);
    check("(6) its input is spent but the answer is not definite: stays open", e.maybe === true && !e.gone);
    chain.tip = 1_002;
    chain.status.set(r.txid, { state: "unknown", definite: true });
    await refresh();
    e = await row(r.txid);
    check("(6) unknown everywhere and its input spent elsewhere: gone", e.gone === true && e.maybe === undefined && inclusionMark(e) === "gone");
  }

  // ── (7) a merge seen in the utxo set and a loopback node without the status route ─────────────────────
  {
    const coins = [mkCoin(401e8), mkCoin(402e8)];
    const chain = mkChain(coins);
    chain.submit = "ok";
    const { w, row, refresh } = await mkWallet(chain);
    const r = await w.consolidate(FEE);
    chain.available = [{ txid: r.txid, vout: 0, value: r.total - FEE, confirmations: 1 }];
    const reads = chain.statusReads;
    const p = await refresh();
    check("(7) the merge output in the utxo set confirms it with no status read", p.pending === false && (await row(r.txid)).confirmed === true && chain.statusReads === reads);

    const coins2 = [mkCoin(411e8), mkCoin(412e8)];
    const chain2 = mkChain(coins2);
    chain2.statusRoute = false;
    const b = await mkWallet(chain2);
    const r2 = await b.w.send(TO, 1e8, FEE);
    chain2.available = [coins2[0].coin];
    await b.refresh();
    check("(7) loopback node: open while /tx/:id does not find it", (await b.row(r2.txid)).maybe === true);
    const reads2 = chain2.statusReads;
    await b.refresh();
    check("(7) loopback node: a second refresh at the same tip reads no status again", chain2.statusReads === reads2);
    chain2.mined.set(r2.txid, 1_000);
    chain2.tip = 1_001;
    await b.refresh();
    check("(7) loopback node: /tx/:id mined clears the row", (await b.row(r2.txid)).maybe === undefined);
  }

  // ── (8) the status reads per refresh are capped ────────────────────────────────────────────────────────
  {
    const chain = mkChain([]);
    const { seed, refresh } = await mkWallet(chain);
    const ids = Array.from({ length: 10 }, (_, i) => "0x" + (i + 16).toString(16).repeat(32));
    await seed(ids.map((txid) => ({ txid, ts: Date.now(), type: "send", to: TO, amount: 1e8, fee: FEE, maybe: true })));
    await refresh();
    check("(8) ten open rows cost at most 8 status reads in one refresh", chain.statusReads === 8);
  }
} finally { globalThis.fetch = origFetch; }

done("inclusion-chain");
