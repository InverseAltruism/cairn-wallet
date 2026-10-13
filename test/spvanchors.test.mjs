// src/core/spvanchors.ts, offline shape: the floor is namespv's checkpoint, the file is exactly the generator's output,
// and every entry is a well-formed hash at its chunk top. Whether each entry is on the chain is the CI `anchors` job
// (scripts/update-spv-anchors.mjs --check), which needs the network.
import { readFileSync } from "node:fs";
import { checker } from "./helpers/check.mjs";
import { SPV_ANCHORS, SPV_CHUNK, SPV_FLOOR } from "../src/core/spvanchors.ts";
import { CP } from "../src/core/namespv.ts";
import { parseTable } from "../scripts/update-spv-anchors.mjs";

const t = checker("spvanchors: the release anchor table shape");
const text = readFileSync(new URL("../src/core/spvanchors.ts", import.meta.url), "utf8");

let parsed = null;
try { parsed = parseTable(text); } catch (e) { console.log("   ", e.message); }
t.check("the committed file re-renders byte for byte from its parse (generated, not hand-edited)", parsed !== null);
t.check("the parse equals the module's exports", parsed?.chunk === SPV_CHUNK && parsed?.floor.hash === SPV_FLOOR.hash && parsed?.anchors.join() === SPV_ANCHORS.join());
t.check("SPV_FLOOR is namespv's checkpoint (29960)", SPV_FLOOR.height === 29960 && SPV_FLOOR.height === CP.height && SPV_FLOOR.hash === CP.hash);
t.check("SPV_CHUNK is 4096", SPV_CHUNK === 4096);
t.check(`at least one entry (${SPV_ANCHORS.length})`, SPV_ANCHORS.length >= 1);
t.check("every entry is 0x and 64 lowercase hex", SPV_ANCHORS.every((h) => /^0x[0-9a-f]{64}$/.test(h)));
t.check("no entry repeats", new Set(SPV_ANCHORS).size === SPV_ANCHORS.length);
const heights = [...text.matchAll(/", \/\/ (\d+)$/gm)].map((m) => Number(m[1]));
t.check("entry i is labelled with height 4096 x (7 + i) + 4095, starting at 32767", heights.length === SPV_ANCHORS.length && heights.every((h, i) => h === 4096 * (7 + i) + 4095) && heights[0] === 32767);

t.done("spvanchors");
