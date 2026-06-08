// Clear-signing formatter coverage — the previously-untested "what am I signing?" layer (the user's
// last line of defense). Focus: C-WL5 (no "NaN CSD"), HTML-escaping of dApp strings, address-poisoning.
import { fmtCsd, baseVal, describe, debitOf, lookalikeOf, costLine, escapeHtml } from "../src/popup/clearsign.js";
declare const process: { exit(code: number): void };

let pass = 0, fail = 0;
const ok = (n: string, c: boolean) => { c ? pass++ : fail++; console.log(`  ${c ? "PASS" : "FAIL"} ${n}`); };
const ADDR = "0x" + "ab".repeat(20);

// C-WL5 — a malicious/garbage amount must NEVER render "NaN CSD"
ok("fmtCsd(valid) → CSD", fmtCsd(150000000) === "1.5 CSD");
ok("fmtCsd('abc') → 'invalid amount' (not NaN)", fmtCsd("abc") === "invalid amount");
ok("fmtCsd(NaN) → 'invalid amount'", fmtCsd(NaN) === "invalid amount");
ok("fmtCsd({}) → 'invalid amount'", fmtCsd({}) === "invalid amount");
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

// Address-poisoning: flag a head8/tail4 twin, but not an unrelated or identical address
const real = "0xabcd1234" + "0".repeat(28) + "beef";
const twin = "0xabcd1234" + "9".repeat(28) + "beef"; // same head8 + tail4, different middle
const other = "0xffff0000" + "0".repeat(28) + "0000";
ok("lookalikeOf flags a head/tail twin", lookalikeOf(twin, [real]) === real);
ok("lookalikeOf does NOT flag an unrelated address", lookalikeOf(other, [real]) === null);
ok("lookalikeOf does NOT flag an identical address", lookalikeOf(real, [real]) === null);

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
