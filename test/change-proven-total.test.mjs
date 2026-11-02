// A send's change comes from the chain-proven input total, never the RPC's reported coin values: an RPC that
// under-reports a coin would otherwise make the change short by the difference, which the miner takes as fee.
// One coin reported at 4 CSD whose source tx proves 5 CSD: the change is 5 - amount - fee.
// Run: npx tsx test/change-proven-total.test.mjs   (offline)
import { checker } from "./helpers/check.mjs";
import { send, sendMany } from "../src/core/node.js";
import { addrFromPriv } from "../src/core/csdtx.js";
import { mkCoin, txReply } from "./_coin.js";

const { check, done } = checker("change comes from the proven input total:");
const PRIV = "0x" + "23".repeat(32);
const ME = addrFromPriv(PRIV).toLowerCase();
const RPC = "http://127.0.0.1:9/api/rpc";
const TO = "0x" + "5b".repeat(20);
const hex = (bytes) => "0x" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

function stub(coins) {
  const s = { submits: [] };
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.includes("/tx/submit")) { s.submits.push(JSON.parse(init?.body ?? "{}")); return { ok: true, status: 200, json: async () => ({ ok: true, txid: "0x" + "aa".repeat(32) }) }; }
    if (u.includes("/utxos/")) return { ok: true, status: 200, json: async () => ({ confirmed_balance: coins.reduce((a, c) => a + c.coin.value, 0), utxos: coins.map((c) => c.coin) }) };
    return txReply(u, coins) ?? { ok: false, status: 404, json: async () => ({}) };
  };
  return s;
}
const outputsOf = (sub) => (sub?.tx?.outputs ?? []).map((o) => ({ to: hex(o.script_pubkey).toLowerCase(), value: Number(o.value) }));

for (const [label, run] of [
  ["send", () => send(RPC, { to: TO, amount: 1e8, fee: 1e6 }, PRIV)],
  ["send({outputs})", () => sendMany(RPC, { outputs: [{ to: TO, value: 1e8 }], fee: 1e6 }, PRIV)],
]) {
  const c = mkCoin(5e8);
  c.coin.value = 4e8;   // what the RPC reports; the served source tx proves 5e8
  const s = stub([c]);
  const r = await run();
  const outs = outputsOf(s.submits[0]);
  const change = outs.find((o) => o.to === ME);
  check(`${label}: signed with the recipient paid 1 CSD (${r.ok}, ${s.submits.length} submit)`, r.ok === true && s.submits.length === 1 && outs.some((o) => o.to === TO.toLowerCase() && o.value === 1e8));
  check(`${label}: change is the proven 5 CSD minus amount and fee, 3.99 CSD (${change?.value})`, change?.value === 5e8 - 1e8 - 1e6);
}

done("change-proven-total");
