// Coin selection runs csd-tx's selectInputs from the vendored bundle; spendableCoins (src/core/node.ts) is
// the wallet's standalone spendability set and must accept exactly the coins selectInputs accepts. The
// expectations below are a neutral oracle: largest-first greedy, non-coinbase preference with coinbase
// fallback, maturity, duplicate and garbage hardening, the exclude key contract (lower-case `txid:vout`,
// a key with or without `0x` matches either spelling, a mixed-case key matches nothing) and the null cases.
// Run: npx tsx test/selectinputs-parity.ts
import { selectInputs } from "../src/vendor/cairnx-spv.js";
import { spendableCoins, opKey } from "../src/core/node.js";
import { checker } from "./helpers/check.mjs";

const { check, done } = checker("selectinputs-parity");
const u = (txid: string, vout: number, value: number, extra: Record<string, unknown> = {}) =>
  ({ txid, vout, value, confirmations: 10, ...extra });
const picked = (s: { inputs: { txid: string; vout: number }[] } | null) =>
  s ? s.inputs.map((i) => `${i.txid}:${i.vout}`).join(",") : "null";
const H = "ab".repeat(32);

// 1. largest-first greedy stops at sufficiency
check("largest-first: picks 500 then 300 for need 700",
  picked(selectInputs([u("0xaa", 0, 100), u("0xbb", 0, 500), u("0xcc", 0, 300)], 700)) === "0xbb:0,0xcc:0");

// 2. non-coinbase preferred even when a bigger coinbase exists; falls back when insufficient
check("non-coinbase preferred over a larger coinbase",
  picked(selectInputs([u("0xaa", 0, 900, { coinbase: true }), u("0xbb", 0, 800)], 700)) === "0xbb:0");
check("coinbase fallback when non-coinbase alone cannot cover (re-selects largest-first from the full set)",
  picked(selectInputs([u("0xaa", 0, 900, { coinbase: true }), u("0xbb", 0, 100)], 700)) === "0xaa:0");

// 3. hardening: immature, duplicate (case-normalized), and garbage values are dropped
check("immature (0-conf) and NaN-conf coins are unspendable",
  selectInputs([u("0xaa", 0, 900, { confirmations: 0 }), u("0xbb", 0, 900, { confirmations: "abc" })], 100) === null);
check("mixed-case duplicate outpoint is deduped (one 600 is not two)",
  selectInputs([u("0xAB", 1, 600), u("0xab", 1, 600)], 1000) === null);
check("non-positive / unsafe values are dropped",
  selectInputs([u("0xaa", 0, -5), u("0xbb", 0, 0), u("0xcc", 0, 2 ** 53)], 1) === null);

// 4. the exclude contract: lowercased txid:vout keys skip; a mixed-case caller key skips nothing
check("exclude skips the ghost outpoint (lowercase key)",
  picked(selectInputs([u("0xaa", 0, 900), u("0xbb", 0, 800)], 700, new Set(["0xaa:0"]))) === "0xbb:0");
check("exclude key is case-sensitive by contract: '0xAA:0' excludes nothing",
  picked(selectInputs([u("0xaa", 0, 900), u("0xbb", 0, 800)], 700, new Set(["0xAA:0"]))) === "0xaa:0");
check("excluding everything spendable -> null",
  selectInputs([u("0xaa", 0, 900)], 100, new Set(["0xaa:0"])) === null);

// 5. sufficiency edge: exact-need selection succeeds; one short fails
check("exact need is sufficient", picked(selectInputs([u("0xaa", 0, 700)], 700)) === "0xaa:0");
check("total one under need -> null", selectInputs([u("0xaa", 0, 699)], 700) === null);

// 6. one coin served in two spellings is one coin, and an exclude key matches either spelling.
check("a coin served bare and 0x is taken once (600 does not cover 1000)",
  selectInputs([u("0x" + H, 0, 600), u(H, 0, 600)], 1000) === null);
check("a coin served bare and 0X is taken once",
  selectInputs([u(H, 0, 600), u("0X" + H.toUpperCase(), 0, 600)], 1000) === null);
check("an honest coin covers the need instead of the second spelling (600 + 1)",
  picked(selectInputs([u("0x" + H, 0, 600), u(H, 0, 600), u("0xcc", 0, 1)], 601)) === `0x${H}:0,0xcc:0`);
check("a bare exclude key skips the 0x-served coin",
  picked(selectInputs([u("0x" + H, 0, 900), u("0xbb", 0, 800)], 700, new Set([`${H}:0`]))) === "0xbb:0");
check("a 0x exclude key skips the bare-served coin",
  picked(selectInputs([u(H, 0, 900), u("0xbb", 0, 800)], 700, new Set([`0x${H}:0`]))) === "0xbb:0");
check("opKey gives both spellings one key, in the 0x form the node serves",
  opKey("0x" + H, 0) === `0x${H}:0` && opKey(H, 0) === `0x${H}:0` && opKey("0X" + H.toUpperCase(), "0") === `0x${H}:0`);

// 7. spendableCoins and selectInputs accept the same set. With need equal to the whole spendable sum,
//    selectInputs must take every coin its filter accepts, so the two sets are equal on every edge.
{
  const setOf = (xs: { txid: string; vout: number }[]) => xs.map((i) => `${i.txid}:${i.vout}`).sort().join(",");
  const filterParity = (name: string, utxos: unknown[], exclude?: ReadonlySet<string>) => {
    const spend = spendableCoins(utxos as any[], exclude);
    const total = spend.reduce((s, c) => s + c.value, 0);
    const sel = total > 0 ? selectInputs(utxos as any[], total, exclude) : null;
    const same = total === 0 ? spend.length === 0 && selectInputs(utxos as any[], 1, exclude) === null : !!sel && setOf(sel.inputs) === setOf(spend);
    check(`filter parity: ${name}`, same);
  };
  filterParity("clean mixed set (coinbase + plain)", [u("0xaa", 0, 900, { coinbase: true }), u("0xbb", 0, 800), u("0xcc", 1, 5)]);
  filterParity("0-conf and NaN-conf dropped by both", [u("0xaa", 0, 900), u("0xbb", 0, 100, { confirmations: 0 }), u("0xcc", 0, 100, { confirmations: "abc" })]);
  filterParity("garbage values dropped by both", [u("0xaa", 0, 900), u("0xbb", 0, -5), u("0xcc", 0, 0), u("0xdd", 0, 2 ** 53), u("0xee", 0, 1.5)]);
  filterParity("mixed-case duplicate outpoint deduped by both", [u("0xAB", 1, 600), u("0xab", 1, 600), u("0xcc", 0, 40)]);
  filterParity("bare and 0x spellings deduped by both", [u("0x" + H, 0, 600), u(H, 0, 600), u("0xcc", 0, 40)]);
  filterParity("bare and 0X spellings deduped by both", [u(H, 0, 600), u("0X" + H.toUpperCase(), 0, 600), u("0xcc", 0, 40)]);
  filterParity("exclude contract shared (lowercase key skips)", [u("0xaa", 0, 900), u("0xbb", 0, 800)], new Set(["0xaa:0"]));
  filterParity("exclude contract shared (mixed-case key skips nothing)", [u("0xaa", 0, 900), u("0xbb", 0, 800)], new Set(["0xAA:0"]));
  filterParity("exclude contract shared (bare key skips the 0x coin)", [u("0x" + H, 0, 900), u("0xbb", 0, 800)], new Set([`${H}:0`]));
  filterParity("exclude contract shared (0x key skips the bare coin)", [u(H, 0, 900), u("0xbb", 0, 800)], new Set([`0x${H}:0`]));
  filterParity("all-garbage set is empty for both", [u("0xaa", 0, 0), u("0xbb", 0, 100, { confirmations: 0 })]);
  check("spendableCoins counts a coin served bare and 0x as one coin",
    spendableCoins([u("0x" + H, 0, 600), u(H, 0, 600)]).length === 1);
  check("spendableCoins preserves reported order (caller sorts; no hidden ordering contract)",
    setOf(spendableCoins([u("0xbb", 0, 5), u("0xaa", 0, 900)])) === "0xaa:0,0xbb:0" &&
    spendableCoins([u("0xbb", 0, 5), u("0xaa", 0, 900)])[0]!.txid === "0xbb");
  check("spendableCoins skips a null entry and a null list",
    spendableCoins([null, u("0xaa", 0, 900)]).length === 1 && spendableCoins(null as unknown as any[]).length === 0);
}

done("selectinputs-parity");
