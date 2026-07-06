// selectInputs parity fixtures — pins the wallet's DELIBERATE supply-chain-isolated fork
// (src/core/node.ts) to hardcoded expected selections. The SAME contract is implemented in csd-tx
// (csd-sdk/packages/tx/src/index.ts, which upstreamed the wallet's `exclude` param as 0.1.16); the
// expectations below are the neutral oracle both bodies must reproduce, so a semantic change landing
// in only one of the twins fails here. Covers: largest-first greedy, non-coinbase preference with
// coinbase fallback, maturity/dup/garbage hardening, the exclude outpoint key contract
// (`${txid.toLowerCase()}:${vout}` — a mixed-case caller key excludes NOTHING by design), and the
// null cases. Run: npx tsx test/selectinputs-parity.ts
import { selectInputs } from "../src/core/node.js";

declare const process: { exit(code: number): void };
let pass = 0, fail = 0;
const check = (n: string, c: boolean) => { c ? (pass++, console.log("  ✅ " + n)) : (fail++, console.log("  ❌ " + n)); };
const u = (txid: string, vout: number, value: number, extra: Record<string, unknown> = {}) =>
  ({ txid, vout, value, confirmations: 10, ...extra });
const picked = (s: { inputs: { txid: string; vout: number }[] } | null) =>
  s ? s.inputs.map((i) => `${i.txid}:${i.vout}`).join(",") : "null";

// 1. largest-first greedy stops at sufficiency
check("largest-first: picks 500 then 300 for need 700",
  picked(selectInputs([u("0xaa", 0, 100), u("0xbb", 0, 500), u("0xcc", 0, 300)], 700)) === "0xbb:0,0xcc:0");

// 2. non-coinbase preferred even when a bigger coinbase exists; falls back when insufficient
check("non-coinbase preferred over a larger coinbase",
  picked(selectInputs([u("0xaa", 0, 900, { coinbase: true }), u("0xbb", 0, 800)], 700)) === "0xbb:0");
check("coinbase fallback when non-coinbase alone cannot cover (re-selects largest-first from the FULL set)",
  picked(selectInputs([u("0xaa", 0, 900, { coinbase: true }), u("0xbb", 0, 100)], 700)) === "0xaa:0");

// 3. hardening: immature, duplicate (case-normalized), and garbage values are dropped
check("immature (0-conf) and NaN-conf coins are unspendable",
  selectInputs([u("0xaa", 0, 900, { confirmations: 0 }), u("0xbb", 0, 900, { confirmations: "abc" })], 100) === null);
check("mixed-case duplicate outpoint is deduped (one 600 is not two)",
  selectInputs([u("0xAB", 1, 600), u("0xab", 1, 600)], 1000) === null);
check("non-positive / unsafe values are dropped",
  selectInputs([u("0xaa", 0, -5), u("0xbb", 0, 0), u("0xcc", 0, 2 ** 53)], 1) === null);

// 4. the exclude contract: lowercased txid:vout keys skip; a mixed-case caller key skips NOTHING
check("exclude skips the ghost outpoint (lowercase key)",
  picked(selectInputs([u("0xaa", 0, 900), u("0xbb", 0, 800)], 700, new Set(["0xaa:0"]))) === "0xbb:0");
check("exclude key is case-sensitive by contract: '0xAA:0' excludes nothing",
  picked(selectInputs([u("0xaa", 0, 900), u("0xbb", 0, 800)], 700, new Set(["0xAA:0"]))) === "0xaa:0");
check("excluding everything spendable -> null",
  selectInputs([u("0xaa", 0, 900)], 100, new Set(["0xaa:0"])) === null);

// 5. sufficiency edge: exact-need selection succeeds; one short fails
check("exact need is sufficient", picked(selectInputs([u("0xaa", 0, 700)], 700)) === "0xaa:0");
check("total one under need -> null", selectInputs([u("0xaa", 0, 699)], 700) === null);

console.log(`\nselectinputs-parity: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
