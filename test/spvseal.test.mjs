// src/core/spvseal.ts and the seal half of mergeStoreWrites: the key and MAC against vectors computed with node:crypto
// from the byte layout (not from the module), a list check that ignores a wrong MAC over forged bytes and a list
// spliced from two genuine branches, a property run over tampered lists, and the merge of detached writes.
import { createHmac } from "node:crypto";
import { checker } from "./helpers/check.mjs";
import { checkSeals, sealKeyGetter, sealMessage, sealRecord } from "../src/core/spvseal.ts";
import { importKeyRaw } from "../src/core/keystore.ts";
import { MAX_CHUNK } from "../src/core/headerstore.ts";
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
}

{
  let cur = null;
  const get = sealKeyGetter(() => cur);
  t.check("locked (no vault key): the getter gives no key", (await get()) === null);
  cur = vk;
  const p = get();
  cur = null;
  t.check("a lock during the derivation gives no key", (await p) === null);
  cur = await importKeyRaw("ff".repeat(32));
  const other = await get();
  const rec = sealRecord(K, TABLE, [{ k: 35, top: T1, work: W1 }]);
  t.check("a new vault (another raw key) gives another key, under which the old list is ignored", other !== null && Buffer.from(other).toString("hex") !== K_HEX && checkSeals(other, rec, TABLE) === null);
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
}

{
  const spliced = { v: 1, newest: TABLE.newest, list: [...recA.list.slice(0, 8), ...recB.list.slice(8)] };
  t.check("both branches' lists verify on their own", checkSeals(K, recA, TABLE) !== null && checkSeals(K, recB, TABLE) !== null);
  t.check("a list spliced from two genuine branches above their fork is ignored (the previous top is in the MAC)", checkSeals(K, spliced, TABLE) === null);
  const atFork = { v: 1, newest: TABLE.newest, list: [...recA.list.slice(0, FORK), ...recB.list.slice(FORK)] };
  t.check("joined at the fork, where the branches are one chain, it is branch B's own list", same(checkSeals(K, atFork, TABLE), B));
}

t.check("a list for another table entry (a newer release) is ignored", checkSeals(K, { ...recA, newest: 147455 }, { newest: 147455, newestHash: NH }) === null);
t.check("a list for another table hash at the same height is ignored", checkSeals(K, recA, { newest: TABLE.newest, newestHash: "0x" + "ab".repeat(32) }) === null);

{
  const first = 35;
  const bad = [null, "seals", 7, { v: 2, newest: TABLE.newest, list: recA.list }, { v: 1, newest: TABLE.newest, list: "x" },
    { v: 1, newest: TABLE.newest, list: recA.list.slice(1) },
    { v: 1, newest: TABLE.newest, list: [recA.list[0], recA.list[2]] },
    { v: 1, newest: TABLE.newest, list: [null] },
    { v: 1, newest: TABLE.newest, list: [{ ...recA.list[0], top: recA.list[0].top.toUpperCase().replace("0X", "0x") }] },
    { v: 1, newest: TABLE.newest, list: [{ ...recA.list[0], work: "0" + recA.list[0].work }] },
    { v: 1, newest: TABLE.newest, list: [{ ...recA.list[0], work: (1n << 128n).toString() }] },
    { v: 1, newest: TABLE.newest, list: [{ ...recA.list[0], mac: recA.list[0].mac.slice(2) }] },
    { v: 1, newest: TABLE.newest, list: [{ ...recA.list[0], k: "35" }] },
    { v: 1, newest: TABLE.newest, list: new Array(MAX_CHUNK - first + 2).fill(recA.list[0]) }];
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

  // Property: folding random suffix writes equals applying them in order, for chunks, and gives the last list cut by
  // every later deleteAbove, which still verifies.
  let bad = 0;
  for (let n = 0; n < 500; n++) {
    const writes = Array.from({ length: 2 + ri(5) }, () => {
      const w = { put: Array.from({ length: ri(4) }, () => ({ k: 35 + ri(14), records: new Uint8Array([ri(256)]) })) };
      if (rnd() < 0.5) w.deleteAbove = 35 + ri(14);
      if (rnd() < 0.6) w.seals = pre(rnd() < 0.5 ? recA : recB, ri(13));
      return w;
    });
    const folded = writes.reduce((o, w) => mergeStoreWrites(o, w));
    const seq = new Map(), fold = new Map();
    let list = null;
    for (const w of writes) {
      if (w.deleteAbove !== undefined) { for (const k of [...seq.keys()]) if (k > w.deleteAbove) seq.delete(k); if (list) list = list.filter((e) => e.k <= w.deleteAbove); }
      for (const p of w.put) seq.set(p.k, p.records[0]);
      if (w.seals) list = w.seals.list;
    }
    if (folded.deleteAbove !== undefined) for (const k of [...fold.keys()]) if (k > folded.deleteAbove) fold.delete(k);
    for (const p of folded.put) fold.set(p.k, p.records[0]);
    const chunksEqual = seq.size === fold.size && [...seq].every(([k, v]) => fold.get(k) === v);
    const sealsEqual = list === null ? !folded.seals : folded.seals?.list.length === list.length && folded.seals.list.every((e, i) => e === list[i]) && checkSeals(K, folded.seals, TABLE) !== null;
    if (!chunksEqual || !sealsEqual) bad++;
  }
  t.check(`merge property: 500 random write sequences fold to the sequential chunks and the last list cut by later truncations (${bad} differ)`, bad === 0);

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
