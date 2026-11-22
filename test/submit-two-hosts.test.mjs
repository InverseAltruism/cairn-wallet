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
// Run: node --import tsx test/submit-two-hosts.test.mjs   (offline; about 40 s, the cap and late cases wait in real time)
// routes the second host itself
import { Wallet } from "../src/core/wallet.js";
import { memoryStore } from "../src/core/storage.js";
import { DEFAULT_RPC, BACKUP_RPC } from "../src/core/endpoints.js";
import { submitEach, MAIN_REFUSED_WAIT_MS } from "../src/core/hosts.js";
import { refusedCopy } from "../src/popup/popup-outcome.ts";
import { SENTENCES } from "../src/popup/sentences.ts";
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
  // a body whose error String() cannot read: a non-callable own toString (JSON can carry it)
  H400: () => json(400, JSON.parse('{"ok":false,"error":{"toString":1}}')),
  H502: () => json(502, JSON.parse('{"ok":false,"error":{"toString":1}}')),
  // the edge's own 502: a text/plain body, not JSON
  E502: () => ({ ok: false, status: 502, json: async () => { throw new SyntaxError("Unexpected token e in JSON"); } }),
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
check("T C+R: the refusal carries the main host's reason (CONFLICT); the node's text only in the internal log", cr.r.reason === "CONFLICT" && !/mempool conflict/.test(String(cr.r.error)) && /mempool conflict/.test(cr.r.hosts[0].text));
const rc = await sendWith({ main: "N", backup: "U" });
check("T N+U: unclear, the wallet's sentence in error", rc.r.code === "SUBMIT_MAYBE_INFLIGHT" && /may hold it/.test(rc.r.error));
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
// ── the cap on the main host's refusal (hosts.ts MAIN_REFUSED_WAIT_MS) ──
// RED-FIRST: before the cap the wait ran to the 20 s POST timeout (W4) and the result did not carry the main host's reason.
const w4 = await sendWith({ main: "R", backup: "hang" });
check(`W4: main refuses (fee), the second host hangs: unclear at the cap (${w4.ms} ms, cap ${MAIN_REFUSED_WAIT_MS}), reason FEE, a maybe row`,
  w4.r.code === "SUBMIT_MAYBE_INFLIGHT" && w4.ms >= MAIN_REFUSED_WAIT_MS - 50 && w4.ms < MAIN_REFUSED_WAIT_MS + 1_000 && w4.r.reason === "FEE" && w4.hist.length === 1 && w4.hist[0].maybe === true);
const w4t = refusedCopy(w4.r, "send");
check(`W4: the line leads with what is known and says the backup has not answered ("${w4t.text}")`,
  w4t.text === SENTENCES.MR_FEE.text && w4t.maybe === true && !/fail/i.test(w4t.text));
for (const b of ["E502", "N", "U"]) {
  const x = await sendWith({ main: "R", backup: b });
  check(`W5: main refuses, the second host ${b === "N" ? "throws" : "answers 502"}: unclear at once (${x.ms} ms), reason FEE, a maybe row`, x.r.code === "SUBMIT_MAYBE_INFLIGHT" && x.ms < 1_000 && x.r.reason === "FEE" && x.hist.length === 1 && x.hist[0].maybe === true);
}
const w6 = await sendWith({ main: "R", backup: { a: "R", after: MAIN_REFUSED_WAIT_MS - 1_500 } });
check(`W6: the second host refuses inside the cap: refused (${w6.r.code}) after ${w6.ms} ms, no row`, w6.r.code === "SUBMIT_REJECTED" && w6.hist.length === 0);
const w7 = await sendWith({ main: "R", backup: { a: "A", after: MAIN_REFUSED_WAIT_MS - 1_500 } });
check(`W7: the second host accepts inside the cap: sent (${w7.r.ok ? "ok" : w7.r.code}), a maybe row (the main host refused)`, w7.r.ok === true && w7.hist.length === 1 && w7.hist[0].maybe === true);
// the second host's answer after the cap settles the row: a refusal removes the row this send made (no host took it)
const late = async (a) => { const x = await sendWith({ main: "R", backup: { a, after: MAIN_REFUSED_WAIT_MS + 400 } }); const at = x.hist.length; await sleep(900); return { x, at, after: await x.w.history() }; };
const lr = await late("R");
check(`L3: the second host refuses after the cap: the result stays unclear, the row it made goes (${lr.at} then ${lr.after.length})`, lr.x.r.code === "SUBMIT_MAYBE_INFLIGHT" && lr.at === 1 && lr.after.length === 0);
const la = await late("A");
check("L3: the second host accepts after the cap: the row stays maybe (only the main host holding it makes it plain)", la.after.length === 1 && la.after[0].maybe === true);
const ld = await late("D");
check("L3: the second host says already present after the cap: the row stays maybe", ld.after.length === 1 && ld.after[0].maybe === true);
const lu = await late("U");
check("L3: the second host is unclear after the cap: the row stays maybe", lu.after.length === 1 && lu.after[0].maybe === true);
// a row an earlier attempt made stays: that attempt may have landed
plan = { main: "U", backup: "U" };
const wE = new Wallet(memoryStore()); await wE.create("super-secret-pw");
const e1r = await wE.send(RCPT, 1e8, 1e6);
plan = { main: "R", backup: { a: "R", after: MAIN_REFUSED_WAIT_MS + 400 } };
await wE.send(RCPT, 1e8, 1e6);
await sleep(900);
const eh = await wE.history();
check(`L3: paired: a row an earlier unclear attempt made survives the later refusal (${eh.length}, ${eh[0]?.maybe})`, e1r.code === "SUBMIT_MAYBE_INFLIGHT" && eh.length === 1 && eh[0].maybe === true);

// ── the order the reviewer found missing: the second host refuses first, the main host accepts later ──
const o1 = await sendWith({ main: { a: "A", after: 300 }, backup: "R" });
check(`O1: the second host refuses at once, the main host accepts at 300 ms: sent after ${o1.ms} ms, one plain row`, o1.r.ok === true && o1.ms >= 250 && o1.hist.length === 1 && !o1.hist[0].maybe);

// ── the second host answers first, the main host accepts later: sent, a plain row ──
for (const first of ["D", "C", "U"]) {
  const o = await sendWith({ main: { a: "A", after: 300 }, backup: first });
  check(`O2: the second host answers ${first} at once, the main host accepts at 300 ms: sent after ${o.ms} ms, one plain row`, o.r.ok === true && o.ms >= 250 && o.hist.length === 1 && !o.hist[0].maybe);
}

// ── a hostile or unreadable answer ends the send (RED-FIRST: before the fix the second host's {"error":{"toString":1}}
// left the send waiting with no row) ──
// a send that does not settle within 5 s reads as { r: {}, ms: 5000 } so the case fails instead of hanging the file
const settles = (p) => Promise.race([sendWith(p), sleep(5_000).then(() => ({ r: {}, ms: 5_000, hist: [] }))]);
for (const bad of ["H400", "H502"]) {
  const h = await settles({ main: "R", backup: bad });
  check(`X1: main refuses, the second host answers ${bad.slice(1)} with an unreadable error: ${h.r.code} after ${h.ms} ms (400: refused, no row; 502: unclear, a maybe row)`,
    h.ms < 2_000 && (bad === "H400" ? h.r.code === "SUBMIT_REJECTED" && h.hist.length === 0 : h.r.code === "SUBMIT_MAYBE_INFLIGHT" && h.hist.length === 1 && h.hist[0].maybe === true));
}
const hm = await settles({ main: "H502", backup: "R" });
check(`X1: the same from the main host: ${hm.r.code} after ${hm.ms} ms`, hm.ms < 2_000 && hm.r.code === "SUBMIT_MAYBE_INFLIGHT" && hm.hist.length === 1);
const rej = await submitEach(DEFAULT_RPC, (h) => (h === BACKUP_RPC ? Promise.reject(new Error("boom")) : Promise.resolve({ kind: "refused", reason: "FEE", text: "feerate too low" })));
check(`X2: a host whose send rejects counts as unclear: the outcome is ${rej.outcome.kind}, not a wait`, rej.outcome.kind === "unclear");
const rejA = await submitEach(DEFAULT_RPC, (h) => (h === DEFAULT_RPC ? Promise.reject(new Error("boom")) : Promise.resolve({ kind: "accepted" })));
check("X2: paired: the other host's acceptance still decides sent", rejA.outcome.kind === "sent");

// ── the edge's 502 with a text body, as both hosts answered a POST of {} on 2026-11-22 ──
const e2 = await sendWith({ main: "E502", backup: "E502" });
check(`E1: both hosts answer the edge's text 502: ${e2.r.code}, the local txid, a maybe row ("${e2.r.error}")`, e2.r.code === "SUBMIT_MAYBE_INFLIGHT" && /^0x[0-9a-f]{64}$/.test(String(e2.r.txid)) && e2.hist.length === 1 && e2.hist[0].maybe === true && e2.r.hosts.every((h) => h.text === "/tx/submit -> 502"));
const e1 = await sendWith({ main: "E502", backup: "A" });
check(`E1: the main host's text 502, the second host accepts: sent, a maybe row`, e1.r.ok === true && e1.hist.length === 1 && e1.hist[0].maybe === true);
const e1b = await sendWith({ main: "A", backup: "E502" });
check("E1: the main host accepts, the second host's text 502: sent, a plain row", e1b.r.ok === true && e1b.hist.length === 1 && !e1b.hist[0].maybe);

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
