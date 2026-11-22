// A send reported sent before the main host had taken it (only the second host had) is recorded as a maybe row, so the
// reconcile tracks it and an unmined row says to check before sending again (src/core/history.ts maybeRecord, node.ts
// mainPending). The main host's later "accepted" or "already present" for the same txid clears the mark; nothing else
// does, nothing adds it back, and the result given to the popup or the page never changes.
//
// RED-FIRST against the previous commit: M1 (the second host accepts, the main host never answers), M3 (the main host
// refuses late) and M4 (the late answer never processed) recorded a plain sent row there.
// Mutations (run in a copy): upgrade on any late answer and M3 fails; allow a late refusal to mark a sent row maybe and
// M6 fails; record a sent row when only the second host accepted and M1, M3, M4 fail.
// PAIRED UNTOUCHED CASES: M2 (the main host accepts 50 ms after the second) and M5 (both healthy, the main host first)
// end as one plain sent row; every case returns the same result shape (the popup's line is drawn from it).
//
// Run: node --import tsx test/submit-main-late.test.mjs   (offline; about 21 s, M1 waits for the 20 s POST timeout)
// routes the second host itself
import { Wallet } from "../src/core/wallet.js";
import { memoryStore } from "../src/core/storage.js";
import { DEFAULT_RPC, BACKUP_RPC } from "../src/core/endpoints.js";
import { mkCoin, txReply } from "./_coin.js";
import { checker } from "./helpers/check.mjs";

const { check, done } = checker("=== the history row of a send only the second host took ===");
const RCPT = "0x" + "11".repeat(20);
const COIN = mkCoin(5e8);
const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const A = () => json(200, { ok: true });
const ANSWERS = {
  A, D: () => json(200, { ok: false, err: "already present in mempool" }),
  C: () => json(200, { ok: false, err: "mempool conflict: a different pending transaction spends these coins" }),
  R: () => json(200, { ok: false, err: "mempool full; feerate 1 not competitive (min=5)" }),
};
// per host: { a, after } answers after `after` ms; "timeout" ends at the wallet's own abort; "never" never settles
let plan;
function answer(spec, init) {
  if (spec === "never") return new Promise(() => undefined);
  if (spec === "timeout") return new Promise((_r, rej) => { const alive = setInterval(() => undefined, 1_000); init?.signal?.addEventListener("abort", () => { clearInterval(alive); rej(init.signal.reason); }); });
  return sleep(spec.after ?? 0).then(() => ANSWERS[spec.a]());
}
globalThis.fetch = async (url, init) => {
  const u = String(url);
  const host = u.startsWith(BACKUP_RPC + "/") ? "backup" : u.startsWith(DEFAULT_RPC + "/") ? "main" : "other";
  if (u.endsWith("/tx/submit")) return answer(plan[host], init);
  if (host === "backup") throw new TypeError("reads stay on the main host in this file");
  if (u.includes("/utxos/")) return json(200, { confirmed_balance: 5e8, utxos: [COIN.coin] });
  return txReply(u, [COIN]) ?? json(404, {});
};
async function sendWith(p) {
  plan = p;
  const w = new Wallet(memoryStore());
  await w.create("super-secret-pw");
  const t0 = Date.now();
  const r = await w.send(RCPT, 1e8, 1e6);
  return { r, ms: Date.now() - t0, w, row: async () => (await w.history())[0], rows: async () => (await w.history()).length };
}
// What the popup and a page are given: the same in every case
const sentShape = (r) => r.ok === true && r.code === undefined && r.error === undefined && /^0x[0-9a-f]{64}$/.test(String(r.txid));

const m1 = await sendWith({ main: "timeout", backup: { a: "A" } });
check(`M1: the second host accepts, the main host never answers: the result is sent at once (${m1.ms} ms)`, sentShape(m1.r) && m1.ms < 400);
check("M1: the row is maybe at once", (await m1.row())?.maybe === true && (await m1.rows()) === 1);
await sleep(20_500);
check("M1: the row is still maybe after the main host's request timed out", (await m1.row())?.maybe === true);

const m2 = await sendWith({ main: { a: "A", after: 50 }, backup: { a: "A" } });
await sleep(200);
const r2 = await m2.row();
check(`M2: the second host accepts first, the main host 50 ms later: the result is sent (${m2.ms} ms) and the row ends sent`, sentShape(m2.r) && !r2?.maybe && (await m2.rows()) === 1);
check("M2: the upgrade moves no submit time (no resent)", r2?.resent === undefined);
const m2d = await sendWith({ main: { a: "D", after: 50 }, backup: { a: "A" } });
await sleep(200);
check("M2: the main host's late 'already present' also ends it sent", sentShape(m2d.r) && !(await m2d.row())?.maybe);

for (const late of ["C", "R"]) {
  const m3 = await sendWith({ main: { a: late, after: 50 }, backup: { a: "A" } });
  await sleep(200);
  check(`M3: the main host refuses late (${late === "C" ? "conflict" : "busy"}): the result is sent and the row stays maybe`, sentShape(m3.r) && (await m3.row())?.maybe === true);
}

const m4 = await sendWith({ main: "never", backup: { a: "A" } });
await sleep(200);
check("M4: the main host's answer never processed (a stopped worker): the row stays maybe", sentShape(m4.r) && (await m4.row())?.maybe === true);

const m5 = await sendWith({ main: { a: "A" }, backup: { a: "A", after: 50 } });
await sleep(200);
check(`M5: both healthy, the main host first: sent at its answer (${m5.ms} ms), one plain row`, sentShape(m5.r) && m5.ms < 400 && !(await m5.row())?.maybe && (await m5.rows()) === 1);

const m6 = await sendWith({ main: { a: "A" }, backup: { a: "C", after: 50 } });
await sleep(200);
check("M6: the main host accepts, the second host refuses later: the row stays sent (never marked maybe afterwards)", sentShape(m6.r) && !(await m6.row())?.maybe);

done("submit-main-late");
