// A name replay counts only cairnx:v1 records. The resolver's own scan reads only that domain, but a Propose in
// another application domain whose uri parses as a cairnx record is just as merkle-proven and signer-bound, so a
// hint source that served one could replay a name to an owner the resolver never saw. toChainEvent (spvbind.ts),
// which both the name replay and the fill scan map proven txs through, maps a foreign-domain Propose to no event.
// Real signed txs in synthetic PoW-verified blocks (test/_spvrig.ts).
// Run: npx tsx test/name-domain.test.mjs   (offline)
import { checker } from "./helpers/check.mjs";
import { verifyNameUnion } from "../src/core/namespv.js";
import { toChainEvent } from "../src/core/spvbind.js";
import { proposeTx, world, source, feeOut, pick, mkFetch, addrFromPriv, buildNameClaim, buildNameSet, ctxid, rpcTxToTx } from "./_spvrig.ts";

const { check, done } = checker("name replay: only cairnx:v1 records count:");
const keyA = "0x" + "31".repeat(32), keyB = "0x" + "32".repeat(32);
const A = addrFromPriv(keyA).toLowerCase(), B = addrFromPriv(keyB).toLowerCase();
const NM = "zed", FOREIGN = "uplink:v1";
const PRIMARY = "https://primary.example/trade/api", CLARVIS = "https://clarvis.example/trade/api";
const SOURCES = [{ label: "primary", base: PRIMARY }, { label: "clarvis", base: CLARVIS }];
const claim = (a) => ({ addr: a, owner: a, via: "owner" });
const body = (c, events) => ({ ok: true, resolve: c, events, scopedReplaySufficient: true });

// A registers zed in cairnx:v1 at 33,700; B's registration of the same name, anchored earlier, is in another domain.
const real = proposeTx({ ...pick(buildNameClaim({ name: NM })), priv: keyA, outputs: feeOut() });
const foreign = proposeTx({ ...pick(buildNameClaim({ name: NM })), priv: keyB, outputs: feeOut(), domain: FOREIGN });
const foreignSet = proposeTx({ ...pick(buildNameSet({ name: NM, addr: B })), priv: keyA, domain: FOREIGN });
const placed = [{ height: 33_690, tx: foreign }, { height: 33_700, tx: real }, { height: 33_710, tx: foreignSet }];
const all = world(placed);
const [hForeign, hReal, hForeignSet] = all.hints;
const spv = source(all.blocks, 33_800);

const t = rpcTxToTx(foreign);
check("a foreign-domain Propose maps to no event", toChainEvent(t, ctxid(t), 33_690, 0, B) === null);
const tr = rpcTxToTx(real);
check("a cairnx:v1 Propose maps to its event", toChainEvent(tr, ctxid(tr), 33_700, 0, A)?.kind === "propose");

const honest = await verifyNameUnion(NM, SOURCES, spv, mkFetch({ [PRIMARY]: body(claim(A), [hReal]), [CLARVIS]: body(claim(A), [hReal]) }));
check(`control: two honest sources verify A (${honest.owner === A}, disagree ${honest.disagree})`, honest.verified === true && honest.owner === A && honest.disagree === false);
const hostile = await verifyNameUnion(NM, SOURCES, spv, mkFetch({ [PRIMARY]: body(claim(A), [hReal]), [CLARVIS]: body(claim(B), [hForeign, hReal]) }));
check(`a source adding an earlier foreign-domain registration does not move the owner (owner ${hostile.owner === A ? "A" : hostile.owner === B ? "B" : hostile.owner})`, hostile.verified === true && hostile.owner === A && hostile.addr === A);
check(`...in the union replay itself, with clarvis's claim flagged, not through a one-source recovery (disagree ${hostile.disagree}, soleSource ${hostile.soleSource})`, hostile.disagree === true && hostile.soleSource !== true && hostile.recovered !== true);
const set = await verifyNameUnion(NM, SOURCES, spv, mkFetch({ [PRIMARY]: body(claim(A), [hReal]), [CLARVIS]: body(claim(B), [hReal, hForeignSet]) }));
check(`the owner's own nset in another domain does not repoint the name (addr ${set.addr === A ? "A" : set.addr === B ? "B" : set.addr})`, set.verified === true && set.addr === A);
const alone = await verifyNameUnion(NM, [SOURCES[1]], spv, mkFetch({ [CLARVIS]: body(claim(B), [hForeign]) }));
check(`foreign-domain records alone establish no owner (${alone.verified}: ${alone.reason})`, alone.verified === false && /don't establish ownership/.test(String(alone.reason)));

done("name-domain");
