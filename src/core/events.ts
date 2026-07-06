// Per-origin event-port registry for provider events (doc 28 Phase 2). Pure + import-safe so the
// cross-origin isolation property is unit-testable without a browser. Background wires
// chrome.runtime.onConnect to this; ports are keyed by their browser-set, UNFORGEABLE sender origin,
// so a page can ONLY ever receive events for its own origin — never another site's.
export interface EventPort { postMessage(m: unknown): void; }

export class PortRegistry {
  private byOrigin = new Map<string, Set<EventPort>>();

  add(origin: string, port: EventPort): void {
    let s = this.byOrigin.get(origin);
    if (!s) { s = new Set(); this.byOrigin.set(origin, s); }
    s.add(port);
  }

  remove(origin: string, port: EventPort): void {
    const s = this.byOrigin.get(origin);
    if (s) { s.delete(port); if (s.size === 0) this.byOrigin.delete(origin); }
  }

  /** Push an event to ONLY the given origin's ports. */
  emitToOrigin(origin: string, event: string, data: unknown): void {
    const s = this.byOrigin.get(origin);
    if (!s) return;
    for (const p of s) { try { p.postMessage({ kind: "cairn-event", event, data }); } catch { /* port closing */ } }
  }

  // There is DELIBERATELY no emitAll(): a wallet-wide event (lock / account-switch) must reach ONLY the
  // origins the user has consented to, never every connected page — background emits per-consented-origin
  // (emitConnected loops emitToOrigin over the consent map) precisely so a random open site can't learn the
  // wallet's lock/account-switch timing. A broadcast helper here invited re-introducing that privacy leak.

  get size(): number { let n = 0; for (const s of this.byOrigin.values()) n += s.size; return n; }
}
