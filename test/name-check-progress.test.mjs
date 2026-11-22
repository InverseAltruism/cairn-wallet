// WL1.3's background half: what the send review's status line reads while resolveName runs (`nameCheck`, memory only).
//   (1) the production SPV source reports its forward header sync as headers verified of those needed while it runs,
//       and nothing once it ended; the sync itself is unchanged (the same request, the same tip);
//   (2) the wallet's nameCheck gives the name service's answer once it arrived, before the check ends, and forgets it
//       when a new lookup of the name starts; a served lapse carries its flag;
//   (3) nameCheck sends nothing (no fetch);
//   (4) only the latest lookup of a name notes its answer (a late answer of an earlier one is dropped), and the answers
//       are cleared when the name service or an endpoint changes, on lock and on reset.
// RED-FIRST: on the commit before this one, the source has no syncProgress and the wallet no nameCheck: all fail.
// Run: node --import tsx test/name-check-progress.test.mjs   (offline)
import "./helpers/backup-host.mjs";
import { serveFixture, memStore, legacyOf, FIX_TOP, FIX_ANCHORS, NEWEST } from "./helpers/spvfixture.mjs";
import { liveSpvSource } from "../src/core/namespv.ts";
import { Wallet } from "../src/core/wallet.ts";
import { memoryStore } from "../src/core/storage.ts";
import { checker } from "./helpers/check.mjs";

const { check, done } = checker("=== the name check's progress read ===");
const API = "https://cairn-substrate.test";

console.log("1. the header sync's progress");
{
  const net = { tip: FIX_TOP };
  const restore = serveFixture(net);
  const src = await liveSpvSource({ rpcBase: `${API}/api/rpc`, headersBase: API, anchors: FIX_ANCHORS, store: async () => memStore(), legacy: legacyOf(new Map()) });
  const inner = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (u, i) => { if (/\/api\/headers\//.test(String(u))) seen.push(src.syncProgress()); return inner(u, i); };
  check(`(1a) before any sync: none (${JSON.stringify(src.syncProgress())})`, src.syncProgress() === null);
  net.log.length = 0;
  const p = await src.prepare(Number.MAX_SAFE_INTEGER);
  check(`(1b) while the page is fetched: 0 of ${FIX_TOP - NEWEST} (${JSON.stringify(seen)})`, seen.length === 1 && seen[0]?.done === 0 && seen[0]?.total === FIX_TOP - NEWEST);
  check(`(1c) after it: none (${JSON.stringify(src.syncProgress())})`, src.syncProgress() === null);
  check(`(1d) honest: the sync is unchanged, one page to the tip (${net.log.join()}, tip ${p.verifiedTip})`, net.log.join() === "114688/512" && p.verifiedTip === FIX_TOP);
  globalThis.fetch = inner;
  restore();
}

console.log("2. the served answer before the check ends");
{
  const ADDR = "0x" + "ab".repeat(20);
  let lapsed = false, fetches = 0;
  globalThis.fetch = async (u) => { fetches++; return String(u).includes("/cairnx/resolve/") ? Response.json({ addr: ADDR, owner: ADDR, via: "nset", ...(lapsed ? { lapsed: true } : {}) }) : new Response("{}", { status: 500 }); };
  const w = new Wallet(memoryStore());
  await w.create("pw-namecheck-12345");
  let release;
  w.verifyName = () => new Promise((r) => { release = () => r({ verified: false, reason: "held" }); });
  w.nameSpvForTest = { syncProgress: () => ({ done: 3, total: 4 }) };
  const run = w.resolveName("alice");
  await new Promise((r) => setTimeout(r, 10));
  const f0 = fetches;
  const mid = w.nameCheck("alice.csd");
  check(`(2a) while the check runs: the served address and the progress (${JSON.stringify(mid)})`, mid.served?.addr === ADDR && mid.served.lapsed === false && mid.progress?.done === 3 && mid.progress.total === 4);
  check("(3) the read sends nothing", fetches === f0);
  release();
  const r = await run;
  check(`(2b) honest: resolveName answers as before (${r.ok}, ${r.addr})`, r.ok === true && r.addr === ADDR && r.verified === false);
  lapsed = true;
  const run2 = w.resolveName("alice");
  check("(2c) a new lookup forgets the earlier answer at once", w.nameCheck("alice").served === null);
  await new Promise((r) => setTimeout(r, 10));
  check(`(2d) a served lapse carries its flag (${JSON.stringify(w.nameCheck("alice").served)})`, w.nameCheck("alice").served?.lapsed === true);
  release(); await run2;
  check("(2e) another name has nothing", w.nameCheck("bob").served === null);
}

console.log("4. lookups in order, and the answers cleared");
{
  const OLD = "0x" + "a1".repeat(20), NEW = "0x" + "b2".repeat(20);
  const held = [];
  // Each resolve answers when its turn is released; `addr` is what that lookup's answer serves.
  const queue = [];
  globalThis.fetch = (u) => {
    if (!String(u).includes("/cairnx/resolve/")) return Promise.resolve(new Response("{}", { status: 500 }));
    const next = queue.shift();
    return new Promise((res) => { held.push(() => res(Response.json({ addr: next, owner: next, via: "owner" }))); });
  };
  const w = new Wallet(memoryStore());
  await w.create("pw-namecheck-12345");
  w.verifyName = () => new Promise(() => undefined);   // the check does not end here; only the served answers are read
  const tick = () => new Promise((r) => setTimeout(r, 10));
  queue.push(OLD, NEW);
  void w.resolveName("alice"); await tick();     // lookup 1: its answer is held
  void w.resolveName("alice"); await tick();     // lookup 2 of the same name
  held[1](); await tick();
  check(`(4a) lookup 2's answer is noted (${w.nameCheck("alice").served?.addr})`, w.nameCheck("alice").served?.addr === NEW);
  held[0](); await tick();
  check(`(4b) lookup 1 answering late does not replace it (${w.nameCheck("alice").served?.addr})`, w.nameCheck("alice").served?.addr === NEW);
  const clears = [
    ["another name service (setTradeApi)", (i) => w.setTradeApi(`https://other${i}.example/trade/api`)],
    ["another API (setApi)", (i) => w.setApi(`https://api${i}.example`)],
    ["lock", () => w.lock()],
  ];
  for (const [label, act] of clears) {
    queue.push(NEW);
    void w.resolveName("alice"); await tick(); held.at(-1)(); await tick();
    const before = w.nameCheck("alice").served?.addr;
    await act(1);
    const after = w.nameCheck("alice").served;
    queue.push(OLD);
    void w.resolveName("alice"); await tick();
    const late = held.at(-1);
    await act(2);
    late(); await tick();
    check(`(4c) ${label}: the answer is cleared (${before} -> ${after}), and a lookup that began before it notes nothing (${w.nameCheck("alice").served})`, before === NEW && after === null && w.nameCheck("alice").served === null);
  }
  await w.unlock("pw-namecheck-12345");
  queue.push(NEW);
  void w.resolveName("alice"); await tick(); held.at(-1)(); await tick();
  const before = w.nameCheck("alice").served?.addr;
  await w.reset();
  check(`(4d) reset: the answer is cleared (${before} -> ${w.nameCheck("alice").served})`, before === NEW && w.nameCheck("alice").served === null);
  w.setTradeApi("");   // honest: the default again
  queue.push(NEW);
  void w.resolveName("alice"); await tick(); held.at(-1)(); await tick();
  check("(4e) honest: a lookup after the clear notes its answer as before", w.nameCheck("alice").served?.addr === NEW);
}
done("name-check-progress");
