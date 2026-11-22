// Real chain headers for the header-store tests (heights 29,696 to 32,767 and 106,496 to 115,199, fetched from
// /api/headers on 2026-10-13 and 2026-10-14; 126,976 to 146,829 from a recording of /api/headers on 2026-11-21),
// the /api/headers and node RPC endpoints served from them, and an in-memory HeaderStore with the write semantics of
// src/core/headerstore.ts. The fixture stores each record without its prev field (the previous record's sha256d),
// and the loader checks that chunks 7, 26, 27 and 31 to 34 walk to the anchor table.
import "./backup-host.mjs";
import { readFileSync } from "node:fs";
import { brotliDecompressSync } from "node:zlib";
import { createHash } from "node:crypto";
import { deserializeHeader, serializeHeader, verifyLinkedRecords } from "../../src/vendor/cairnx-spv.js";
import { SPV_ANCHORS, SPV_FLOOR } from "../../src/core/spvanchors.ts";

const HB = 84;
const sha256d = (b) => createHash("sha256").update(createHash("sha256").update(b).digest()).digest();
const hex = (b) => "0x" + Buffer.from(b).toString("hex");

const raw = brotliDecompressSync(readFileSync(new URL("../fixtures/spv-headers.bin.br", import.meta.url)));
const RANGES = [];
{
  let o = 4;
  for (let r = 0, n = raw.readUInt32LE(0); r < n; r++) {
    const from = raw.readUInt32LE(o), count = raw.readUInt32LE(o + 4);
    o += 8;
    const recs = new Uint8Array(count * HB);
    recs.set(raw.subarray(o, o + HB), 0);
    o += HB;
    for (let i = 1; i < count; i++, o += 52) {
      recs.set(raw.subarray(o, o + 4), i * HB);
      recs.set(sha256d(recs.subarray((i - 1) * HB, i * HB)), i * HB + 4);
      recs.set(raw.subarray(o + 4, o + 52), i * HB + 36);
    }
    RANGES.push({ from, to: from + count - 1, recs });
  }
}

export const FIX_TOP = 115199;
export const NEWEST = 114687;

/** Records for heights from..to (inclusive), copied. Throws outside the fixture. */
export function records(from, to) {
  const r = RANGES.find((x) => from >= x.from && to <= x.to);
  if (!r) throw new Error(`fixture has no records ${from}..${to}`);
  return r.recs.slice((from - r.from) * HB, (to - r.from + 1) * HB);
}
export const has = (h) => RANGES.some((x) => h >= x.from && h <= x.to);
export const headerOf = (h) => deserializeHeader(records(h, h));
export const hashOf = (h) => hex(sha256d(records(h, h)));
let byHash = null;
/** The fixture height whose header has this hash (0x, lower case), or undefined. */
export function heightOfHash(hash) {
  if (!byHash) { byHash = new Map(); for (const r of RANGES) for (let h = r.from; h <= r.to; h++) byHash.set(hashOf(h), h); }
  return byHash.get(String(hash).toLowerCase());
}
/** An /api/headers row, as the front door serves it. */
export const row = (h) => ({ height: h, header: headerOf(h), hash: hashOf(h) });
/** A v1 (pre-0.2.99) chrome.storage.local snapshot of heights from..to. */
export function v1Snapshot(from, to) {
  const headers = [];
  for (let h = from; h <= to; h++) headers.push({ height: h, hash: hashOf(h), header: headerOf(h), chainwork: "0", trusted: h - from < 46 });
  return { v: 1, baseHeight: from, headers };
}

verifyLinkedRecords(records(SPV_FLOOR.height, 32767), { firstHeight: SPV_FLOOR.height, firstHash: SPV_FLOOR.hash, lastHash: SPV_ANCHORS[0], lastHeight: 32767 });
verifyLinkedRecords(records(106496, 110591), { firstHeight: 106496, prevHash: SPV_ANCHORS[18], lastHash: SPV_ANCHORS[19], lastHeight: 110591 });
verifyLinkedRecords(records(110592, NEWEST), { firstHeight: 110592, prevHash: SPV_ANCHORS[19], lastHash: SPV_ANCHORS[20], lastHeight: NEWEST });
for (let k = 31; k <= 34; k++) verifyLinkedRecords(records(k * 4096, k * 4096 + 4095), { firstHeight: k * 4096, prevHash: SPV_ANCHORS[k - 8], lastHash: SPV_ANCHORS[k - 7], lastHeight: k * 4096 + 4095 });
if (SPV_ANCHORS.length < 28) throw new Error("the fixture needs the release table's first 28 entries (to 143,359)");
/** The release table's first 21 entries (newest 114,687, the fixture's top anchored chunk). Sources built on the fixture
 *  pass it as `anchors`, so a release that appends entries leaves these tests unchanged. */
export const FIX_ANCHORS = Object.freeze(SPV_ANCHORS.slice(0, 21));
/** The sealed-store fixture: the table's first 25 entries (newest 131,071, chunk 31), real headers to 146,829, so
 *  chunks 32 and 33 are sealable (their tops at least 4,096 below the tip) and 34 and 35 are the unsealed tail. */
export const SEAL_ANCHORS = Object.freeze(SPV_ANCHORS.slice(0, 25));
export const SEAL_NEWEST = 131071;
export const SEAL_TOP = 146829;

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/**
 * Installs globalThis.fetch serving /api/headers/:from/:count and the node RPC (/tip, /block/height/:h, /block/:hash,
 * /tx/:id) from the fixture; a hash outside the fixture answers as the node does (200, ok false). `net.tip` is the node tip; `net.tamper(from, rows)` may rewrite a page; `net.down` answers 500
 * to everything; `net.tipDown` answers 500 to /tip only; `net.unserved(from)` true answers 404 to that page.
 * `net.blocks` (height to node block JSON) and `net.txs` (txid to node /tx JSON) serve real bodies, `net.rawBlocks`
 * (height to /block response text) and `net.rawTxs` (txid to /tx response text) serve a body JSON.stringify cannot
 * write (a u64 above 2^53); other blocks are served with no transactions. `net.log` lists every /api/headers path requested. Returns a restore function.
 */
export function serveFixture(net) {
  net.log ??= [];
  net.tip ??= FIX_TOP;
  const prev = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (net.down) return json({ ok: false }, 500);
    const m = /\/api\/headers\/(\d+)\/(\d+)$/.exec(u);
    if (m) {
      const from = Number(m[1]), n = Number(m[2]);
      net.log.push(`${from}/${n}`);
      if (from + n - 1 > net.tip) return json({ ok: false, error: "headers unavailable" }, 502);
      if (net.unserved?.(from)) return json({ ok: false, error: "headers not served" }, 404);
      let rows = [];
      for (let h = from; h < from + n; h++) {
        if (!has(h)) return json({ ok: false, error: `fixture has no header ${h}` }, 404);
        rows.push(row(h));
      }
      if (net.tamper) rows = net.tamper(from, rows);
      return json({ ok: true, from, count: n, headers: rows });
    }
    if (u.endsWith("/tip")) return net.tipDown ? json({ ok: false }, 500) : json({ height: net.tip, hash: has(net.tip) ? hashOf(net.tip) : undefined });
    const bh = /\/block\/(0x[0-9a-f]{64})$/.exec(u);
    const atHash = bh ? heightOfHash(bh[1]) : undefined;
    if (bh && atHash === undefined) return json({ ok: false, hash: bh[1], height: null, header: { err: "not found" }, txs: [] });
    const b = atHash !== undefined ? [u, String(atHash)] : /\/block\/height\/(\d+)$/.exec(u);
    if (b && net.rawBlocks?.has(Number(b[1]))) return new Response(net.rawBlocks.get(Number(b[1])), { status: 200, headers: { "content-type": "application/json" } });
    if (b && net.blocks?.has(Number(b[1]))) return json(net.blocks.get(Number(b[1])));
    if (b) return json({ ok: true, height: Number(b[1]), hash: hashOf(Number(b[1])), header: headerOf(Number(b[1])), txs: [] });
    const t = /\/tx\/(0x[0-9a-f]{64})$/.exec(u);
    if (t && net.rawTxs?.has(t[1])) return new Response(net.rawTxs.get(t[1]), { status: 200, headers: { "content-type": "application/json" } });
    if (t && net.txs?.has(t[1])) return json(net.txs.get(t[1]));
    return json({ ok: false, err: "not found" }, 404);
  };
  return () => { globalThis.fetch = prev; };
}

/** The row with one hex digit of its merkle root changed; its claimed hash is left as the real one. */
export function forge(r) {
  const header = { ...r.header, merkle: "0x" + (r.header.merkle[2] === "0" ? "1" : "0") + r.header.merkle.slice(3) };
  return { ...r, header };
}

/** The row with its claimed hash recomputed from its (possibly edited) header, as a consistent forger serves it. */
export const rehash = (r) => ({ ...r, hash: hex(sha256d(serializeHeader(r.header))) });

/** An in-memory HeaderStore with headerstore.ts write semantics (deleteAbove, then del, then put, then head). */
export function memStore({ failWrite = () => false } = {}) {
  const chunks = new Map();
  const st = {
    chunks, head: null, seals: null, writes: [], reads: 0, readKeys: [],
    async listChunks() { return [...chunks.keys()].filter((k) => k >= 7 && k <= 7 + 4096).sort((a, b) => a - b); },
    async getChunk(k) { st.reads++; st.readKeys.push(k); const v = chunks.get(k); return v ? v.slice() : null; },
    async getHead() { return st.head ? { ...st.head } : null; },
    async getSeals() { return st.seals ? structuredClone(st.seals) : null; },
    async write(w) {
      if (failWrite(w, st.writes.length)) { st.writes.push({ ...w, failed: true }); throw new Error("QuotaExceededError"); }
      st.writes.push(w);
      if (w.deleteAbove !== undefined) for (const k of [...chunks.keys()]) if (k > w.deleteAbove) chunks.delete(k);
      for (const k of w.del ?? []) chunks.delete(k);
      for (const p of w.put ?? []) chunks.set(p.k, p.records.slice());
      if (w.head) st.head = { ...w.head };
      if (w.seals) st.seals = structuredClone(w.seals);
    },
    close() {},
    /** A byte image of the store, to compare before and after. */
    image() { return JSON.stringify({ head: st.head, seals: st.seals, chunks: [...chunks].sort((a, b) => a[0] - b[0]).map(([k, v]) => [k, hex(createHash("sha256").update(v).digest()), v.length]) }); },
  };
  return st;
}

/** The legacy snapshot seam over a plain map (chrome.storage.local in production). */
export function legacyOf(kv, { bytes = null } = {}) {
  const calls = { get: 0, del: 0 };
  return {
    calls,
    get: async () => { calls.get++; return kv.has("spvHeaderChain") ? kv.get("spvHeaderChain") : null; },
    del: async () => { calls.del++; kv.delete("spvHeaderChain"); },
    bytes: async () => bytes,
    attempts: { get: async () => kv.get("spvMigrateAttempts") ?? 0, set: async (n) => { if (n) kv.set("spvMigrateAttempts", n); else kv.delete("spvMigrateAttempts"); } },
  };
}

/** A real CSD-priced open offer at 30,332 (chunk 7) with its block body and spent prevout (test/fixtures/offer-30332.json). */
export const OFFER = JSON.parse(readFileSync(new URL("../fixtures/offer-30332.json", import.meta.url), "utf8"));
OFFER.height = OFFER.block.height;
OFFER.seller = OFFER.prevout.tx.outputs[OFFER.block.txs.find((t) => t.txid === OFFER.offerId).inputs[0].vout].script_pubkey;
/** Adds the offer's block and prevout to a serveFixture `net`. */
export function serveOffer(net) {
  net.blocks ??= new Map();
  net.txs ??= new Map();
  net.blocks.set(OFFER.height, OFFER.block);
  net.txs.set(OFFER.prevout.txid, OFFER.prevout);
}

/**
 * An SpvSource that answers heights at or below `top` from `live` (the production liveSpvSource over the fixture)
 * and every other height, the tip and every other prevout from `synthetic` (a test world near its own tip).
 */
export function splitSource(live, synthetic, top = 32767) {
  return {
    bodySource: live.bodySource,
    headerSource: live.headerSource,
    prepare: (h) => synthetic.prepare(h),
    blockAt: (h) => (h <= top ? live.blockAt(h) : synthetic.blockAt(h)),
    prevoutScriptPubkey: async (t, v) => (String(t).toLowerCase() === OFFER.prevout.txid ? live.prevoutScriptPubkey(t, v) : synthetic.prevoutScriptPubkey(t, v)),
  };
}
