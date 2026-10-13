// A DOM only to the extent src/popup/approve.ts uses one, plus the background message bridge, so a test
// can drive the REAL approval-window module (no jsdom, no browser).
//
// The one behaviour that matters: assigning innerHTML REPLACES the subtree, so every id inside the old
// markup stops being reachable through getElementById and every id inside the new markup becomes a FRESH
// element. Buttons record their click listener in `_listeners.click`, which re-checks `disabled` itself,
// exactly like the real handler.
//
// approve.ts reads `chrome` and registers its poll at module load, so `mountApproveWindow` must run before
// `loadApprove`, and each test file gets one window (the module is a singleton per process).

const TAG_WITH_ID = /<[a-zA-Z][^>]*\sid="([^"]+)"[^>]*>/g;
const STATIC_IDS = ["view-locked", "view-req", "req", "msg", "btn-approve", "btn-reject", "btn-unlock", "unlock-pw"];

export function mountApproveWindow(handlers) {
  const registry = new Map();
  class El {
    constructor(id) { this.id = id; this._html = ""; this.textContent = ""; this.className = ""; this.hidden = false; this.disabled = false; this._kids = []; }
    get innerHTML() { return this._html; }
    set innerHTML(v) {
      for (const k of this._kids) if (registry.get(k)?._parent === this) registry.delete(k);
      this._kids = [];
      this._html = String(v);
      this._adopt(this._html);
    }
    _adopt(html) {
      for (const m of String(html).matchAll(TAG_WITH_ID)) {
        const el = new El(m[1]);
        el._parent = this;
        el.hidden = /\shidden(\s|>|=)/.test(m[0]);
        registry.set(m[1], el);
        this._kids.push(m[1]);
      }
    }
    insertAdjacentHTML(_pos, html) { this._html += String(html); this._adopt(html); }
    addEventListener(type, fn) { (this._listeners ||= {})[type] = fn; }
  }
  for (const id of STATIC_IDS) registry.set(id, new El(id));
  globalThis.document = { getElementById: (id) => registry.get(id) ?? null };
  let closes = 0;
  globalThis.window = { close: () => { closes++; } };
  globalThis.chrome = {
    runtime: {
      lastError: undefined,
      sendMessage(m, cb) {
        // async delivery, like the real port: every reply lands on a later turn
        Promise.resolve().then(async () => {
          const h = handlers[m.method];
          if (!h) return cb({ ok: false, error: "no such popup method: " + m.method });
          try { cb({ ok: true, result: await h(...(m.args || [])) }); } catch (e) { cb({ ok: false, error: String(e?.message || e) }); }
        });
      },
    },
  };
  return { registry, closes: () => closes };
}

// Import approve.ts (which fires the first render) and return its 1.2 s poll callback, captured instead of
// scheduled so a test drives each tick itself.
export async function loadApprove() {
  let tick = null;
  const realSetInterval = globalThis.setInterval;
  globalThis.setInterval = (fn) => { tick = fn; return 0; };
  try { await import("../../src/popup/approve.js"); } finally { globalThis.setInterval = realSetInterval; }
  if (typeof tick !== "function") throw new Error("approve.ts did not register its poll");
  return tick;
}

export const flush = async (n = 10) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
