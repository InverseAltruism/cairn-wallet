// src/core/spvseal.ts and the seal half of mergeStoreWrites: the key and MAC against vectors computed with node:crypto
// from the byte layout (not from the module), a list check that ignores a wrong MAC over forged bytes and a list
// spliced from two genuine branches, a property run over tampered lists, and the merge of detached writes.
import { createHash, createHmac } from "node:crypto";
import { checker } from "./helpers/check.mjs";
import { checkSeals, sealKeyGetter, sealMessage, sealRecord } from "../src/core/spvseal.ts";
import { importKeyRaw } from "../src/core/keystore.ts";
import { detachStoreWrite, flushSpvStoreWrites, mergeStoreWrites } from "../src/core/namespv.ts";

const t = checker("spvseal: key, message, MAC, list check, merge");

// Vectors: computed with node:crypto from the layout in the design (tag, 0x00, u32be k, prevTop, top, u128be work,
// u32be newest, newestHash) and pinned as hex.
const rawHex = Buffer.from([...Array(32).keys()]).toString("hex");
const K_HEX = "a1be5de67fa9e1c2fe1bac00cfd9e5118a06b89f3fce655d2b6f601dbc8fbc81";
const NH = "0x" + "aa".repeat(32), T1 = "0x" + "11".repeat(32), T2 = "0x" + "22".repeat(32);
const W1 = (1n << 100n) + 12345n, W2 = (1n << 128n) - 1n;
const TABLE = { newest: 143359, newestHash: NH };
const nodeMsg = (k, prev, top, work, newest, nh) => Buffer.concat([
  Buffer.from("cairn-wallet/spv-seal/v1", "utf8"), Buffer.from([0]), u32(k), Buffer.from(prev.slice(2), "hex"),
  Buffer.from(top.slice(2), "hex"), Buffer.from(work.toString(16).padStart(32, "0"), "hex"), u32(newest), Buffer.from(nh.slice(2), "hex"),
]);
function u32(n) { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; }

const vk = await importKeyRaw(rawHex);
const K = await sealKeyGetter(() => vk)();
{
  const viaNode = createHmac("sha256", Buffer.from(rawHex, "hex")).update("cairn-wallet/spv-seal-key/v1").digest("hex");
  t.check("the seal key is HMAC-SHA256(raw vault key, the label): equals node:crypto and the pinned vector", Buffer.from(K).toString("hex") === viaNode && viaNode === K_HEX);
  const m = sealMessage(35, NH, T1, W1, TABLE);
  t.check("the message is 145 bytes in the design's layout (equal to the node:crypto build)", m.length === 145 && Buffer.from(m).equals(nodeMsg(35, NH, T1, W1, 143359, NH)));
  const rec = sealRecord(K, TABLE, [{ k: 35, top: T1, work: W1 }, { k: 36, top: T2, work: W2 }]);
  const mac35 = createHmac("sha256", Buffer.from(K_HEX, "hex")).update(nodeMsg(35, NH, T1, W1, 143359, NH)).digest("hex");
  const mac36 = createHmac("sha256", Buffer.from(K_HEX, "hex")).update(nodeMsg(36, T1, T2, W2, 143359, NH)).digest("hex");
  t.check("MAC vectors: the first entry's prevTop is the table hash, the second's is the first entry's top; work 2^128-1 encodes",
    rec.list[0]?.mac === mac35 && mac35 === "98f05ef7119dfbe544c0969472d2c3fd6414097af3487c3d78d9748fd96819a3"
    && rec.list[1]?.mac === mac36 && mac36 === "59194f904ceae3e2f9a51c37c7fa7ee7a2b7eb172b03f2934aba70b90b9605c0");
  t.check("the stored entry form: decimal work, 0x top, k from chunkOf(newest) + 1", rec.v === 1 && rec.newest === 143359 && rec.list[0].k === 35 && rec.list[0].work === W1.toString() && rec.list[1].top === T2);
  let threw = 0;
  for (const f of [() => sealMessage(35, NH, T1, W2 + 1n, TABLE), () => sealMessage(35, NH, T1, -1n, TABLE), () => sealMessage(35, NH, "0x" + "AB".repeat(32), W1, TABLE),
    () => sealRecord(K, TABLE, [{ k: 36, top: T1, work: W1 }]), () => sealRecord(K, TABLE, [{ k: 35, top: T1, work: W1 }, { k: 37, top: T2, work: W2 }])]) {
    try { f(); } catch { threw++; }
  }
  t.check("work outside u128, an uppercase hash and a list not contiguous from newestK + 1 throw when sealing", threw === 5);
  // A u32 field that wrapped would give two heights one message, so one MAC would seal both.
  let wraps = 0;
  for (const f of [() => sealMessage(2 ** 32 + 35, NH, T1, W1, TABLE), () => sealMessage(-1, NH, T1, W1, TABLE), () => sealMessage(35.5, NH, T1, W1, TABLE),
    () => sealMessage(35, NH, T1, W1, { newest: 2 ** 32 + 143359, newestHash: NH })]) {
    try { f(); } catch { wraps++; }
  }
  t.check("k or newest outside u32 (or not an integer) throws instead of wrapping onto another height's message", wraps === 4);
}

{
  // One getter over a vault key that changes, as Wallet's does: vault A, vault B, a lock, A again.
  const vkB = await importKeyRaw("ff".repeat(32));
  const hex = (k) => (k ? Buffer.from(k).toString("hex") : null);
  let cur = null;
  const get = sealKeyGetter(() => cur);
  t.check("locked (no vault key): the getter gives no key", (await get()) === null);
  cur = vk;
  const kA = hex(await get());
  cur = vkB;
  const kB = hex(await get());
  cur = null;
  const kLocked = await get();
  cur = vk;
  const kA2 = hex(await get());
  t.check("vault A, then vault B, then a lock, then A again: A's key, B's own key, none, A's key", kA === K_HEX && kB !== null && kB !== K_HEX && kLocked === null && kA2 === K_HEX);
  const rec = sealRecord(K, TABLE, [{ k: 35, top: T1, work: W1 }]);
  t.check("under vault B's key (a new vault) vault A's list is ignored", checkSeals(Buffer.from(kB, "hex"), rec, TABLE) === null);
  cur = vk;
  const toNull = get();
  cur = null;
  t.check("a lock during the derivation gives no key", (await toNull) === null);
  cur = vk;
  const toB = get();
  cur = vkB;
  t.check("a change to another vault key during the derivation gives no key (not A's, not B's)", (await toB) === null);
  t.check("after that change the getter gives B's key", hex(await get()) === kB);
}

// Seeded generator for branches and tampering.
let seed = 0x5eed1;
const rnd = () => { seed = (seed + 0x6d2b79f5) >>> 0; let x = seed; x = Math.imul(x ^ (x >>> 15), x | 1); x ^= x + Math.imul(x ^ (x >>> 7), x | 61); return ((x ^ (x >>> 14)) >>> 0) / 4294967296; };
const ri = (n) => Math.floor(rnd() * n);
const hash = () => "0x" + Array.from({ length: 32 }, () => ri(256).toString(16).padStart(2, "0")).join("");
const branch = (base, n) => {
  const out = base.map((c) => ({ ...c }));
  let w = out.length ? out[out.length - 1].work : 10n ** 20n;
  for (let k = 35 + out.length; out.length < n; k++) { w += BigInt(1 + ri(1e9)) * 4096n; out.push({ k, top: hash(), work: w }); }
  return out;
};
const A = branch([], 12);
const FORK = 5;                                        // A and B share chunks 35..39
const B = branch(A.slice(0, FORK), 12);
const recA = sealRecord(K, TABLE, A), recB = sealRecord(K, TABLE, B);
const same = (got, want) => got !== null && got.length === want.length && got.every((c, i) => c.k === want[i].k && c.top === want[i].top && c.work === want[i].work);

t.check("honest path: a list read back by structured clone (the IndexedDB value) verifies to its chunks", same(checkSeals(K, structuredClone(recA), TABLE), A) && same(checkSeals(K, structuredClone(recB), TABLE), B));
t.check("an empty list verifies to no sealed chunk", same(checkSeals(K, { v: 1, newest: TABLE.newest, list: [] }, TABLE), []));

{
  const forged = structuredClone(recA);
  const k2 = await importKeyRaw("01".repeat(32));
  const attackerKey = await sealKeyGetter(() => k2)();
  const top = hash();
  const prev = forged.list[2].top;
  forged.list[3] = { k: 38, top, work: forged.list[3].work, mac: createHmac("sha256", Buffer.from(attackerKey)).update(nodeMsg(38, prev, top, BigInt(forged.list[3].work), TABLE.newest, NH)).digest("hex") };
  t.check("a list with a wrong MAC over forged bytes is ignored (invariant 2)", checkSeals(K, forged, TABLE) === null);
  const kept = structuredClone(recA);
  kept.list[3].top = top;
  t.check("forged bytes under the genuine MAC are ignored", checkSeals(K, kept, TABLE) === null);
  const work = structuredClone(recA);
  work.list[7].work = (BigInt(work.list[7].work) + 1n).toString();
  t.check("a raised work under the genuine MAC is ignored", checkSeals(K, work, TABLE) === null);
  // The compare covers all 64 hex characters of every entry's MAC.
  let flips = 0, taken = 0;
  for (let e = 0; e < recA.list.length; e++) for (let p = 0; p < 64; p++) {
    const r = structuredClone(recA);
    const m = r.list[e].mac;
    r.list[e].mac = m.slice(0, p) + (m[p] === "0" ? "1" : "0") + m.slice(p + 1);
    flips++;
    if (checkSeals(K, r, TABLE) !== null) taken++;
  }
  t.check(`each of ${flips} one-character MAC changes over genuine bytes is ignored (${taken} taken)`, flips === recA.list.length * 64 && taken === 0);
  const upper = structuredClone(recA);
  upper.list[0].mac = upper.list[0].mac.toUpperCase();
  t.check("the genuine MAC in upper case is ignored (the compare is exact)", checkSeals(K, upper, TABLE) === null);
}

{
  // An entry whose fields are read through getters (a value that did not come from IndexedDB): each field is read
  // once, so the top returned is the top the MAC covered.
  let reads = 0;
  const e = { k: recA.list[0].k, work: recA.list[0].work, mac: recA.list[0].mac };
  Object.defineProperty(e, "top", { enumerable: true, get() { reads++; return reads === 1 ? recA.list[0].top : "0x" + "ee".repeat(32); } });
  const out = checkSeals(K, { v: 1, newest: TABLE.newest, list: [e] }, TABLE);
  t.check(`a top read through a getter is read once and the returned top is the one the MAC covered (${reads} reads)`, reads === 1 && out?.[0]?.top === recA.list[0].top);
}

{
  const spliced = { v: 1, newest: TABLE.newest, list: [...recA.list.slice(0, 8), ...recB.list.slice(8)] };
  t.check("both branches' lists verify on their own", checkSeals(K, recA, TABLE) !== null && checkSeals(K, recB, TABLE) !== null);
  t.check("a list spliced from two genuine branches above their fork is ignored (the previous top is in the MAC)", checkSeals(K, spliced, TABLE) === null);
  const atFork = { v: 1, newest: TABLE.newest, list: [...recA.list.slice(0, FORK), ...recB.list.slice(FORK)] };
  t.check("joined at the fork, where the branches are one chain, it is branch B's own list", same(checkSeals(K, atFork, TABLE), B));
}

{
  const NEXT = { newest: 147455, newestHash: "0x" + "ab".repeat(32) };
  const recNext = sealRecord(K, NEXT, [{ k: 36, top: T1, work: W1 }]);
  t.check("a list sealed for another table entry (a newer release) is ignored, and verifies against its own", checkSeals(K, recNext, TABLE) === null && checkSeals(K, recNext, NEXT)?.length === 1);
  t.check("an empty list stored for another table entry is ignored (no MAC binds it, the record's newest does)", checkSeals(K, { v: 1, newest: NEXT.newest, list: [] }, TABLE) === null);
}
t.check("a list for another table hash at the same height is ignored", checkSeals(K, recA, { newest: TABLE.newest, newestHash: "0x" + "ab".repeat(32) }) === null);

{
  const bad = [null, "seals", 7, { v: 2, newest: TABLE.newest, list: recA.list }, { v: 1, newest: TABLE.newest, list: "x" },
    { v: 1, newest: TABLE.newest, list: recA.list.slice(1) },
    { v: 1, newest: TABLE.newest, list: [recA.list[0], recA.list[2]] },
    { v: 1, newest: TABLE.newest, list: [null] },
    { v: 1, newest: TABLE.newest, list: [{ ...recA.list[0], top: recA.list[0].top.toUpperCase().replace("0X", "0x") }] },
    { v: 1, newest: TABLE.newest, list: [{ ...recA.list[0], work: "0" + recA.list[0].work }] },
    { v: 1, newest: TABLE.newest, list: [{ ...recA.list[0], work: (1n << 128n).toString() }] },
    { v: 1, newest: TABLE.newest, list: [{ ...recA.list[0], mac: recA.list[0].mac.slice(2) }] },
    { v: 1, newest: TABLE.newest, list: [{ ...recA.list[0], k: "35" }] },
    { v: 1, newest: TABLE.newest, list: [{ ...recA.list[0], mac: Number.NaN }] },
    { v: 1, newest: TABLE.newest },
    { v: 1, newest: TABLE.newest, list: null },
    { v: 1, newest: TABLE.newest, list: new Array(1e6).fill(recA.list[0]) }];
  let threw = false, nulls = 0;
  for (const raw of bad) { try { if (checkSeals(K, raw, TABLE) === null) nulls++; } catch { threw = true; } }
  t.check(`malformed stored values are ignored without a throw (${nulls} of ${bad.length})`, !threw && nulls === bad.length);
}

// Property: whatever is done to genuine lists (bytes flipped, entries dropped, swapped, renumbered, moved between
// branches, spliced, cut), the check gives null or a prefix of one genuine branch.
{
  const prefixOf = (got, br) => got !== null && got.length <= br.length && same(got, br.slice(0, got.length));
  const flip = (s) => { const i = 2 + ri(s.length - 2); const c = s[i] === "0" ? "1" : "0"; return s.slice(0, i) + c + s.slice(i + 1); };
  const ops = [
    (l) => { const e = l[ri(l.length)]; e.top = flip(e.top); },
    (l) => { const e = l[ri(l.length)]; e.mac = flip("0x" + e.mac).slice(2); },
    (l) => { const e = l[ri(l.length)]; e.work = (BigInt(e.work) + BigInt(1 + ri(3))).toString(); },
    (l) => { if (l.length > 1) l.splice(ri(l.length - 1), 1); },
    (l) => { if (l.length > 1) { const i = ri(l.length - 1); [l[i], l[i + 1]] = [l[i + 1], l[i]]; } },
    (l) => { const e = l[ri(l.length)]; e.k += 1; },
    (l) => { const i = ri(l.length); l[i] = { ...((rnd() < 0.5 ? recA : recB).list[i] ?? l[i]) }; },
    (l) => { const j = ri(l.length); const other = rnd() < 0.5 ? recA : recB; l.splice(j, l.length - j, ...structuredClone(other.list.slice(j))); },
    (l) => { l.length = ri(l.length + 1); },
  ];
  let runs = 0, accepted = 0, rejected = 0, violations = 0;
  for (let n = 0; n < 3000; n++) {
    const base = structuredClone(rnd() < 0.5 ? recA : recB);
    const steps = 1 + ri(3);
    for (let s = 0; s < steps && base.list.length; s++) ops[ri(ops.length)](base.list);
    const got = checkSeals(K, base, TABLE);
    runs++;
    if (got === null) rejected++;
    else if (prefixOf(got, A) || prefixOf(got, B)) accepted++;
    else violations++;
  }
  t.check(`property: ${runs} tampered lists give null or a prefix of a genuine branch (${accepted} prefixes, ${rejected} ignored, ${violations} other)`, violations === 0 && accepted > 0 && rejected > 0);
}

// The merge of detached suffix writes.
{
  const head = (tip) => ({ v: 2, tip, tipHash: "0x" + "cd".repeat(32) });
  const pre = (rec, n) => ({ ...rec, list: rec.list.slice(0, n) });
  const m1 = mergeStoreWrites({ put: [], seals: pre(recA, 6) }, { put: [], seals: pre(recB, 4) });
  t.check("merge: the newer write's seal list wins whole", m1.seals?.list.length === 4 && same(checkSeals(K, m1.seals, TABLE), B.slice(0, 4)));
  const m2 = mergeStoreWrites({ put: [], seals: pre(recA, 6) }, { put: [], head: head(170000) });
  t.check("merge: a newer write without a list keeps the older list", same(checkSeals(K, m2.seals, TABLE), A.slice(0, 6)));
  const m3 = mergeStoreWrites({ put: [], seals: pre(recA, 10) }, { put: [], deleteAbove: 40 });
  t.check("merge: older seal entries above the newer deleteAbove are dropped, and the cut list still verifies", m3.seals?.list.every((e) => e.k <= 40) && same(checkSeals(K, m3.seals, TABLE), A.slice(0, 6)));
  const m4 = mergeStoreWrites({ put: [{ k: 41, records: new Uint8Array(1) }] }, { put: [{ k: 40, records: new Uint8Array(2) }], deleteAbove: 40 });
  t.check("merge: no list in either write gives none, and the puts merge as before", !("seals" in m4) && m4.put.map((p) => p.k).join() === "40" && m4.deleteAbove === 40);
  t.check("merge: the older list is not changed in place", recA.list.length === 12);

  // A store model that applies a write as headerstore.write does: deleteAbove, then puts, then the seal record. A
  // chunk's bytes name the branch that made it; a seal entry is made for the bytes of its branch at k.
  const forkOf = [0, 40, 44];                                   // branch 1 forks from 0 at chunk 40, branch 2 at 44
  const owner = (b, k) => (b === 0 || k < forkOf[b] ? (b === 0 ? 0 : owner(0, k)) : b);
  const bytesOf = (b, k) => new Uint8Array([owner(b, k), k]);
  const topOf = (bytes) => "0x" + createHash("sha256").update(bytes).digest("hex");
  const sealsFor = (b, ks) => sealRecord(K, TABLE, ks.map((k) => ({ k, top: topOf(bytesOf(b, k)), work: 1000n * BigInt(k) + BigInt(owner(b, k)) })));
  const apply = (st, w) => {
    const chunks = new Map(st.chunks);
    if (w.deleteAbove !== undefined) for (const k of [...chunks.keys()]) if (k > w.deleteAbove) chunks.delete(k);
    for (const p of w.put ?? []) chunks.set(p.k, p.records);
    return { chunks, seals: w.seals ?? st.seals };
  };
  // The entries of `seals` that sit over a missing chunk or over bytes other than the ones they were made for.
  const stale = (chunks, seals) => (seals?.list ?? []).filter((e) => !chunks.has(e.k) || topOf(chunks.get(e.k)) !== e.top).map((e) => e.k);
  const range = (a, b) => Array.from({ length: Math.max(0, b - a + 1) }, (_, i) => a + i);

  // The review's two cases, by name.
  {
    const older = { put: range(35, 40).map((k) => ({ k, records: bytesOf(0, k) })), deleteAbove: 42, seals: sealsFor(0, range(35, 40)) };
    const reorg = { put: range(40, 43).map((k) => ({ k, records: bytesOf(1, k) })), deleteAbove: 43 };
    const mA = mergeStoreWrites(older, reorg);
    const after = apply({ chunks: new Map(), seals: null }, mA);
    t.check(`merge, newer write without a list replaces sealed chunks: the older list is cut below them (stale ${stale(after.chunks, mA.seals).join() || "none"}, list to ${mA.seals?.list.at(-1)?.k})`,
      stale(after.chunks, mA.seals).length === 0 && mA.seals?.list.at(-1)?.k === 39 && checkSeals(K, mA.seals, TABLE)?.length === 5);
    const trunc = { put: [{ k: 38, records: new Uint8Array([9, 38]) }], deleteAbove: 38 };
    const mT = mergeStoreWrites(older, trunc);
    t.check("merge, newer write truncating into the sealed run: the older list is cut below the rewritten chunk", stale(apply({ chunks: new Map(), seals: null }, mT).chunks, mT.seals).length === 0 && mT.seals?.list.at(-1)?.k === 37);
    const cut = { put: [{ k: 36, records: bytesOf(0, 36) }], deleteAbove: 36 };
    const catchUp = { seals: sealsFor(0, range(35, 38)) };
    const mB = mergeStoreWrites(cut, catchUp);
    const afterB = apply({ chunks: new Map(range(35, 38).map((k) => [k, bytesOf(0, k)])), seals: null }, mB);
    t.check(`merge, newer list over chunks the older write deletes: the merged list names no deleted chunk (stale ${stale(afterB.chunks, mB.seals).join() || "none"})`,
      stale(afterB.chunks, mB.seals).length === 0 && mB.seals?.list.at(-1)?.k === 36);
  }

  // Property: for pairs and runs of writes made as a writer makes them (each list seals only chunks that hold its
  // branch's bytes once that write lands), the merged write leaves the chunks the writes leave in order, and its list
  // sits over no missing chunk and no other bytes.
  let differ = 0, staleMerged = 0, staleSeq = 0, runs = 0;
  let seqExample = null;
  for (let n = 0; n < 2000; n++) {
    let st = { chunks: new Map(range(35, 35 + ri(14)).map((k) => [k, bytesOf(ri(3), k)])), seals: null };
    const start = st;
    const writes = [];
    for (let i = 0, len = 2 + ri(4); i < len; i++) {
      const b = ri(3), lo = 35 + ri(14), hi = lo + ri(4);
      const w = { put: range(lo, hi).map((k) => ({ k, records: bytesOf(b, k) })) };
      if (rnd() < 0.7) w.deleteAbove = hi + (rnd() < 0.3 ? -ri(3) : 0);
      const landed = apply(st, w).chunks;
      if (rnd() < 0.6) {
        let top = 34;
        while (landed.has(top + 1) && topOf(landed.get(top + 1)) === topOf(bytesOf(b, top + 1))) top++;
        w.seals = sealsFor(b, range(35, 35 + ri(top - 34 + 1) - 1));
      }
      st = apply(st, w);
      writes.push(w);
    }
    const merged = writes.reduce((o, w) => mergeStoreWrites(o, w));
    const one = apply(start, merged);
    runs++;
    if (one.chunks.size !== st.chunks.size || [...st.chunks].some(([k, v]) => one.chunks.get(k) !== v)) differ++;
    if (merged.seals && (stale(one.chunks, merged.seals).length || checkSeals(K, merged.seals, TABLE) === null)) staleMerged++;
    if (stale(st.chunks, st.seals).length) { staleSeq++; seqExample ??= writes.map((w) => ({ put: w.put.map((p) => `${p.k}:${p.records[0]}`).join(" "), deleteAbove: w.deleteAbove, seals: w.seals?.list.map((e) => e.k).join(" ") })); }
  }
  t.check(`merge property: ${runs} runs of 2 to 5 writes over a filled store: the merged write leaves the same chunks (${differ} differ) and its list is never stale (${staleMerged} stale)`, differ === 0 && staleMerged === 0);
  console.log(`    (the same writes applied one by one left a stale seal in ${staleSeq} of ${runs} runs, a write without a list over sealed chunks; first: ${JSON.stringify(seqExample)})`);

  // The production path: a burst of detached writes while one is in flight lands the newest list.
  const writes = [];
  let release;
  const gate = new Promise((r) => { release = r; });
  const store = { async write(w) { writes.push(w); if (writes.length === 1) await gate; } };
  detachStoreWrite(store, { put: [{ k: 46, records: new Uint8Array(1) }], deleteAbove: 46, head: head(190000), seals: pre(recA, 4) });
  await new Promise((r) => setTimeout(r, 0));             // the first transaction is now in flight
  detachStoreWrite(store, { put: [{ k: 46, records: new Uint8Array(2) }], deleteAbove: 46, head: head(190100), seals: pre(recA, 8) });
  detachStoreWrite(store, { put: [{ k: 47, records: new Uint8Array(1) }], deleteAbove: 47, head: head(194000), seals: pre(recA, 9) });
  release();
  await flushSpvStoreWrites();
  t.check("detached writes: the first lands as sent, the burst behind it as one write carrying the newest list", writes.length === 2 && writes[0].seals.list.length === 4 && same(checkSeals(K, writes[1].seals, TABLE), A.slice(0, 9)) && writes[1].head.tip === 194000);
}

t.done();
