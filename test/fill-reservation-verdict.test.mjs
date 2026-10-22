// The fclaim lane's second-source reservation verdict (offerxcheck.ts reservationRecordVerdict). A party that
// controls the wallet's header source can serve a short forged extension that hides a competing hold placed just
// before the buyer's fclaim: the scan grants the fclaim, the real chain denies it, and the payment burns. The
// competing hold ends before ours, so the offer check (secondSourceOfferConflict) passes it. clarvis's record of
// the fclaim (GET /cairnx/record/{fclaimTxid}) shows the denial.
//
//   1. The pure verdict over every branch.
//   2. Through the real preflight: a denied reservation refuses and submits nothing; the honest granted one and a
//      lagging clarvis proceed with the honest bytes. 2b: a 404 past our height plus the margin signs nothing and
//      returns RESERVATION_UNCONFIRMED for the approval window's confirm step.
//   3. Latency: a slow record read does not lengthen the fill past the scan.
//
// RED-FIRST: replace `rv?.kind === "denied"` in fillpreflight.ts fclaimLanePreflight (MUTATE_RESERVATION_VERDICT) with
// `false` and section 2's refusal assertion fails (the fill submits).
// Run: npx tsx test/fill-reservation-verdict.test.mjs   (offline)
import assert from "node:assert/strict";
import { reservationRecordVerdict, secondSourceOfferConflict, RECORD_LAG_MARGIN } from "../src/core/offerxcheck.js";
import { verifyFillSpv, requiredFillOutputs } from "../src/vendor/cairnx-spv.js";
import { H, PAY, world, body, always, notFound, netErr, garbage, delayed, fill, digest, recordAnswer, truthful } from "./helpers/fillworld.mjs";

console.log("1. reservationRecordVerdict (pure)");
{
  const FC = H(2), h = 1000;
  const ctx = { fclaimTxid: FC, provenHeight: h };
  const r200 = (b) => ({ ok: true, status: 200, body: b });
  const r404 = (b) => ({ ok: false, status: 404, body: b });
  const rec = { txid: FC, kind: "fclaim", applied: false, note: "offer already claimed (hold live)", height: h, tipHeight: h + 20 };
  const v = (reply, c = ctx) => reservationRecordVerdict(reply, c);

  assert.deepEqual(v(r200(rec)), { kind: "denied", note: "offer already claimed (hold live)" }, "denied with its note");
  assert.deepEqual(v(r200({ ...rec, txid: FC.toUpperCase().replace("0X", "0x") })), { kind: "denied", note: "offer already claimed (hold live)" }, "txid compare ignores case");
  assert.deepEqual(v(r200({ ...rec, note: null })), { kind: "denied", note: null }, "denied without a note");
  assert.deepEqual(v(r200({ ...rec, note: "x".repeat(161) })), { kind: "denied", note: null }, "an over-long note is dropped, the denial kept");
  assert.deepEqual(v(r200({ ...rec, note: "line\nbreak" })), { kind: "denied", note: null }, "a note with control characters is dropped");
  assert.deepEqual(v(r200(rec), { fclaimTxid: FC }), { kind: "denied", note: "offer already claimed (hold live)" }, "a denial needs no proven height");
  assert.equal(v(r200({ ...rec, applied: true })), null, "applied: no evidence");
  assert.equal(v(r200({ ...rec, applied: "false" })), null, "a non-boolean applied: no evidence");
  assert.equal(v(r200({ ...rec, applied: undefined })), null, "applied missing: no evidence");
  assert.equal(v(r200({ ...rec, kind: "offer" })), null, "a wrong kind: no evidence");
  assert.equal(v(r200({ ...rec, txid: H(3) })), null, "a different txid: no evidence");
  assert.equal(v(r200({ ...rec, txid: undefined })), null, "no txid: no evidence");

  const nf = (tipHeight) => r404({ ok: false, error: "no resolved record for this txid (not a CairnX record, or not yet scanned)", tipHeight });
  assert.equal(RECORD_LAG_MARGIN, 12);
  assert.deepEqual(v(nf(h + RECORD_LAG_MARGIN)), { kind: "unknown", tipHeight: h + 12 }, "404 at our height plus the margin: unknown");
  assert.deepEqual(v(nf(h + 500)), { kind: "unknown", tipHeight: h + 500 }, "404 far past our height: unknown");
  assert.equal(v(nf(h + RECORD_LAG_MARGIN - 1)), null, "404 one block inside the margin: a lagging source, no evidence");
  assert.equal(v(nf(h - 50)), null, "404 below our height: no evidence");
  assert.equal(v(nf(h + 500), { fclaimTxid: FC }), null, "404 with our proven height unknown: no evidence");
  assert.equal(v(nf("1100")), null, "404 with a string tipHeight: no evidence");
  assert.equal(v(nf(1.5e300)), null, "404 with an unsafe tipHeight: no evidence");
  assert.equal(v(r404({ ok: false, error: "x" })), null, "404 without tipHeight: no evidence");
  assert.equal(v({ ok: false, status: 500, body: { ...rec } }), null, "a 500 carrying a record body: no evidence");
  assert.equal(v({ ok: false, status: 503, body: { tipHeight: h + 500 } }), null, "a 503 with tipHeight: no evidence");
  for (const g of [undefined, null, { ok: true, status: 200, body: null }, { ok: true, status: 200, body: "denied" }, { ok: true, status: 200, body: [] }])
    assert.equal(v(g), null, `garbage ${JSON.stringify(g)}: no evidence`);
  console.log("  ok: every branch");
}

console.log("\n2. through the real preflight");
{
  // The attack world: the offer check alone passes it, verifyFillSpv grants it, the true chain denies it.
  const probe = world("0x" + "bb".repeat(20), "hidden-hold");
  const hidden = probe.withheld[0];
  assert.equal(probe.truthFclaimGranted, false, "the true chain denies our fclaim");
  const denial = probe.truthLog.find((e) => e.id === probe.fc.id);
  assert.equal(denial?.ok, false);
  assert.equal(denial?.note, "offer already claimed (hold live)");
  assert.ok(hidden.height > probe.fc.height - 12 && probe.truth.claimTxid === hidden.id, "the hidden hold sits three blocks below ours and holds the offer");
  assert.equal(secondSourceOfferConflict(probe.primary, probe.truth, { offerId: probe.offerId, fclaimTxid: probe.fc.id, ownHoldEnd: probe.holdEnd }), null,
    "the offer check passes it: the hidden hold ends before ours");
  const spv = await verifyFillSpv(probe.offerId, probe.fc.id, "0x" + "bb".repeat(20), probe.io(), { myLiveHoldsAtGrant: 0, pay: PAY, sums: Object.fromEntries(requiredFillOutputs(probe.primary, PAY).map((o) => [o.to, o.value])) });
  assert.equal(spv.safe, true, "verifyFillSpv over the forged view grants it");

  const denied = await fill("hidden-hold", (w) => truthful(w));
  assert.equal(denied.r?.ok, false, `denied reservation refuses (${denied.r?.error})`);
  assert.equal(denied.r?.code, "RESERVATION_DENIED");
  assert.equal(denied.st.submits.length, 0, "nothing submitted");
  assert.match(denied.r.error, /\(offer already claimed \(hold live\)\)/, "clarvis's note is shown as the reason");
  assert.equal(denied.r.error, "refusing to sign: the second source (clarvis) reports that the chain did not grant your reservation for this offer (offer already claimed (hold live)). The chain would take your payment and deliver nothing. Your resolver may be hiding a competing reservation; check the offer on the explorer before trying again.", "the refusal text names clarvis the second source");
  const recordReads = denied.st.clarvisUrls.filter((u) => u.includes("/cairnx/record/"));
  assert.deepEqual(recordReads, [`https://clarvis.cairn-substrate.com/trade/api/cairnx/record/${denied.w.fc.id}`], "one record read, by fclaim txid, at clarvis");
  console.log(`  ok: denied reservation refused, nothing submitted (${denied.r.code})`);

  // The paired honest path: the same flow, clarvis on the honest chain says applied.
  const honest = await fill(null, (w) => truthful(w));
  assert.equal(honest.r?.error, undefined);
  assert.equal(honest.r?.ok, true);
  assert.equal(honest.st.submits.length, 1);
  const honestDigest = digest(honest.st.submits[0]);
  assert.equal((await recordAnswer(honest.w).json()).applied, true, "the honest record says applied");
  console.log("  ok: honest granted reservation proceeds");

  const cases = [
    ["a lagging clarvis (404 below our height)", (w) => (i, u) => (u.includes("/record/") ? recordAnswer(w, w.fc.height - 40) : body(w.truth)())],
    ["a lagging clarvis (404 one block inside the margin)", (w) => (i, u) => (u.includes("/record/") ? recordAnswer(w, w.fc.height + 11) : body(w.truth)())],
    ["clarvis 404 everywhere", always(notFound)],
    ["clarvis network error", always(netErr)],
    ["clarvis garbage body", always(garbage)],
    ["clarvis timeout", always(delayed(30_000, notFound))],
  ];
  for (const [label, cl] of cases) {
    const x = await fill(null, cl);
    assert.equal(x.r?.ok, true, `${label}: proceeds (${x.r?.error})`);
    assert.equal(x.st.submits.length, 1);
    assert.equal(digest(x.st.submits[0]), honestDigest, `${label}: same bytes as the honest fill`);
    console.log(`  ok: ${label} proceeds with the honest bytes`);
  }
}

console.log("\n2a. accepted: a clarvis on a stale fork denies a reservation the current chain grants; the fill refuses");
{
  const stale = await fill(null, (w) => (i, u) => (u.includes("/record/")
    ? body({ txid: w.fc.id, kind: "fclaim", applied: false, note: "offer already claimed (hold live)", height: w.fc.height, tipHeight: w.tip })()
    : body(w.truth)()));
  assert.equal(stale.w.truthFclaimGranted, true, "the current chain grants the fclaim");
  assert.equal(stale.r?.code, "RESERVATION_DENIED", "the denial still refuses (the buyer retries later)");
  assert.equal(stale.st.submits.length, 0);
  console.log("  ok: a stale-fork denial refuses; accepted (Rule B in the design note)");
}

console.log("\n2b. an unknown reservation goes to the confirm step (the window's side: test/fill-reservation-confirm.test.mjs)");
{
  const unknown = (w) => (i, u) => (u.includes("/record/") ? recordAnswer({ ...w, truthLog: [] }, w.fc.height + 30) : body(w.truth)());
  const x = await fill(null, unknown);
  assert.equal(x.r?.code, "RESERVATION_UNCONFIRMED", String(x.r?.error));
  assert.equal(x.st.submits.length, 0, "nothing submitted");
  assert.equal(x.r.error, `the second source has read the chain to block ${x.w.fc.height + 30} and has no record of your reservation (block ${x.w.fc.height}); confirm in the approval window to sign anyway`);
  assert.deepEqual(x.r.unconfirmed, { fclaimTxid: x.w.fc.id.toLowerCase(), fclaimHeight: x.w.fc.height, tipHeight: x.w.fc.height + 30 });
  console.log("  ok: 404 past our height plus the margin returns RESERVATION_UNCONFIRMED and signs nothing");
}

console.log("\n3. latency: the record read never lengthens the fill past the scan");
{
  // The scan is simulated at 300 ms. Median of 5: clarvis instant vs clarvis answering after 3 s on both routes.
  const runs = async (cl) => { const t = []; for (let i = 0; i < 5; i++) t.push((await fill(null, cl, 300)).ms); return t.sort((a, b) => a - b)[2]; };
  const fast = await runs((w) => truthful(w));
  const slow = await runs((w) => delayed(3000, truthful(w)));
  console.log(`    honest fill wall-clock, median of 5: clarvis instant ${fast.toFixed(1)} ms, clarvis 3,000 ms ${slow.toFixed(1)} ms`);
  assert.ok(slow - fast < 50 && slow < 1000, `a 3 s clarvis adds under 50 ms to a 300 ms scan (instant ${fast.toFixed(1)}, slow ${slow.toFixed(1)})`);
  const inScan = await fill("hidden-hold", (w) => delayed(100, truthful(w)), 300);
  assert.equal(inScan.r?.code, "RESERVATION_DENIED", "a denial that arrives within the scan is used");
  const late = await fill("hidden-hold", (w) => delayed(1000, truthful(w)), 300);
  assert.equal(late.r?.ok, true, "a denial that arrives after the scan is not waited for (the stated residual)");
  console.log("  ok: no added latency; an in-scan denial refuses, a late one is not awaited");
}

console.log("\nfill-reservation-verdict: all assertions passed");
