// src/core/headerstore.ts, offline: the LRU, per-height chunk acquisition (lazy, single-flight, verify before use,
// a failing stored chunk deleted and fetched once, a failing fetched chunk refused) and the no-IndexedDB path.
// The IndexedDB behaviour itself is tested in real Chrome: test/headerstore-chrome.test.mjs.
import { checker } from "./helpers/check.mjs";
import { ChunkLru, chunkAcquirer, chunkSpec, openHeaderStore } from "../src/core/headerstore.ts";
import { makeSerializer } from "../src/core/namespv.ts";
import { SPV_ANCHORS } from "../src/core/spvanchors.ts";

const t = checker("headerstore: LRU and lazy chunk acquisition");

{
  const lru = new ChunkLru(8);
  for (let k = 7; k < 15; k++) lru.set(k, new Uint8Array([k]));
  lru.get(7);
  lru.set(15, new Uint8Array([15]));
  t.check("LRU holds 8 and evicts the least recently used (8, not the re-read 7)", lru.size === 8 && lru.get(8) === undefined && lru.get(7)?.[0] === 7 && lru.get(15)?.[0] === 15);
  lru.set(9, new Uint8Array([99]));
  t.check("LRU set on a present key replaces it without growing", lru.size === 8 && lru.get(9)?.[0] === 99);
}

// A stand-in for the record walk: a "chunk" is valid when its first byte is its chunk index.
const good = (k) => new Uint8Array([k, 1, 2, 3]);
const verify = (rec, spec) => { if (rec[0] !== spec.k) throw new Error(`walk does not reach ${spec.lastHash.slice(0, 10)}`); };
function memStore(init = {}, { failWrite = false, failRead = false } = {}) {
  const m = new Map(Object.entries(init).map(([k, v]) => [Number(k), v]));
  const writes = [];
  const st = {
    m, writes, reads: 0,
    async listChunks() { return [...m.keys()].sort((a, b) => a - b); },
    async getChunk(k) { st.reads++; if (failRead) throw new Error("read failed"); return m.get(k) ?? null; },
    async getHead() { return null; },
    async write(w) {
      writes.push(w);
      if (failWrite) throw new Error("QuotaExceededError");
      for (const k of w.del ?? []) m.delete(k);
      for (const p of w.put ?? []) m.set(p.k, p.records);
    },
    close() {},
  };
  return st;
}
function rig(store, fetchImpl = async (spec) => good(spec.k)) {
  const fetched = [];
  const acq = chunkAcquirer({ store, lru: new ChunkLru(8), serialize: makeSerializer(), verify, fetchChunk: async (spec) => { fetched.push(spec.k); return fetchImpl(spec); } });
  return { acq, fetched };
}
const rejects = async (p) => { try { await p; return null; } catch (e) { return e; } };

{
  const s = memStore();
  const { acq, fetched } = rig(s);
  const [a, b] = await Promise.all([acq.acquire(40000), acq.acquire(40001)]);
  await acq.writes();
  t.check("two concurrent proofs in one chunk fetch it once and read the store once", fetched.length === 1 && fetched[0] === 9 && s.reads === 1 && a.records === b.records);
  t.check("the fetched chunk is stored after it verifies", s.m.get(9)?.[0] === 9 && s.writes.length === 1);
  await acq.acquire(40002);
  t.check("a later proof in that chunk is served from the LRU", fetched.length === 1);
  const spec = (await acq.acquire(32767)).spec;
  t.check("height 32767 maps to chunk 7 with the floor pin as its first hash", spec.k === 7 && spec.firstHeight === 29960 && spec.lastHash === SPV_ANCHORS[0] && spec.firstHash !== undefined);
  const s8 = (await acq.acquire(32768)).spec;
  t.check("height 32768 maps to chunk 8 linked to entry 0", s8.k === 8 && s8.firstHeight === 32768 && s8.prevHash === SPV_ANCHORS[0] && s8.lastHash === SPV_ANCHORS[1]);
}
{
  const s = memStore({ 10: good(10) });
  const { acq, fetched } = rig(s);
  await acq.acquire(10 * 4096 + 5);
  t.check("a stored chunk that verifies is used without a fetch", fetched.length === 0);
}
{
  const s = memStore({ 10: good(11) });
  const { acq, fetched } = rig(s);
  const r = await acq.acquire(10 * 4096 + 5);
  await acq.writes();
  t.check("a stored chunk that fails is fetched once and replaced", fetched.length === 1 && r.records[0] === 10 && s.m.get(10)?.[0] === 10);
  t.check("the failing stored chunk is deleted before the replacement is put", s.writes[0]?.del?.[0] === 10 && s.writes[1]?.put?.[0]?.k === 10);
}
{
  const s = memStore();
  const { acq, fetched } = rig(s, async (spec) => good(spec.k + 1));
  const e = await rejects(acq.acquire(50000));
  await acq.writes();
  t.check(`a fetched chunk that fails is refused naming the chunk (${e?.message})`, /^chunk 12 \(heights 49152 to 53247\) failed verification/.test(e?.message ?? ""));
  t.check("the refused chunk is neither stored nor cached", s.m.size === 0 && s.writes.length === 0 && fetched.length === 1);
  const again = await rejects(acq.acquire(50000));
  t.check("a refused chunk is fetched again on the next proof, not remembered as good", !!again && fetched.length === 2);
}
{
  const { acq, fetched } = rig(memStore());
  const below = await rejects(acq.acquire(29959));
  const top = 7 * 4096 + SPV_ANCHORS.length * 4096 - 1;
  const above = await rejects(acq.acquire(top + 1));
  await acq.acquire(top);
  t.check("a height below 29,960 or above the newest anchor is refused without a request", !!below && !!above && fetched.length === 1);
}
{
  const { acq } = rig(null);
  t.check("no store (IndexedDB unavailable): acquisition still serves the verified chunk", (await acq.acquire(36000)).records[0] === 8);
  const w = memStore({}, { failWrite: true });
  const r = rig(w);
  const got = await r.acq.acquire(36000);
  await r.acq.writes();
  t.check("a store write that fails does not fail the proof", got.records[0] === 8 && w.writes.length === 1);
  const rf = rig(memStore({ 8: good(8) }, { failRead: true }));
  t.check("a store read that fails falls back to a fetch", (await rf.acq.acquire(36000)).records[0] === 8 && rf.fetched.length === 1);
}
{
  const spec = chunkSpec(7 + SPV_ANCHORS.length - 1);
  t.check("chunkSpec of the newest anchored chunk links entry n-2 to entry n-1", spec?.prevHash === SPV_ANCHORS[SPV_ANCHORS.length - 2] && spec?.lastHash === SPV_ANCHORS[SPV_ANCHORS.length - 1]);
  t.check("chunkSpec is null below chunk 7 and above the table", chunkSpec(6) === null && chunkSpec(7 + SPV_ANCHORS.length) === null);
  t.check("openHeaderStore without IndexedDB returns null (no cache this session)", (await openHeaderStore(undefined)) === null);
}

t.done("headerstore");
