// The SPV header store: 84-byte header records in 4,096-height chunks in IndexedDB, the LRU of
// verified chunks, and per-height chunk acquisition against the release anchor table.
// Design: cairn docs/Plans/86-wallet-0299-2026-10.md sections 3.3 to 3.5.
//
// Nothing read from the store is trusted: acquisition verifies every chunk against its two baked
// hashes before use. Every store failure (open, read, write) degrades to "no cache", not a refusal.
import { SPV_ANCHORS, SPV_CHUNK, SPV_FLOOR } from "./spvanchors.js";

export const DB_NAME = "cairn-wallet-spv";
export const DB_VERSION = 1;
const CHUNKS = "chunks";
const META = "meta";

/** The chunk holding the names floor; nothing below it is stored. */
export const FIRST_CHUNK = Math.floor(SPV_FLOOR.height / SPV_CHUNK);
/** Bound on chunk keys read or written, so a hostile key flood in the profile costs a bounded listing. */
export const MAX_CHUNK = FIRST_CHUNK + 4096;

export const chunkOf = (height: number): number => Math.floor(height / SPV_CHUNK);

/** Bounds and baked hashes of an anchored chunk, in the shape `verifyLinkedRecords` takes. */
export interface ChunkSpec {
  k: number;
  firstHeight: number;
  lastHeight: number;
  /** Chunk 7 only: the hash of its first record (the names-floor pin). */
  firstHash?: string;
  /** Chunks above 7: the previous chunk's baked top hash, which the first record's prev must equal. */
  prevHash?: string;
  lastHash: string;
}

/** The spec of chunk k when the release table anchors it, else null (k is in the forward-verified suffix). */
export function chunkSpec(k: number): ChunkSpec | null {
  const i = k - FIRST_CHUNK;
  if (!Number.isSafeInteger(k) || i < 0 || i >= SPV_ANCHORS.length) return null;
  const lastHeight = k * SPV_CHUNK + SPV_CHUNK - 1;
  const lastHash = SPV_ANCHORS[i]!;
  if (i === 0) return { k, firstHeight: SPV_FLOOR.height, firstHash: SPV_FLOOR.hash, lastHash, lastHeight };
  return { k, firstHeight: k * SPV_CHUNK, prevHash: SPV_ANCHORS[i - 1]!, lastHash, lastHeight };
}

/** A hint only: chunk presence is the truth, a head that disagrees is recomputed. */
export interface HeadHint { v: 2; tip: number; tipHash: string }

export function isHeadHint(x: unknown): x is HeadHint {
  const h = x as HeadHint | null;
  return !!h && typeof h === "object" && h.v === 2 && Number.isSafeInteger(h.tip) && h.tip >= SPV_FLOOR.height
    && typeof h.tipHash === "string" && /^0x[0-9a-f]{64}$/.test(h.tipHash);
}

/** One transaction: the common advance, a boundary crossing, a backfill, a truncation or a delete. */
export interface StoreWrite {
  put?: { k: number; records: Uint8Array }[];
  del?: number[];
  /** Deletes every chunk key above this one (a suffix truncation). */
  deleteAbove?: number;
  head?: HeadHint;
}

export interface HeaderStore {
  /** Chunk keys present, ascending, limited to FIRST_CHUNK..MAX_CHUNK. */
  listChunks(): Promise<number[]>;
  /** The stored bytes, or null when absent or not an ArrayBuffer (a malformed value is overwritten on refetch). */
  getChunk(k: number): Promise<Uint8Array | null>;
  getHead(): Promise<HeadHint | null>;
  /** Commits whole or not at all; resolves after the transaction completes, rejects on bad input. */
  write(w: StoreWrite): Promise<void>;
  close(): void;
}

const reqP = <T>(r: IDBRequest<T>): Promise<T> => new Promise((res, rej) => {
  r.onsuccess = () => res(r.result);
  r.onerror = () => rej(r.error);
});

const txDone = (tx: IDBTransaction): Promise<void> => new Promise((res, rej) => {
  tx.oncomplete = () => res();
  tx.onerror = () => rej(tx.error);
  tx.onabort = () => rej(tx.error ?? new Error("header store transaction aborted"));
});

function checkKey(k: number): number {
  if (!Number.isSafeInteger(k) || k < FIRST_CHUNK || k > MAX_CHUNK) throw new RangeError(`chunk key ${k} outside ${FIRST_CHUNK}..${MAX_CHUNK}`);
  return k;
}

function openDb(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = factory.open(DB_NAME, DB_VERSION);
    let settled = false;
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains(CHUNKS)) db.createObjectStore(CHUNKS);
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META);
    };
    r.onsuccess = () => {
      const db = r.result;
      // A connection that arrives after a blocked open was given up on is closed.
      if (settled) { db.close(); return; }
      settled = true;
      db.onversionchange = () => db.close();
      res(db);
    };
    r.onerror = () => { if (!settled) { settled = true; rej(r.error); } };
    r.onblocked = () => { if (!settled) { settled = true; rej(new Error("header store open blocked")); } };
  });
}

function deleteDb(factory: IDBFactory): Promise<void> {
  return new Promise((res, rej) => {
    const r = factory.deleteDatabase(DB_NAME);
    r.onsuccess = () => res();
    r.onerror = () => rej(r.error);
    r.onblocked = () => rej(new Error("header store delete blocked"));
  });
}

function wrap(db: IDBDatabase): HeaderStore {
  return {
    async listChunks() {
      const tx = db.transaction(CHUNKS, "readonly");
      const keys = await reqP(tx.objectStore(CHUNKS).getAllKeys(IDBKeyRange.bound(FIRST_CHUNK, MAX_CHUNK), MAX_CHUNK - FIRST_CHUNK + 1));
      return keys.filter((k): k is number => typeof k === "number" && Number.isSafeInteger(k));
    },
    async getChunk(k) {
      const v = await reqP(db.transaction(CHUNKS, "readonly").objectStore(CHUNKS).get(checkKey(k)));
      return v instanceof ArrayBuffer ? new Uint8Array(v) : null;
    },
    async getHead() {
      const v = await reqP(db.transaction(META, "readonly").objectStore(META).get("head"));
      return isHeadHint(v) ? v : null;
    },
    async write(w) {
      for (const p of w.put ?? []) checkKey(p.k);
      for (const k of w.del ?? []) checkKey(k);
      if (w.deleteAbove !== undefined) checkKey(w.deleteAbove);
      if (w.head !== undefined && !isHeadHint(w.head)) throw new TypeError("header store head is malformed");
      // Every request is issued before the first await: awaiting anything between two requests lets
      // IndexedDB auto-commit the first half (test/headerstore-chrome.test.mjs pins this in real Chrome).
      const tx = db.transaction([CHUNKS, META], "readwrite");
      const done = txDone(tx);
      const chunks = tx.objectStore(CHUNKS);
      if (w.deleteAbove !== undefined) chunks.delete(IDBKeyRange.lowerBound(w.deleteAbove, true));
      for (const k of w.del ?? []) chunks.delete(k);
      for (const p of w.put ?? []) chunks.put(p.records.slice().buffer, p.k);
      if (w.head) tx.objectStore(META).put(w.head, "head");
      return done;
    },
    close() { db.close(); },
  };
}

/**
 * Open the store, or null for "no cache this session" (no IndexedDB, a blocked open, a full disk).
 * A VersionError (a newer schema left by a later release, then a rollback) deletes and recreates it.
 */
export async function openHeaderStore(factory: IDBFactory | undefined = globalThis.indexedDB): Promise<HeaderStore | null> {
  if (!factory) { console.warn("[headerstore] IndexedDB unavailable; running without a header cache"); return null; }
  try {
    return wrap(await openDb(factory));
  } catch (e) {
    if ((e as DOMException | null)?.name !== "VersionError") {
      console.warn("[headerstore] open failed; running without a header cache:", e);
      return null;
    }
  }
  try {
    await deleteDb(factory);
    return wrap(await openDb(factory));
  } catch (e) {
    console.warn("[headerstore] recreate after VersionError failed; running without a header cache:", e);
    return null;
  }
}

/** Least-recently-used cache of verified chunks. */
export class ChunkLru {
  private readonly m = new Map<number, Uint8Array>();
  constructor(readonly capacity = 8) {}
  get size(): number { return this.m.size; }
  keys(): number[] { return [...this.m.keys()]; }
  get(k: number): Uint8Array | undefined {
    const v = this.m.get(k);
    if (v) { this.m.delete(k); this.m.set(k, v); }
    return v;
  }
  set(k: number, v: Uint8Array): void {
    this.m.delete(k);
    this.m.set(k, v);
    while (this.m.size > this.capacity) this.m.delete(this.m.keys().next().value!);
  }
  delete(k: number): void { this.m.delete(k); }
}

export interface AcquireDeps {
  store: HeaderStore | null;
  lru: ChunkLru;
  /** The caller's sync serializer, so concurrent proofs fetch one chunk once. */
  serialize: <T>(op: () => Promise<T>) => Promise<T>;
  /** Throws with a reason unless the records walk from the spec's first hash or prev hash to its last hash. */
  verify(records: Uint8Array, spec: ChunkSpec): void;
  fetchChunk(spec: ChunkSpec): Promise<Uint8Array>;
}

export interface ChunkAcquirer {
  /** The verified chunk holding `height`; rejects for a height outside the anchored range or a chunk that fails. */
  acquire(height: number): Promise<{ spec: ChunkSpec; records: Uint8Array }>;
  /** Settles when the detached store writes issued so far have finished. */
  writes(): Promise<void>;
}

export function chunkAcquirer(deps: AcquireDeps): ChunkAcquirer {
  const { store, lru } = deps;
  let writeTail: Promise<void> = Promise.resolve();
  // Store writes are detached from the proof path: chained, and a failure is warned.
  const detachWrite = (w: StoreWrite) => {
    if (!store) return;
    writeTail = writeTail.then(() => store.write(w)).catch((e) => console.warn("[headerstore] chunk write failed (refetched next session):", e));
  };
  const tryStored = async (spec: ChunkSpec): Promise<Uint8Array | null> => {
    let rec: Uint8Array | null = null;
    try { rec = store ? await store.getChunk(spec.k) : null; }
    catch (e) { console.warn(`[headerstore] chunk ${spec.k} read failed; fetching it:`, e); }
    if (!rec) return null;
    try { deps.verify(rec, spec); return rec; }
    catch (e) {
      console.warn(`[headerstore] stored chunk ${spec.k} failed verification; deleting and fetching it:`, e);
      detachWrite({ del: [spec.k] });
      return null;
    }
  };
  return {
    async acquire(height) {
      const spec = height >= SPV_FLOOR.height ? chunkSpec(chunkOf(height)) : null;
      if (!spec) throw new Error(`height ${height} is outside the release-anchored range ${SPV_FLOOR.height} to ${FIRST_CHUNK * SPV_CHUNK + SPV_ANCHORS.length * SPV_CHUNK - 1}`);
      const hit = lru.get(spec.k);
      if (hit) return { spec, records: hit };
      return deps.serialize(async () => {
        const again = lru.get(spec.k);
        if (again) return { spec, records: again };
        let records = await tryStored(spec);
        if (!records) {
          const fetched = await deps.fetchChunk(spec);
          try { deps.verify(fetched, spec); }
          catch (e) { throw new Error(`chunk ${spec.k} (heights ${spec.firstHeight} to ${spec.lastHeight}) failed verification: ${(e as Error)?.message ?? e}`); }
          records = fetched;
          detachWrite({ put: [{ k: spec.k, records }] });
        }
        lru.set(spec.k, records);
        return { spec, records };
      });
    },
    writes: () => writeTail,
  };
}
