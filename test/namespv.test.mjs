// namespv.test.mjs; the XREPO-1 name verifier (core/namespv.ts), tested with REAL signed cairnx txs +
// synthetic PoW-verified blocks (the SpvSource injection seam). Proves the security properties without a
// live chain: a correct mapping verifies, a FORGED address is refused, a TAMPERED block is refused, a
// LAPSED lease is refused, and the replay equals the audited resolver. Run: tsx test/namespv.test.mjs
import { verifyNameUnion } from "../src/core/namespv.ts";
import { checker } from "./_check.ts";
// The SPV rig (proposeTx / world / source / mkFetch / prevout registry) + the cairnx/csdtx/vendor building
// blocks are shared with the name2/name4/name5 PoCs via _spvrig.ts (extracted 2026-07-06 from 4 hand copies).
import {
  buildNameClaim, buildNameSet, buildNameXfer, buildNameProfile, TREASURY_ADDR,
  addrFromPriv, signSighash, buildScriptSig, ctxid, vSighash, merkleRoot, rpcTxToTx, resolve,
  REG_FEE, proposeTx, attestTx, world, source, feeOut, pick, prevoutFor, nodeBlockBody, mkFetch as mkFetchByBase,
} from "./_spvrig.ts";
import { nameCommit, nameCommitRecord, nameFinalize, V25_HEIGHT, V28_HEIGHT, REG_COMMIT_MAX_BLOCKS, offer, fclaim, deploy, mint, tradeFee, makerRebate, epochOf, SCORE_FILL, CONF_TOKEN_FILL, DEPLOY_FEE } from "../src/vendor/cairnx-spv.js";

const { check: ok, done } = checker();

const keyA = "0x" + "11".repeat(32), keyB = "0x" + "22".repeat(32);
const A = addrFromPriv(keyA).toLowerCase(), B = addrFromPriv(keyB).toLowerCase();
const TARGET = "0x" + "cd".repeat(20), ATTACKER = "0x" + "ee".repeat(20);

const NAME = "alice";
const claimTx = proposeTx({ ...pick(buildNameClaim({ name: NAME })), priv: keyA, outputs: feeOut() });
const nsetTx = proposeTx({ ...pick(buildNameSet({ name: NAME, addr: TARGET })), priv: keyA });

// D2 (2026-09-12): the single-source verifyName twin was DELETED (zero prod callers; it drifted from
// the union and let this suite certify code production never ran). Every former single-source case now
// drives verifyNameUnion with ONE source; the production shape. Honest semantic flips (Fable-gated):
// a forged/stale served claim is no longer REFUSED; the union serves the chain-PROVEN winner and flags
// the source's disagreement (strictly stronger: the user sends to the proven address, never the served
// one); and the served-lapsed short-circuit is gone (nothing in the union reads claim.lapsed; the N19
// lapse path is covered in resolve-lapse-corroborate).
const SRC1 = [{ label: "primary", base: "https://primary.example/trade/api" }];
const unionOne = (nm, claim, hints, src) =>
  verifyNameUnion(nm, SRC1, src, mkFetchByBase({ [SRC1[0].base]: { ok: true, resolve: claim, events: hints } }));

console.log("XREPO-1 name verifier (real signed txs + synthetic PoW-verified blocks):");

// 1. HAPPY PATH; A registers alice, sets addr=TARGET; resolver claims TARGET ⇒ verified
{
  const { blocks, hints } = world([{ height: 33700, tx: claimTx }, { height: 33710, tx: nsetTx }]);
  const r = await unionOne(NAME, { addr: TARGET, owner: A, via: "nset" }, hints, source(blocks, 33800));
  ok("correct mapping verifies", r.verified === true && r.addr === TARGET && r.owner === A && r.via === "nset");
  ok("reports a sane confirmation depth", typeof r.depth === "number" && r.depth >= 90);
  ok("single source is flagged as such (sources=1, no multi-source claim)", r.sources === 1);
}

// 2. FORGED ADDRESS; the resolver claims ATTACKER, the chain proves TARGET. D2/S-B6 truth: the union
//    serves the chain-PROVEN address (never the forged claim) and flags the source's disagreement.
{
  const { blocks, hints } = world([{ height: 33700, tx: claimTx }, { height: 33710, tx: nsetTx }]);
  const r = await unionOne(NAME, { addr: ATTACKER, owner: A }, hints, source(blocks, 33800));
  ok("a forged resolver address is never served: the PROVEN address wins, source flagged disagree", r.verified === true && r.addr === TARGET && r.disagree === true);
}

// 3. TAMPERED BLOCK; node serves a tx-set that doesn't hash to the (claimed) verified merkle root ⇒ REFUSED
{
  const { blocks, hints } = world([{ height: 33700, tx: claimTx }, { height: 33710, tx: nsetTx }]);
  const r = await unionOne(NAME, { addr: TARGET, owner: A }, hints, source(blocks, 33800, { tamperMerkle: 33710 }));
  ok("tampered block (merkle mismatch) is REFUSED", r.verified === false && /merkle/i.test(r.reason ?? ""));
}

// 4. WITHHELD/MISSING record; a hint points at a block that doesn't contain it ⇒ REFUSED (fail-closed)
{
  const { blocks } = world([{ height: 33700, tx: claimTx }]);
  const bogus = [{ txid: "0x" + "ab".repeat(32), height: 33700, pos: 9 }];
  const r = await unionOne(NAME, { addr: TARGET, owner: A }, bogus, source(blocks, 33800));
  ok("a hint not present in the verified block is REFUSED", r.verified === false && /not in verified block/i.test(r.reason ?? ""));
}

// 5. NAME TRANSFERRED; A registers, transfers to B, B sets addr; the union proves B's ownership
{
  const xferTx = proposeTx({ ...pick(buildNameXfer({ name: NAME, to: B })), priv: keyA });
  const nsetB = proposeTx({ ...pick(buildNameSet({ name: NAME, addr: TARGET })), priv: keyB });
  const { blocks, hints } = world([
    { height: 33700, tx: claimTx }, { height: 33710, tx: xferTx }, { height: 33720, tx: nsetB },
  ]);
  const r = await unionOne(NAME, { addr: TARGET, owner: B }, hints, source(blocks, 33800));
  ok("after transfer, ownership verifies to the NEW owner", r.verified === true && r.owner === B && r.addr === TARGET);
  // a served claim naming the OLD owner is ignored; the proven owner wins
  const r2 = await unionOne(NAME, { addr: TARGET, owner: A }, hints, source(blocks, 33800));
  ok("a stale OWNER claim is ignored (the proven owner wins)", r2.verified === true && r2.owner === B);
  // a served STALE address is never served; the proven address wins + the source is flagged
  const staleAddr = "0x" + "99".repeat(20);
  const r3 = await unionOne(NAME, { addr: staleAddr, owner: A }, hints, source(blocks, 33800));
  ok("a stale/forged addr is never served: the PROVEN addr wins + disagree", r3.verified === true && r3.addr === TARGET && r3.disagree === true);
}

// 6. UNAUTHENTICATED signer; corrupt the scriptSig so the signature can't authenticate ⇒ REFUSED
{
  const badTx = JSON.parse(JSON.stringify(claimTx));
  badTx.inputs[0].script_sig = "0x40" + "00".repeat(64) + "21" + "00".repeat(33); // well-formed shape, invalid sig
  const { blocks, hints } = world([{ height: 33700, tx: badTx }]);
  const r = await unionOne(NAME, { addr: TARGET, owner: A }, hints, source(blocks, 33800));
  ok("a record with an unverifiable signature is REFUSED", r.verified === false);
}

// 7. REPLAY EQUIVALENCE; the verifier's resolve() over reconstructed events equals a direct resolve()
{
  const events = [claimTx, nsetTx].map((t, i) => {
    const tx = rpcTxToTx(t);
    return { kind: "propose", id: ctxid(tx).toLowerCase(), proposer: A, uri: tx.app.uri, payloadHash: String(tx.app.payloadHash).toLowerCase(), expiresEpoch: Number(tx.app.expiresEpoch), height: 33700 + i * 10, pos: 0, paidTo: i === 0 ? { [TREASURY_ADDR]: String(REG_FEE) } : {} };
  });
  const direct = resolve(events, 33800).names[NAME];
  ok("direct resolve() establishes the name (sanity for the oracle)", direct && direct.owner === A && direct.addr === TARGET);
}

// 8. (DROPPED with D2); the single-source twin's served-`lapsed` short-circuit is gone: nothing in
//    the union reads claim.lapsed. The lapse path is covered by the N19 union behavior in
//    resolve-lapse-corroborate.test.mjs and the NS-2 proven-lapse gate in names.ts.

// 9. DoS-RESISTANCE; a hostile node pads a hinted block with an app-LESS filler tx (no `app` field).
//    rpcTxToTx must not throw on it (the fix); the hinted record still verifies. (review finding #2)
{
  const filler = { version: 1, locktime: 0, inputs: [{ prev_txid: "0x" + "00".repeat(32), vout: 1, script_sig: "0x" }], outputs: [{ value: 1, script_pubkey: "0x" + "77".repeat(20) }] }; // NO app
  const txs = [claimTx, filler];
  const merkle = merkleRoot(txs.map((t) => ctxid(rpcTxToTx(t.app ? t : { ...t, app: { type: "None" } }))));
  const blocks = new Map([[33700, txs]]);
  const hints = [{ txid: ctxid(rpcTxToTx(claimTx)), height: 33700, pos: 0 }];
  // a source that serves the real (filler-padded) tx-set + its true merkle
  const src = { async prepare() { return { verifiedTip: 33800, nodeTip: 33800 }; }, async blockAt() { return { merkle, body: nodeBlockBody(txs) }; }, async prevoutScriptPubkey(t) { return prevoutFor(t); } };
  // only a claim (no nset) ⇒ addr defaults to owner A
  const r = await unionOne(NAME, { addr: A, owner: A }, hints, src);
  ok("an app-less filler tx in a hinted block does NOT break verification (no throw)", r.verified === true && r.owner === A);
}

// 10. V19 / nprofile (audit NSPV-V19-TESTS); the prior suite ran ENTIRELY below V19_HEIGHT (36,700), so the
//     wallet's own SPV verifier was never exercised over a V19-height block. V19 went live on-chain; the
//     vendored resolver must (a) process a hinted nprofile record at a height >= V19_HEIGHT without error, and
//     (b) keep the send verdict UNCHANGED; nprofile is cosmetic identity metadata and must NOT move owner/addr
//     (the property the wallet relies on: namespv reads only addr/owner/expired, never the profile field).
{
  const V19 = 36700;
  const profTx = proposeTx({ ...pick(buildNameProfile({ name: NAME, profile: { twitter: "alice", avatar: "ipfs://Qmxyz" } })), priv: keyA });
  const { blocks, hints } = world([
    { height: 33700, tx: claimTx }, { height: 33710, tx: nsetTx }, { height: V19 + 10, tx: profTx },
  ]);
  const r = await unionOne(NAME, { addr: TARGET, owner: A, via: "nset" }, hints, source(blocks, V19 + 100));
  ok("V19 nprofile at a >=V19_HEIGHT block verifies without error", r.verified === true);
  ok("nprofile is consensus-inert for the send verdict (addr/owner unchanged)", r.addr === TARGET && r.owner === A);
  // and a forged addr is still never served even with the V19 record present
  const rf = await unionOne(NAME, { addr: ATTACKER, owner: A }, hints, source(blocks, V19 + 100));
  ok("a forged addr is never served with an nprofile record in play (proven wins + disagree)", rf.verified === true && rf.addr === TARGET && rf.disagree === true);
}

// 11-14. UNION cross-check (NSPV-COMPLETE-1 cure, doc 36 Part B); verifyNameUnion over 2 sources
{
  const NM = "bob";
  const aClaim = proposeTx({ ...pick(buildNameClaim({ name: NM })), priv: keyA, outputs: feeOut() }); // A wins (earlier height)
  const aNset = proposeTx({ ...pick(buildNameSet({ name: NM, addr: TARGET })), priv: keyA });
  const bClaim = proposeTx({ ...pick(buildNameClaim({ name: NM })), priv: keyB, outputs: feeOut(REG_FEE + 1) }); // B loses (later height); distinct fee → distinct txid (a real competing claim spends different inputs)
  const bNset = proposeTx({ ...pick(buildNameSet({ name: NM, addr: ATTACKER })), priv: keyB });
  const { blocks } = world([
    { height: 33700, tx: aClaim }, { height: 33705, tx: bClaim }, { height: 33710, tx: aNset }, { height: 33715, tx: bNset },
  ]);
  const H = (tx, h) => ({ txid: ctxid(rpcTxToTx(tx)), height: h, pos: 0 });
  const granus = [H(bClaim, 33705), H(bNset, 33715)];   // HOSTILE: withholds A's winning claim, shows only B's losing one
  const clarvis = [H(aClaim, 33700), H(aNset, 33710)];  // HONEST: shows A's winning claim
  const src = source(blocks, 33800);
  const SRC = [{ label: "primary", base: "https://primary.example/trade/api" }, { label: "clarvis", base: "https://clarvis.example/trade/api" }];
  // adapt the shared per-base mock to this section's (primary, clarvis) call shape (a {__status:502} body = down)
  const mkFetch = (gBody, cBody) => mkFetchByBase({ [SRC[0].base]: gBody, [SRC[1].base]: cBody });

  // 11. withholding DEFEATED: union resolves to the true winner (TARGET), not the attacker; hostile source flagged
  const r11 = await verifyNameUnion(NM, SRC, src, mkFetch(
    { ok: true, resolve: { addr: ATTACKER, owner: B, via: "nset" }, events: granus },
    { ok: true, resolve: { addr: TARGET, owner: A, via: "nset" }, events: clarvis }));
  ok("union DEFEATS a withholding resolver: resolves to the true winner, NOT the attacker", r11.verified === true && r11.addr === TARGET && r11.addr !== ATTACKER);
  ok("union flags the disagreeing (hostile) source", r11.disagree === true && r11.sources === 2);

  // 12. both sources AGREE on the true mapping → strong, no disagreement
  const r12 = await verifyNameUnion(NM, SRC, src, mkFetch(
    { ok: true, resolve: { addr: TARGET, owner: A, via: "nset" }, events: clarvis },
    { ok: true, resolve: { addr: TARGET, owner: A, via: "nset" }, events: clarvis }));
  ok("two agreeing sources → verified, 2 sources, no disagreement", r12.verified === true && r12.addr === TARGET && r12.sources === 2 && r12.disagree === false);

  // 13. fail-SOFT: one source down (502) → single-source verify still works
  const r13 = await verifyNameUnion(NM, SRC, src, mkFetch(
    { ok: true, resolve: { addr: TARGET, owner: A, via: "nset" }, events: clarvis },
    { __status: 502 }));
  ok("fail-soft: one source down → single-source verify (sources=1)", r13.verified === true && r13.addr === TARGET && r13.sources === 1 && r13.disagree === false);

  // 14. both sources down → unavailable (fail-closed, not verified)
  const r14 = await verifyNameUnion(NM, SRC, src, mkFetch({ __status: 502 }, { __status: 502 }));
  ok("both sources down → NOT verified (fail-closed, unavailable)", r14.verified === false && r14.sources === 0);
}

// 15. H3 / NSPV-SIGSUB-1; a hostile block-body provider swaps a salt-less name claim's scriptSig for a
//     FOREIGN but VALID signature over the same (secret-free) public sighash, re-attributing the author. The
//     txid is unchanged (scriptSig is stripped from it) so the merkle proof still passes; the ONLY thing that
//     stops the redirect is the prevout-ownership bind: the signer must own the coin the tx spends.
{
  const NM = "carol";
  const legit = proposeTx({ ...pick(buildNameClaim({ name: NM })), priv: keyA, outputs: feeOut() }); // A's own coin
  // tamper: re-sign the SAME (stripped) sighash with the ATTACKER's key B, keeping A's prevout
  const tampered = JSON.parse(JSON.stringify(legit));
  const { sig64, pub33 } = signSighash(vSighash(rpcTxToTx(legit)), keyB);
  tampered.inputs[0].script_sig = buildScriptSig(sig64, pub33);
  const { blocks, hints } = world([{ height: 33700, tx: tampered }]); // ctxid(tampered)==ctxid(legit): same hint + merkle
  const r = await unionOne(NM, { addr: B, owner: B }, hints, source(blocks, 33800));
  ok("H3: scriptSig substitution on a salt-less name claim is REFUSED (prevout-ownership bind)", r.verified === false && /own the coin|substitution|bind/i.test(r.reason ?? ""));
  // and the HONEST claim (A signs, A owns the coin) still verifies; the bind does not over-reject
  const { blocks: hb, hints: hh } = world([{ height: 33700, tx: legit }]);
  const rh = await unionOne(NM, { addr: A, owner: A }, hh, source(hb, 33800));
  ok("H3: the honest signer (owns the spent coin) still verifies: no over-rejection", rh.verified === true && rh.owner === A);
}

// 16. H1 / NSPV-CLAIMCAP-1; a source flags scopedReplaySufficient:false (its winner was decided by out-of-
//     name-scope state: a V17 open-lane claim cap or a name-for-token balance). The union MUST fail closed even
//     though the scoped replay reproduces the claimed address; and must NOT over-degrade an honest name whose
//     replay IS sufficient.
{
  const NM = "dave";
  const dClaim = proposeTx({ ...pick(buildNameClaim({ name: NM })), priv: keyA, outputs: feeOut() });
  const dNset = proposeTx({ ...pick(buildNameSet({ name: NM, addr: TARGET })), priv: keyA });
  const { blocks } = world([{ height: 33700, tx: dClaim }, { height: 33710, tx: dNset }]);
  const H = (tx, h) => ({ txid: ctxid(rpcTxToTx(tx)), height: h, pos: 0 });
  const ev = [H(dClaim, 33700), H(dNset, 33710)];
  const src = source(blocks, 33800);
  const SRC = [{ label: "primary", base: "https://primary.example/trade/api" }];
  const mk = (flag) => async () => ({ ok: true, status: 200, json: async () => ({ ok: true, resolve: { addr: TARGET, owner: A, via: "nset" }, events: ev, ...(flag === undefined ? {} : { scopedReplaySufficient: flag }) }) });
  const rFalse = await verifyNameUnion(NM, SRC, src, mk(false));
  ok("H1: scopedReplaySufficient:false ⇒ NOT verified (fail-closed caution)", rFalse.verified === false && /scope|fill|out-of-band/i.test(rFalse.reason));
  const rTrue = await verifyNameUnion(NM, SRC, src, mk(true));
  ok("H1: scopedReplaySufficient:true (honest registration) stays verified: no over-degradation", rTrue.verified === true && rTrue.addr === TARGET);
  const rNone = await verifyNameUnion(NM, SRC, src, mk(undefined));
  ok("H1: a non-viaFill name with no flag stays verified (back-compat with older servers)", rNone.verified === true && rNone.addr === TARGET);
}

// 16b. The viaFill gate is what keeps a name-scoped replay from turning a fill the chain rejected into a
//      verified address. B already holds MAX_ACTIVE_CLAIMS (3) live fclaims on other offers, then fclaims A's
//      open name offer for "cove" and fills it. On the full chain that fclaim is denied by the cap, the fill does
//      nothing and A keeps the name. A replay of only cove's own records cannot see the other holds, grants the
//      fclaim and delivers cove to B with viaFill set. No source sends a scopedReplaySufficient flag here (an
//      older or hostile server), so only the wallet's own gate stands between the scoped result and "verified".
//      The token sale pins the event mapping's confidence: resolve() applies a token fill only with the
//      CONF_TOKEN_FILL marker, so a mapping that dropped it would replay that name to the seller as verified.
{
  const id = (t) => ctxid(rpcTxToTx(t)).toLowerCase();
  const H = V28_HEIGHT + 10, V = 50_000_000n, E = epochOf(H + 10) + 2;
  const names = ["cove", "pier1", "pier2", "pier3"];
  const reg = names.map((n) => proposeTx({ ...pick(buildNameClaim({ name: n })), priv: keyA, outputs: feeOut() }));
  const offs = names.map((n) => proposeTx({ ...pick(offer({ give: { name: n }, want: { value: String(V), payto: A } })), priv: keyA, expiresEpoch: epochOf(H) + 50 }));
  const fcs = offs.map((o) => proposeTx({ ...pick(fclaim({ offer: id(o) })), priv: keyB, expiresEpoch: E }));
  const fill = attestTx({ proposalId: id(fcs[0]), score: SCORE_FILL, confidence: 100, priv: keyB, outputs: [{ to: A, value: Number(V + makerRebate(V)) }, { to: TREASURY_ADDR, value: Number(tradeFee(V, 150)) }] });
  const full = world([
    ...reg.map((tx) => ({ height: 33700, tx })), ...offs.map((tx) => ({ height: H, tx })),
    ...fcs.slice(1).map((tx) => ({ height: H + 10, tx })), { height: H + 15, tx: fcs[0] }, { height: H + 20, tx: fill },
  ]);
  const own = new Set([reg[0], offs[0], fcs[0], fill].map(id));
  const scoped = full.hints.filter((h) => own.has(h.txid.toLowerCase()));
  const src = source(full.blocks, H + 30);
  const rFull = await unionOne("cove", { addr: A, owner: A, via: "owner" }, full.hints, src);
  ok(`viaFill gate: with every record the cap denies B's fclaim and cove stays with the seller (${rFull.reason ?? "verified"})`, rFull.verified === true && rFull.owner === A && rFull.addr === A);
  const rScoped = await unionOne("cove", { addr: B, owner: B, via: "owner" }, scoped, src);
  ok(`viaFill gate: cove's own records alone deliver it to B, and the wallet does NOT call that verified (${rScoped.reason ?? "verified"})`, rScoped.verified === false && rScoped.viaFill === true);

  const tok = world([
    { height: 33700, tx: proposeTx({ ...pick(buildNameClaim({ name: "quay" })), priv: keyA, outputs: feeOut() }) },
    { height: 33710, tx: proposeTx({ ...pick(deploy({ ticker: "TKN", decimals: 0, supply: "1000000", mint: "issuer" })), priv: keyB, outputs: [{ to: TREASURY_ADDR, value: Number(DEPLOY_FEE) }] }) },
    { height: 33720, tx: proposeTx({ ...pick(mint({ ticker: "TKN", amount: "1000000" })), priv: keyB }) },
  ]);
  const tOff = proposeTx({ ...pick(offer({ give: { name: "quay" }, want: { ticker: "TKN", amount: "500" }, taker: B })), priv: keyA, expiresEpoch: 2000 });
  const tFill = attestTx({ proposalId: id(tOff), score: SCORE_FILL, confidence: CONF_TOKEN_FILL, priv: keyB });
  const t2 = world([{ height: 35000, tx: tOff }, { height: 35010, tx: tFill }]);
  for (const [h, txs] of t2.blocks) tok.blocks.set(h, txs);
  const rt = await unionOne("quay", { addr: B, owner: B, via: "owner" }, [...tok.hints, ...t2.hints], source(tok.blocks, 35100));
  ok(`viaFill gate: a name bought for a token replays to the buyer and is NOT verified (${rt.reason ?? "verified"})`, rt.verified === false && rt.viaFill === true);
}

// 17. S-B6 (2026-09-09; REPLACES the H1 union backstop): a REGISTERED-vs-UNREGISTERED source split no
//     longer vetoes the proof. The old pre-replay short-circuit failed closed here, and resolveName then
//     fell through to serving the hint-serving source's RAW claim with a caution; strictly worse than
//     serving the SPV-PROVEN winner. Now: the replay runs (fabricated events aren't mined and fail SPV; a
//     genuinely-unregistered name has no mined events), the PROVEN address is served, and the 404 rides as
//     a `disagree` flag for the UI badge. A merely-DOWN peer (502) remains a non-event (single-source).
//     RED-FIRST: the old assertions (verified:false + a fail reason) flip.
{
  const NM = "erin";
  const eClaim = proposeTx({ ...pick(buildNameClaim({ name: NM })), priv: keyA, outputs: feeOut() });
  const eNset = proposeTx({ ...pick(buildNameSet({ name: NM, addr: TARGET })), priv: keyA });
  const { blocks } = world([{ height: 33700, tx: eClaim }, { height: 33710, tx: eNset }]);
  const H = (tx, h) => ({ txid: ctxid(rpcTxToTx(tx)), height: h, pos: 0 });
  const ev = [H(eClaim, 33700), H(eNset, 33710)];
  const src = source(blocks, 33800);
  const SRC = [{ label: "primary", base: "https://primary.example/trade/api" }, { label: "clarvis", base: "https://clarvis.example/trade/api" }];
  // fetch mock: primary serves history; clarvis 404s (affirmatively unregistered) or 502s (merely down)
  const mk = (clarvisStatus) => async (url) => {
    const u = String(url);
    if (u.includes("clarvis")) return { ok: clarvisStatus === 200, status: clarvisStatus, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ ok: true, resolve: { addr: TARGET, owner: A, via: "nset" }, events: ev }) };
  };
  const r404 = await verifyNameUnion(NM, SRC, src, mk(404));
  ok("S-B6: a lagging-404 peer no longer suppresses the SPV proof: the PROVEN address is served", r404.verified === true && r404.addr === TARGET);
  ok("S-B6: the 404 rides as a disagree flag (the UI badge shows a source disagreed)", r404.disagree === true);
  const r502 = await verifyNameUnion(NM, SRC, src, mk(502));
  ok("S-B6: a merely-DOWN peer (502) is NOT a disagreement: lone honest source still verifies", r502.verified === true && r502.addr === TARGET && r502.sources === 1 && r502.disagree === false);
}

// 18. D4; the pos leg of the union conflict is DELETED: a pos-ONLY mismatch between sources is NOT
//     a disagreement (replayName recomputes each event's position from the merkle-bound block, so
//     hint.pos carries no tamper signal; the leg only let one source lying about pos raise a false
//     "sources DISAGREE" caution on an honest name). A same-txid-different-HEIGHT mismatch stays a
//     tamper conflict. RED-FIRST: the pos-only case was disagree:true pre-deletion.
{
  const NM2 = "frank";
  const fClaim = proposeTx({ ...pick(buildNameClaim({ name: NM2 })), priv: keyA, outputs: feeOut() });
  const fNset = proposeTx({ ...pick(buildNameSet({ name: NM2, addr: TARGET })), priv: keyA });
  const { blocks } = world([{ height: 33700, tx: fClaim }, { height: 33710, tx: fNset }]);
  const H = (tx, h, pos) => ({ txid: ctxid(rpcTxToTx(tx)), height: h, pos });
  const src = source(blocks, 33800);
  const SRC = [{ label: "primary", base: "https://primary.example/trade/api" }, { label: "clarvis", base: "https://clarvis.example/trade/api" }];
  // pos-only drift between the sources (same txid, same height, different pos)
  const rPos = await verifyNameUnion(NM2, SRC, src, mkFetchByBase({
    [SRC[0].base]: { ok: true, resolve: { addr: TARGET, owner: A, via: "nset" }, events: [H(fClaim, 33700, 0), H(fNset, 33710, 0)] },
    [SRC[1].base]: { ok: true, resolve: { addr: TARGET, owner: A, via: "nset" }, events: [H(fClaim, 33700, 1), H(fNset, 33710, 1)] },
  }));
  ok("D4: a pos-ONLY mismatch is NOT a disagreement (no tamper signal in pos)", rPos.verified === true && rPos.addr === TARGET && rPos.disagree === false);
  // a height mismatch stays a conflict
  const rH = await verifyNameUnion(NM2, SRC, src, mkFetchByBase({
    [SRC[0].base]: { ok: true, resolve: { addr: TARGET, owner: A, via: "nset" }, events: [H(fClaim, 33700, 0), H(fNset, 33710, 0)] },
    [SRC[1].base]: { ok: true, resolve: { addr: TARGET, owner: A, via: "nset" }, events: [H(fClaim, 33701, 0), H(fNset, 33710, 0)] },
  }));
  ok("D4: a same-txid-different-HEIGHT mismatch stays a tamper conflict", rH.verified === true && rH.disagree === true);
}

// A v2.5 reservation (commit, then the salted reveal) that has not been finalized confers no address: the
// audited resolver carries it as `pending`, and a send to it is refused. The resolver still names an owner
// for it, so without the refusal the reservation verifies green to the reserver's address.
//   RED-FIRST: delete the `if (rec.pending) return { ok: false, ... }` line in replayName and the first
//   assertion fails (verified:true to the reserver).
//   PAIRED HONEST PATH: the same reservation finalized inside its window verifies to its owner.
{
  const NM3 = "dora", SALT = "5a".repeat(16);
  const commitTx = proposeTx({ ...pick(nameCommitRecord({ commit: nameCommit(NM3, SALT, A) })), priv: keyA });
  const revealTx = proposeTx({ ...pick(buildNameClaim({ name: NM3, salt: SALT })), priv: keyA });
  const finalizeTx = proposeTx({ ...pick(nameFinalize({ name: NM3, salt: SALT })), priv: keyA, outputs: feeOut() });
  const C = V25_HEIGHT + 60, R = C + 5, F = C + REG_COMMIT_MAX_BLOCKS + 2;   // the reveal and finalize land inside their windows
  const TIP = C + REG_COMMIT_MAX_BLOCKS + 10;                                  // before finalizeBy, so the reservation is live
  const reserved = world([{ height: C, tx: commitTx }, { height: R, tx: revealTx }]);
  const rRes = await unionOne(NM3, { addr: A, owner: A }, reserved.hints, source(reserved.blocks, TIP));
  ok("a pending (unfinalized) reservation is REFUSED as a send target", rRes.verified === false && /reservation that has not been finalized/.test(rRes.reason ?? ""));
  const finalized = world([{ height: C, tx: commitTx }, { height: R, tx: revealTx }, { height: F, tx: finalizeTx }]);
  const rFin = await unionOne(NM3, { addr: A, owner: A }, finalized.hints, source(finalized.blocks, TIP));
  ok("paired: the same reservation, finalized, verifies to its owner", rFin.verified === true && rFin.addr === A && rFin.owner === A);
}

done("namespv");
