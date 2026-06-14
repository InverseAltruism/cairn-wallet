// Tiny async key/value abstraction so the Wallet brain works in the extension
// service worker (chrome.storage.local), a plain page (localStorage, dev/E2E),
// or a test (in-memory).
export interface Store { get(k: string): Promise<any>; set(k: string, v: any): Promise<void>; del(k: string): Promise<void> }

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

// chrome.storage.local adapter (extension). `chrome` is provided by the runtime.
export const chromeStore = (): Store => {
  const c: any = (globalThis as any).chrome;
  return {
    async get(k) { return (await c.storage.local.get(k))[k] ?? null; },
    async set(k, v) { await c.storage.local.set({ [k]: v }); },
    async del(k) { await c.storage.local.remove(k); },
  };
};

// chrome.storage.session adapter (extension): IN-MEMORY, never written to disk, cleared when the
// browser closes, and (by default access level TRUSTED_CONTEXTS) unreadable by content scripts /
// web pages. Used only to survive MV3 service-worker idle-kills without re-prompting for the
// password. Returns null where session storage is unavailable (older runtime / non-extension host),
// so the wallet transparently falls back to in-memory-only behaviour.
export const chromeSessionStore = (): Store | null => {
  const c: any = (globalThis as any).chrome;
  if (!c?.storage?.session) return null;
  return {
    async get(k) { return (await c.storage.session.get(k))[k] ?? null; },
    async set(k, v) { await c.storage.session.set({ [k]: v }); },
    async del(k) { await c.storage.session.remove(k); },
  };
};
