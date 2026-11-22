// The copy rule (Plan 91 D28) over every entry of src/popup/sentences.ts, and the selector's coverage of the submit
// path's codes and refusal reasons. A wording change edits one entry; this file holds it to the rule.
// RED-FIRST: an entry over 160 characters, with three sentences, a forbidden word, an em dash, an unfilled part or a
// tone outside the three levels fails (1); a submit code or RefusalReason without a key fails (2); a send's refusal
// without a line fails (4).
// Run: node --import tsx test/sentences-copy.test.mjs   (offline)
import { SENTENCES, sentenceKeyOf, sentenceOf, M11_BACKUP_SERVER } from "../src/popup/sentences.ts";
import { checker } from "./helpers/check.mjs";

const { check, done } = checker("=== the wallet's sentences against the copy rule ===");
const FORBIDDEN = /\b(chain|block|blocks|header|headers|node|nodes|resolver|proof|proofs|registrar|safe|guaranteed|always|never)\b/i;
const sentences = (t) => t.split(/(?<=[.!?])\s+(?=[A-Z])/).filter(Boolean).length;
// A line with variable parts is checked as shown with the sheet's example values and with long ones.
const EXAMPLES = [{ amount: "12.5 CSD", cap: "1 CSD" }, { amount: "92,233,720,368.54775807 CSD", cap: "100 CSD" }];
const shown = (k) => [...new Set(EXAMPLES.map((v) => sentenceOf(k, undefined, v).text))];
const entries = [...Object.keys(SENTENCES).flatMap((k) => shown(k).map((text) => [k, { ...SENTENCES[k], text }])), ["M11", { text: M11_BACKUP_SERVER, tone: "grey", details: "x" }]];
for (const [k, s] of entries) {
  const bad = [];
  if (s.text.length > 160) bad.push(`${s.text.length} characters`);
  if (sentences(s.text) > 2) bad.push(`${sentences(s.text)} sentences`);
  if (FORBIDDEN.test(s.text)) bad.push(`word "${s.text.match(FORBIDDEN)[0]}"`);
  if (/\u2014/.test(s.text + s.details)) bad.push("em dash");
  if (/[{}?]/.test(s.text.replace(/\?$/, ""))) bad.push("an unfilled part");
  if (!["grey", "amber", "red"].includes(s.tone)) bad.push(`tone ${s.tone}`);
  if (!s.details) bad.push("no Details");
  if (/\bfail(ed)?\b/i.test(s.text) && !/^R1$/.test(k)) bad.push("says failed");
  check(`(1) ${k}: ${s.text.length} characters, ${sentences(s.text)} sentence(s), ${s.tone}${bad.length ? ": " + bad.join(", ") : ""}`, bad.length === 0);
}
const over120 = entries.filter(([, s]) => s.text.length > 120).map(([k, s]) => `${k} ${s.text.length}`);
console.log(`  (lines over the 120-character aim, under the 160 limit: ${over120.join(", ") || "none"})`);
const REASONS = ["FEE", "BUSY", "SPENT", "CONFLICT", "PROXY", "INVALID", "UNKNOWN"];
for (const reason of REASONS) {
  check(`(2) SUBMIT_REJECTED ${reason} has a key (${sentenceKeyOf({ code: "SUBMIT_REJECTED", reason })})`, !!sentenceKeyOf({ code: "SUBMIT_REJECTED", reason }));
  check(`(2) SUBMIT_MAYBE_INFLIGHT with the main server's ${reason} has a key (${sentenceKeyOf({ code: "SUBMIT_MAYBE_INFLIGHT", reason })})`, String(sentenceKeyOf({ code: "SUBMIT_MAYBE_INFLIGHT", reason })).startsWith("MR_"));
}
for (const code of ["SUBMIT_MAYBE_INFLIGHT", "SUBMIT_DUPLICATE", "USER_REJECTED", "WALLET_LOCKED", "ACCOUNT_CHANGED", "FIRST_PARTY_ONLY", "VERIFY_UNAVAILABLE", "VERIFY_TAMPER", "VERIFY_HORIZON", "VERIFY_UNREPRESENTABLE", "GHOST_INPUTS_SKIPPED"])
  check(`(2) ${code} has a key (${sentenceKeyOf({ code })})`, !!sentenceKeyOf({ code }));
check("(2) a code this slice does not word has no key (it keeps the engine's own text)", sentenceKeyOf({ code: "FILL_UNSAFE" }) === null && sentenceKeyOf({}) === null);
check("(3) Details carries the code, not a served text", sentenceOf("R6", "SUBMIT_REJECTED").details.endsWith("(SUBMIT_REJECTED)"));
// (4) In a send every refusal has a line: each code a send can return (node.ts send, sendMany, assembleValueTx and the
// background's answers), and any code not known today, reads as its own line or R1, never the engine's text.
const SEND = { INSUFFICIENT: "S4", TOO_MANY_INPUTS: "S8", ZERO_ADDR_REFUSED: "S2", BAD_FEE: "R1", BAD_OUTPUTS: "R1", NO_OUTPUTS: "R1", FEE_TOO_LOW: "R1", INTERNAL: "R1", BAD_REQUEST: "R1", WALLET_UNAVAILABLE: "R1", SOMETHING_NEW: "R1", "": "R1" };
for (const [code, key] of Object.entries(SEND)) check(`(4) a send refused ${code || "without a code"} reads ${key} (${sentenceKeyOf({ ok: false, code }, "send")})`, sentenceKeyOf({ ok: false, code }, "send") === key);
check("(4) a send's FEE_CAP with its cap reads S12, without one R1", sentenceKeyOf({ ok: false, code: "FEE_CAP", feeCap: 1e8 }, "send") === "S12" && sentenceKeyOf({ ok: false, code: "FEE_CAP" }, "send") === "R1");
check("(4) the sheet's example: S12 with a 1 CSD cap", sentenceOf("S12", undefined, { cap: "1 CSD" }).text === "The fee is above what the wallet allows (1 CSD here). Nothing was sent.");
check("(4) an accepted send has no refusal line", sentenceKeyOf({ ok: true, txid: "0x" }, "send") === null);
// (5) Outside a send the send's own lines do not apply: a merge's INSUFFICIENT means the coins are smaller than the fee.
check("(5) a merge's INSUFFICIENT keeps its own text (no key outside a send)", sentenceKeyOf({ ok: false, code: "INSUFFICIENT" }) === null && sentenceKeyOf({ ok: false, code: "FEE_CAP", feeCap: 1 }) === null);
check("(5) a code worded everywhere is worded outside a send too", sentenceKeyOf({ ok: false, code: "SEAL_UNKNOWN" }) === "Q4" && sentenceKeyOf({ ok: false, code: "VERIFY_TAMPER" }) === "S10");
done("sentences-copy");
