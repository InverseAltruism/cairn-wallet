// The copy rule (Plan 91 D28) over every entry of src/popup/sentences.ts, and the selector's coverage of the submit
// path's codes and refusal reasons. A wording change edits one entry; this file holds it to the rule.
// RED-FIRST: an entry over 160 characters, with three sentences, a forbidden word, an em dash or a tone outside the
// three levels fails (1); a submit code or RefusalReason without a key fails (2).
// Run: node --import tsx test/sentences-copy.test.mjs   (offline)
import { SENTENCES, sentenceKeyOf, sentenceOf, M11_BACKUP_SERVER } from "../src/popup/sentences.ts";
import { checker } from "./helpers/check.mjs";

const { check, done } = checker("=== the wallet's sentences against the copy rule ===");
const FORBIDDEN = /\b(chain|block|blocks|header|headers|node|nodes|resolver|proof|proofs|registrar|safe|guaranteed|always|never)\b/i;
const sentences = (t) => t.split(/(?<=[.!?])\s+(?=[A-Z])/).filter(Boolean).length;
const entries = [...Object.entries(SENTENCES), ["M11", { text: M11_BACKUP_SERVER, tone: "grey", details: "x" }]];
for (const [k, s] of entries) {
  const bad = [];
  if (s.text.length > 160) bad.push(`${s.text.length} characters`);
  if (sentences(s.text) > 2) bad.push(`${sentences(s.text)} sentences`);
  if (FORBIDDEN.test(s.text)) bad.push(`word "${s.text.match(FORBIDDEN)[0]}"`);
  if (/—/.test(s.text + s.details)) bad.push("em dash");
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
done("sentences-copy");
