// "Second source not consulted": when clarvis's record read (the reservation verdict, offerxcheck.ts) had not
// answered or failed at the moment the fclaim-lane preflight judged the fill, the signed fill carries
// `secondSource: "pending" | "failed"` for the approval window. No new refusal and no wait: the fill signs the same
// bytes as the honest one. Through the real Wallet.fillOffer (test/helpers/fillworld.mjs).
//
// RED-FIRST: delete the MUTATE_SECOND_SOURCE_NOTE line in wallet.ts and section 2 fails; make
// secondSourceUnanswered return "failed" for every reply and section 1 fails (section 4 asserts the same on the
// honest call: no notice).
// The worker channel and the window: test/fill-reservation-confirm.test.mjs (11), test/approve-second-source-dom.test.mjs.
// Run: npx tsx test/fill-second-source-notice.test.mjs   (offline)
import assert from "node:assert/strict";
import { secondSourceUnanswered } from "../src/core/offerxcheck.js";
import { fill, body, always, notFound, netErr, garbage, delayed, digest, recordAnswer, truthful } from "./helpers/fillworld.mjs";

let n = 0;
const test = async (name, fn) => { await fn(); n++; console.log("  ok " + name); };
const recordOnly = (handler) => (w) => (i, u) => (String(u).includes("/cairnx/record/") ? handler(w)(i, u) : body(w.truth)());
let honestDigest = "";

console.log("second source not consulted:");

await test("1. secondSourceUnanswered over every reply shape", async () => {
  assert.equal(secondSourceUnanswered(undefined), "pending");
  assert.equal(secondSourceUnanswered(null), "failed", "an error, a timeout or an abort");
  assert.equal(secondSourceUnanswered({ ok: false, status: 503, body: { error: "x" } }), "failed");
  assert.equal(secondSourceUnanswered({ ok: false, status: 500, body: null }), "failed");
  assert.equal(secondSourceUnanswered({ ok: true, status: 200, body: null }), "failed", "a body that is not JSON");
  assert.equal(secondSourceUnanswered({ ok: true, status: 200, body: "applied" }), "failed");
  assert.equal(secondSourceUnanswered({ ok: true, status: 200, body: [] }), "failed");
  assert.equal(secondSourceUnanswered({ ok: true, status: 200, body: { applied: true } }), null);
  assert.equal(secondSourceUnanswered({ ok: false, status: 404, body: { tipHeight: 5 } }), null, "a 404 is an answer");
});

await test("4 (first, for the digest). honest path: clarvis answers, the fill signs with no notice", async () => {
  const x = await fill(null, (w) => truthful(w));
  assert.equal(x.r?.ok, true, String(x.r?.error));
  assert.equal("secondSource" in x.r, false, "no notice");
  assert.equal(x.st.submits.length, 1);
  honestDigest = digest(x.st.submits[0]);
  const lag = await fill(null, recordOnly((w) => () => recordAnswer(w, w.fc.height - 40)));
  assert.equal(lag.r?.ok, true);
  assert.equal("secondSource" in lag.r, false, "a lagging 404 is an answer: no notice");
});

await test("2. the record read still pending at the verdict: signed, the same bytes, secondSource pending, no wait", async () => {
  for (const [label, cl] of [["both reads slow", (w) => delayed(3000, truthful(w))], ["only the record read slow", recordOnly((w) => delayed(3000, truthful(w)))]]) {
    const x = await fill(null, cl, 300);
    assert.equal(x.r?.ok, true, `${label}: ${x.r?.error}`);
    assert.equal(x.r.secondSource, "pending", label);
    assert.equal(x.st.submits.length, 1);
    assert.equal(digest(x.st.submits[0]), honestDigest, `${label}: the honest bytes`);
    assert.ok(x.ms < 1000, `${label}: the fill did not wait for clarvis (${x.ms.toFixed(0)} ms with a 300 ms scan)`);
  }
});

await test("3. the record read failed: signed, the same bytes, secondSource failed", async () => {
  const cases = [
    ["a network error", always(netErr)],
    ["a body that is not JSON", always(garbage)],
    ["a 503", recordOnly(() => () => ({ ok: false, status: 503, json: async () => ({ error: "unavailable" }) }))],
  ];
  for (const [label, cl] of cases) {
    const x = await fill(null, cl);
    assert.equal(x.r?.ok, true, `${label}: ${x.r?.error}`);
    assert.equal(x.r.secondSource, "failed", label);
    assert.equal(digest(x.st.submits[0]), honestDigest, `${label}: the honest bytes`);
  }
  const nf = await fill(null, always(notFound));
  assert.equal("secondSource" in nf.r, false, "a 404 without tipHeight is an answer (no evidence, no notice)");
});

console.log(`fill-second-source-notice: ${n} passed, 0 failed`);
