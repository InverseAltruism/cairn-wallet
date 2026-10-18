// M-1: fclaim-lane pre-window withholding. The fill SPV scan covers [tip - 223, tip]; a primary resolver that
// withholds an older cancel or consuming fill serves the buyer's fclaim as granted, verifyFillSpv returns safe and
// the buyer pays for nothing. The wallet now reads the offer from the second resolver (clarvis) by offer id while
// the scan runs and refuses on positive evidence only (OFFER_SOURCE_CONFLICT).
//
//   1. secondSourceOfferConflict unit table (pure).
//   1b. The holder rule against the vendored replay: another fclaim with our expiry epoch refuses, the previous
//      holder a lagging source shows does not.
//   2. The PoC (cancel / 90% partial fill withheld ~1,400 blocks before the buy) through the REAL wallet preflight:
//      with clarvis telling the truth it is refused and nothing is submitted; with clarvis 404 it still submits
//      (the gap is open when the second source is down, and this is the red-first for the wallet change).
//   3. Acceptance (a)-(g): cancelled / higher paid / later holder refuse; agree / 404 / timeout / garbage proceed,
//      and the honest fill submits the same bytes as the 0.2.72 tree.
//   4. Latency: a slow clarvis does not lengthen the honest fill (the read runs beside the scan, never awaited).
//
// RED-FIRST: replace the secondSourceOfferConflict call in wallet.ts fclaimLanePreflight with `null` and the
// refusal rows of sections 2 and 3 go red.
// Run: node --import tsx test/fill-offer-crosscheck.test.mjs   (offline)
import { secondSourceOfferConflict } from "../src/core/offerxcheck.js";
import { verifyFillSpv, requiredFillOutputs, resolve, offer, fclaim, fclaimHoldEnd, epochOf, EPOCH_LEN, MAX_SCAN } from "../src/vendor/cairnx-spv.js";
import { H, S, C, PAY, world, eventMaker, body, always, notFound, netErr, garbage, delayed, fill, digest } from "./helpers/fillworld.mjs";
import { checker } from "./helpers/check.mjs";

const { check, done } = checker();

console.log("1. secondSourceOfferConflict (pure)");
{
  const OID = H(1), FC = H(2), OTHER = H(3);
  const P = { id: OID, status: "open", paid: "100", delivered: "10", claimTxid: FC, claimUntilHeight: 1200 };
  const ctx = { offerId: OID, fclaimTxid: FC, ownHoldEnd: 1199 };
  const x = (second, c = ctx, primary = P) => secondSourceOfferConflict(primary, second, c);
  for (const st of ["cancelled", "filled", "expired"]) check(`status ${st} refuses`, /is /.test(x({ ...P, status: st }) ?? ""));
  check("status open, same progress, same holder: no conflict", x({ ...P }) === null);
  check("unknown status string is not evidence", x({ ...P, status: "weird" }) === null);
  check("higher paid refuses", /paid/.test(x({ ...P, paid: "101" }) ?? ""));
  check("higher delivered refuses", /delivered/.test(x({ ...P, delivered: "11" }) ?? ""));
  check("paid on a primary that omits it (0) refuses", /paid/.test(x({ ...P, paid: "1" }, ctx, { ...P, paid: undefined }) ?? ""));
  check("lower or equal paid (a lagging source) proceeds", x({ ...P, paid: "50", delivered: "10" }) === null && x({ ...P, paid: "100" }) === null);
  check("second source omitting paid is not evidence", x({ ...P, paid: undefined, delivered: undefined }) === null);
  check("malformed paid is not evidence", x({ ...P, paid: "1e9" }) === null && x({ ...P, paid: -5 }) === null);
  check("a later reservation by another fclaim refuses, naming its end", x({ ...P, claimTxid: OTHER, claimUntilHeight: 1230 }) === "another reservation holds this offer through block 1229");
  check("an earlier holder (a source that has not seen our grant) proceeds", x({ ...P, claimTxid: OTHER, claimUntilHeight: 1150 }) === null);
  check("a different holder without a usable hold end proceeds", x({ ...P, claimTxid: OTHER, claimUntilHeight: "1230" }) === null && x({ ...P, claimTxid: OTHER, claimUntilHeight: undefined }) === null);
  check("a different holder with our hold end unknown proceeds", x({ ...P, claimTxid: OTHER, claimUntilHeight: 1230 }, { offerId: OID, fclaimTxid: FC }) === null);
  check("no claimTxid on the second source (not indexed yet) proceeds", x({ ...P, claimTxid: undefined, claimUntilHeight: undefined }) === null);
  check("holder compare ignores case", x({ ...P, claimTxid: FC.toUpperCase().replace("0X", "0x"), claimUntilHeight: 5000 }) === null);
  check("a body for a different offer id is ignored", x({ ...P, id: OTHER, status: "cancelled" }) === null);
  for (const g of [null, undefined, "cancelled", 7, [], { ok: false, error: "unknown offer" }]) check(`garbage ${JSON.stringify(g)} proceeds`, x(g) === null);
}

console.log("\n1b. the holder rule against the replay: an equal expiry epoch is a conflict, an earlier one is not");
{
  // ownHoldEnd is the last block our fclaim holds (fclaimHoldEnd); claimUntilHeight is the first block another
  // fclaim no longer holds ((E + 1) * 30), so the same epoch E gives until = ownHoldEnd + 1.
  const OID = H(1), FC = H(2), OTHER = H(3), E = 39;
  const P = { id: OID, status: "open", claimTxid: FC, claimUntilHeight: (E + 1) * EPOCH_LEN };
  const ctx = { offerId: OID, fclaimTxid: FC, ownHoldEnd: fclaimHoldEnd(E) };
  check("another fclaim with our expiry epoch refuses, naming its end", secondSourceOfferConflict(P, { ...P, claimTxid: OTHER, claimUntilHeight: (E + 1) * EPOCH_LEN }, ctx) === `another reservation holds this offer through block ${(E + 1) * EPOCH_LEN - 1}`);
  check("another fclaim one epoch earlier proceeds", secondSourceOfferConflict(P, { ...P, claimTxid: OTHER, claimUntilHeight: E * EPOCH_LEN }, ctx) === null);

  // Replay: a competing fclaim with our epoch, granted first, is still held at our grant, so ours is denied and
  // the chain shows it as the holder. The previous holder of a granted fclaim has a lower epoch, since replay
  // grants ours only once that hold has ended.
  const { PE, token } = eventMaker(5000);
  const base = token();
  const o = PE(S, offer({ give: { ticker: "TOKA", amount: "1000" }, want: { value: String(1000e8) } }), 115010, epochOf(115010) + 200);
  base.push(o);
  const h = 116490, eh = epochOf(h);
  const theirs = PE(C, fclaim({ offer: o.id }), h - 3, eh + 1);
  const ours = PE("0x" + "bb".repeat(20), fclaim({ offer: o.id }), h, eh + 1);
  const applied = (st, ev) => st.events.find((e) => e.id === ev.id)?.ok;
  const same = resolve([...base, theirs, ours], h + 10);
  check("replay: an equal-epoch fclaim granted first denies ours", applied(same, theirs) === true && applied(same, ours) === false);
  check("replay: ...and the chain's holder ends exactly one block past our hold end",
    same.offers[o.id].claimTxid === theirs.id && same.offers[o.id].claimUntilHeight === fclaimHoldEnd(ours.expiresEpoch) + 1);
  check("replay: ...so the second source's honest answer refuses",
    secondSourceOfferConflict(same.offers[o.id], same.offers[o.id], { offerId: o.id, fclaimTxid: ours.id, ownHoldEnd: fclaimHoldEnd(ours.expiresEpoch) }) !== null);
  const prev = PE(C, fclaim({ offer: o.id }), h - 40, epochOf(h - 40));
  const after = PE("0x" + "bb".repeat(20), fclaim({ offer: o.id }), (prev.expiresEpoch + 1) * EPOCH_LEN, prev.expiresEpoch + 2);
  const seq = resolve([...base, prev, after], after.height + 5);
  const lagging = resolve([...base, prev], after.height - 1).offers[o.id];
  check("replay: ours is granted at the first block the previous hold no longer covers", applied(seq, prev) === true && applied(seq, after) === true && after.expiresEpoch > prev.expiresEpoch);
  check("replay: a lagging source still showing that previous holder proceeds",
    lagging.claimTxid === prev.id && secondSourceOfferConflict(seq.offers[o.id], lagging, { offerId: o.id, fclaimTxid: after.id, ownHoldEnd: fclaimHoldEnd(after.expiresEpoch) }) === null);
}

// Submit body of the honest fill below, captured on the unmodified 0.2.72 tree (origin/master 5945710) with the
// same key, world and coin. That tree makes no clarvis request on this lane.
const DIGEST_0272 = "7bab37e2d90cb06be538cb11f31c6829831801a23a2c6c22cba7d8a712397c11";

console.log("\n2. the security PoC through the real wallet preflight");
for (const kind of ["cancel", "partial"]) {
  const label = kind === "cancel" ? "A: pre-window CANCEL withheld" : "B: pre-window 90% PARTIAL FILL withheld";
  const probe = world("0x" + "bb".repeat(20), kind);
  check(`${label}: the withheld events sit below the scan window (${probe.withheld.map((e) => e.height)} < ${probe.tip - (MAX_SCAN + 89)})`,
    probe.withheld.every((e) => e.height < probe.tip - (MAX_SCAN + 89)));
  const truthy = kind === "cancel" ? probe.truth.status === "cancelled" : probe.truth.status === "open" && probe.truth.paid === String(900e8);
  check(`${label}: truth is ${kind === "cancel" ? "cancelled" : "paid 900 CSD"}; the primary serves open with nothing paid`, truthy && probe.primary.status === "open" && (probe.primary.paid ?? "0") === "0");
  const v = await verifyFillSpv(probe.offerId, probe.fc.id, "0x" + "bb".repeat(20), probe.io(), { myLiveHoldsAtGrant: 0, pay: PAY, sums: Object.fromEntries(requiredFillOutputs(probe.primary, PAY).map((o) => [o.to, o.value])) });
  check(`${label}: verifyFillSpv alone says safe (the gap is real in the vendored boundary)`, v.safe === true);
  const down = await fill(kind, always(notFound));
  check(`${label}: clarvis 404 -> the wallet still submits (gap open while the second source is down) (${down.r?.error ?? "ok"})`, down.r?.ok === true && down.st.submits.length === 1);
  const told = await fill(kind, (w) => body(w.truth));
  check(`${label}: clarvis tells the truth -> REFUSED with OFFER_SOURCE_CONFLICT (${told.r?.error})`, told.r?.ok === false && told.r?.code === "OFFER_SOURCE_CONFLICT");
  check(`${label}: ...nothing submitted`, told.st.submits.length === 0);
  const offerReads = told.st.clarvisUrls.filter((u) => u.includes("/cairnx/offer/"));
  check(`${label}: ...clarvis was asked for the offer once, by OFFER id`, offerReads.length === 1 && offerReads[0].endsWith(`/cairnx/offer/${told.w.offerId}`));
}

console.log("\n3. acceptance (a)-(g)");
{
  const a = await fill("cancel", (w) => body({ ...w.primary, status: "cancelled" }));
  check(`(a) second source shows the offer cancelled: refused, nothing submitted (${a.r?.code})`, a.r?.code === "OFFER_SOURCE_CONFLICT" && a.st.submits.length === 0);
  // SECURITY.md: clarvis has the default resolver's operator, so the copy names it the second source, never independent.
  check(`(a) the refusal text (${a.r?.error})`, a.r?.error === "refusing to sign: the second source (clarvis) reports that this offer is cancelled, while your resolver shows it open. Paying now would likely be lost. Reload the offer and check it on the explorer before trying again.");
  const b = await fill(null, (w) => body({ ...w.primary, paid: String(100e8), delivered: "100" }));
  check(`(b) second source shows higher paid progress: refused, nothing submitted (${b.r?.code})`, b.r?.code === "OFFER_SOURCE_CONFLICT" && b.st.submits.length === 0);
  const c = await fill(null, (w) => body({ ...w.primary, claimTxid: H(0xdead), claimUntilHeight: w.holdEnd + 1 + 30 }));
  check(`(c) second source shows a later claim holder: refused, nothing submitted (${c.r?.code})`, c.r?.code === "OFFER_SOURCE_CONFLICT" && c.st.submits.length === 0);
  const cLag = await fill(null, (w) => body({ ...w.primary, claimTxid: H(0xbeef), claimUntilHeight: 116400 }));
  check(`(c, paired) second source still shows the PREVIOUS holder (lagging): proceeds (${cLag.r?.error ?? "ok"})`, cLag.r?.ok === true && cLag.st.submits.length === 1);

  const d = await fill(null, (w) => body(w.truth));
  check(`(d) both sources agree the offer is open: the fill submits (${d.r?.error ?? "ok"})`, d.r?.ok === true && d.st.submits.length === 1);
  check(`(d) ...with the same bytes as the 0.2.72 tree (sha256 ${digest(d.st.submits[0]).slice(0, 12)})`, digest(d.st.submits[0]) === DIGEST_0272);
  for (const [tag, cl] of [["(e) 404", always(notFound)], ["(f) timeout", always(delayed(30_000, notFound))], ["(g) garbage body", always(garbage)], ["(g) network error", always(netErr)], ["(g) error envelope", always(body({ ok: false, error: "unknown offer" }))]]) {
    const x = await fill(null, cl);
    check(`${tag}: the fill proceeds with the same bytes (${x.r?.error ?? "ok"})`, x.r?.ok === true && x.st.submits.length === 1 && digest(x.st.submits[0]) === DIGEST_0272);
  }
}

console.log("\n4. latency: the second-source read never lengthens the honest fill");
{
  // The scan is simulated at 300 ms. Median of 5 runs each: clarvis instant 404 vs clarvis that answers after 3 s.
  const runs = async (cl) => { const t = []; for (let i = 0; i < 5; i++) t.push((await fill(null, cl, 300)).ms); return t.sort((x, y) => x - y)[2]; };
  const fast = await runs(always(notFound));
  const slow = await runs(always(delayed(3000, notFound)));
  console.log(`    honest fill wall-clock, median of 5: clarvis instant ${fast.toFixed(1)} ms, clarvis 3,000 ms ${slow.toFixed(1)} ms`);
  check(`a 3 s clarvis adds under 50 ms to a 300 ms scan (instant ${fast.toFixed(1)} ms, slow ${slow.toFixed(1)} ms)`, slow - fast < 50 && slow < 1000);
  const inScan = await fill("cancel", (w) => delayed(100, body(w.truth)), 300);
  check(`a truthful clarvis that answers within the scan (100 ms < 300 ms) is used: refused (${inScan.r?.code})`, inScan.r?.code === "OFFER_SOURCE_CONFLICT");
  const late = await fill("cancel", (w) => delayed(1000, body(w.truth)), 300);
  check(`a truthful clarvis that answers after the scan is not waited for: proceeds (stated limit) (${late.r?.error ?? "ok"})`, late.r?.ok === true);
}

done("fill-offer-crosscheck");
