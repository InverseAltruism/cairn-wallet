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
const STATIC_IDS = ["view-locked", "view-req", "req", "msg", "btn-approve", "btn-reject", "btn-unlock", "unlock-pw", "ap-origin", "ap-ask", "ap-signer"];

export function mountApproveWindow(handlers) {
  const registry = new Map();
  class El {
    constructor(id) { this.id = id; this._html = ""; this._text = ""; this.className = ""; this.hidden = false; this.disabled = false; this._kids = []; }
    // Setting textContent replaces the subtree, markup added with insertAdjacentHTML included.
    get textContent() { return this._text; }
    set textContent(v) {
      for (const k of this._kids) if (registry.get(k)?._parent === this) registry.delete(k);
      this._kids = [];
      this._text = String(v);
      this._html = this._text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    }
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
    // "afterend" and "beforebegin" add the markup to the parent, as a browser does; the place inside the parent is
    // not modelled (test/approve-layout-chrome.test.mjs measures it in Chrome).
    insertAdjacentHTML(pos, html) {
      const into = pos === "afterend" || pos === "beforebegin" ? this._parent : this;
      if (!into) throw new Error(`approve-dom: ${pos} on an element with no parent`);
      into._insert(html);
    }
    _insert(html) {
      const ids = [...String(html).matchAll(TAG_WITH_ID)].map((m) => m[1]);
      this._html += String(html); this._adopt(html);
      // remember the inserted chunk, so remove() can take exactly that markup back out of the parent
      for (const id of ids) registry.get(id)._chunk = String(html);
    }
    // Element.remove() for an element that arrived through insertAdjacentHTML: drops its whole chunk.
    remove() {
      const p = this._parent;
      if (!p || this._chunk === undefined) throw new Error("approve-dom: remove() only models elements inserted with insertAdjacentHTML");
      p._html = p._html.replace(this._chunk, "");
      for (const m of this._chunk.matchAll(TAG_WITH_ID)) { if (registry.get(m[1])?._parent === p) registry.delete(m[1]); p._kids = p._kids.filter((k) => k !== m[1]); }
    }
    addEventListener(type, fn) { (this._listeners ||= {})[type] = fn; }
  }
  for (const id of STATIC_IDS) registry.set(id, new El(id));
  globalThis.document = { getElementById: (id) => registry.get(id) ?? null };
  // approve.ts observes the request for its "more below" line; layout is not modelled here, so the observers never fire
  // (test/approve-layout-chrome.test.mjs measures the line in Chrome)
  class Unobserved { observe() { /* never fires */ } disconnect() { /* nothing to stop */ } }
  globalThis.MutationObserver = Unobserved;
  globalThis.ResizeObserver = Unobserved;
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
