// A history row whose inclusion is open (a submit answer lost, maybe:true, or a merge not yet confirmed) is
// settled from chain state by Wallet.pendingMerge, the reconcile the popup runs on every balance refresh.
// The clock decides nothing. Included: its txid is in a utxo set or the node reports it mined. Gone: one of
// its inputs is missing from the MINED utxo set while the tx itself is not mined, at two different tips;
// any later reading that disagrees undoes it. Stuck: ten blocks past the tip at submit (the popup's
// standing notice). Nothing here submits a transaction.
// The chain model keeps the mined utxo set and the outpoints the mempool holds apart; /utxos?available=true
// is derived from them the way the node derives it (node src/api/mod.rs: the mempool's spends removed).
//   RED-FIRST (clock): put `&& Date.now() - (x.ts || 0) <= 3_600_000` back into isMergeCandidate and (1)
//   fails. RED-FIRST (gone): judge "spent" against the available set instead of the mined one, or latch
//   gone on one reading, and (6a)-(6c) fail; drop the two-tip rule and (6e) fails at its first tip; treat
//   an unknown that could not look (no `definite`) as "not mined" and (6h) fails; let a read that could
//   not look clear gone and (6i) fails.
//   PAIRED HONEST PATH: (5) a mined txid clears the row; (6e) an input spent by a different mined tx,
//   with our txid unknown at two tips, shows gone. Calls use the popup's shape: pendingMerge(<the utxos the
//   balance fetch got>).
// Run: node --import tsx test/inclusion-chain.test.mjs   (offline)
import { Wallet } from "../src/core/wallet.ts";
import { memoryStore } from "../src/core/storage.ts";
import { confirmedUtxos, opKey } from "../src/core/node.ts";
import { inclusionMark } from "../src/core/inclusion.ts";
import { mkCoin, txReply } from "./_coin.ts";
import { checker } from "./helpers/check.mjs";

const { check, done } = checker("inclusion of sent transactions, from chain state:");
const FEE = 1_000_000;
const TO = "0x" + "66".repeat(20);
const MIN = 60_000;
const op = (c) => opKey(c.txid, c.vout);

// `mined`: the mined utxo set (coin objects). `held`: outpoints a pending tx spends. `status` answers
// /tx/:id/status by txid (default pending). `statusRoute: false` models a bare loopback node.
function mkChain(coins) {
  const c = { tip: 1_000, mined: coins.map((x) => x.coin), held: new Set(), status: new Map(), minedTx: new Map(),
    absent: new Set(), statusRoute: true, minedRead: true, submit: "maybe", submits: 0, statusReads: 0, minedReads: 0 };
  c.available = () => c.mined.filter((u) => !c.held.has(op(u)));
  const utxos = (list) => ({ ok: true, status: 200, json: async () => ({ confirmed_balance: list.reduce((s, x) => s + x.value, 0), utxos: list }) });
  c.fetch = async (url) => {
    const u = String(url);
    if (u.includes("/tx/submit")) {
      c.submits++;
      if (c.submit === "maybe") return { ok: false, status: 502, json: async () => ({ ok: false, error: "node unreachable" }) };
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }
    if (u.includes("/utxos-all/")) {
      c.minedReads++;
      if (!c.statusRoute) return { ok: false, status: 404, json: async () => ({}) };
      return c.minedRead ? utxos(c.mined) : { ok: false, status: 500, json: async () => ({}) };
    }
    if (u.includes("/utxos/")) {
      if (u.includes("available=true")) return utxos(c.available());
      c.minedReads++;
      return utxos(c.mined);                               // a bare node's own unfiltered /utxos/:addr
    }
    if (u.endsWith("/tip")) return { ok: true, status: 200, json: async () => ({ height: c.tip }) };
    const st = u.match(/\/tx\/(0x[0-9a-f]{64})\/status$/i);
    if (st) {
      c.statusReads++;
      if (!c.statusRoute) return { ok: false, status: 404, json: async () => ({}) };
      const s = c.status.get(st[1].toLowerCase()) ?? { state: "pending" };
      return { ok: true, status: 200, json: async () => ({ ok: true, txid: st[1], ...s }) };
    }
    const tx = u.match(/\/tx\/(0x[0-9a-f]{64})$/i);
    if (tx && c.minedTx.has(tx[1].toLowerCase())) return { ok: true, status: 200, json: async () => ({ ok: true, txid: tx[1], height: c.minedTx.get(tx[1].toLowerCase()) }) };
    // the node's complete scan (ScanOutcome::Absent) carries complete:true; any other miss does not
    if (tx && c.absent.has(tx[1].toLowerCase())) return { ok: true, status: 200, json: async () => ({ ok: false, txid: tx[1], err: "not found", complete: true }) };
    return txReply(u, coins) ?? { ok: false, status: 404, json: async () => ({}) };
  };
  // Effects of our own tx: pending holds its inputs; mined removes them and adds its outputs.
  c.pending = (inputs) => { for (const o of inputs) c.held.add(o); };
  c.mine = (txid, inputs, outs = []) => {
    for (const o of inputs) c.held.delete(o);
    c.mined = c.mined.filter((u) => !inputs.includes(op(u))).concat(outs.map((value, vout) => ({ txid, vout, value, confirmations: 1 })));
    c.status.set(txid, { state: "mined", height: c.tip });
  };
  return c;
}
async function mkWallet(chain, rpc) {
  globalThis.fetch = chain.fetch;
  const store = memoryStore();
  const w = new Wallet(store);
  const { addr } = await w.create("inclusion-pw");
  if (rpc) await w.setRpc(rpc);
  const rows = async () => (await store.get("txHistory:" + addr)) || [];
  const row = async (txid) => (await rows()).find((x) => x.txid === txid);
  const setRow = async (txid, patch) => { const h = await rows(); Object.assign(h.find((x) => x.txid === txid), patch); await store.set("txHistory:" + addr, h); };
  const refresh = () => w.pendingMerge(chain.available());   // the popup: pendingMerge(b.utxos)
  const seed = (h) => store.set("txHistory:" + addr, h);
  return { w, row, setRow, refresh, seed };
}
const at = async (chain, tip, refresh) => { chain.tip = tip; return refresh(); };
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
    chain.pending(r.inputs);
    await setRow(r.txid, { ts: Date.now() - 61 * MIN });
    const p = await refresh();
    check("(1) a 61-minute-old merge the node still holds is pending", p.pending === true && p.amount === r.total - FEE);
    check("(1) ...with no notice yet (0 blocks since submit)", p.stuck === false);
    const e = await row(r.txid);
    check("(1) the tip at submit is stamped from the chain", e.subTip === 1_000);
    check("(1) the merge row keeps its input outpoints", Array.isArray(e.inputs) && e.inputs.length === 3 && e.inputs.every((o) => /^0x[0-9a-f]{64}:\d+$/.test(o)));
  }

  // ── (2)-(5) a lost submit answer: sent, then the notice, then mined ───────────────────────────────────
  {
    const coins = [mkCoin(201e8), mkCoin(202e8)];
    const chain = mkChain(coins);
    const { w, row, setRow, refresh } = await mkWallet(chain);
    const r = await w.send(TO, 1e8, FEE);
    check("(2) setup: a 502 on submit is SUBMIT_MAYBE_INFLIGHT", r.code === "SUBMIT_MAYBE_INFLIGHT" && /^0x[0-9a-f]{64}$/.test(r.txid));
    let e = await row(r.txid);
    check("(2) the maybe row keeps the input it spent", e.maybe === true && Array.isArray(e.inputs) && e.inputs.length === 1 && e.inputs[0] === op(coins[1].coin));
    chain.pending(r.inputs);
    await setRow(r.txid, { ts: Date.now() - 24 * 60 * MIN });
    await refresh();
    e = await row(r.txid);
    check("(2) a day-old row the node still holds stays open: sent, not yet included", e.maybe === true && inclusionMark(e) === "sent");
    const submitsBefore = chain.submits;
    await at(chain, 1_009, refresh);
    check("(3) nine blocks past submit: still 'sent', no notice", inclusionMark(await row(r.txid)) === "sent");
    await at(chain, 1_010, refresh);
    e = await row(r.txid);
    check("(3) ten blocks past submit: the standing notice", e.maybe === true && e.stuck === true && inclusionMark(e) === "stuck");
    const reads = chain.statusReads;
    await refresh();
    check("(4) a second refresh at the same tip reads no status again", chain.statusReads === reads);
    check("(4) no reconcile ever submitted a transaction", chain.submits === submitsBefore);
    chain.tip = 1_011;
    chain.mine(r.txid, r.inputs, [201e8 - 1e8 - FEE]);
    await refresh();
    e = await row(r.txid);
    check("(5) paired: a mined txid clears the row (no maybe, no notice, no marker)", e.maybe === undefined && e.stuck === undefined && inclusionMark(e) === null);
  }

  // ── (6) gone means a DIFFERENT mined tx spent an input, seen at two tips ─────────────────────────────────
  {
    // (6a) the reviewer's race: the proxy's 3 s pool cache answers unknown/definite for a tx that just
    // entered the mempool, then pending. Our own pending tx holds its inputs; they stay in the mined set.
    const coins = [mkCoin(301e8), mkCoin(302e8)];
    const chain = mkChain(coins);
    const { w, row, refresh } = await mkWallet(chain);
    const r = await w.send(TO, 1e8, FEE);
    chain.pending(r.inputs);
    chain.status.set(r.txid, { state: "unknown", definite: true });
    await refresh();
    check("(6a) a pending maybe send read as unknown/definite is not gone", !(await row(r.txid)).gone && inclusionMark(await row(r.txid)) === "sent");
    chain.status.set(r.txid, { state: "pending" });
    await at(chain, 1_001, refresh);
    check("(6a) ...and the next reading (pending) leaves no trace of it", !(await row(r.txid)).gone && (await row(r.txid)).goneTip === undefined);
    // (6c) the same pending send read unknown/definite at two tips: its input is still in the mined set
    chain.status.set(r.txid, { state: "unknown", definite: true });
    await at(chain, 1_002, refresh);
    await at(chain, 1_003, refresh);
    check("(6c) a pending maybe send read unknown at two tips is not gone (its own spend, not another's)", !(await row(r.txid)).gone);
  }
  {
    // (6b) an accepted merge read unknown/definite at two tips while the mempool holds it
    const coins = [mkCoin(311e8), mkCoin(312e8)];
    const chain = mkChain(coins);
    chain.submit = "ok";
    const { w, row, refresh } = await mkWallet(chain);
    const r = await w.consolidate(FEE);
    chain.pending(r.inputs);
    chain.status.set(r.txid, { state: "unknown", definite: true });
    await refresh();
    const p = await at(chain, 1_001, refresh);
    check("(6b) an accepted merge read unknown at two tips is not gone", !(await row(r.txid)).gone);
    check("(6b) ...and the merge line still says merging", p.pending === true);
  }
  {
    // (6d) never latched: a change-less send mined while the status read lagged twice shows gone, and the
    // next reading (mined) clears it
    const coins = [mkCoin(321e8)];
    const chain = mkChain(coins);
    const { w, row, refresh } = await mkWallet(chain);
    const r = await w.send(TO, 321e8 - FEE, FEE);
    check("(6d) setup: a change-less maybe send", r.code === "SUBMIT_MAYBE_INFLIGHT");
    chain.mine(r.txid, r.inputs, []);                      // no output of ours: only the status can say mined
    chain.status.set(r.txid, { state: "unknown", definite: true });
    await refresh();
    check("(6d) one lagging read: not gone yet", !(await row(r.txid)).gone);
    await at(chain, 1_001, refresh);
    check("(6d) a second lagging read at another tip: gone (the residual two wrong reads can cause)", (await row(r.txid)).gone === true);
    chain.status.set(r.txid, { state: "mined", height: 1_000 });
    await at(chain, 1_101, refresh);                       // a gone row's next reading: 100 blocks on
    const e = await row(r.txid);
    check("(6d) the next reading says mined: gone is cleared, the row is settled", !e.gone && e.goneTip === undefined && e.maybe === undefined && inclusionMark(e) === null);
  }
  {
    // (6e) paired honest path: a different mined tx spent our input; our txid is unknown at two tips
    const coins = [mkCoin(331e8), mkCoin(332e8)];
    const chain = mkChain(coins);
    const { w, row, refresh } = await mkWallet(chain);
    const r = await w.send(TO, 1e8, FEE);
    chain.mined = chain.mined.filter((u) => !r.inputs.includes(op(u)));   // spent by someone else's mined tx
    chain.status.set(r.txid, { state: "unknown", definite: true });
    await refresh();
    check("(6e) paired: at the first tip it is not gone yet", !(await row(r.txid)).gone && inclusionMark(await row(r.txid)) === "sent");
    await at(chain, 1_001, refresh);
    let e = await row(r.txid);
    check("(6e) paired: at a second tip it is gone", e.gone === true && inclusionMark(e) === "gone");
    // (6f) a later disagreeing reading undoes it (the spend was reorged out; ours is pending again)
    chain.mined.push(...coins.filter((x) => r.inputs.includes(op(x.coin))).map((x) => x.coin));
    chain.pending(r.inputs);
    chain.status.set(r.txid, { state: "pending" });
    await at(chain, 1_101, refresh);                       // a gone row's next reading: 100 blocks on
    e = await row(r.txid);
    check("(6f) a later reading that disagrees clears gone (101 blocks on, the row shows the notice)", !e.gone && e.goneTip === undefined && e.maybe === true && inclusionMark(e) === "stuck");
  }
  {
    // (6g) no mined-set read, no gone verdict
    const coins = [mkCoin(341e8), mkCoin(342e8)];
    const chain = mkChain(coins);
    const { w, row, refresh } = await mkWallet(chain);
    const r = await w.send(TO, 1e8, FEE);
    chain.mined = chain.mined.filter((u) => !r.inputs.includes(op(u)));
    chain.minedRead = false;
    chain.status.set(r.txid, { state: "unknown", definite: true });
    await refresh();
    await at(chain, 1_001, refresh);
    check("(6g) the mined utxo set unreadable: not gone", !(await row(r.txid)).gone);
  }
  {
    // (6h) a status that could not look (the proxy's unknown without `definite`, e.g. a node 503
    // SCAN_BUSY) is not "not mined": a change-less send that WAS mined stays open and reaches the notice.
    //   RED-FIRST: drop `st.definite !== true ||` from inclusionVerdict and (6h) fails (gone at tip 1001).
    const coins = [mkCoin(351e8)];
    const chain = mkChain(coins);
    const { w, row, refresh } = await mkWallet(chain);
    const r = await w.send(TO, 351e8 - FEE, FEE);
    chain.mine(r.txid, r.inputs, []);
    chain.status.set(r.txid, { state: "unknown", definite: false });
    let everGone = false;
    for (let t = 1_000; t <= 1_012; t++) { await at(chain, t, refresh); everGone = everGone || !!(await row(r.txid)).gone; }
    const e = await row(r.txid);
    check("(6h) a mined send read unknown/not-definite at tips 1000-1012 is never gone", !everGone && !e.gone && e.goneTip === undefined);
    check("(6h) ...it shows the standing notice instead", inclusionMark(e) === "stuck");
  }
  {
    // (6i) gone stays gone across readings that cannot look; (6j) a gone row is read once per 100 blocks
    //   RED-FIRST: call goneStep on a "noreading" verdict and (6i) fails (gone, then sent).
    const coins = [mkCoin(361e8), mkCoin(362e8)];
    const chain = mkChain(coins);
    const { w, row, refresh } = await mkWallet(chain);
    const r = await w.send(TO, 1e8, FEE);
    chain.mined = chain.mined.filter((u) => !r.inputs.includes(op(u)));
    chain.status.set(r.txid, { state: "unknown", definite: true });
    await refresh();
    await at(chain, 1_001, refresh);
    check("(6i) setup: gone at the second tip", (await row(r.txid)).gone === true);
    let reads = chain.statusReads;
    await at(chain, 1_100, refresh);
    check("(6j) a gone row is not read again within 100 blocks of its last read", chain.statusReads === reads);
    chain.minedRead = false;
    await at(chain, 1_101, refresh);
    check("(6j) ...and is read again 100 blocks after it", chain.statusReads === reads + 1);
    check("(6i) the mined set unreadable at that reading: still gone, not 'sent'", (await row(r.txid)).gone === true && inclusionMark(await row(r.txid)) === "gone");
    chain.minedRead = true;
    chain.status.set(r.txid, { state: "unknown", definite: false });
    reads = chain.statusReads;
    await at(chain, 1_201, refresh);
    check("(6i) a status that could not look: still gone", chain.statusReads === reads + 1 && (await row(r.txid)).gone === true);
  }
  {
    // (6k) a false gone on a change-less send that WAS mined (its txid is in no utxo set) is undone once the
    // source says mined: the slow cadence keeps reading it.
    //   RED-FIRST: stop reading rows gone for over 100 blocks (`t - goneTip > 100`) and (6k) fails.
    const coins = [mkCoin(371e8)];
    const chain = mkChain(coins);
    const { w, row, refresh } = await mkWallet(chain);
    const r = await w.send(TO, 371e8 - FEE, FEE);
    chain.mine(r.txid, r.inputs, []);
    chain.status.set(r.txid, { state: "unknown", definite: true });   // a lying or broken source, twice
    await refresh();
    await at(chain, 1_001, refresh);
    check("(6k) setup: two false readings make it gone", (await row(r.txid)).gone === true);
    chain.status.set(r.txid, { state: "mined", height: 1_000 });
    await at(chain, 1_102, refresh);
    await at(chain, 1_103, refresh);
    const e = await row(r.txid);
    check("(6k) the source then says mined: the row is settled, not gone", !e.gone && e.maybe === undefined && inclusionMark(e) === null);
  }

  // ── (7) the utxo set settles a merge; a loopback node; where the mined set is read ─────────────────────
  {
    const coins = [mkCoin(401e8), mkCoin(402e8)];
    const chain = mkChain(coins);
    chain.submit = "ok";
    const { w, row, refresh } = await mkWallet(chain);
    const r = await w.consolidate(FEE);
    chain.mine(r.txid, r.inputs, [r.total - FEE]);
    const reads = chain.statusReads;
    const p = await refresh();
    check("(7) the merge output in the utxo set confirms it with no status read", p.pending === false && (await row(r.txid)).confirmed === true && chain.statusReads === reads);

    const coins2 = [mkCoin(411e8), mkCoin(412e8)];
    const chain2 = mkChain(coins2);
    chain2.statusRoute = false;
    const b = await mkWallet(chain2, "http://127.0.0.1:8789");
    const r2 = await b.w.send(TO, 1e8, FEE);
    chain2.pending(r2.inputs);
    await b.refresh();
    check("(7) loopback node: open while /tx/:id does not find it", (await b.row(r2.txid)).maybe === true);
    const reads2 = chain2.statusReads;
    await b.refresh();
    check("(7) loopback node: a second refresh at the same tip reads no status again", chain2.statusReads === reads2);
    chain2.tip = 1_001;
    chain2.minedTx.set(r2.txid, 1_000);
    await b.refresh();
    check("(7) loopback node: /tx/:id mined clears the row", (await b.row(r2.txid)).maybe === undefined);

    // a loopback node's not-found is `definite` only when its scan was complete (complete:true)
    const coins3 = [mkCoin(421e8), mkCoin(422e8)];
    const chain3 = mkChain(coins3);
    chain3.statusRoute = false;
    const c3 = await mkWallet(chain3, "http://127.0.0.1:8789");
    const r3 = await c3.w.send(TO, 1e8, FEE);
    chain3.mined = chain3.mined.filter((u) => !r3.inputs.includes(op(u)));
    await c3.refresh();
    await at(chain3, 1_001, c3.refresh);
    check("(7) loopback node: an input spent elsewhere but no complete scan: not gone", !(await c3.row(r3.txid)).gone);
    chain3.absent.add(r3.txid);
    await at(chain3, 1_002, c3.refresh);
    await at(chain3, 1_003, c3.refresh);
    check("(7) loopback node: complete scans at two tips with the input spent elsewhere: gone", (await c3.row(r3.txid)).gone === true);

    const asked = [];
    const answer = (u) => { asked.push(u); return u.includes("/utxos-all/") ? { ok: false, status: 404, json: async () => ({}) } : { ok: true, status: 200, json: async () => ({ utxos: [{ txid: "0x" + "aa".repeat(32), vout: 0 }] }) }; };
    globalThis.fetch = async (u) => answer(String(u));
    const bare = await confirmedUtxos("http://127.0.0.1:8789", TO);
    check("(7) a bare node origin falls back to its own unfiltered /utxos/:addr", Array.isArray(bare) && bare.length === 1 && asked.at(-1) === `http://127.0.0.1:8789/utxos/${TO}`);
    const proxied = await confirmedUtxos("http://127.0.0.1:7777/api/rpc", TO);
    check("(7) an RPC with a path and no /utxos-all (its /utxos is mempool-filtered) gives no mined set", proxied === null);
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
