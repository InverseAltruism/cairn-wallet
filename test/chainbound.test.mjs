// chainbound.ts: the lowest chain height for this release and install, and the generated height it rests on.
// The approval window imports it, so it must not bring the anchor table or the light client into that bundle: the
// window then keeps the release bound when its reads from the background fail or time out.
//
// Run: TSX_DISABLE_CACHE=1 node --import tsx test/chainbound.test.mjs   (offline)
import { readFileSync } from "node:fs";
import { build } from "esbuild";
import { checker } from "./helpers/check.mjs";
import { lowestChainHeight } from "../src/core/chainbound.ts";
import { SPV_NEWEST_HEIGHT } from "../src/core/spvnewest.ts";
import { SPV_NEWEST } from "../src/core/namespv.ts";
import { SPV_ANCHORS } from "../src/core/spvanchors.ts";
import { parseTable, renderNewest } from "../scripts/update-spv-anchors.mjs";

const { check, done } = checker("chainbound: the release bound without the anchor table:");
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

// 1. The generated height is the anchor table's newest entry, and the generator writes it.
check(`spvnewest.ts holds the table's newest entry (${SPV_NEWEST_HEIGHT} = ${SPV_NEWEST})`, SPV_NEWEST_HEIGHT === SPV_NEWEST);
check("spvnewest.ts is exactly what the generator writes for the committed table", read("src/core/spvnewest.ts") === renderNewest(parseTable(read("src/core/spvanchors.ts"))));

// 2. The bound.
check("floor 0 gives the release anchor", lowestChainHeight(0) === SPV_NEWEST_HEIGHT);
check("a stored floor above the anchor is kept", lowestChainHeight(SPV_NEWEST_HEIGHT + 7) === SPV_NEWEST_HEIGHT + 7);
check("a non-finite floor counts as 0", lowestChainHeight(Number.NaN) === SPV_NEWEST_HEIGHT && lowestChainHeight(Number.POSITIVE_INFINITY) === SPV_NEWEST_HEIGHT);

// 3. The approval window and the toolbar popup are built as build.mjs builds them: the window's bundle carries the
//    bound and neither carries the anchor table, namespv.ts or the light client.
const common = { bundle: true, target: "es2022", logLevel: "silent", legalComments: "none", define: { __WALLET_VERSION__: '"0.0.0"' }, format: "esm", write: false, metafile: true, outdir: "/tmp/chainbound-test-out" };
const approve = await build({ ...common, entryPoints: { approve: "src/popup/approve.ts" }, splitting: false });
const popup = await build({ ...common, entryPoints: { popup: "src/popup/popup.ts" }, splitting: true, chunkNames: "[name]" });
const outputOf = (res, name) => Object.entries(res.metafile.outputs).find(([k]) => k.endsWith(`/${name}`));
const textOf = (res, name) => res.outputFiles.find((f) => f.path.endsWith(`/${name}`))?.text ?? "";
for (const [res, name] of [[approve, "approve.js"], [popup, "popup.js"]]) {
  const [, out] = outputOf(res, name) ?? [];
  const inputs = Object.keys(out?.inputs ?? {});
  const text = textOf(res, name);
  check(`${name}: built (${inputs.length} inputs, ${text.length} bytes)`, inputs.length > 0 && text.length > 0);
  check(`${name}: no anchor table, namespv.ts or header store among its inputs`, !inputs.some((p) => /src\/core\/(spvanchors|namespv|headerstore)\.ts$/.test(p)));
  check(`${name}: no anchor hash and no light client in its text`, !SPV_ANCHORS.some((h) => text.includes(h.slice(2))) && !/class LightClient\b/.test(text));
}
check("approve.js carries chainbound.ts and the generated height", ["src/core/chainbound.ts", "src/core/spvnewest.ts"].every((p) => Object.keys(outputOf(approve, "approve.js")[1].inputs).includes(p)));

done("chainbound");
