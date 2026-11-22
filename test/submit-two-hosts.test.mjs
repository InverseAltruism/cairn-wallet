// Every send goes to both hosts of the default RPC (src/core/hosts.ts submitEach): one signing, the same bytes to each,
// and the outcome by submitverdict.ts decideSubmit. This file routes the second host itself (no helpers/backup-host.mjs).
//
// RED-FIRST against the previous commit (one host): with the main host refusing or unclear and the second host
// accepting, the send read as refused or unclear (T rows with backup A); the second host got no submit (B1).
// Rules and the mutation that undoes each (run in a copy):
//   - only an acceptance ends the wait: wait for both hosts after an acceptance and W1, W2 fail (the result waits for
//     the slow host);
//   - a refusal waits for every host: decide on the first non-accepted answer and W3 fails (main refuses, the second
//     host accepts later: the send is sent, not refused);
//   - unclear is not refused: read an unclear answer as a refusal and the R+U, C+U cells and W4 fail.
// PAIRED UNTOUCHED CASE (H1): both hosts accept: one signing, one history row, one local txid, the result at the main
// host's answer.
// The late answer of the slower host changes neither the result nor the history row (L1, L2).
//
// Run: node --import tsx test/submit-two-hosts.test.mjs   (offline; about 25 s, one case waits for the 20 s POST timeout)
// routes the second host itself
import { Wallet } from "../src/core/wallet.js";
import { memoryStore } from "../src/core/storage.js";
import { DEFAULT_RPC, BACKUP_RPC } from "../src/core/endpoints.js";
import { mkCoin, txReply } from "./_coin.js";
import { checker } from "./helpers/check.mjs";

const { check, done } = checker("=== a send to both hosts ===");
const RCPT = "0x" + "11".repeat(20);
const COIN = mkCoin(5e8);
const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const realNow = Date.now.bind(Date);

const ANSWER = {
  A: () => json(200, { ok: true }),
  D: () => json(200, { ok: false, err: "already present in mempool" }),
  C: () => json(200, { ok: false, err: "mempool conflict: a different pending transaction spends these coins" }),
  R: () => json(200, { ok: false, err: "feerate too low (0 < MIN_FEERATE_PPM=1)" }),
  U: () => json(502, { ok: false, error: "node unreachable" }),
  N: () => { throw new TypeError("fetch failed"); },
};
// submit answers per host: a letter, or { a: letter, after: ms }, or "hang" (ends at the wallet's own timeout)
let plan = { main: "A", backup: "A" };
let submits = [];
async function answer(spec, init) {
  if (spec === "hang") {
    return new Promise((_r, rej) => {
      const alive = setInterval(() => undefined, 1_000);   // AbortSignal.timeout's timer does not keep the loop alive
      init?.signal?.addEventListener("abort", () => { clearInterval(alive); rej(init.signal.reason); });
    });
  }
  const { a, after = 0 } = typeof spec === "string" ? { a: spec } : spec;
  if (after) await sleep(after);
  return ANSWER[a]();
}
globalThis.fetch = async (url, init) => {
  const u = String(url);
  const host = u.startsWith(BACKUP_RPC + "/") ? "backup" : u.startsWith(DEFAULT_RPC + "/") ? "main" : "other";
  if (u.endsWith("/tx/submit")) { submits.push({ host, body: init.body, t: realNow() }); return answer(plan[host], init); }
  if (host === "backup") throw new TypeError("reads stay on the main host in this file");
  if (u.includes("/utxos/")) return json(200, { confirmed_balance: 5e8, utxos: [COIN.coin] });
  return txReply(u, [COIN]) ?? json(404, {});
};
async function sendWith(p) {
  plan = p; submits = [];
  const w = new Wallet(memoryStore());
  await w.create("super-secret-pw");
  const t0 = realNow();
  const r = await w.send(RCPT, 1e8, 1e6);
  return { r, ms: realNow() - t0, hist: await w.history(), w, t0 };
}
const sameBytes = () => submits.length === 2 && submits[0].body === submits[1].body && new Set(submits.map((s) => s.host)).size === 2;

// ── the table: every pair of answers, both immediate ──
// Sent with a maybe row when the main host had not taken it (test/submit-main-late.test.mjs has that rule); its
// "already present" counts as taken.
const expect = (m, b) => {
  const vs = [m, b];
  if (vs.includes("A")) return m === "A" || m === "D" ? "sent" : "sentMaybe";
  if (vs.includes("U") || vs.includes("N")) return "unclear";
  if (vs.includes("D")) return "duplicate";
  return "refused";
};
const shape = {
  sent: ({ r, hist }) => r.ok === true && r.code === undefined && hist.length === 1 && !hist[0].maybe && hist[0].txid === r.txid,
  sentMaybe: ({ r, hist }) => r.ok === true && r.code === undefined && hist.length === 1 && hist[0].maybe === true && hist[0].txid === r.txid,
  duplicate: ({ r, hist }) => r.code === "SUBMIT_DUPLICATE" && /^0x[0-9a-f]{64}$/.test(String(r.txid)) && hist.length === 0,
  unclear: ({ r, hist }) => r.code === "SUBMIT_MAYBE_INFLIGHT" && /^0x[0-9a-f]{64}$/.test(String(r.txid)) && hist.length === 1 && hist[0].maybe === true,
  refused: ({ r, hist }) => r.code === "SUBMIT_REJECTED" && r.txid === undefined && hist.length === 0,
};
const L = ["A", "D", "C", "R", "U", "N"];
for (const m of L) for (const b of L) {
  const out = await sendWith({ main: m, backup: b });
  const want = expect(m, b);
  check(`T ${m}+${b}: ${want} (${out.r.ok ? "ok" : out.r.code}${out.r.reason ? " " + out.r.reason : ""}), the same bytes to both hosts`, shape[want](out) && sameBytes());
}
const cr = await sendWith({ main: "C", backup: "R" });
check("T C+R: the refusal carries the main host's reason (CONFLICT) and text", cr.r.reason === "CONFLICT" && /mempool conflict/.test(String(cr.r.error)));
const rc = await sendWith({ main: "N", backup: "U" });
check("T N+U: the unclear text is the main host's", rc.r.error === "/tx/submit -> network error");
check("B1: the second host received the submit", submits.some((s) => s.host === "backup"));

// ── timing ──
const h1 = await sendWith({ main: "A", backup: { a: "A", after: 600 } });
check(`H1: both accept: sent at the main host's answer (${h1.ms} ms, the second host answers at 600 ms), one row, one txid, one signing`,
  h1.r.ok === true && h1.ms < 400 && h1.hist.length === 1 && sameBytes());
const w1 = await sendWith({ main: "A", backup: "hang" });
check(`W1: main accepts, the second host hangs: sent at once (${w1.ms} ms), nothing waits on the second host`, w1.r.ok === true && w1.ms < 400 && w1.hist.length === 1);
const w2 = await sendWith({ main: "hang", backup: "A" });
check(`W2: the second host accepts, the main host hangs: sent at once (${w2.ms} ms), the row maybe`, w2.r.ok === true && w2.ms < 400 && w2.hist.length === 1 && w2.hist[0].maybe === true);
const w3 = await sendWith({ main: "R", backup: { a: "A", after: 500 } });
check(`W3: main refuses at once, the second host accepts at 500 ms: sent (${w3.r.ok ? "ok" : w3.r.code}) after ${w3.ms} ms, not refused`, w3.r.ok === true && w3.ms >= 450 && w3.hist.length === 1);
const w3b = await sendWith({ main: "R", backup: { a: "R", after: 500 } });
check(`W3: main refuses at once, the second host refuses at 500 ms: refused after ${w3b.ms} ms, not at the first answer`, w3b.r.code === "SUBMIT_REJECTED" && w3b.ms >= 450);
const w4 = await sendWith({ main: "R", backup: "hang" });
check(`W4: main refuses, the second host hangs: unclear at the 20 s POST timeout (${w4.ms} ms, ${w4.r.code}), with a maybe row`,
  w4.r.code === "SUBMIT_MAYBE_INFLIGHT" && w4.ms >= 19_000 && w4.hist.length === 1 && w4.hist[0].maybe === true);

// ── late answers ──
const l1 = await sendWith({ main: "A", backup: { a: "R", after: 300 } });
await sleep(500);
const l1h = await l1.w.history();
check("L1: a later refusal from the second host changes neither the result nor the row", l1.r.ok === true && l1h.length === 1 && !l1h[0].maybe);
const l2 = await sendWith({ main: "U", backup: { a: "A", after: 300 } });
await sleep(500);
const l2h = await l2.w.history();
check("L2: main unclear, the second host accepts at 300 ms: sent, one row, maybe (the main host never took it)", l2.r.ok === true && l2h.length === 1 && l2h[0].maybe === true);

done("submit-two-hosts");
