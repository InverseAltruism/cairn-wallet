// resolveName base-claim fallback (0.2.55 change, first pinned 0.2.56): the recipient path for
// "send to a .csd name" fetches the UNTRUSTED base claim from the primary resolver and, on a
// primary outage (network error / 5xx), falls back to clarvis — accepting only a POSITIVE answer
// from the fallback (a 404 from a degraded second source must NOT definitively claim "not
// registered"). The SPV verifyName step stays the trust anchor either way; here it is offline in
// every case, so every result must carry verified:false — these tests pin the SOURCE-SELECTION
// logic, not the trust. Money path: a wrong answer here routes a send.
import { Wallet } from "../src/core/wallet.js";
import { memoryStore } from "../src/core/storage.js";

let pass = 0, fail = 0;
const check = (n, c) => { c ? pass++ : (fail++, console.error("  ✗ " + n)); if (c) console.log("  ✓ " + n); };

const ADDR = "0x" + "ab".repeat(20);
// URL-routed stub: `primary` / `clarvis` are handlers for the respective /cairnx/resolve hits;
// everything else (the SPV verify machinery, name-history, headers) gets a hard failure so
// verifyName degrades to its caught "verification unavailable" path — deliberate: these tests
// isolate base-claim source selection.
function mkResolveStub({ primary, clarvis }) {
  const stats = { primary: 0, clarvis: 0 };
  const wrapped = async (url) => {
    const u = String(url);
    if (u.includes("/cairnx/resolve/")) {
      if (u.includes("clarvis.")) { stats.clarvis++; return clarvis(); }
      stats.primary++; return primary();
    }
    return { ok: false, status: 500, json: async () => ({}) };
  };
  return { fetch: wrapped, stats };
}
const okBody = (extra = {}) => ({ ok: true, status: 200, json: async () => ({ addr: ADDR, via: "nset", owner: ADDR, ...extra }) });
const s404 = () => ({ ok: false, status: 404, json: async () => ({ error: "not found" }) });
const s500 = () => ({ ok: false, status: 500, json: async () => ({ error: "boom" }) });
const boom = () => { throw new Error("network down"); };

const origFetch = globalThis.fetch;
try {
  const mkWallet = async () => { const w = new Wallet(memoryStore()); await w.create("super-secret-pw"); return w; };

  // 1. healthy primary answers; clarvis is never consulted
  {
    const { fetch, stats } = mkResolveStub({ primary: okBody, clarvis: okBody });
    globalThis.fetch = fetch;
    const w = await mkWallet();
    const r = await w.resolveName("alice");
    check("healthy primary resolves (addr surfaced, verified:false — SPV offline here)", r.ok === true && r.addr === ADDR && r.verified === false);
    check("fallback not consulted when the primary answers", stats.clarvis === 0 && stats.primary === 1);
  }
  // 2. a primary 404 is DEFINITIVE — no fallback shopping for a different answer
  {
    const { fetch, stats } = mkResolveStub({ primary: s404, clarvis: okBody });
    globalThis.fetch = fetch;
    const w = await mkWallet();
    const r = await w.resolveName("alice");
    check("primary 404 is definitive 'not registered'", r.ok === false && /not registered/.test(String(r.error)));
    check("no second-source shopping after a definitive 404", stats.clarvis === 0);
  }
  // 3. primary 5xx → clarvis positive answer accepted (outage no longer blocks every name send)
  {
    const { fetch, stats } = mkResolveStub({ primary: s500, clarvis: okBody });
    globalThis.fetch = fetch;
    const w = await mkWallet();
    const r = await w.resolveName("alice");
    check("primary 5xx falls back to a positive clarvis answer", r.ok === true && r.addr === ADDR && stats.clarvis === 1);
  }
  // 4. primary network-dead → clarvis positive answer accepted
  {
    const { fetch } = mkResolveStub({ primary: boom, clarvis: okBody });
    globalThis.fetch = fetch;
    const w = await mkWallet();
    const r = await w.resolveName("alice");
    check("primary network error falls back to clarvis", r.ok === true && r.addr === ADDR);
  }
  // 5. clarvis 404 during a primary outage is NOT trusted as 'not registered' — retryable failure
  {
    const { fetch } = mkResolveStub({ primary: s500, clarvis: s404 });
    globalThis.fetch = fetch;
    const w = await mkWallet();
    const r = await w.resolveName("alice");
    check("fallback 404 stays a retryable 'name lookup failed' (never definitive)", r.ok === false && /name lookup failed/.test(String(r.error)) && !/not registered/.test(String(r.error)));
  }
  // 6. both sources down → honest retryable failure
  {
    const { fetch } = mkResolveStub({ primary: boom, clarvis: boom });
    globalThis.fetch = fetch;
    const w = await mkWallet();
    const r = await w.resolveName("alice");
    check("both sources down → 'name lookup failed'", r.ok === false && /name lookup failed/.test(String(r.error)));
  }
  // 7. fail-closed lease semantics survive the fallback path: a lapsed answer from clarvis refuses
  {
    const { fetch } = mkResolveStub({ primary: s500, clarvis: () => okBody({ lapsed: true }) });
    globalThis.fetch = fetch;
    const w = await mkWallet();
    const r = await w.resolveName("alice");
    check("lapsed lease via the fallback still refuses (fail-closed)", r.ok === false && /lapsed/.test(String(r.error)));
  }
  // 8. a fallback answer with no usable address refuses (no silent empty-addr acceptance)
  {
    const { fetch } = mkResolveStub({ primary: s500, clarvis: () => ({ ok: true, status: 200, json: async () => ({ owner: ADDR }) }) });
    globalThis.fetch = fetch;
    const w = await mkWallet();
    const r = await w.resolveName("alice");
    check("fallback answer without an addr refuses", r.ok === false && /has no address/.test(String(r.error)));
  }
} finally {
  globalThis.fetch = origFetch;
}

console.log(`\nresolve-fallback: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
