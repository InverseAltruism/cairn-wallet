// A send's result for each kind of submit answer, through Wallet.send on the production call shape (the default RPC).
//
// RED-FIRST against 0.3.4 (register row 212, and the node's panic text): a JSON 408, a 2xx {} and an ok:false without
// an err string read as SUBMIT_REJECTED with no txid and no history row, a truthy non-boolean ok read as sent, and
// "submit validation did not finish" (the node's check panicked, so the admission may have run) read as refused. Each
// may follow a node taking the transaction, so each is now SUBMIT_MAYBE_INFLIGHT with the local txid and a maybe row.
// Undo the row 212 branches in submitverdict.ts classifyAnswer and R1 to R5 fail.
// PAIRED HONEST PATHS: H1 to H5 are unchanged from 0.3.4: accepted, a node refusal (now with `reason`), a proxy's 400
// and 429, a duplicate, a timeout.
//
// Run: node --import tsx test/submit-answers.test.mjs   (offline)
import { Wallet } from "../src/core/wallet.js";
import { memoryStore } from "../src/core/storage.js";
import { mkCoin, txReply } from "./_coin.js";
import { checker } from "./helpers/check.mjs";
import "./helpers/backup-host.mjs";

const { check, done } = checker("=== submit answers, end to end ===");
const RCPT = "0x" + "11".repeat(20);
const COIN = mkCoin(5e8);
const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

async function sendWith(submit) {
  const w = new Wallet(memoryStore());
  await w.create("super-secret-pw");
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes("/tx/submit")) return submit();
    if (u.includes("/utxos/")) return json(200, { confirmed_balance: 5e8, utxos: [COIN.coin] });
    const tr = txReply(u, [COIN]); if (tr) return tr;
    return json(404, {});
  };
  const r = await w.send(RCPT, 1e8, 1e6);
  return { r, hist: await w.history() };
}
const unclear = ({ r, hist }) => r.ok === false && r.code === "SUBMIT_MAYBE_INFLIGHT" && /^0x[0-9a-f]{64}$/.test(String(r.txid)) && hist.length === 1 && hist[0].maybe === true && hist[0].txid === r.txid;

check("R1: a JSON 408 is SUBMIT_MAYBE_INFLIGHT with the local txid and a maybe row", unclear(await sendWith(() => json(408, { ok: false, error: "request timeout" }))));
check("R2: a 2xx {} is SUBMIT_MAYBE_INFLIGHT with a maybe row", unclear(await sendWith(() => json(200, {}))));
check("R3: a truthy non-boolean ok is SUBMIT_MAYBE_INFLIGHT, not sent", unclear(await sendWith(() => json(200, { ok: 1 }))));
check("R4: ok:false without an err string is SUBMIT_MAYBE_INFLIGHT", unclear(await sendWith(() => json(200, { ok: false }))));
check("R5: 'submit validation did not finish' is SUBMIT_MAYBE_INFLIGHT", unclear(await sendWith(() => json(200, { ok: false, err: "submit validation did not finish: task 7 panicked" }))));

const h1 = await sendWith(() => json(200, { ok: true }));
check("H1: accepted is sent, one row, no maybe", h1.r.ok === true && h1.r.code === undefined && h1.hist.length === 1 && !h1.hist[0].maybe && h1.hist[0].txid === h1.r.txid);
const h2 = await sendWith(() => json(200, { ok: false, err: "feerate too low (0 < MIN_FEERATE_PPM=1)" }));
check("H2: a node refusal is SUBMIT_REJECTED, no txid, no row, reason FEE; error is the wallet's sentence, the node's text only in the internal log",
  h2.r.ok === false && h2.r.code === "SUBMIT_REJECTED" && h2.r.txid === undefined && h2.hist.length === 0 && h2.r.reason === "FEE" && !/feerate/.test(h2.r.error) && h2.r.hosts.some((h) => /feerate too low/.test(h.text)));
const h3 = await sendWith(() => json(400, { ok: false, error: "request body too large" }));
const h3b = await sendWith(() => json(429, { ok: false, error: "too many requests" }));
check("H3: a proxy's 400 and 429 are SUBMIT_REJECTED (PROXY, BUSY) with no row",
  h3.r.code === "SUBMIT_REJECTED" && h3.r.reason === "PROXY" && h3.hist.length === 0 && h3b.r.code === "SUBMIT_REJECTED" && h3b.r.reason === "BUSY" && h3b.hist.length === 0);
const h4 = await sendWith(() => json(200, { ok: false, err: "already present in mempool" }));
check("H4: a duplicate is SUBMIT_DUPLICATE with the local txid and no new row", h4.r.code === "SUBMIT_DUPLICATE" && /^0x/.test(String(h4.r.txid)) && h4.hist.length === 0);
const h5 = await sendWith(() => { throw new TypeError("fetch failed"); });
check("H5: a thrown submit is SUBMIT_MAYBE_INFLIGHT with a maybe row", unclear(h5) && h5.r.hosts.every((h) => h.text === "/tx/submit -> network error"));
// WL1.2: a server's text never reaches `error` (what a page receives); RED-FIRST: 1d83702 put it there
const invented = "visit evil.example to recover your coins";
const leaks = [];
for (const body of [{ ok: false, err: invented }, { ok: false, err: "already present " + invented }]) for (const status of [200, 400, 429, 502]) {
  const x = await sendWith(() => json(status, status === 200 ? body : { ok: false, error: invented }));
  if (String(x.r.error).includes("evil.example")) leaks.push(`${status} ${x.r.code}`);
}
check(`H6: an invented server text on every answer path never reaches the result's error (${leaks.join(", ") || "none"})`, leaks.length === 0);

done("submit-answers");
