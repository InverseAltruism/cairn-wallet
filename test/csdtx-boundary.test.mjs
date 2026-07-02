// csdtx-boundary.test.mjs (Plan 56 A.4 finding 1 parity edges; Plan 57 B1). The wallet's MV3 twin
// codec (core/csdtx.ts) and the SDK codec (@inversealtruism/csd-codec) are byte-identical on VALID
// input (golden vectors pin that), but their EDGE contracts differ and valid-input vectors cannot
// see it: the SDK writers reject out-of-range u32/u64; the twin writers WRAP (u32 via `>>> 0`,
// u64 via ToBigUint64). Callers validate before the writers, so wrap is unreachable in practice.
// This file pins the twin's actual edge behavior as executable fixtures, so any future change to
// either contract (a "fix" to reject, or a regression that widens reach) shows up as a diff here,
// NOT as a silent byte divergence. No csd-sdk import on purpose: the wallet gate must stay
// insensitive to sdk work-in-progress (supply-chain isolation is the twin's reason to exist).
// Run: tsx test/csdtx-boundary.test.mjs
import { serialize } from "../src/core/csdtx.ts";

let pass = 0, fail = 0;
const ok = (n, c) => { c ? pass++ : fail++; console.log(`  ${c ? "✓" : "✗"} ${n}`); };
const hex = (b) => Buffer.from(b).toString("hex");

const baseTx = (over = {}) => ({
  version: 1,
  inputs: [{ prevTxid: "0x" + "11".repeat(32), vout: 0, scriptSig: "0x" }],
  outputs: [{ value: 1, scriptPubkey: "0x" + "22".repeat(20) }],
  locktime: 0,
  app: { type: "None" },
  ...over,
});
// layout offsets for a 1-in/1-out tx with empty scriptSig:
// version u32 (0..3) | inputs-len u64 (4..11) | prevTxid 32 (12..43) | vout u32 (44..47)
// | scriptSig len u64 (48..55) | outputs-len u64 (56..63) | value u64 (64..71) | spk 20 | ...
const VOUT = [44, 48], VALUE = [64, 72];

console.log("u32 edge (input.vout):");
{
  const b = serialize(baseTx({ inputs: [{ prevTxid: "0x" + "11".repeat(32), vout: -1, scriptSig: "0x" }] }));
  ok("vout=-1 WRAPS to ffffffff (the coinbase-sentinel forge the SDK codec rejects)", hex(b.slice(...VOUT)) === "ffffffff");
}
{
  const b = serialize(baseTx({ inputs: [{ prevTxid: "0x" + "11".repeat(32), vout: 2 ** 32, scriptSig: "0x" }] }));
  ok("vout=2^32 WRAPS to 00000000 (SDK codec rejects out-of-range instead)", hex(b.slice(...VOUT)) === "00000000");
}
{
  const b = serialize(baseTx());
  ok("layout sanity: valid vout=0 sits at the pinned offset", hex(b.slice(...VOUT)) === "00000000" && hex(b.slice(0, 4)) === "01000000");
}

console.log("u64 edge (output.value):");
{
  const b = serialize(baseTx({ outputs: [{ value: -1, scriptPubkey: "0x" + "22".repeat(20) }] }));
  ok("value=-1 WRAPS to ff..ff via ToBigUint64 (SDK codec rejects negatives)", hex(b.slice(...VALUE)) === "ff".repeat(8));
}
{
  const b = serialize(baseTx({ outputs: [{ value: 2n ** 64n, scriptPubkey: "0x" + "22".repeat(20) }] }));
  ok("value=2^64 WRAPS to zero (SDK codec rejects out-of-range)", hex(b.slice(...VALUE)) === "00".repeat(8));
}
{
  let threw = false;
  try { serialize(baseTx({ outputs: [{ value: 1.5, scriptPubkey: "0x" + "22".repeat(20) }] })); } catch { threw = true; }
  ok("value=1.5 THROWS (BigInt(1.5) RangeError): non-integers cannot encode", threw);
}
{
  const v = Number.MAX_SAFE_INTEGER;
  const b = serialize(baseTx({ outputs: [{ value: v, scriptPubkey: "0x" + "22".repeat(20) }] }));
  ok("value=2^53-1 encodes exactly (BigInt path, no float loss)", hex(b.slice(...VALUE)) === "ffffffffffff1f00");
}

console.log("feerate-trivia edge (why the twin's missing byte-proportional feerate check is unreachable):");
{
  // The SDK's build-time floor (csd-tx index.ts): need >= ceil(bytes / 1_000_000) base units.
  // The node caps a tx at 100_000 bytes (mempool cap, enforced by csd-codec deserialize).
  // So the floor for ANY acceptable tx is ceil(100_000 / 1_000_000) = 1 base unit: every
  // integer fee >= 1 satisfies it, and the wallet always pays >= 1. Documentation-as-test over
  // hardcoded constants (this file deliberately imports no SDK): if the SDK floor formula
  // (csd-tx index.ts) or the node tx-size cap ever changes, reconcile these literals by hand.
  const NODE_MAX_TX_BYTES = 100_000;
  const floorFor = (bytes) => Math.ceil(bytes / 1_000_000);
  ok("floor(max-size tx) == 1 base unit", floorFor(NODE_MAX_TX_BYTES) === 1);
  ok("fee=1 satisfies the floor at every size up to the cap", floorFor(1) === 1 && floorFor(NODE_MAX_TX_BYTES) <= 1);
}

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
