// Clear-signing formatter coverage — the previously-untested "what am I signing?" layer (the user's
// last line of defense). Focus: C-WL5 (no "NaN CSD"), HTML-escaping of dApp strings, address-poisoning.
import { fmtCsd, fmtCsdBig, baseVal, describe, debitOf, lookalikeOf, costLine, escapeHtml, expiryLine, nfinalizeApproveGate } from "../src/popup/clearsign.js";
import { explorerLink } from "../src/core/wallet.js";
import { buildNameRenew, CAIRNX_DOMAIN, TREASURY_ADDR } from "../src/core/cairnx.js";
import { REG_COMMIT_MAX_BLOCKS, REG_FINALIZE_GRACE_BLOCKS } from "../src/vendor/cairnx-spv.js";
declare const process: { exit(code: number): void };

let pass = 0, fail = 0;
const ok = (n: string, c: boolean) => { c ? pass++ : fail++; console.log(`  ${c ? "PASS" : "FAIL"} ${n}`); };
const ADDR = "0x" + "ab".repeat(20);

// C-WL5 — a malicious/garbage amount must NEVER render "NaN CSD"
ok("fmtCsd(valid) → CSD", fmtCsd(150000000) === "1.5 CSD");
ok("fmtCsd('abc') → 'invalid amount' (not NaN)", fmtCsd("abc") === "invalid amount");
ok("fmtCsd(NaN) → 'invalid amount'", fmtCsd(NaN) === "invalid amount");
ok("fmtCsd({}) → 'invalid amount'", fmtCsd({}) === "invalid amount");

// LOW-2 — offer/bid CSD `value` (a base-unit STRING up to 2^96) rendered EXACTLY via BigInt.
// Independent ground truth: the exact decimal is hand-derived, and the old Number() path is shown
// to diverge above 2^53, so this is non-self-fulfilling.
const bigVal = "9007199254740993"; // 2^53 + 1 base units
ok("fmtCsdBig exact above 2^53 (no precision loss)", fmtCsdBig(bigVal) === "90071992.54740993 CSD");
ok("old Number() path WOULD have diverged (independent check)", `${Number(bigVal) / 1e8} CSD` !== "90071992.54740993 CSD");
ok("fmtCsdBig('500000000') → '5 CSD'", fmtCsdBig("500000000") === "5 CSD");
ok("fmtCsdBig('100000000') → '1 CSD'", fmtCsdBig("100000000") === "1 CSD");
ok("fmtCsdBig('1') → '0.00000001 CSD'", fmtCsdBig("1") === "0.00000001 CSD");
ok("fmtCsdBig('-1') → 'invalid amount'", fmtCsdBig("-1") === "invalid amount");
ok("fmtCsdBig('abc') → 'invalid amount'", fmtCsdBig("abc") === "invalid amount");
ok("baseVal('abc') → 0 (finite for sums)", baseVal("abc") === 0);
ok("baseVal(5) → 5", baseVal(5) === 5);
const badSend = describe({ method: "send", params: { to: ADDR, amount: "evil" } });
ok("describe(send, non-numeric amount): shows 'invalid amount', never 'NaN'", badSend.includes("invalid amount") && !badSend.includes("NaN"));
ok("describe(propose, non-numeric fee): no 'NaN'", !describe({ method: "propose", params: { domain: "d", fee: "evil" } }).includes("NaN"));
ok("costLine(send, garbage): no 'NaN'", !costLine({ method: "send", params: { amount: "x", fee: "y" } }).includes("NaN"));
ok("debitOf is always finite", Number.isFinite(debitOf({ method: "send", params: { amount: "x", fee: "y" } })));

// HTML-escaping of dApp-controlled strings in the clear-signing dialog (no injection)
const xss = describe({ method: "propose", params: { domain: '"><img src=x onerror=alert(1)>', fee: 1000 } });
ok("describe escapes a malicious domain (no raw <img>)", !xss.includes("<img") && xss.includes("&lt;img"));
ok("escapeHtml neutralizes <script>", escapeHtml("<script>") === "&lt;script&gt;");

// EXP-XSS-1/2 regression — any URL flowing into an href (explorer link, trade-name link) is escapeHtml'd at the
// render layer so a malicious custom-explorer/API base cannot break out of the href attribute and inject markup.
{
  const evilBase = 'https://evil.example/"><img src=x onerror=alert(1)>';
  const rendered = escapeHtml(explorerLink(evilBase, "tx", "0xdeadbeef")); // what popup.ts puts inside href="…"
  ok("EXP-XSS: rendered href has no raw <, >, or \" (cannot break out of the attribute)", !/[<>"]/.test(rendered));
  ok("EXP-XSS: the injected <img is neutralized to inert &lt;img text (not a live tag)", !rendered.includes("<img") && rendered.includes("&lt;img"));
}

// fillOffer (Attest + payment in one tx) — clear-signs like send, plus the offer id
const fo = { method: "fillOffer", params: { proposalId: "0x" + "aa".repeat(32), score: 100, confidence: 100, outputs: [{ to: ADDR, value: 200_000_000 }], fee: 5_000_000 } };
const foHtml = describe(fo);
ok("describe(fillOffer) names the action + the offer id", foHtml.includes("Fill offer") && foHtml.includes("aa".repeat(32)));
ok("describe(fillOffer) clear-signs the full recipient + amount", foHtml.includes(ADDR) && foHtml.includes("2 CSD"));
ok("describe(fillOffer) shows the fee + signed score/confidence", foHtml.includes("0.05 CSD") && foHtml.includes("score 100"));
ok("describe(fillOffer) mounts the address-poisoning warn slot", foHtml.includes('id="send-warn"'));
ok("debitOf(fillOffer) = outputs + fee", debitOf(fo) === 205_000_000);
ok("costLine(fillOffer) shows paid + fee, atomic", costLine(fo).includes("2 CSD") && costLine(fo).includes("0.05 CSD") && costLine(fo).toLowerCase().includes("atomic"));
const foBad = describe({ method: "fillOffer", params: { proposalId: "0x" + "aa".repeat(32), outputs: [{ to: ADDR, value: "evil" }], fee: "junk" } });
ok("describe(fillOffer, garbage amounts): 'invalid amount', never 'NaN'", foBad.includes("invalid amount") && !foBad.includes("NaN"));
ok("debitOf(fillOffer, garbage) is finite", Number.isFinite(debitOf({ method: "fillOffer", params: { outputs: [{ value: "x" }], fee: "y" } })));
const foXss = describe({ method: "fillOffer", params: { proposalId: '"><img src=x onerror=alert(1)>', outputs: [{ to: "<script>", value: 1 }], fee: 1 } });
ok("describe(fillOffer) escapes hostile offer id + recipient", !foXss.includes("<img") && !foXss.includes("<script>"));

// propose with value outputs (CairnX fee) — shown NEUTRALLY as funds leaving + address-poisoning slot.
// A malicious dApp must NOT be able to disguise a payout to itself as a benign "fee".
const propFee = { method: "propose", params: { domain: "cairnx:v1", payloadHash: "0x" + "11".repeat(32), uri: '{"t":"name"}', expiresEpoch: 1, fee: 25000000, outputs: [{ to: ADDR, value: 100000000 }] } };
const pfHtml = describe(propFee);
ok("describe(propose+outputs) labels them NEUTRALLY as funds leaving (not a benign 'fee')", /transfers funds out/i.test(pfHtml) && !pfHtml.includes("protocol fee"));
ok("describe(propose+outputs) shows the full recipient + amount", pfHtml.includes(ADDR) && pfHtml.includes("1 CSD"));
ok("describe(propose+outputs) mounts the address-poisoning warn slot (#send-warn)", pfHtml.includes('id="send-warn"'));
ok("debitOf(propose+outputs) = outputs + anchor fee (true funds leaving)", debitOf(propFee) === 100000000 + 25000000);
ok("costLine(propose+outputs) says funds transferred out", /transferred out/i.test(costLine(propFee)));
ok("describe(propose with NO outputs) shows no transfer-out warning", !/transfers funds out/i.test(describe({ method: "propose", params: { domain: "d", fee: 1 } })));
ok("describe(propose, garbage output value): no NaN", !describe({ method: "propose", params: { domain: "d", fee: 1, outputs: [{ to: ADDR, value: "x" }] } }).includes("NaN"));

// v1.2 token-priced fill (confidence = 1 000 000, typically ZERO outputs): the resolver debits the
// user's CairnX token balance, so an outputs-free fill must NEVER clear-sign as "free".
const foTok = { method: "fillOffer", params: { proposalId: "0x" + "bb".repeat(32), score: 100, confidence: 1_000_000, outputs: [], fee: 5_000_000 } };
const foTokHtml = describe(foTok);
ok("describe(token fill) warns it SPENDS TOKENS from the CairnX balance", /SPENDS TOKENS/.test(foTokHtml));
ok("describe(token fill) still shows the signed confidence value", foTokHtml.includes("confidence 1000000"));
ok("costLine(token fill) mentions the token debit", /tokens debited/i.test(costLine(foTok)));
ok("describe(normal CSD fill) does NOT show the token warning", !/SPENDS TOKENS/.test(foHtml));
ok("costLine(normal CSD fill) does NOT mention token debits", !/tokens debited/i.test(costLine(fo)));
ok("describe(confidence 999999 ≠ marker) does NOT show the token warning",
  !/SPENDS TOKENS/.test(describe({ method: "fillOffer", params: { proposalId: "0x" + "cc".repeat(32), confidence: 999_999, outputs: [], fee: 1 } })));

// v1.7 claim-to-fill — a score-50 / confidence-0 attest is a PAYMENT-FREE reservation of an open CSD
// offer; the wallet must label it "Reserve an open offer" and say it moves no money, so the user can
// tell it apart from the fill that pays. (The attest method never carries value outputs.)
const claim = describe({ method: "attest", params: { proposalId: "0x" + "dd".repeat(32), score: 50, confidence: 0, fee: 5_000_000 } });
ok("describe(claim score50/conf0) labels it 'Reserve an open offer'", /Reserve an open offer/.test(claim));
ok("describe(claim) states it MOVES NO MONEY (no payment)", /moves no money/i.test(claim) && /no payment/i.test(claim));
ok("describe(claim) does NOT show the token-spend warning", !/SPENDS TOKENS/.test(claim));
const sup = describe({ method: "attest", params: { proposalId: "0x" + "ee".repeat(32), score: 80, confidence: 70, fee: 5_000_000 } });
ok("describe(ordinary attest score80) stays 'Support / review' (claim label is score50/conf0 only)", /Support \/ review/.test(sup) && !/Reserve an open offer/.test(sup));
const atok = describe({ method: "attest", params: { proposalId: "0x" + "ff".repeat(32), score: 100, confidence: 1_000_000, fee: 5_000_000 } });
ok("describe(token-fill attest conf1e6) STILL warns SPENDS TOKENS (claim branch didn't swallow it)", /SPENDS TOKENS/.test(atok));

// F6 — the dApp-supplied expiresEpoch is part of the SIGNED bytes (csdtx.ts u64) and must be shown
// in the approval window so a site can't commit a record claimable for years past what the user expects.
{
  const EXP = 500000;
  const raw = describe({ method: "propose", params: { domain: "csd:test", payloadHash: "0x" + "11".repeat(32), uri: "x", fee: 1000000, expiresEpoch: EXP } });
  ok("describe(propose) RENDERS the signed expiresEpoch (F6 — was silently dropped)", raw.includes("expires") && raw.includes(String(EXP)));
  const cx = describe({ method: "propose", params: { domain: "cairnx:v1", payloadHash: "0x" + "11".repeat(32), uri: '{"t":"name"}', fee: 25000000, expiresEpoch: EXP } });
  ok("describe(propose, cairnx branch) ALSO renders the expiry", cx.includes("expires") && cx.includes(String(EXP)));
  ok("describe(propose, no expiresEpoch) omits the expiry line cleanly", !describe({ method: "propose", params: { domain: "d", fee: 1 } }).includes("expires"));

  // expiryLine: raw epoch alone when the current epoch is unknown (offline)
  ok("expiryLine shows the raw epoch when current epoch unknown", expiryLine(1234) === "expires: epoch 1234");
  ok("expiryLine() empty for absent expiry", expiryLine(undefined) === "" && expiryLine(null) === "");
  ok("expiryLine flags a non-integer/garbage epoch (never 'NaN')", expiryLine("evil").includes("invalid") && !expiryLine("evil").includes("NaN"));
  // with a known current epoch → humanized remaining window
  const near = expiryLine(100 + 24, 100); // +24 epochs ≈ 1 day
  ok("expiryLine humanizes the remaining window from the current epoch", /in ~1 day/.test(near) && near.includes("current epoch 100"));
  ok("expiryLine WARNs on an unusually long claim window (mirrors FEE_WARN)", /unusually long/.test(expiryLine(100 + 100001, 100)));
  ok("expiryLine does NOT warn on a normal horizon", !/unusually long/.test(expiryLine(100 + 24, 100)));
  ok("expiryLine flags an already-past expiry as a no-op", /already past/.test(expiryLine(50, 100)));
  // the warn flows through describe() when approve.ts supplies r.currentEpoch
  const warned = describe({ method: "propose", params: { domain: "d", fee: 1, expiresEpoch: 100 + 200000 }, currentEpoch: 100 });
  ok("describe(propose) surfaces the long-window WARN when current epoch is known", /unusually long/.test(warned));
}

// Address-poisoning: flag a head8/tail4 twin, but not an unrelated or identical address
const real = "0xabcd1234" + "0".repeat(28) + "beef";
const twin = "0xabcd1234" + "9".repeat(28) + "beef"; // same head8 + tail4, different middle
const other = "0xffff0000" + "0".repeat(28) + "0000";
ok("lookalikeOf flags a head/tail twin", lookalikeOf(twin, [real]) === real);
ok("lookalikeOf does NOT flag an unrelated address", lookalikeOf(other, [real]) === null);
ok("lookalikeOf does NOT flag an identical address", lookalikeOf(real, [real]) === null);

// WYSIWYS-TRUNC-1 — a multi-output send with MORE recipients than the display cap must LOUDLY disclose the
// hidden recipients + their TOTAL (not a quiet "…and N more"), so a dApp can't hide where funds go.
{
  const manyOuts = Array.from({ length: 15 }, (_, i) => ({ to: "0x" + (i + 1).toString(16).padStart(40, "0"), value: 1e8 }));
  const manyHtml = describe({ method: "send", params: { outputs: manyOuts, fee: 1e6 } });
  ok("TRUNC-1: truncated multi-send LOUDLY flags the hidden recipients (err class, not a dim aside)",
    /NOT shown/i.test(manyHtml) && manyHtml.includes('class="err"') && /3 more recipient/i.test(manyHtml)); // 15−12=3 hidden
  ok("TRUNC-1: truncated multi-send discloses the HIDDEN total (3 × 1 CSD)", /3 CSD/.test(manyHtml));
  ok("TRUNC-1: a send within the cap shows no truncation warning (no false alarm)",
    !/NOT shown/i.test(describe({ method: "send", params: { outputs: manyOuts.slice(0, 5), fee: 1e6 } })));
  // and the SAME loud truncation applies to a dApp fillOffer (single-sourced renderer)
  ok("TRUNC-1: a truncated fillOffer also flags hidden recipients",
    /NOT shown/i.test(describe({ method: "fillOffer", params: { proposalId: "0x" + "aa".repeat(32), outputs: manyOuts, fee: 5e6 } })));
}

// WYSIWYS-BIDI-1 — escapeHtml neutralizes Unicode bidi-override / zero-width controls to a VISIBLE \uXXXX
// token, so a dApp can't reorder or hide characters in a displayed name/address/memo vs the signed bytes.
ok("BIDI-1: a bidi-override (U+202E) is neutralized to a visible token (not passed through)",
  escapeHtml("abc\u202Edef") === "abc\\u202Edef" && !escapeHtml("abc\u202Edef").includes("\u202E"));
ok("BIDI-1: a zero-width char (U+200B) is neutralized", escapeHtml("a\u200Bb") === "a\\u200Bb");
ok("BIDI-1: an RLI isolate (U+2067) is neutralized", escapeHtml("x\u2067y") === "x\\u2067y");
ok("BIDI-1: plain text is unchanged (no false neutralization)", escapeHtml("alice.csd") === "alice.csd" && escapeHtml("0x" + "ab".repeat(20)) === "0x" + "ab".repeat(20));

// CLEARSIGN-FEE-1 — a dApp-built .csd renewal that UNDERPAYS the length-graded fee must warn (fund-loss with
// no benefit: the fee leaves the wallet but the resolver no-ops the underpaid record). "audit" (5 chars) costs
// 5 CSD at V24 (tip ≥ V24_HEIGHT=49200) but only the 3 CSD V18 price below it.
{
  const ren = buildNameRenew({ name: "audit" });
  const mk = (treasuryVal: number, tip?: number) => describe({ method: "propose", currentTip: tip,
    params: { domain: CAIRNX_DOMAIN, uri: ren.uri, payloadHash: ren.payloadHash, fee: 25000000, expiresEpoch: 2000, outputs: [{ to: TREASURY_ADDR, value: treasuryVal }] } });
  ok("FEE-1: underpaid renewal (3 CSD where V24 needs 5) WARNS", /BELOW the current price/.test(mk(3e8, 49300)));
  ok("FEE-1: correctly-paid renewal (5 CSD at V24) does NOT warn", !/BELOW the current price/.test(mk(5e8, 49300)));
  ok("FEE-1: pre-V24 renewal paying the 3 CSD V18 price does NOT warn (no false alarm)", !/BELOW the current price/.test(mk(3e8, 44230)));
  ok("FEE-1: offline (no tip) skips the fee check (no false warning)", !/BELOW the current price/.test(mk(3e8, undefined)));
}

// NFIN-WINDOW-1 (Plan 63 carry-over, 0.2.54) — the approve-path nfinalize gate: a displaced or
// out-of-window finalize burns the fee, so the gate must refuse those, pass a live in-window
// reservation, and WARN (never block) when the name service / tip is unreachable (fail-open —
// approval must not gain a hard network dependency; same posture as the FEE-1 offline skip).
{
  const ME = "0x" + "cd".repeat(20);
  const OTHER = "0x" + "ee".repeat(20);
  const EFF = 47000;
  const winEnd = EFF + REG_COMMIT_MAX_BLOCKS + REG_FINALIZE_GRACE_BLOCKS; // the resolver's own finalizeBy formula
  const mine = { name: "audit", owner: ME, pending: true, effectiveHeight: EFF };
  ok("NFIN: in-window live reservation passes (no note)", (() => {
    const g = nfinalizeApproveGate({ record: mine }, ME, winEnd - 2);
    return g.block === false && g.note === null;
  })());
  ok("NFIN: owner compare is case-insensitive (uppercase signer still passes)",
    nfinalizeApproveGate({ record: mine }, ME.toUpperCase(), winEnd - 2).block === false);
  ok("NFIN: out-of-window refuses (one block past the tip > windowEnd - 2 margin)", (() => {
    const g = nfinalizeApproveGate({ record: mine }, ME, winEnd - 1);
    return g.block === true && /window has closed/.test(g.note || "");
  })());
  ok("NFIN: displaced reservation (another owner holds the pending record) refuses", (() => {
    const g = nfinalizeApproveGate({ record: { ...mine, owner: OTHER } }, ME, winEnd - 2);
    return g.block === true && /earlier committer won/.test(g.note || "");
  })());
  ok("NFIN: no reservation at all (clean 404) refuses", (() => {
    const g = nfinalizeApproveGate({ record: null }, ME, winEnd - 2);
    return g.block === true && /no reservation on-chain/.test(g.note || "");
  })());
  ok("NFIN: already finalized (registered to me, not pending) refuses a second fee", (() => {
    const g = nfinalizeApproveGate({ record: { ...mine, pending: false } }, ME, winEnd - 2);
    return g.block === true && /no second finalize fee/.test(g.note || "");
  })());
  ok("NFIN: v2.6 recapture reservation (lapsed record + live .recapture for me) passes in-window",
    nfinalizeApproveGate({ record: { name: "audit", owner: OTHER, expired: true, recapture: { owner: ME, effectiveHeight: EFF } } }, ME, winEnd - 2).block === false);
  ok("NFIN: recapture displaced (someone else's .recapture) refuses",
    nfinalizeApproveGate({ record: { name: "audit", owner: OTHER, expired: true, recapture: { owner: OTHER, effectiveHeight: EFF } } }, ME, winEnd - 2).block === true);
  ok("NFIN: lapsed record with NO recapture reservation refuses as no-reservation", (() => {
    const g = nfinalizeApproveGate({ record: { name: "audit", owner: ME, expired: true } }, ME, winEnd - 2);
    return g.block === true && /no reservation on-chain/.test(g.note || "");
  })());
  ok("NFIN: fetch failure (5xx/timeout) WARNS but does NOT block (fail-open)", (() => {
    const g = nfinalizeApproveGate({ failed: true }, ME, winEnd - 2);
    return g.block === false && /could not verify/.test(g.note || "");
  })());
  ok("NFIN: tip unavailable WARNS but does NOT block (fail-open)", (() => {
    const g = nfinalizeApproveGate({ record: mine }, ME, null);
    return g.block === false && /could not verify/.test(g.note || "");
  })());
}

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
