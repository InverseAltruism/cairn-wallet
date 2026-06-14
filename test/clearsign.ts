// Clear-signing formatter coverage — the previously-untested "what am I signing?" layer (the user's
// last line of defense). Focus: C-WL5 (no "NaN CSD"), HTML-escaping of dApp strings, address-poisoning.
import { fmtCsd, fmtCsdBig, baseVal, describe, debitOf, lookalikeOf, costLine, escapeHtml, expiryLine } from "../src/popup/clearsign.js";
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

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
