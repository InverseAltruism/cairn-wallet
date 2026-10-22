// Tiny async key/value abstraction so the Wallet brain works in the extension
// service worker (chrome.storage.local), a plain page (localStorage, dev/E2E),
// or a test (in-memory).
export interface Store {
  get(k: string): Promise<any>; set(k: string, v: any): Promise<void>; del(k: string): Promise<void>;
  /** Bytes a key occupies, where the area can say (chrome.storage.local); read before a value too large to load. */
  bytesInUse?(k: string): Promise<number>;
}

export const memoryStore = (): Store => {
  const m = new Map<string, any>();
  return {
    async get(k) { return m.has(k) ? structuredClone(m.get(k)) : null; },
    async set(k, v) { m.set(k, structuredClone(v)); },
    async del(k) { m.delete(k); },
  };
};

export const localStore = (): Store => ({
  async get(k) { const s = localStorage.getItem("cairn:" + k); return s ? JSON.parse(s) : null; },
  async set(k, v) { localStorage.setItem("cairn:" + k, JSON.stringify(v)); },
  async del(k) { localStorage.removeItem("cairn:" + k); },
});

// The part of the extension's chrome.storage API the two adapters call. `chrome` is provided by the runtime.
interface ChromeArea {
  get(k: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(k: string): Promise<void>;
  getBytesInUse(k: string): Promise<number>;
}
type ChromeGlobal = { chrome?: { storage?: { local?: ChromeArea; session?: ChromeArea } } };

// chrome.storage.local adapter (extension). The area is read on each call; outside an extension a call rejects.
export const chromeStore = (): Store => {
  const c = (globalThis as ChromeGlobal).chrome;
  const local = (): ChromeArea => { const a = c?.storage?.local; if (!a) throw new Error("chrome.storage.local is unavailable"); return a; };
  return {
    async get(k) { return (await local().get(k))[k] ?? null; },
    async set(k, v) { await local().set({ [k]: v }); },
    async del(k) { await local().remove(k); },
    async bytesInUse(k) { return Number(await local().getBytesInUse(k)) || 0; },
  };
};

// chrome.storage.session adapter (extension): IN-MEMORY, never written to disk, cleared when the
// browser closes, and (by default access level TRUSTED_CONTEXTS) unreadable by content scripts /
// web pages. Used only to survive MV3 service-worker idle-kills without re-prompting for the
// password. Returns null where session storage is unavailable (older runtime / non-extension host),
// so the wallet transparently falls back to in-memory-only behaviour.
export const chromeSessionStore = (): Store | null => {
  const c = (globalThis as ChromeGlobal).chrome;
  if (!c?.storage?.session) return null;
  const session = (): ChromeArea => { const a = c?.storage?.session; if (!a) throw new Error("chrome.storage.session is unavailable"); return a; };
  return {
    async get(k) { return (await session().get(k))[k] ?? null; },
    async set(k, v) { await session().set({ [k]: v }); },
    async del(k) { await session().remove(k); },
  };
};
