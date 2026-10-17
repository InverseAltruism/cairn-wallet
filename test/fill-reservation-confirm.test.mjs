// The reservation confirm step, through the REAL background worker channel (mock chrome, the real onMessage
// listener, the real Wallet behind it with the synthetic fill-SPV io). When clarvis has scanned past the buyer's
// proven fclaim height and has no record of it ("unknown"), the worker signs nothing, returns
// RESERVATION_UNCONFIRMED with the facts to the approval window and keeps the request queued. "Sign anyway" re-sends
// the approval with an acknowledgement bound to (request id, fclaim txid); the worker re-runs the whole preflight.
//
// RED-FIRST:
//   - pass the dApp's own params through instead of setting reservationAck from the popup's resolve call
//     (background.ts MUTATE_ACK_CHANNEL: `reservationAck: p.params?.reservationAck ?? reservationAckFor(id, ack)`):
//     section 3 fails (the page's acknowledgement signs).
//   - drop the "unknown" return in wallet.ts (MUTATE_RESERVATION_CONFIRM: `if (false && ...)`): section 1 fails.
// PAIRED HONEST PATH: section 7, a granted reservation signs on the first approval, with no added latency.
//
// Run: npx tsx test/fill-reservation-confirm.test.mjs   (offline)
import assert from "node:assert/strict";
import { PRIV, world, stub, body, delayed, recordAnswer, truthful, H } from "./helpers/fillworld.mjs";

const tick = () => new Promise((r) => setTimeout(r, 0));
const settle = async () => { for (let i = 0; i < 10; i++) await tick(); };
const WIN = 77;
const mem = new Map();
let onRemoved = null;
const chrome = {
  runtime: {
    id: "cairnwallettestid", lastError: undefined,
    getURL: (p) => "chrome-extension://x/" + p,
    onMessage: { addListener: (fn) => { chrome.listener = fn; } },
    onConnect: { addListener: () => {} },
    onInstalled: { addListener: () => {} },
  },
  storage: { local: {
    get: async (k) => ({ [k]: structuredClone(mem.get(k)) }),
    set: async (o) => { for (const k of Object.keys(o)) mem.set(k, structuredClone(o[k])); },
    remove: async (k) => { mem.delete(k); },
  } },
  alarms: { create: () => {}, onAlarm: { addListener: () => {} } },
  action: { setBadgeText: () => {} },
  windows: { create: (opts, cb) => { cb?.({ id: WIN }); }, update: () => {}, onRemoved: { addListener: (fn) => { onRemoved = fn; } } },
};
globalThis.chrome = chrome;
globalThis.fetch = async () => ({ ok: false, status: 404, json: async () => ({}) });
globalThis.__CAIRN_TEST__ = true;
await import("../src/background.ts");
const bg = globalThis.__cairnBgWallet;

const APPROVE_PAGE = { id: "cairnwallettestid", url: "chrome-extension://x/approve.html", tab: { id: 1 } };
const popup = (method, ...args) => new Promise((res) => chrome.listener({ kind: "popup", method, args }, APPROVE_PAGE, res));
const call = async (method, ...args) => { const r = await popup(method, ...args); assert.equal(r.ok, true, `${method}: ${r.error}`); return r.result; };
const imported = await call("import", PRIV, "pw-confirm");
const ME = String(imported.addr).toLowerCase();

// One fill request from a page. `clarvis` is swappable so a re-run can see a different answer.
async function request(kind, clarvisFor, { scanMs = 0, params = {} } = {}) {
  const w = world(ME, kind);
  let clarvis = clarvisFor(w);
  bg.fillSpvIoForTest = () => w.io(scanMs);
  const st = stub(w, (init, u) => clarvis(init, u));
  const fetchFor = globalThis.fetch;
  // Each request owns its chain view and fetch stub; arm() puts them back before its own resolve.
  const arm = () => { globalThis.fetch = fetchFor; bg.fillSpvIoForTest = () => w.io(scanMs); };
  const out = { w, st, arm, reply: undefined, setClarvis: (f) => { clarvis = f(w); } };
  chrome.listener({ kind: "dapp", method: "fillOffer", params: { proposalId: w.fc.id, outputs: w.outputs, ...params } }, { origin: "https://dapp.test" }, (r) => { out.reply = r; });
  await settle();
  const q = await call("pending");
  out.id = q[q.length - 1].id;
  return out;
}
// The window's resolve for one request, with that request's chain view in place.
const resolveAs = (req, ...args) => { req.arm(); return call("resolve", req.id, ...args); };
// clarvis on the true chain for the offer, and a record 404 30 blocks past our fclaim: "unknown".
const unknown = (w) => (i, u) => (String(u).includes("/record/") ? recordAnswer({ ...w, truthLog: [] }, w.fc.height + 30) : body(w.truth)());
const ackFor = (req, over = {}) => ({ requestId: req.id, fclaimTxid: req.w.fc.id, ...over });
const queuedIds = async () => (await call("pending")).map((p) => p.id);
let n = 0;
const test = async (name, fn) => { await fn(); n++; console.log("  ok " + name); };

console.log("the reservation confirm step through the worker channel:");

let A;
await test("1. unknown: nothing signed, the facts reach the window, the request stays queued and unsettled", async () => {
  A = await request(null, unknown);
  const r = await resolveAs(A, true, ME);
  assert.equal(r.code, "RESERVATION_UNCONFIRMED", String(r.error));
  assert.equal(r.done, false);
  assert.deepEqual(r.unconfirmed, { fclaimTxid: A.w.fc.id.toLowerCase(), fclaimHeight: A.w.fc.height, tipHeight: A.w.fc.height + 30 });
  assert.equal(A.st.submits.length, 0);
  assert.equal(A.reply, undefined, "the dApp promise is not settled");
  assert.deepEqual(await queuedIds(), [A.id]);
});

await test("2. an acknowledgement for another request id or another fclaim is ignored", async () => {
  for (const bad of [ackFor(A, { requestId: "other-1" }), ackFor(A, { fclaimTxid: H(0x999) }), { requestId: A.id }, "yes", null]) {
    const r = await resolveAs(A, true, ME, undefined, bad);
    assert.equal(r.code, "RESERVATION_UNCONFIRMED", JSON.stringify(bad));
    assert.equal(A.st.submits.length, 0);
    assert.equal(A.reply, undefined);
  }
  assert.deepEqual(await queuedIds(), [A.id]);
});

await test("3. an acknowledgement from the page (in the request params) or a page-sent resolve is ignored", async () => {
  // The page names its own fclaim, which is exactly what an honest acknowledgement carries.
  const C = await request(null, unknown, { params: { reservationAck: "__FCLAIM__" } });
  const q = await call("pending");
  assert.equal(q.find((x) => x.id === C.id).params.reservationAck, "__FCLAIM__");
  const C2 = await (async () => {
    await resolveAs(C, false);
    const w = world(ME, null);
    return request(null, unknown, { params: { reservationAck: w.fc.id, ack: { requestId: "any", fclaimTxid: w.fc.id } } });
  })();
  assert.equal((await call("pending")).find((x) => x.id === C2.id).params.reservationAck, C2.w.fc.id, "the page sent the right fclaim");
  const r = await resolveAs(C2, true, ME);
  assert.equal(r.code, "RESERVATION_UNCONFIRMED", "the page's acknowledgement does not sign");
  assert.equal(C2.st.submits.length, 0);
  // A content script relaying a popup-kind resolve with the web page as sender is refused outright.
  const fromPage = await new Promise((res) => chrome.listener({ kind: "popup", method: "resolve", args: [C2.id, true, ME, undefined, ackFor(C2)] }, { id: "cairnwallettestid", url: "https://dapp.test/", origin: "https://dapp.test" }, res));
  assert.equal(fromPage.code, "FORBIDDEN");
  assert.equal(C2.st.submits.length, 0);
  assert.equal(C2.reply, undefined);
  assert.ok((await queuedIds()).includes(C2.id), "still queued for the window");
  await resolveAs(C2, false);
});

await test("4. Cancel rejects the request as a user rejection", async () => {
  const B = await request(null, unknown);
  assert.equal((await resolveAs(B, true, ME)).code, "RESERVATION_UNCONFIRMED");
  const r = await resolveAs(B, false);
  assert.equal(r.done, true);
  assert.deepEqual(B.reply, { ok: false, code: "USER_REJECTED", error: "rejected by user" });
  assert.equal(B.st.submits.length, 0);
  assert.ok(!(await queuedIds()).includes(B.id));
});

await test("5. Sign anyway signs exactly once, after the full preflight re-ran", async () => {
  const before = A.st.clarvisUrls.length;
  const r = await resolveAs(A, true, ME, undefined, ackFor(A));
  assert.equal(r.ok, true, String(r.error));
  assert.equal(A.st.submits.length, 1);
  assert.equal(A.st.clarvisUrls.length - before, 2, "both clarvis reads ran again");
  assert.equal(A.reply?.ok, true);
  assert.equal(typeof A.reply?.result?.txid, "string");
  const again = await resolveAs(A, true, ME, undefined, ackFor(A));
  assert.equal(again.done, false, "a second click finds nothing to sign");
  assert.equal(A.st.submits.length, 1);
  assert.ok(!(await queuedIds()).includes(A.id));
});

await test("6. a re-run that now says denied refuses even with the acknowledgement", async () => {
  const D = await request("hidden-hold", unknown);
  assert.equal((await resolveAs(D, true, ME)).code, "RESERVATION_UNCONFIRMED");
  D.setClarvis((w) => truthful(w));
  const r = await resolveAs(D, true, ME, undefined, ackFor(D));
  assert.equal(r.code, "RESERVATION_DENIED");
  assert.equal(D.st.submits.length, 0);
  assert.equal(D.reply?.result?.code, "RESERVATION_DENIED", "the dApp is told the fill was refused");
});

await test("7. honest path: a granted reservation signs on the first approval, with no added latency", async () => {
  const runs = async (cl) => {
    const t = [];
    for (let i = 0; i < 5; i++) {
      const R = await request(null, cl, { scanMs: 300 });
      const t0 = performance.now();
      const r = await resolveAs(R, true, ME);
      t.push(performance.now() - t0);
      assert.equal(r.ok, true, String(r.error));
      assert.equal(R.st.submits.length, 1);
      assert.equal(R.reply?.ok, true);
    }
    return t.sort((a, b) => a - b)[2];
  };
  const fast = await runs((w) => truthful(w));
  const slow = await runs((w) => delayed(3000, truthful(w)));
  console.log(`    honest fill through the worker, median of 5: clarvis instant ${fast.toFixed(1)} ms, clarvis 3,000 ms ${slow.toFixed(1)} ms`);
  assert.ok(slow - fast < 50 && slow < 1000);
});

await test("8. the window closing settles a confirm-step request APPROVAL_CLOSED, before or during the re-run", async () => {
  const E = await request(null, unknown);
  assert.equal((await resolveAs(E, true, ME)).code, "RESERVATION_UNCONFIRMED");
  onRemoved(WIN);
  await settle();
  assert.deepEqual(E.reply, { ok: false, code: "APPROVAL_CLOSED", error: "rejected (approval window closed)" });
  const F = await request(null, unknown, { scanMs: 200 });
  const inFlight = resolveAs(F, true, ME);
  await new Promise((r) => setTimeout(r, 50));
  onRemoved(WIN);
  await inFlight;
  assert.deepEqual(F.reply, { ok: false, code: "APPROVAL_CLOSED", error: "rejected (approval window closed)" });
  assert.equal(F.st.submits.length, 0);
  assert.deepEqual(await queuedIds(), []);
});

await test("9. the window closing during the Sign anyway re-run still signs: the user chose", async () => {
  const G = await request(null, unknown, { scanMs: 200 });
  assert.equal((await resolveAs(G, true, ME)).code, "RESERVATION_UNCONFIRMED");
  const inFlight = resolveAs(G, true, ME, undefined, ackFor(G));
  await new Promise((r) => setTimeout(r, 50));
  onRemoved(WIN);
  const r = await inFlight;
  assert.equal(r.ok, true, String(r.error));
  assert.equal(G.st.submits.length, 1);
  assert.equal(G.reply?.ok, true);
  assert.equal(typeof G.reply?.result?.txid, "string");
});

console.log(`fill-reservation-confirm: ${n} passed, 0 failed`);
