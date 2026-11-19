// A name the replay has no record of is not verified, even when it is the name of a property every object inherits.
// replayName reads resolve()'s `names`, a plain object, so `names.constructor` is Object's constructor: it is truthy, its
// `expired` and `pending` are undefined, and the replay answered ok with owner and address the text "undefined". Real
// signed txs in synthetic PoW-verified blocks (test/_spvrig.ts): A registers "zed", and a source serves zed's record as
// the hint set for each prototype name.
// Run: TSX_DISABLE_CACHE=1 node --import tsx test/namespv-proto-name.test.mjs   (offline)
import { checker } from "./helpers/check.mjs";
import { verifyNameUnion } from "../src/core/namespv.js";
import { isPlainName } from "../src/core/cairnx.js";
import { proposeTx, world, source, feeOut, pick, mkFetch, addrFromPriv, buildNameClaim } from "./_spvrig.ts";

const { check, done } = checker("name replay: a prototype property is not a record:");
const keyA = "0x" + "31".repeat(32);
const A = addrFromPriv(keyA).toLowerCase();
const PRIMARY = "https://primary.example/trade/api", CLARVIS = "https://clarvis.example/trade/api";
const SOURCES = [{ label: "primary", base: PRIMARY }, { label: "clarvis", base: CLARVIS }];
const claim = (a) => ({ addr: a, owner: a, via: "owner" });
const body = (c, events) => ({ ok: true, resolve: c, events, scopedReplaySufficient: true });

const real = proposeTx({ ...pick(buildNameClaim({ name: "zed" })), priv: keyA, outputs: feeOut() });
const all = world([{ height: 33_700, tx: real }]);
const [hReal] = all.hints;
const spv = source(all.blocks, 33_800);
const both = mkFetch({ [PRIMARY]: body(claim(A), [hReal]), [CLARVIS]: body(claim(A), [hReal]) });

const honest = await verifyNameUnion("zed", SOURCES, spv, both);
check(`control: the registered name verifies to its owner (${honest.verified}, owner ${honest.owner === A})`, honest.verified === true && honest.owner === A && honest.addr === A);

// names.ts checks the name grammar before any lookup: only "constructor" passes it; the others reach the index only
// through a direct call, which this test makes.
for (const nm of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
  const v = await verifyNameUnion(nm, SOURCES, spv, both);
  check(`${nm} (name grammar ${isPlainName(nm) ? "passes" : "refuses"}): not verified (${v.verified}, addr ${v.addr}, ${v.reason})`, v.verified === false && v.addr !== "undefined" && v.owner !== "undefined");
}
check("of the four, only constructor passes the name grammar a send applies", isPlainName("constructor") && !isPlainName("__proto__") && !isPlainName("toString") && !isPlainName("hasOwnProperty"));

done("namespv-proto-name");
