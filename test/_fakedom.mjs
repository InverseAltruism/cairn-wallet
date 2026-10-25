// A DOM only as far as popup.ts and approve.ts use one, plus a scripted background bridge.
// Assigning innerHTML replaces the subtree: ids inside the new markup become fresh elements, and
// `[data-x]` selectors return elements built from the markup with their dataset filled in.
const TAG = /<([a-zA-Z][a-zA-Z0-9]*)([^>]*)>/g;
const ATTR = /\s([a-zA-Z][\w-]*)(?:="([^"]*)")?/g;

export function installFakeDom({ autoCreate = false } = {}) {
  const registry = new Map();
  class El {
    constructor(id = "") {
      this.id = id; this._html = ""; this.textContent = ""; this.className = ""; this.hidden = false; this.disabled = false;
      this.value = ""; this.href = ""; this.style = {}; this.dataset = {}; this._kids = []; this._listeners = {}; this._qsa = {};
      this.onclick = null;
      const cls = new Set();
      this.classList = { add: (c) => cls.add(c), remove: (c) => cls.delete(c), contains: (c) => cls.has(c), toggle: (c, on) => ((on ?? !cls.has(c)) ? cls.add(c) : cls.delete(c)) };
    }
    get innerHTML() { return this._html; }
    set innerHTML(v) {
      for (const k of this._kids) if (registry.get(k)?._parent === this) registry.delete(k);
      this._kids = []; this._qsa = {};
      this._html = String(v);
      this._adopt(this._html);
      // as in a browser, the markup's text becomes the element's text (tags dropped, the five escapes decoded)
      this.textContent = this._html.replace(/<[^>]*>/g, "").replace(/&(amp|lt|gt|quot|#39);/g, (_, e) => ({ amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" })[e]);
    }
    _adopt(html) {
      for (const m of String(html).matchAll(TAG)) {
        const attrs = {};
        for (const a of m[2].matchAll(ATTR)) attrs[a[1]] = a[2] ?? "";
        if (!attrs.id) continue;
        const el = new El(attrs.id);
        el._parent = this; el.hidden = "hidden" in attrs;
        registry.set(attrs.id, el); this._kids.push(attrs.id);
      }
    }
    // "afterend" and "beforebegin" add the markup to the parent, as a browser does (the place inside it is not modelled)
    insertAdjacentHTML(pos, html) {
      const into = (pos === "afterend" || pos === "beforebegin") && this._parent ? this._parent : this;
      into._html += String(html); into._adopt(html);
    }
    appendChild(c) { this._html += c?.textContent ?? ""; return c; }
    addEventListener(type, fn) { (this._listeners[type] ||= []).push(fn); }
    setAttribute(name, value) { (this._attrs ||= {})[name] = String(value); }
    getAttribute(name) { return this._attrs?.[name] ?? null; }
    focus() {}
    querySelector() { return null; }
    querySelectorAll(sel) {
      const m = /^\[data-([a-z-]+)\]$/.exec(String(sel));
      if (!m) return [];
      if (this._qsa[sel]) return this._qsa[sel];
      const key = m[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      const out = [];
      for (const t of this._html.matchAll(TAG)) {
        const attrs = {};
        for (const a of t[2].matchAll(ATTR)) attrs[a[1]] = a[2] ?? "";
        if (!(`data-${m[1]}` in attrs)) continue;
        const el = new El(); el.dataset[key] = attrs[`data-${m[1]}`];
        out.push(el);
      }
      return (this._qsa[sel] = out);
    }
    async click() {
      if (this.onclick) await this.onclick();
      for (const fn of this._listeners.click || []) await fn();
    }
  }
  const byId = (id) => {
    let el = registry.get(id);
    if (!el && autoCreate) { el = new El(id); registry.set(id, el); }
    return el ?? null;
  };
  globalThis.document = { getElementById: byId, querySelector: () => null, querySelectorAll: () => [], createElement: () => new El(), addEventListener: () => {} };
  // approve.ts observes the request for its "more below" line; layout is not modelled here, so the observers never fire
  // (test/approve-layout-chrome.test.mjs measures the line in Chrome)
  class Unobserved { observe() { /* never fires */ } disconnect() { /* nothing to stop */ } }
  globalThis.MutationObserver = Unobserved;
  globalThis.ResizeObserver = Unobserved;
  globalThis.window = { close: () => {} };
  globalThis.matchMedia = () => ({ matches: true });
  // no tokens: motion reads none (tokenMs is null), so no tween or delay runs
  globalThis.getComputedStyle = () => ({ getPropertyValue: () => "" });
  globalThis.document.documentElement = {};
  return { registry, El, byId };
}

// The chrome.runtime port: answers {ok:true,result} from a handler, {ok:false,error} when the handler
// throws (the background's own shape), and a lastError for a method listed in `breakChannel`.
export function installBridge(handlers) {
  const breakChannel = new Set();
  const calls = [];
  globalThis.chrome = {
    runtime: {
      lastError: undefined,
      sendMessage(m, cb) {
        calls.push(m.method);
        Promise.resolve().then(async () => {
          if (breakChannel.has(m.method)) {
            breakChannel.delete(m.method);
            globalThis.chrome.runtime.lastError = { message: "The message port closed before a response was received." };
            cb(undefined);
            globalThis.chrome.runtime.lastError = undefined;
            return;
          }
          const h = handlers[m.method];
          if (!h) return cb({ ok: false, error: "no such popup method: " + m.method });
          try { cb({ ok: true, result: await h(...(m.args || [])) }); } catch (e) { cb({ ok: false, error: String(e?.message || e) }); }
        });
      },
    },
  };
  return { breakChannel, calls };
}

export const flush = async (n = 20) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };
