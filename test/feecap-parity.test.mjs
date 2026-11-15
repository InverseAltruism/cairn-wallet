// The proportional fee cap in src/core/node.ts (max(1 CSD, 10% of the verified inputs)) equals csd-tx's feeCap, the
// rule's home. The vendored bundle exports only csd-tx's selectInputs, so the wallet keeps its copy until a re-vendor
// adds feeCap to scripts/build-spv-vendor.sh's export list; this pins the copy to the csd-tx version package.json pins
// (the same package the bundle is built from, checked by scripts/check-vendor-fresh.mjs).
//   RED-FIRST: change the wallet's 10% or its 1 CSD floor and the comparison fails at the first differing total.
// Run: npx tsx test/feecap-parity.test.mjs   (offline)
import { readFileSync } from "node:fs";
import { feeCap, MAX_FEE_BACKSTOP, MAX_FEE_INPUT_FRACTION } from "@inversealtruism/csd-tx";
import { proportionalFeeCap } from "../src/core/node.ts";
import { checker } from "./helpers/check.mjs";

const { check, done } = checker("the wallet's proportional fee cap equals csd-tx feeCap:");
const pinned = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).devDependencies["@inversealtruism/csd-tx"];
const installed = JSON.parse(readFileSync(new URL("../node_modules/@inversealtruism/csd-tx/package.json", import.meta.url), "utf8")).version;
check(`setup: the csd-tx compared is the pinned one (${installed} = ${pinned})`, installed === pinned);
check(`csd-tx's constants are the ones the wallet's copy writes out (${MAX_FEE_BACKSTOP}, ${MAX_FEE_INPUT_FRACTION})`, MAX_FEE_BACKSTOP === 100_000_000 && MAX_FEE_INPUT_FRACTION === 0.1);

// Every total around the floor's crossing (1,000,000,000 base units, 10 CSD), the rounding edges of 10%, the powers of
// two up to 2^53, and 200,000 totals from a fixed-seed generator across the safe-integer range.
const totals = new Set([0, 1, 9, 10, 11, 99_999_999, 100_000_000, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER - 1]);
for (let t = 999_999_000; t <= 1_000_001_000; t++) totals.add(t);
for (let k = 0; k <= 53; k++) { const p = 2 ** k; for (const d of [-1, 0, 1]) if (p + d >= 0 && p + d <= Number.MAX_SAFE_INTEGER) totals.add(p + d); }
let seed = 0x2545f491;
const next = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; };
for (let i = 0; i < 200_000; i++) totals.add(((next() * 2 ** 21) + (next() >>> 11)) % (Number.MAX_SAFE_INTEGER + 1));
let first = null;
for (const t of totals) if (proportionalFeeCap(t) !== feeCap(t)) { first = t; break; }
check(`${totals.size} totals give the same cap from both (first difference: ${first})`, first === null);
done("feecap-parity");
