// A3 (Plans/68 F-QUEUE-1/2): the pending-content queue must not lose PAID bodies.
//
// F-QUEUE-1: node.registerContent NEVER throws: it resolves {ok:false} on any refusal/outage. The
// old flushPending only kept an entry on a THROWN error, so a mined proposal whose registration
// answered {ok:false} silently lost its content forever (the user paid the propose fee). Now a
// failed register keeps the entry for the next alarm tick (registration is idempotent).
// F-QUEUE-2: flushPending is a read-modify-write with awaits between read and write, firing from
// three triggers: an addPending landing DURING a flush was clobbered by the stale write-back. Now
// an in-flight latch collapses overlaps and the write-back re-reads + unions by txid.
//
// MUTATION CONTRACT: both cases FAIL on 0.2.56.
//
// A body the server refuses for good (HTTP 400, 413 or 422) is dropped after one attempt, its history row says the post
// was not published, and every other
// failure backs off after 15 attempts on the alarm (doubling from 2 min, at most an hour): 0.3.2 retried every entry on
// every 1-minute alarm for 7 days, 10,080 attempts of up to 2 requests each.
//   RED-FIRST: drop the lasting-refusal stop and "a 413 refusal is dropped" fails; drop the backoff and the 7-day count is
//   10,081 (one per alarm) instead of 186; stop on any 4xx again (the 0.3.3 first cut) and "a 403 keeps the entry" fails;
//   drop the history mark and "the post's history row says it was not published" fails.
//   PAIRED HONEST PATHS: a 503, a 429, a 403, a 404 and a 200 {ok:false} keep the entry; the first 15 attempts
//   run on every alarm, so a post mined within 15 minutes registers at the next alarm as before.
import "./helpers/backup-host.mjs";
import { Wallet } from "../src/core/wallet.js";
import { memoryStore } from "../src/core/storage.js";
import { mkCoin, txReply } from "./_coin.js";

let pass = 0, fail = 0;
const check = (n, c) => { c ? pass++ : (fail++, console.error("  ✗ " + n)); if (c) console.log("  ✓ " + n); };
const origFetch = globalThis.fetch;

const store = memoryStore();
const w = new Wallet(store);
await w.create("super-secret-pw");
const TX_A = "0x" + "a1".repeat(32), TX_B = "0x" + "b2".repeat(32);

function stub({ registerOk, parkProposal = false }) {
  const s = { registers: 0, proposals: 0, releaseProposal: null, proposalParked: null };
  if (parkProposal) s.proposalParked = new Promise((res) => { s.armProposal = res; });
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes("/proposal/")) {
      s.proposals++;
      if (parkProposal && s.proposals === 1) { s.armProposal(); await new Promise((res) => { s.releaseProposal = res; }); }
      return { ok: true, status: 200, json: async () => ({ payload_hash: "0x" + "ff".repeat(32) }) };
    }
    if (u.includes("/api/content")) { s.registers++; return { ok: true, status: 200, json: async () => ({ ok: registerOk }) }; }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  return s;
}

console.log("A3: F-QUEUE-1 keep-on-failure:");
{
  await store.set("pendingContent", [{ content: { v: 1, title: "paid body" }, txid: TX_A, ts: Date.now() }]);
  const s = stub({ registerOk: false });                       // mined, but registration ANSWERS {ok:false}
  await w.flushPending();
  const left = (await store.get("pendingContent")) || [];
  check("a mined entry whose registration answered {ok:false} is KEPT for retry", left.some((x) => x.txid === TX_A));
  check("…the register was actually attempted", s.registers === 1);

  const s2 = stub({ registerOk: true });                       // registration succeeds → entry drains
  await w.flushPending();
  const left2 = (await store.get("pendingContent")) || [];
  check("a successful registration still drains the entry (no stuck queue)", !left2.some((x) => x.txid === TX_A) && s2.registers === 1);
}

console.log("A3: F-QUEUE-2 concurrent addPending survives the write-back:");
{
  await store.set("pendingContent", [{ content: { v: 1, title: "first" }, txid: TX_A, ts: Date.now() }]);
  const s = stub({ registerOk: true, parkProposal: true });
  const flight = w.flushPending();                             // parks inside the /proposal fetch
  await s.proposalParked;
  await w.addPending({ v: 1, title: "second, queued mid-flush" }, TX_B);  // lands DURING the flush
  const second = w.flushPending();                             // overlap → latch returns immediately
  s.releaseProposal();
  await flight; await second;
  const left = (await store.get("pendingContent")) || [];
  check("the entry queued mid-flush SURVIVES the write-back (union by txid)", left.some((x) => x.txid === TX_B));
  check("the processed entry drained normally", !left.some((x) => x.txid === TX_A));
  check("the overlapping flush was collapsed by the latch (no second /proposal read)", s.proposals === 1);
}

console.log("a lasting refusal stops the retries; other failures back off:");
{
  const answer = { status: 200, body: { ok: false } };
  let registers = 0, proposals = 0, mined = true;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes("/proposal/")) { proposals++; return { ok: true, status: 200, json: async () => (mined ? { payload_hash: "0x" + "ff".repeat(32) } : { ok: false, err: "not found" }) }; }
    if (u.includes("/api/content")) { registers++; return { ok: answer.status < 300, status: answer.status, json: async () => answer.body }; }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const one = async (status, body) => {
    Object.assign(answer, { status, body });
    await store.set("pendingContent", [{ content: { v: 1, title: "paid body" }, txid: TX_A, ts: Date.now() }]);
    const r0 = registers;
    await w.flushPending();
    return { left: (await store.get("pendingContent")) || [], tried: registers - r0 };
  };
  const big = await one(413, { ok: false, error: "request refused" });
  check("a 413 refusal (a body over the server's cap) is dropped after one attempt", big.tried === 1 && big.left.length === 0);
  const bad = await one(400, { ok: false, error: "request refused" });
  check("a 400 refusal is dropped after one attempt", bad.tried === 1 && bad.left.length === 0);
  const un = await one(422, { ok: false, error: "unprocessable" });
  check("a 422 refusal is dropped after one attempt", un.tried === 1 && un.left.length === 0);
  for (const [status, body, what] of [[503, { ok: false, failover: true }, "a 503 (failover)"], [429, { ok: false }, "a 429 (rate limit)"], [200, { ok: false, error: "proposal not found on-chain yet" }, "a 200 {ok:false}"], [403, { ok: false, error: "challenge" }, "a 403 (an edge challenge, not Cairn's content route)"], [404, {}, "a 404 (a mistyped API address the user can fix)"]]) {
    const r = await one(status, body);
    check(`honest path: ${what} keeps the entry for the next alarm`, r.tried === 1 && r.left.length === 1 && r.left[0].fails === 1 && r.left[0].nextAt <= Date.now());
  }

  // Seven days of 1-minute alarms against a server that answers 503 every time, on a test clock.
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  try {
    Object.assign(answer, { status: 503, body: { ok: false } });
    await store.set("pendingContent", [{ content: { v: 1, title: "paid body" }, txid: TX_A, ts: now }]);
    const r0 = registers;
    const firstTimes = [];
    for (let m = 0; m <= 7 * 1440; m++) {
      const before = registers;
      await w.flushPending();
      if (registers > before && firstTimes.length < 17) firstTimes.push(m);
      now += 60_000;
    }
    const tries = registers - r0;
    check(`the 7-day queue made ${tries} attempts against a refusing server (0.3.2: one per alarm)`, tries === 186);
    check(`honest path: the first 15 attempts ran on consecutive alarms, then the wait grew (${firstTimes.join(",")})`, firstTimes.slice(0, 15).every((m, i) => m === i) && firstTimes[15] === 16 && firstTimes[16] === 20);
    await w.flushPending();
    check("past 7 days the entry has expired from the queue", ((await store.get("pendingContent")) || []).length === 0);
    // A post whose tx mines after 3 minutes registers at the alarm after that, as before.
    Object.assign(answer, { status: 200, body: { ok: true } });
    mined = false;
    await store.set("pendingContent", [{ content: { v: 1, title: "fresh post" }, txid: TX_B, ts: now }]);
    const p0 = proposals, g0 = registers;
    for (let m = 0; m < 3; m++) { await w.flushPending(); now += 60_000; }
    mined = true;
    await w.flushPending();
    check("honest path: a post mined after 3 minutes registers at the 4th alarm, with no wait", proposals - p0 === 4 && registers - g0 === 1 && ((await store.get("pendingContent")) || []).length === 0);
  } finally { Date.now = realNow; }
}

console.log("a post whose text the server refuses for good says so in its history row:");
{
  const ps = memoryStore();
  const pw = new Wallet(ps);
  const { addr } = await pw.create("super-secret-pw-2");
  const cm = mkCoin(10e8), coin = cm.coin;
  let contentStatus = 413;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.endsWith("/tip")) return { ok: true, status: 200, json: async () => ({ height: 50_000 }) };
    if (/\/utxos\//.test(u)) return { ok: true, status: 200, json: async () => ({ confirmed_balance: coin.value, utxos: [coin] }) };
    if (u.includes("/tx/submit")) return { ok: true, status: 200, json: async () => ({ ok: true }) };
    if (u.includes("/proposal/")) return { ok: true, status: 200, json: async () => ({ payload_hash: "0x" + "ff".repeat(32) }) };
    if (u.includes("/api/content")) return { ok: false, status: contentStatus, json: async () => ({ ok: false, error: "request refused" }) };
    return txReply(u, [cm]) ?? { ok: false, status: 404, json: async () => ({}) };
  };
  // cairnPost starts a flush itself; wait for it (a second flushPending returns at once while one runs).
  const drained = async () => { for (let i = 0; i < 200; i++) { await new Promise((res) => setTimeout(res, 0)); await pw.flushPending(); } };
  const r = await pw.cairnPost({ domain: "board:v1", title: "too long", body: "x", fee: 25_000_000 });
  await drained();
  const row = ((await ps.get("txHistory:" + addr)) || []).find((x) => x.txid === r.txid);
  check(`the post's history row says it was not published, with the server's status (${JSON.stringify(row?.bodyRefused)})`, r.txid !== undefined && row?.type === "post" && row.bodyRefused === 413 && ((await ps.get("pendingContent")) || []).length === 0);
  contentStatus = 503;
  const r2 = await pw.cairnPost({ domain: "board:v1", title: "fine later", body: "y", fee: 25_000_000 });
  await drained();
  const row2 = ((await ps.get("txHistory:" + addr)) || []).find((x) => x.txid === r2.txid);
  check("honest path: a post the server cannot take yet (503) keeps its row unmarked and its body queued", row2?.type === "post" && row2.bodyRefused === undefined && ((await ps.get("pendingContent")) || []).some((x) => x.txid === r2.txid));
}

globalThis.fetch = origFetch;
console.log(`\nflushpending: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
