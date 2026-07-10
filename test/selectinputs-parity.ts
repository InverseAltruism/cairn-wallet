// selectInputs parity fixtures — pins the wallet's DELIBERATE supply-chain-isolated fork
// (src/core/node.ts) to hardcoded expected selections. The SAME contract is implemented in csd-tx
// (csd-sdk/packages/tx/src/index.ts, which upstreamed the wallet's `exclude` param as 0.1.16); the
// expectations below are the neutral oracle both bodies must reproduce, so a semantic change landing
// in only one of the twins fails here. Covers: largest-first greedy, non-coinbase preference with
// coinbase fallback, maturity/dup/garbage hardening, the exclude outpoint key contract
// (`${txid.toLowerCase()}:${vout}` — a mixed-case caller key excludes NOTHING by design), and the
// null cases. Run: npx tsx test/selectinputs-parity.ts
import { selectInputs, spendableCoins } from "../src/core/node.js";

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

// 6. spendableCoins ↔ selectInputs FILTER parity (0.2.56): spendableCoins is a marked KEEP-IN-SYNC
//    standalone of selectInputs' spendability predicate (it diagnoses TOO_MANY_INPUTS and feeds
//    consolidate's smallest-first pool, WITHOUT touching the frozen csd-tx-mirrored body above).
//    Oracle trick: selectInputs(need = full spendable sum) must take EVERY coin its filter accepts,
//    so the two accepted-sets must be identical on every hardening edge. A drift in either body
//    (0-conf, NaN-conf, garbage values, dedupe, exclude contract) breaks the set equality here.
{
  const setOf = (xs: { txid: string; vout: number }[]) => xs.map((i) => `${i.txid}:${i.vout}`).sort().join(",");
  const filterParity = (name: string, utxos: unknown[], exclude?: ReadonlySet<string>) => {
    const spend = spendableCoins(utxos as any[], exclude);
    const total = spend.reduce((s, c) => s + c.value, 0);
    const sel = total > 0 ? selectInputs(utxos as any[], total, exclude) : null;
    const same = total === 0 ? spend.length === 0 : !!sel && setOf(sel.inputs) === setOf(spend);
    check(`filter parity: ${name}`, same);
  };
  filterParity("clean mixed set (coinbase + plain)", [u("0xaa", 0, 900, { coinbase: true }), u("0xbb", 0, 800), u("0xcc", 1, 5)]);
  filterParity("0-conf and NaN-conf dropped by both", [u("0xaa", 0, 900), u("0xbb", 0, 100, { confirmations: 0 }), u("0xcc", 0, 100, { confirmations: "abc" })]);
  filterParity("garbage values dropped by both", [u("0xaa", 0, 900), u("0xbb", 0, -5), u("0xcc", 0, 0), u("0xdd", 0, 2 ** 53), u("0xee", 0, 1.5)]);
  filterParity("mixed-case duplicate outpoint deduped by both", [u("0xAB", 1, 600), u("0xab", 1, 600), u("0xcc", 0, 40)]);
  filterParity("exclude contract shared (lowercase key skips)", [u("0xaa", 0, 900), u("0xbb", 0, 800)], new Set(["0xaa:0"]));
  filterParity("exclude contract shared (mixed-case key skips nothing)", [u("0xaa", 0, 900), u("0xbb", 0, 800)], new Set(["0xAA:0"]));
  filterParity("all-garbage set is empty for both", [u("0xaa", 0, 0), u("0xbb", 0, 100, { confirmations: 0 })]);
  check("spendableCoins preserves reported order (caller sorts; no hidden ordering contract)",
    setOf(spendableCoins([u("0xbb", 0, 5), u("0xaa", 0, 900)])) === "0xaa:0,0xbb:0" &&
    spendableCoins([u("0xbb", 0, 5), u("0xaa", 0, 900)])[0]!.txid === "0xbb");
}

console.log(`\nselectinputs-parity: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
