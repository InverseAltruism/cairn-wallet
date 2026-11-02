// The name replay proves at most MAX_HINTS (256) record hints: each costs a block bind and a prevout read, so the
// cap bounds what a hostile hint source can make the wallet fetch. 257 hints refuse before any block is read; 256
// are proven and replayed. (The resolver's selector keeps an honest name far below the cap; a name with more than
// 256 real records is the accepted residual of paid renewals, at least 3.25 CSD each.)
// Real signed txs in synthetic PoW-verified blocks (test/_spvrig.ts).
// Run: npx tsx test/namespv-hint-cap.test.mjs   (offline)
import { checker } from "./helpers/check.mjs";
import { verifyNameUnion } from "../src/core/namespv.js";
import { proposeTx, world, source, feeOut, pick, mkFetch, addrFromPriv, buildNameClaim, buildNameSet } from "./_spvrig.ts";

const { check, done } = checker("name replay: the 256-hint cap:");
const keyA = "0x" + "41".repeat(32);
const A = addrFromPriv(keyA).toLowerCase();
const NM = "zzcap";
const SRC = [{ label: "primary", base: "https://primary.example/trade/api" }];
const target = (i) => "0x" + (i + 1).toString(16).padStart(40, "0");

// One registration and 256 nsets by the owner, one block each: 257 real records of the name.
const placed = [{ height: 33_700, tx: proposeTx({ ...pick(buildNameClaim({ name: NM })), priv: keyA, outputs: feeOut() }) }];
for (let i = 0; i < 256; i++) placed.push({ height: 33_701 + i, tx: proposeTx({ ...pick(buildNameSet({ name: NM, addr: target(i) })), priv: keyA }) });
const all = world(placed);
const base = source(all.blocks, 34_100);
const counted = () => { let reads = 0; return { spv: { ...base, async blockAt(h) { reads++; return base.blockAt(h); } }, reads: () => reads }; };
const run = async (hints) => { const c = counted(); const r = await verifyNameUnion(NM, SRC, c.spv, mkFetch({ [SRC[0].base]: { ok: true, resolve: { addr: A, owner: A }, events: hints, scopedReplaySufficient: true } })); return { r, reads: c.reads() }; };

const over = await run(all.hints);
check(`257 hints: refused before any block read (${over.r.reason}; ${over.reads} block reads)`, over.r.verified === false && /too many record hints/.test(String(over.r.reason)) && over.reads === 0);
const at = await run(all.hints.slice(0, 256));
check(`256 hints: proven and replayed (${at.reads} block reads, addr ${at.r.addr})`, at.r.verified === true && at.reads === 256 && at.r.addr === target(254));

done("namespv-hint-cap");
