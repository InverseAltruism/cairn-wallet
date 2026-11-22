// WL1.5 (D20): the name proof returns the height of the event that completed the name's current holding, and the send
// review shows [A18] when it is above this release's newest table entry. Driven through the real verifyNameUnion over
// real signed records in synthetic PoW-verified blocks (_spvrig.ts), and through resolveName.
//   (1) a v2.5 registration completes at its nfinalize, not at its commit (`effectiveHeight`); a transfer or an nset after
//       it leaves the height; a name from before the two-step finalize completes at its claim;
//   (2) the groundwork's boundary case: a commit at or below the newest entry with the reveal and nfinalize above it
//       is above (the rule on `effHeight` read it as below);
//   (3) resolveName passes the height on.
// RED-FIRST: on the commit before this one, completedAt is absent and (1), (2), (3) fail; returning the record's
// `effectiveHeight` (the commit's height) instead of completingHeight fails (1a), (1b) and (2a).
// Run: node --import tsx test/name-completed-at.test.mjs   (offline)
import { verifyNameUnion } from "../src/core/namespv.ts";
import { resolveName } from "../src/core/names.ts";
import { SPV_NEWEST_HEIGHT } from "../src/core/spvnewest.ts";
import { buildNameClaim, buildNameSet, buildNameXfer, addrFromPriv, proposeTx, world, source, feeOut, pick, mkFetch } from "./_spvrig.ts";
import { nameCommit, nameCommitRecord, nameFinalize } from "../src/vendor/cairnx-spv.js";
import { checker } from "./helpers/check.mjs";

const { check, done } = checker("=== the height that completed a name's holding ===");
const keyA = "0x" + "11".repeat(32), keyB = "0x" + "22".repeat(32);
const A = addrFromPriv(keyA).toLowerCase(), B = addrFromPriv(keyB).toLowerCase();
const TARGET = "0x" + "cd".repeat(20);
const SRC = [{ label: "primary", base: "https://primary.example/trade/api" }];
const union = (nm, claim, w, tip) => verifyNameUnion(nm, SRC, source(w.blocks, tip), mkFetch({ [SRC[0].base]: { ok: true, resolve: claim, events: w.hints } }));
const registration = (nm, salt, key) => ({
  commit: proposeTx({ ...pick(nameCommitRecord({ commit: nameCommit(nm, salt, addrFromPriv(key).toLowerCase()) })), priv: key }),
  reveal: proposeTx({ ...pick(buildNameClaim({ name: nm, salt })), priv: key }),
  finalize: proposeTx({ ...pick(nameFinalize({ name: nm, salt })), priv: key, outputs: feeOut() }),
});

console.log("1. what completes a holding");
{
  const reg = registration("dora", "5a".repeat(16), keyA);
  const C = 100_000, R = C + 5, F = C + 13;
  const w = world([{ height: C, tx: reg.commit }, { height: R, tx: reg.reveal }, { height: F, tx: reg.finalize }]);
  const r = await union("dora", { addr: A, owner: A }, w, F + 40);
  check(`(1a) a registration completes at its nfinalize, ${F}, not its commit ${C} (${r.completedAt})`, r.verified === true && r.completedAt === F);
  const xfer = proposeTx({ ...pick(buildNameXfer({ name: "dora", to: B })), priv: keyA });
  const nset = proposeTx({ ...pick(buildNameSet({ name: "dora", addr: TARGET })), priv: keyB });
  const w2 = world([{ height: C, tx: reg.commit }, { height: R, tx: reg.reveal }, { height: F, tx: reg.finalize }, { height: F + 20, tx: xfer }, { height: F + 30, tx: nset }]);
  const r2 = await union("dora", { addr: TARGET, owner: B }, w2, F + 60);
  check(`(1b) a transfer and an nset after it leave the height (${r2.completedAt}, owner ${r2.owner === B ? "B" : r2.owner})`, r2.verified === true && r2.owner === B && r2.addr === TARGET && r2.completedAt === F);
  const legacy = proposeTx({ ...pick(buildNameClaim({ name: "erin" })), priv: keyA, outputs: feeOut() });
  const lset = proposeTx({ ...pick(buildNameSet({ name: "erin", addr: TARGET })), priv: keyA });
  const w3 = world([{ height: 33_700, tx: legacy }, { height: 33_710, tx: lset }]);
  const r3 = await union("erin", { addr: TARGET, owner: A }, w3, 33_800);
  check(`(1c) a name from before the two-step finalize completes at its claim, 33,700 (${r3.completedAt})`, r3.verified === true && r3.completedAt === 33_700);
}

console.log("2. the boundary case");
{
  const N = SPV_NEWEST_HEIGHT;
  const reg = registration("frank", "6b".repeat(16), keyA);
  const C = N - 4, R = N + 1, F = N + 9;   // the groundwork's case: 143,355 / 143,360 / 143,368 under 0.3.4's table
  const w = world([{ height: C, tx: reg.commit }, { height: R, tx: reg.reveal }, { height: F, tx: reg.finalize }]);
  const r = await union("frank", { addr: A, owner: A }, w, F + 40);
  check(`(2a) commit ${C} at or below the newest entry ${N}, nfinalize ${F} above it: completedAt ${r.completedAt} is above`, r.verified === true && r.completedAt === F && r.completedAt > N);
  const reg2 = registration("gina", "7c".repeat(16), keyA);
  const w2 = world([{ height: N - 30, tx: reg2.commit }, { height: N - 25, tx: reg2.reveal }, { height: N - 17, tx: reg2.finalize }]);
  const r2 = await union("gina", { addr: A, owner: A }, w2, N + 40);
  check(`(2b) honest: a registration completed below the entry stays below (${r2.completedAt})`, r2.verified === true && r2.completedAt === N - 17 && r2.completedAt <= N);
}

console.log("3. resolveName passes it on");
{
  const wallet = {
    tradeGet: async () => ({ ok: true, status: 200, json: async () => ({ addr: A, owner: A, via: "owner" }) }),
    verifyName: async (nm) => ({ verified: true, addr: A, owner: A, depth: 40, sources: 2, disagree: false, completedAt: 143_368, name: nm }),
  };
  const r = await resolveName(wallet, "dora");
  check(`(3) the resolve result carries completedAt (${r.completedAt})`, r.ok === true && r.verified === true && r.completedAt === 143_368);
}
done("name-completed-at");
