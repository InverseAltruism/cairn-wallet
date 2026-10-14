// The vendored header-record primitives (csd-light verifyLinkedRecords, codec serializeHeader/deserializeHeader)
// on real mainnet headers 29,888 to 30,079: what the header store stores and how a stored range is bound to a
// baked hash. Pins the two record requirements of Plan 86 section 3.2: every authentic record round-trips byte for
// byte, and a walk binds only when it reproduces the baked hash at the right height.
//
// Run: npx tsx test/vendor-records.test.mjs   (offline)
import { readFileSync } from "node:fs";
import { serializeHeader, deserializeHeader, verifyLinkedRecords, HEADER_BYTES, LWMA_WINDOW } from "../src/vendor/cairnx-spv.js";
import { SPV_FLOOR } from "../src/core/spvanchors.ts";
import { checker } from "./helpers/check.mjs";

const { check, done } = checker();
const rows = JSON.parse(readFileSync(new URL("./fixtures/headers-29888-30079.json", import.meta.url), "utf8"));
const hex = (b) => "0x" + Buffer.from(b).toString("hex");
const throws = (f) => { try { f(); return null; } catch (e) { return String(e?.message ?? e); } };

check("constants: 84-byte records, a 45-header LWMA window", HEADER_BYTES === 84 && LWMA_WINDOW === 45);

const recs = new Uint8Array(rows.length * HEADER_BYTES);
let roundTrip = 0;
rows.forEach((r, i) => {
  const rec = serializeHeader(r.header);
  recs.set(rec, i * HEADER_BYTES);
  if (hex(serializeHeader(deserializeHeader(rec))) === hex(rec)) roundTrip++;
});
check(`every authentic record round-trips byte for byte (${roundTrip} of ${rows.length})`, roundTrip === rows.length && rows.length === 192);

const at = (h) => rows.findIndex((r) => r.height === h);
const iFloor = at(SPV_FLOOR.height), iTop = rows.length - 1;
const slice = (a, b) => recs.subarray(a * HEADER_BYTES, (b + 1) * HEADER_BYTES);
const topHash = rows[iTop].hash;

// Honest path: the shape a chunk-7 walk has (first record pinned to the names floor, last to a baked hash).
check("a walk from the floor pin to the served top hash binds",
  throws(() => verifyLinkedRecords(slice(iFloor, iTop), { firstHeight: SPV_FLOOR.height, firstHash: SPV_FLOOR.hash, lastHash: topHash, lastHeight: rows[iTop].height })) === null);
// Honest path: the shape an upper chunk's walk has (first record's prev pinned to the previous chunk's top).
check("a walk whose first prev is the previous record's hash binds",
  throws(() => verifyLinkedRecords(slice(iFloor + 1, iTop), { firstHeight: SPV_FLOOR.height + 1, prevHash: SPV_FLOOR.hash, lastHash: topHash, lastHeight: rows[iTop].height })) === null);

const flipped = slice(iFloor, iTop).slice();
flipped[40 * HEADER_BYTES + 50] ^= 1;   // one merkle byte of record 40
check("one flipped byte breaks the walk", /prev link broken|does not match/.test(throws(() => verifyLinkedRecords(flipped, { firstHeight: SPV_FLOOR.height, firstHash: SPV_FLOOR.hash, lastHash: topHash })) ?? ""));
check("a wrong end hash is refused", /does not match lastHash/.test(throws(() => verifyLinkedRecords(slice(iFloor, iTop), { firstHeight: SPV_FLOOR.height, firstHash: SPV_FLOOR.hash, lastHash: rows[iTop - 1].hash })) ?? ""));
check("a range starting one record off the floor is refused", /does not match firstHash/.test(throws(() => verifyLinkedRecords(slice(iFloor + 1, iTop), { firstHeight: SPV_FLOOR.height, firstHash: SPV_FLOOR.hash, lastHash: topHash })) ?? ""));
check("a count that does not end at lastHeight is refused", /do not end at lastHeight/.test(throws(() => verifyLinkedRecords(slice(iFloor, iTop), { firstHeight: SPV_FLOOR.height, firstHash: SPV_FLOOR.hash, lastHash: topHash, lastHeight: rows[iTop].height + 1 })) ?? ""));
check("a walk with no first binding is refused", /firstHash or prevHash is required/.test(throws(() => verifyLinkedRecords(slice(iFloor, iTop), { firstHeight: SPV_FLOOR.height, lastHash: topHash })) ?? ""));

done("vendor-records");
