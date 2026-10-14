// src/core/spvanchors.ts, offline shape: the floor is the light client's checkpoint, its only source, the file is exactly the generator's output,
// and every entry is a well-formed hash at its chunk top. Whether each entry is on the chain is the CI `anchors` job
// (scripts/update-spv-anchors.mjs --check), which needs the network.
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { checker } from "./helpers/check.mjs";
import { SPV_ANCHORS, SPV_CHUNK, SPV_FLOOR } from "../src/core/spvanchors.ts";
import { SPV_CHECKPOINTS } from "../src/core/namespv.ts";
import { parseTable } from "../scripts/update-spv-anchors.mjs";

const t = checker("spvanchors: the release anchor table shape");
const text = readFileSync(new URL("../src/core/spvanchors.ts", import.meta.url), "utf8");

let parsed = null;
try { parsed = parseTable(text); } catch (e) { console.log("   ", e.message); }
t.check("the committed file re-renders byte for byte from its parse (generated, not hand-edited)", parsed !== null);
t.check("the parse equals the module's exports", parsed?.chunk === SPV_CHUNK && parsed?.floor.hash === SPV_FLOOR.hash && parsed?.anchors.join() === SPV_ANCHORS.join());
t.check("SPV_FLOOR is the names floor (29960) and the light client's checkpoint at that height", SPV_FLOOR.height === 29960 && SPV_CHECKPOINTS[SPV_FLOOR.height] === SPV_FLOOR.hash);
// One source of truth: the floor hash is written once, in the table, and namespv derives its checkpoint from it.
const srcRoot = new URL("../src/", import.meta.url).pathname;
const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? (e.name === "vendor" ? [] : walk(join(dir, e.name))) : [join(dir, e.name)]);
const holders = walk(srcRoot).filter((f) => readFileSync(f, "utf8").includes(SPV_FLOOR.hash)).map((f) => relative(srcRoot, f));
t.check(`the floor hash literal is in src/core/spvanchors.ts and no other file under src/ outside vendor (${holders.join(", ")})`, holders.length === 1 && holders[0] === "core/spvanchors.ts");
t.check("SPV_CHUNK is 4096", SPV_CHUNK === 4096);
t.check(`at least one entry (${SPV_ANCHORS.length})`, SPV_ANCHORS.length >= 1);
t.check("every entry is 0x and 64 lowercase hex", SPV_ANCHORS.every((h) => /^0x[0-9a-f]{64}$/.test(h)));
t.check("no entry repeats", new Set(SPV_ANCHORS).size === SPV_ANCHORS.length);
const heights = [...text.matchAll(/", \/\/ (\d+)$/gm)].map((m) => Number(m[1]));
t.check("entry i is labelled with height 4096 x (7 + i) + 4095, starting at 32767", heights.length === SPV_ANCHORS.length && heights.every((h, i) => h === 4096 * (7 + i) + 4095) && heights[0] === 32767);

t.done("spvanchors");
