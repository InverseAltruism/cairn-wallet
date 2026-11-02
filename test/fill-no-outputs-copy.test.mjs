// A fill with no payment outputs whose selected coins equal the fee leaves a transaction with no outputs at all; the
// engine refuses it (NO_OUTPUTS) before signing, with copy that has no em dash.
// Run: npx tsx test/fill-no-outputs-copy.test.mjs   (offline)
import { checker } from "./helpers/check.mjs";
import { fillOffer } from "../src/core/node.js";
import { mkCoin, txReply } from "./_coin.js";

const { check, done } = checker("fill with no outputs:");
const FEE = 5_000_000;
const coin = mkCoin(FEE);   // exactly the fee: no change output
let submits = 0;
globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes("/tx/submit")) { submits++; return { ok: true, status: 200, json: async () => ({ ok: true, txid: "0x" + "aa".repeat(32) }) }; }
  if (u.includes("/utxos/")) return { ok: true, status: 200, json: async () => ({ confirmed_balance: FEE, utxos: [coin.coin] }) };
  return txReply(u, [coin]) ?? { ok: false, status: 404, json: async () => ({}) };
};
const r = await fillOffer("http://127.0.0.1:9/api/rpc", { proposalId: "0x" + "ab".repeat(32), score: 100, confidence: 1_000_000, outputs: [], fee: FEE }, "0x" + "26".repeat(32));
check(`refused NO_OUTPUTS before any submit (${r.code}: ${r.error})`, r.ok === false && r.code === "NO_OUTPUTS" && submits === 0);
check("the copy reads \"tx would have no outputs: add a payment or leave change\"", r.error === "tx would have no outputs: add a payment or leave change");
done("fill-no-outputs-copy");
