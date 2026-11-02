// A dApp's output value has one reading: the engine parses it with csdBase, the parser the approval window prints
// it through, so a spelling the window shows as "invalid amount" is refused before anything is read or signed.
// Number() let "1e8", " 100000000", "0x5f5e100", [100000000] and true through to a signed output while the
// window's row and amount hero said "invalid amount". An integer number and a decimal-digit string still sign, the
// same bytes.
// Run: npx tsx test/output-value-parse.test.mjs   (offline)
import { checker } from "./helpers/check.mjs";
import { sendMany, propose } from "../src/core/node.js";
import { fmtCsd, baseVal } from "../src/popup/clearsign.js";
import { mkCoin, txReply } from "./_coin.js";

const { check, done } = checker("dApp output values: one parse for the window and the engine:");
const PRIV = "0x" + "21".repeat(32);
const RPC = "http://127.0.0.1:9/api/rpc";
const TO = "0x" + "5a".repeat(20);
const HASH = "0x" + "ab".repeat(32);

function stub(coins) {
  const s = { fetches: 0, submits: [] };
  globalThis.fetch = async (url, init) => {
    s.fetches++;
    const u = String(url);
    if (u.includes("/tx/submit")) { s.submits.push(JSON.parse(init?.body ?? "{}")); return { ok: true, status: 200, json: async () => ({ ok: true, txid: "0x" + "aa".repeat(32) }) }; }
    if (u.includes("/utxos/")) return { ok: true, status: 200, json: async () => ({ confirmed_balance: coins.reduce((a, c) => a + c.coin.value, 0), utxos: coins.map((c) => c.coin) }) };
    return txReply(u, coins) ?? { ok: false, status: 404, json: async () => ({}) };
  };
  return s;
}
const coin = mkCoin(5e8);

for (const value of ["1e8", " 100000000", "100000000 ", "0x5f5e100", "1.0e8", [100000000], true, "+100000000"]) {
  const label = JSON.stringify(value);
  check(`${label}: the window prints it as invalid and counts 0 toward its total`, fmtCsd(value) === "invalid amount" && baseVal(value) === 0);
  let s = stub([coin]);
  const r = await sendMany(RPC, { outputs: [{ to: TO, value }], fee: 1e6 }, PRIV);
  check(`${label}: send({outputs}) refuses BAD_OUTPUTS before any fetch (${r.code}, ${s.fetches} fetches)`, r.ok === false && r.code === "BAD_OUTPUTS" && s.fetches === 0 && s.submits.length === 0);
  s = stub([coin]);
  const p = await propose(RPC, { domain: "cairnx:v1", payloadHash: HASH, uri: "x", expiresEpoch: 100, fee: 25e6, outputs: [{ to: TO, value }] }, PRIV);
  check(`${label}: a propose payout refuses BAD_OUTPUTS before any fetch (${p.code}, ${s.fetches} fetches)`, p.ok === false && p.code === "BAD_OUTPUTS" && s.fetches === 0 && s.submits.length === 0);
}

// The honest spellings sign, and the same bytes.
const signed = [];
for (const value of [100000000, "100000000"]) {
  const s = stub([coin]);
  const r = await sendMany(RPC, { outputs: [{ to: TO, value }], fee: 1e6 }, PRIV);
  check(`${JSON.stringify(value)}: the window prints 1 CSD, totals it, and send({outputs}) signs it (${r.ok}, ${s.submits.length} submit)`, fmtCsd(value) === "1 CSD" && baseVal(value) === 1e8 && r.ok === true && s.submits.length === 1);
  signed.push(JSON.stringify(s.submits[0]));
}
check("the number and the digit string sign identical bytes", signed.length === 2 && signed[0] === signed[1]);
{
  const s = stub([coin]);
  const p = await propose(RPC, { domain: "cairnx:v1", payloadHash: HASH, uri: "x", expiresEpoch: 100, fee: 25e6, outputs: [{ to: TO, value: "100000000" }] }, PRIV);
  check(`a propose payout of "100000000" signs (${p.ok}, ${s.submits.length} submit)`, p.ok === true && s.submits.length === 1);
}
// Zero and a value past 2^53 stay refused (csdBase admits both; the engine's own bounds do not).
for (const value of [0, "0", "9007199254740993"]) {
  const s = stub([coin]);
  const r = await sendMany(RPC, { outputs: [{ to: TO, value }], fee: 1e6 }, PRIV);
  check(`${JSON.stringify(value)}: refused BAD_OUTPUTS (${r.code})`, r.ok === false && r.code === "BAD_OUTPUTS" && s.submits.length === 0);
}

done("output-value-parse");
