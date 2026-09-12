// M1: the source-preserving JSON reviver (parseSpvJson) keeps an unbounded u64 (a Propose's
// expires_epoch > 2^53) EXACT as a BigInt, so the SPV txid recompute matches the on-chain txid and
// the merkle bind succeeds - the "SPV poison" becomes a consensus no-op instead of bricking the
// fill/name lanes. Red-first: a plain JSON.parse rounds the value (the bug).
//
// Run: node --import tsx test/spv-json-reviver.test.mjs   (offline)
import { parseSpvJson } from "../src/core/node.js";

let pass = 0, fail = 0;
const check = (n, c) => { c ? (pass++, console.log("  ✓ " + n)) : (fail++, console.error("  ✗ " + n)); };

const BIG = "9007199254740993"; // 2^53 + 1 - NOT a safe integer
const body = `{"ok":true,"tx":{"app":{"type":"Propose","domain":"cairnx:v1","expires_epoch":${BIG}},"value":123}}`;

console.log("M1: source-preserving SPV JSON reviver");

// the fix: the reviver preserves the exact value as a BigInt
const revived = parseSpvJson(body);
const got = revived?.tx?.app?.expires_epoch;
check("a >2^53 expires_epoch parses to the EXACT BigInt (not rounded)", got === 9007199254740993n);

// red-first: a plain JSON.parse rounds it (9007199254740993 -> 9007199254740992, the bug)
const plain = JSON.parse(body)?.tx?.app?.expires_epoch;
check("a plain JSON.parse ROUNDS it (the bug the reviver fixes)", plain === 9007199254740992 && BigInt(plain) !== 9007199254740993n);

// a normal value is byte-identical to a plain parse (no regression on the honest path)
const normal = parseSpvJson(body);
check("safe values stay plain numbers (byte-identical honest path)", normal?.tx?.value === 123 && typeof normal?.tx?.value === "number");

// Fable M1 QC: a non-safe-integer FLOAT literal (0.5, 1e20) also fails isSafeInteger — without the
// integer-literal gate, BigInt("0.5") throws and the WHOLE parse fails closed (a one-float brick of
// every SPV lane). Non-integer literals must fall through to the plain value, exactly as JSON.parse.
{
  let threw = false, val;
  try { val = parseSpvJson(`{"a":0.5}`)?.a; } catch { threw = true; }
  check("a float literal parses to the plain number (never throws)", threw === false && val === 0.5);
}
{
  let threw = false, val;
  try { val = parseSpvJson(`{"a":1e20}`)?.a; } catch { threw = true; }
  check("an exponential literal parses to the plain number (never throws)", threw === false && val === 1e20);
}
// a NEGATIVE non-safe integer literal is still preserved exactly (the -? arm of the gate)
check("a negative non-safe integer is preserved as BigInt", parseSpvJson(`{"a":-9007199254740993}`)?.a === -9007199254740993n);

console.log(`\nspv-json-reviver: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
