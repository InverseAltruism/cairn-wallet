// Invariant 7 at the chunk acquirer (src/core/headerstore.ts chunkAcquirer): a read in flight across an adoption never
// serves or caches the replaced chain, and never deletes the adopted chain's chunk. A sealed chunk's spec comes from
// the source's remembered tops, which an adoption replaces; the serializer is the source's, held here by a test op so
// a read is queued behind an "adoption" (the spec switched from branch A to branch B). Stand-in walk: a chunk is valid
// for a spec when its first byte is the branch the spec names. Run: npx tsx test/headerstore-adoption.test.mjs
import { checker } from "./helpers/check.mjs";
import { ChunkLru, chunkAcquirer } from "../src/core/headerstore.ts";
import { makeSerializer } from "../src/core/namespv.ts";

const t = checker("chunk acquirer across an adoption (invariant 7)");
const K = 32, H = K * 4096 + 7;
const A = 0xa, B = 0xb;
const bytes = (branch) => new Uint8Array([branch, 1, 2, 3]);
const specFor = (branch) => ({ k: K, firstHeight: K * 4096, lastHeight: K * 4096 + 4095, prevHash: "0x" + "00".repeat(32), lastHash: "0x" + branch.toString(16).repeat(64) });
const verify = (rec, spec) => { if (rec[0] !== Number.parseInt(spec.lastHash.slice(-1), 16)) throw new Error("walk does not reach the seal's top"); };

function rig(stored) {
  const chunks = new Map(stored === null ? [] : [[K, bytes(stored)]]);
  const writes = [];
  const store = {
    async listChunks() { return [...chunks.keys()]; },
    async getChunk(k) { return chunks.get(k) ?? null; },
    async getHead() { return null; }, async getSeals() { return null; },
    async write(w) { writes.push(w); for (const k of w.del ?? []) chunks.delete(k); for (const p of w.put ?? []) chunks.set(p.k, p.records); },
    close() { /* nothing to release in memory */ },
  };
  let branch = A;
  const fetched = [];
  const serialize = makeSerializer();
  const lru = new ChunkLru(8);
  const acq = chunkAcquirer({ store, lru, anchors: ["0x" + "11".repeat(32)], serialize, verify, sealedSpec: (k) => (k === K ? specFor(branch) : null),
    fetchChunk: async () => { fetched.push(branch); return bytes(branch); } });
  let release;
  // Resolves once the holding op runs, so a read issued after it queues behind it.
  const hold = () => new Promise((held) => { void serialize(() => new Promise((r) => { release = r; held(); })); });
  return { chunks, writes, fetched, acq, lru, hold, adopt: () => { branch = B; }, release: () => release() };
}
const settle = async (p) => { try { return { records: (await p).records }; } catch (e) { return { error: String(e?.message ?? e) }; } };

{
  // The adoption's write has not landed: the store still holds branch A's chunk when the queued read runs.
  const r = rig(A);
  await r.hold();
  const inFlight = settle(r.acq.acquire(H));
  r.adopt();
  r.release();
  const first = await inFlight;
  const later = await settle(r.acq.acquire(H));
  await r.acq.writes();
  t.check(`stored A, read queued across the adoption: it answers branch B (${first.records?.[0]?.toString(16) ?? first.error}) and so does the next read (${later.records?.[0]?.toString(16) ?? later.error})`,
    first.records?.[0] === B && later.records?.[0] === B);
  t.check("  the replaced chunk is not cached: the LRU holds branch B", r.lru.get(K)?.[0] === B);
}
{
  // The adoption's write has landed: the store holds branch B's chunk when the queued read runs.
  const r = rig(B);
  await r.hold();
  const inFlight = settle(r.acq.acquire(H));
  r.adopt();
  r.release();
  const first = await inFlight;
  await r.acq.writes();
  t.check(`stored B, read queued across the adoption: it answers branch B from the store (${first.records?.[0]?.toString(16) ?? first.error}), no fetch (${r.fetched.length})`, first.records?.[0] === B && r.fetched.length === 0);
  t.check(`  the adopted chunk is not deleted (writes: ${JSON.stringify(r.writes.map((w) => Object.keys(w)))})`, r.chunks.get(K)?.[0] === B && r.writes.every((w) => !w.del?.length));
}
{
  // Branch A's chunk was cached before the adoption, under A's spec: a read after it is checked against B's spec.
  const r = rig(A);
  const before = await settle(r.acq.acquire(H));
  r.adopt();
  const after = await settle(r.acq.acquire(H));
  t.check(`a chunk cached under the replaced spec is not served after the adoption (before ${before.records?.[0]?.toString(16)}, after ${after.records?.[0]?.toString(16) ?? after.error})`, before.records?.[0] === A && after.records?.[0] === B);
}
{
  // Honest path: no adoption, a cached chunk is served from the LRU with no second read or fetch.
  const r = rig(A);
  await settle(r.acq.acquire(H));
  const again = await settle(r.acq.acquire(H));
  t.check("without an adoption a cached chunk is served from the LRU (no fetch)", again.records?.[0] === A && r.fetched.length === 0);
}
t.done("headerstore-adoption");
