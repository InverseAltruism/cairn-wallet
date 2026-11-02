// A dApp output's recipient is a 20-byte address: validateOutputs refuses a 19- or 21-byte one with BAD_OUTPUTS
// before anything is read or signed, on send({outputs}) and on a propose payout, beside an honest 20-byte send that
// signs. The codec's fixed-width write is the backstop: it throws on a 19- or 21-byte scriptPubkey.
// Run: npx tsx test/recipient-length.test.mjs   (offline)
import { checker } from "./helpers/check.mjs";
import { sendMany, propose } from "../src/core/node.js";
import { serialize } from "../src/core/csdtx.js";
import { mkCoin, txReply } from "./_coin.js";

const { check, done } = checker("dApp output recipients are 20 bytes:");
const PRIV = "0x" + "24".repeat(32);
const RPC = "http://127.0.0.1:9/api/rpc";
const HASH = "0x" + "ab".repeat(32);
const coin = mkCoin(5e8);
function stub() {
  const s = { fetches: 0, submits: [] };
  globalThis.fetch = async (url, init) => {
    s.fetches++;
    const u = String(url);
    if (u.includes("/tx/submit")) { s.submits.push(JSON.parse(init?.body ?? "{}")); return { ok: true, status: 200, json: async () => ({ ok: true, txid: "0x" + "aa".repeat(32) }) }; }
    if (u.includes("/utxos/")) return { ok: true, status: 200, json: async () => ({ confirmed_balance: 5e8, utxos: [coin.coin] }) };
    return txReply(u, [coin]) ?? { ok: false, status: 404, json: async () => ({}) };
  };
  return s;
}

for (const [label, to] of [["19-byte", "0x" + "5c".repeat(19)], ["21-byte", "0x" + "5c".repeat(21)]]) {
  let s = stub();
  const r = await sendMany(RPC, { outputs: [{ to, value: 1e8 }], fee: 1e6 }, PRIV).catch((e) => ({ ok: false, code: `threw: ${e.message}` }));
  check(`${label} recipient: send({outputs}) refuses BAD_OUTPUTS with no read or submit (${r.code}, ${s.fetches} fetches)`, r.ok === false && r.code === "BAD_OUTPUTS" && s.fetches === 0 && s.submits.length === 0);
  s = stub();
  const p = await propose(RPC, { domain: "cairnx:v1", payloadHash: HASH, uri: "x", expiresEpoch: 100, fee: 25e6, outputs: [{ to, value: 1e8 }] }, PRIV).catch((e) => ({ ok: false, code: `threw: ${e.message}` }));
  check(`${label} recipient: a propose payout refuses BAD_OUTPUTS with no read or submit (${p.code}, ${s.fetches} fetches)`, p.ok === false && p.code === "BAD_OUTPUTS" && s.fetches === 0 && s.submits.length === 0);
}
const tx = (spk) => ({ version: 1, locktime: 0, app: { type: "None" }, inputs: [{ prevTxid: "0x" + "11".repeat(32), vout: 0, scriptSig: "0x" }], outputs: [{ value: 1, scriptPubkey: spk }] });
const throws = (f) => { try { f(); return false; } catch { return true; } };
check("the codec refuses to serialize a 19- or 21-byte scriptPubkey and serializes a 20-byte one",
  throws(() => serialize(tx("0x" + "5c".repeat(19)))) && throws(() => serialize(tx("0x" + "5c".repeat(21)))) && !throws(() => serialize(tx("0x" + "5c".repeat(20)))));
{
  const s = stub();
  const r = await sendMany(RPC, { outputs: [{ to: "0x" + "5c".repeat(20), value: 1e8 }], fee: 1e6 }, PRIV);
  check(`20-byte recipient: send({outputs}) signs and submits once (${r.ok}, ${s.submits.length})`, r.ok === true && s.submits.length === 1);
}

done("recipient-length");
