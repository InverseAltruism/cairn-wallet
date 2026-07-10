// A3 (Plans/68 F-QUEUE-1/2): the pending-content queue must not lose PAID bodies.
//
// F-QUEUE-1: node.registerContent NEVER throws — it resolves {ok:false} on any refusal/outage. The
// old flushPending only kept an entry on a THROWN error, so a mined proposal whose registration
// answered {ok:false} silently lost its content forever (the user paid the propose fee). Now a
// failed register keeps the entry for the next alarm tick (registration is idempotent).
// F-QUEUE-2: flushPending is a read-modify-write with awaits between read and write, firing from
// three triggers — an addPending landing DURING a flush was clobbered by the stale write-back. Now
// an in-flight latch collapses overlaps and the write-back re-reads + unions by txid.
//
// MUTATION CONTRACT: both cases FAIL on 0.2.56.
import { Wallet } from "../src/core/wallet.js";
import { memoryStore } from "../src/core/storage.js";

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

console.log("A3 — F-QUEUE-1 keep-on-failure:");
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

console.log("A3 — F-QUEUE-2 concurrent addPending survives the write-back:");
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

globalThis.fetch = origFetch;
console.log(`\nflushpending: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
