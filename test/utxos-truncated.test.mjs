// Node 0.1.17 cuts a `/utxos` answer at its bound (`--utxos-bound`, 10,000 by default, the largest coins first) and
// says `truncated: true`; `confirmed_balance` stays the whole balance. The wallet reads the flag: the coin counts it
// shows become floors ("at least N") and no absence conclusion is drawn from a cut list (the inclusion side is
// test/inclusion-chain.test.mjs case 6t).
//   RED-FIRST: drop the `truncated` read in node.ts balance() and sections 1 to 3 fail.
//   PAIRED HONEST PATHS: an uncut answer (no field, as 0.1.16 and every answer under the bound send) reads as before,
//   with exact counts (1, 2, 3).
// Run: npx tsx test/utxos-truncated.test.mjs   (offline)
import { installFakeDom, installBridge, flush } from "./_fakedom.mjs";
import { balance, consolidatePreview, maxSendable, consolidate, send } from "../src/core/node.ts";
import { mkCoin, txReply } from "./_coin.ts";
import { checker } from "./helpers/check.mjs";

const { check, done } = checker("a /utxos answer the node cut at its bound:");
const RPC = "http://127.0.0.1:8789", ADDR = "0x" + "a1".repeat(20), FEE = 1_000_000;
const coins = [mkCoin(30e8), mkCoin(20e8), mkCoin(5e8)];
let cut = true;
globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes("/utxos/")) return { ok: true, status: 200, json: async () => ({ confirmed_balance: 60e8, utxos: coins.map((c) => c.coin), ...(cut ? { truncated: true } : {}) }) };
  return txReply(u, coins) ?? { ok: false, status: 404, json: async () => ({}) };
};

// 1. balance() carries the flag; the balance is the node's whole figure either way.
{
  const b = await balance(RPC, ADDR);
  check(`1. a cut answer reads truncated, with the whole balance (${b.truncated}, ${b.confirmed})`, b.truncated === true && b.confirmed === 60e8 && b.utxos.length === 3);
  cut = false;
  const h = await balance(RPC, ADDR);
  check("1. honest path: an answer without the field is not truncated", h.truncated === false && h.utxos.length === 3);
  cut = true;
}
// 2. The merge preview and Max report it, so the popup can say "at least".
{
  const p = await consolidatePreview(RPC, ADDR, FEE);
  check(`2. the merge preview says the count is a floor (${JSON.stringify(p)})`, p.ok && p.truncated === true && p.coins === 3);
  const m = await maxSendable(RPC, ADDR, FEE);
  check(`2. Max says its eligible count is a floor (${JSON.stringify(m)})`, m.ok === true && m.truncated === true && m.eligible === 3 && m.amount === 55e8 - FEE);
  cut = false;
  const p2 = await consolidatePreview(RPC, ADDR, FEE), m2 = await maxSendable(RPC, ADDR, FEE);
  check("2. honest path: uncut, both say the count is exact", p2.ok && p2.truncated === false && m2.ok === true && m2.truncated === false && m2.amount === 55e8 - FEE);
  cut = true;
}
// 2b. A merge reports the cut too, so its "coins left" reads as a floor (test/popup-inclusion-dom.test.mjs 7c).
{
  const PRIV = "0x" + "11".repeat(32);
  const m = await consolidate(RPC, { fee: FEE }, PRIV);
  cut = false;
  const m2 = await consolidate(RPC, { fee: FEE }, PRIV);
  cut = true;
  check(`2b. a merge from a cut list says truncated, from an uncut one not (${m.truncated}, ${m2.truncated})`, m.truncated === true && m2.truncated === false && m.merged === 3);
}
// 2c. A send the whole balance covers but whose listed coins cannot cover within the 512-input cap is TOO_MANY_INPUTS
// under a cut list (W1b's probe: 600 listed coins of 1 CSD, whole balance 2,000 CSD, a 700 CSD send).
{
  const saved = globalThis.fetch;
  const many = Array.from({ length: 600 }, (_, i) => ({ txid: "0x" + i.toString(16).padStart(64, "0"), vout: 0, value: 100_000_000, height: 100, confirmations: 10, coinbase: false }));
  const serve = (truncated) => { globalThis.fetch = async (url) => String(url).includes("/utxos/") ? { ok: true, status: 200, json: async () => ({ confirmed_balance: truncated ? 2_000e8 : 600e8, utxos: many, ...(truncated ? { truncated: true } : {}) }) } : { ok: false, status: 404, json: async () => ({}) }; };
  const PRIV = "0x" + "11".repeat(32), TO = "0x" + "22".repeat(20);
  serve(true);
  const capped = await send(RPC, { to: TO, amount: 700e8, fee: FEE }, PRIV);
  serve(false);
  const short = await send(RPC, { to: TO, amount: 700e8, fee: FEE }, PRIV);
  serve(true);
  const over = await send(RPC, { to: TO, amount: 2_500e8, fee: FEE }, PRIV);
  globalThis.fetch = saved;
  check(`2c. under a cut list a send the whole balance covers refuses TOO_MANY_INPUTS (${capped.code})`, capped.ok === false && capped.code === "TOO_MANY_INPUTS");
  check(`2c. honest path: uncut, 600 CSD of coins cannot cover 700 CSD: INSUFFICIENT (${short.code})`, short.code === "INSUFFICIENT");
  check(`2c. honest path: a send above the whole balance is still INSUFFICIENT under a cut list (${over.code})`, over.code === "INSUFFICIENT");
}
// 3. The popup: Settings' coin count and the merge sheet read "at least" under a cut list, the exact count otherwise.
{
  const { byId } = installFakeDom({ autoCreate: true });
  let preview = { ok: true, coins: 10_000, truncated: true, merge: 512, total: 512e6, out: 511e6 };
  installBridge({
    status: () => ({ hasVault: true, unlocked: true, addr: ADDR, active: 0, accounts: [{ label: "Main", addr: ADDR }], rpc: "https://x", api: "https://x", tradeApi: "https://x/trade/api", explorer: "cairn", hasMnemonic: true }),
    balance: () => ({ confirmed: 100e8, utxos: [], truncated: true }), pendingMerge: () => ({ pending: false, amount: 0, maybe: false, stuck: false }),
    cairnxAssets: () => ({ ok: true, primaryName: null, tipHeight: 1, balances: {}, names: [], nameDetails: [] }), cairnxTokens: () => ({ ok: true, tokens: [] }),
    prewarmSpv: () => ({ ok: true }), pending: () => [], history: () => [], sealedClaims: () => [], connectedSites: () => [],
    consolidatePreview: () => preview,
    maxSendable: () => max,
  });
  let max = { ok: true, amount: 5e8, fee: FEE, inputs: 512, eligible: 10_000, skipped: 0, capped: true, truncated: true };
  globalThis.setInterval = () => 0;
  await import("../src/popup/popup.ts");
  const { renderCoinsInfo, openConsolidatePanel } = await import("../src/popup/popup-coins.ts");
  await flush();
  await renderCoinsInfo(); await flush();
  check(`3. Settings says "at least" for a cut list (${byId("coins-info").textContent})`, byId("coins-info").textContent.startsWith("You have at least 10000 spendable coins."));
  await openConsolidatePanel(true); await flush();
  check(`3. the merge sheet says "of at least" and "at least N merges" (${byId("cs-merge").textContent}; ${byId("cs-note").textContent.slice(0, 80)})`, byId("cs-merge").textContent === "512 of at least 10000" && /so at least 20 merges are needed/.test(byId("cs-note").textContent));
  const pressMax = async () => { byId("s-amt").disabled = false; byId("send-form").hidden = false; await byId("s-max")._listeners.click[0](); await flush(); return byId("s-max-note").textContent; };
  const capNote = await pressMax();
  check(`3. Max's note says "at least" for a cut list (${capNote.slice(0, 90)})`, capNote.includes("it spends 512 of your coins (at least 10000 in all), the limit per transaction"));
  preview = { ok: true, coins: 600, truncated: false, merge: 512, total: 512e6, out: 511e6 };
  await renderCoinsInfo(); await flush();
  check(`3. honest path: an uncut count is exact (${byId("coins-info").textContent})`, byId("coins-info").textContent.startsWith("You have 600 spendable coins."));
  max = { ...max, eligible: 600, truncated: false };
  const exact = await pressMax();
  check(`3. honest path: Max's note keeps the exact count (${exact.slice(0, 90)})`, exact.includes("it spends 512 of your 600 coins"));
}
done("utxos-truncated");
