// A served block body whose transaction is not written as the node writes it (the csd-light 0.1.27 bind):
// a `txid` field absent or not the id its body hashes to, or a Propose's `payload_hash` or an Attest's `proposal_id`
// without `0x` or in upper case. No hash commits the `txid` field and the codec reads either hex spelling to the same
// bytes, so such a body matches the verified merkle root. The block bind refuses it as body-mismatch, and the wallet
// refuses on each path that reads block bodies:
//   - the shared bind (`spvbind.ts` bindBlock): a body-mismatch refusal, never a bound block;
//   - the fill preflight's fclaim lane (Wallet.fillOffer on a reservation): RPC_BLOCK_MISMATCH, nothing submitted;
//   - the fill preflight's offer-id lane (Wallet.fillOffer on a taker-bound offer): VERIFY_UNAVAILABLE, nothing
//     submitted (SECURITY.md: "an offer-id fill refuses as VERIFY_UNAVAILABLE");
//   - name verification (Wallet.verifyName, Wallet.resolveName): not chain-verified, with the bind's reason.
// Each source carries a merkle root over the honest txids, so only the served text differs.
//   RED-FIRST: on the 0.1.26 bundle the bind binds every mutated body, and the fills on both lanes sign and submit
//   and the name verifies in every case but a payload_hash without 0x, which the record parse refuses (the fclaim
//   lane as VERIFY_UNAVAILABLE, the name for another reason).
//   HONEST PATH: the same blocks served as the node writes them bind, both fills sign and submit one transaction,
//   and the name verifies to its owner's address.
// Run: TSX_DISABLE_CACHE=1 node --import tsx test/spv-node-form.test.mjs   (offline)
import "./helpers/backup-host.mjs";
import { checker } from "./helpers/check.mjs";
import { Wallet } from "../src/core/wallet.ts";
import { memoryStore } from "../src/core/storage.ts";
import { bindBlock } from "../src/core/spvbind.ts";
import { offer, fclaim, requiredFillOutputs, epochOf, feeBpsAt, V29_HEIGHT } from "../src/vendor/cairnx-spv.js";
import {
  proposeTx, attestTx, addrFromPriv, ctxid, rpcTxToTx, merkleRoot, prevoutFor, pick, nodeBlockBody, FILLER,
  buildNameClaim, buildNameSet, feeOut, mkFetch,
} from "./_spvrig.ts";
import { mkCoin, txReply } from "./_coin.ts";

const { check, done } = checker("a served block body not as the node writes it is refused on every path that binds it:");

const RPC = "https://cairn-substrate.test/api/rpc", API = "https://cairn-substrate.test";
const meKey = "0x" + "1a".repeat(32), sellerKey = "0x" + "5e".repeat(32), strangerKey = "0x" + "2b".repeat(32);
const ME = addrFromPriv(meKey).toLowerCase(), SELLER = addrFromPriv(sellerKey).toLowerCase();
const V = 5_000_000;
const H_OFF = 87_000, H_G = V29_HEIGHT + 50, TIP = V29_HEIGHT + 60;
const idOf = (tx) => ctxid(rpcTxToTx(tx)).toLowerCase();

// The mutations, each applied to a copy of one served tx. The hex fields are chosen to carry letters, so the
// upper-case spelling differs from the node's.
const MUTATIONS = [
  ["its txid field absent", "propose", (t) => { delete t.txid; }],
  ["its txid field another tx's id", "propose", (t, other) => { t.txid = other; }],
  ["its payload_hash without 0x", "propose", (t) => { t.app.payload_hash = t.app.payload_hash.slice(2); }],
  ["its payload_hash in upper case", "propose", (t) => { t.app.payload_hash = "0x" + t.app.payload_hash.slice(2).toUpperCase(); }],
  ["an attest's proposal_id without 0x", "attest", (t) => { t.app.proposal_id = t.app.proposal_id.slice(2); }],
  ["an attest's proposal_id in upper case", "attest", (t) => { t.app.proposal_id = "0x" + t.app.proposal_id.slice(2).toUpperCase(); }],
];

// A synthetic PoW-verified source in the production shape (bodySource and headerSource as liveSpvSource sets them).
// `serve` maps a block's honest txs to the txs served; the merkle root is always over the honest txids.
function mkSource(blocks, tip, serve = (_h, txs) => txs) {
  return {
    bodySource: RPC, headerSource: API,
    async prepare() { return { verifiedTip: tip, nodeTip: tip }; },
    async blockAt(height) {
      const txs = blocks.get(height) ?? [FILLER];
      return { merkle: merkleRoot(txs.map((t) => ctxid(rpcTxToTx(t.app ? t : { ...t, app: { type: "None" } })))), body: nodeBlockBody(serve(height, txs)) };
    },
    async prevoutScriptPubkey(prevTxid) { return prevoutFor(prevTxid); },
  };
}
// Serve block `height` with the tx `targetId` mutated; `otherId` is another tx's id in that block.
const mutated = (height, targetId, otherId, mutate) => (h, txs) => h !== height ? txs : txs.map((t) => {
  if (t.txid !== targetId) return t;
  const copy = structuredClone(t);
  mutate(copy, otherId);
  return copy;
});
const sameId = (a, b) => ctxid(rpcTxToTx(a)) === ctxid(rpcTxToTx(b));

// ── the fill world: an open-lane offer with my granted reservation, a taker-bound offer to me, and a stranger's
// attest, all three in the offer block ──
const openRec = offer({ give: { ticker: "AAA", amount: "10" }, want: { value: String(V), payto: SELLER } });
const takerRec = offer({ give: { ticker: "AAA", amount: "10" }, want: { value: String(V), payto: SELLER }, taker: ME });
const openTx = proposeTx({ ...pick(openRec), priv: sellerKey, expiresEpoch: 9e9 });
const takerTx = proposeTx({ ...pick(takerRec), priv: sellerKey, expiresEpoch: 9e9 });
const strayAttest = attestTx({ proposalId: "0x" + "ab".repeat(32), score: 0, priv: strangerKey });
const OPEN = idOf(openTx), TAKER = idOf(takerTx), STRAY = idOf(strayAttest);
const claimTx = proposeTx({ ...pick(fclaim({ offer: OPEN })), priv: meKey, expiresEpoch: epochOf(H_G) + 2 });
const CLAIM = idOf(claimTx);
const fillBlocks = new Map([[H_OFF, [openTx, takerTx, strayAttest]], [H_G, [claimTx]]]);

const servedOpen = { id: OPEN, seller: SELLER, give: { ticker: "AAA", amount: "10" }, want: { value: String(V), payto: SELLER }, status: "open", height: H_OFF, feeBps: feeBpsAt(H_OFF), paid: "0", delivered: "0" };
const servedAlias = { ...servedOpen, fclaimId: CLAIM, fclaimHeight: H_G, fclaimExpiresEpoch: epochOf(H_G) + 2 };
const servedTaker = { ...servedOpen, id: TAKER, taker: ME };
const outputsFor = (served) => requiredFillOutputs(served, BigInt(V)).map(({ to, value }) => ({ to, value: Number(value) }));

// Wallet.fillOffer with the wallet holding the buyer key, its light client replaced by `source`, and the resolver,
// the coin and the submit route stubbed. Returns the result and the submitted bodies.
async function walletFill(source, lane) {
  const w = new Wallet(memoryStore());
  if ((await w.importKey(meKey, "pw-node-form-123")).addr.toLowerCase() !== ME) throw new Error("setup: wrong account");
  w.nameSpvForTest = source;
  const coin = mkCoin(100_000_002);
  const submits = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.includes("/tx/submit")) { submits.push(JSON.parse(init?.body || "{}")); return { ok: true, status: 200, json: async () => ({ ok: true, txid: "0x" + "aa".repeat(32) }) }; }
    const m = u.match(/\/cairnx\/offer\/(0x[0-9a-f]{64})$/);
    if (m && u.includes("clarvis")) return { ok: false, status: 404, json: async () => ({}) };
    if (m && lane === "fclaim" && m[1] === CLAIM) return { ok: true, status: 200, json: async () => servedAlias };
    if (m && lane === "offer-id" && m[1] === TAKER) return { ok: true, status: 200, json: async () => servedTaker };
    if (u.match(/\/utxos\//)) return { ok: true, status: 200, json: async () => ({ confirmed_balance: coin.coin.value, utxos: [coin.coin] }) };
    if (u.endsWith("/tip")) return { ok: true, status: 200, json: async () => ({ height: TIP }) };
    const t = txReply(u, [coin]);
    if (t) return t;
    return { ok: false, status: 404, json: async () => ({}) };
  };
  try {
    const r = lane === "fclaim"
      ? await w.fillOffer({ proposalId: CLAIM, outputs: outputsFor(servedOpen) })
      : await w.fillOffer({ proposalId: TAKER, outputs: outputsFor(servedTaker) });
    return { r, submits };
  } finally { globalThis.fetch = origFetch; }
}

const BIND_REASON = new RegExp(`^block ${H_OFF} from ${RPC.replace(/[.]/g, "\\.")} does not match its verified merkle root`);

console.log("the fill preflight (fclaim lane and offer-id lane):");
for (const [label, target, mutate] of MUTATIONS) {
  const lanes = target === "propose" ? [["fclaim", OPEN, TAKER], ["offer-id", TAKER, OPEN]] : [["fclaim", STRAY, OPEN], ["offer-id", STRAY, OPEN]];
  const [, firstTarget, firstOther] = lanes[0];
  const serve = mutated(H_OFF, firstTarget, firstOther, mutate);
  const honestTxs = fillBlocks.get(H_OFF), at = honestTxs.findIndex((t) => t.txid === firstTarget);
  const served = serve(H_OFF, honestTxs)[at];
  check(`setup (${label}): the served tx differs in text and hashes to the same id`, JSON.stringify(served) !== JSON.stringify(honestTxs[at]) && sameId(served, honestTxs[at]));
  const b = await bindBlock(mkSource(fillBlocks, TIP, serve), H_OFF);
  check(`bindBlock: a body with ${label} is refused as body-mismatch (${b.ok ? "bound" : b.kind})`, b.ok === false && b.kind === "body-mismatch" && BIND_REASON.test(b.reason));
  for (const [lane, targetId, otherId] of lanes) {
    const { r, submits } = await walletFill(mkSource(fillBlocks, TIP, mutated(H_OFF, targetId, otherId, mutate)), lane);
    if (lane === "fclaim")
      check(`fclaim lane, ${label}: refused RPC_BLOCK_MISMATCH naming the block, the RPC and the header source, nothing submitted (${r?.ok ? "signed" : r?.code}, ${submits.length} submitted)`,
        r?.ok === false && r.code === "RPC_BLOCK_MISMATCH" && String(r.error).startsWith(`refusing to sign: block ${H_OFF} from ${RPC} does not match the block header the wallet verified from ${API}.`) && submits.length === 0);
    else
      check(`offer-id lane, ${label}: refused VERIFY_UNAVAILABLE, nothing submitted (${r?.ok ? "signed" : r?.code}, ${submits.length} submitted)`,
        r?.ok === false && r.code === "VERIFY_UNAVAILABLE" && /couldn't prove this offer's on-chain payment recipient/.test(String(r.error)) && submits.length === 0);
  }
}

{
  const b = await bindBlock(mkSource(fillBlocks, TIP), H_OFF);
  check("honest path: the offer block served as the node writes it binds, three txs", b.ok === true && b.ids.length === 3 && b.ids[0] === OPEN);
  const f = await walletFill(mkSource(fillBlocks, TIP), "fclaim");
  check(`honest path, fclaim lane: the fill signs and submits one transaction (${f.r?.ok ? "ok" : `${f.r?.code}: ${f.r?.error}`})`, f.r?.ok === true && f.submits.length === 1);
  const o = await walletFill(mkSource(fillBlocks, TIP), "offer-id");
  check(`honest path, offer-id lane: the fill signs and submits one transaction (${o.r?.ok ? "ok" : `${o.r?.code}: ${o.r?.error}`})`, o.r?.ok === true && o.submits.length === 1);
}

// ── the name world: A registers "dana" and points it at TARGET; a stranger's attest shares the claim's block ──
console.log("name verification (Wallet.verifyName and Wallet.resolveName):");
const PRIMARY = "https://cairn-substrate.com/trade/api", CLARVIS = "https://clarvis.cairn-substrate.com/trade/api";
const keyA = "0x" + "11".repeat(32), A = addrFromPriv(keyA).toLowerCase();
const TARGET = "0x" + "cd".repeat(20), NM = "dana", H_N = 33_700, H_S = 33_710, TIP_N = 33_800;
const nClaim = proposeTx({ ...pick(buildNameClaim({ name: NM })), priv: keyA, outputs: feeOut() });
const nSet = proposeTx({ ...pick(buildNameSet({ name: NM, addr: TARGET })), priv: keyA });
const nAttest = attestTx({ proposalId: "0x" + "ef".repeat(32), score: 0, priv: strangerKey });
const nameBlocks = new Map([[H_N, [nClaim, nAttest]], [H_S, [nSet]]]);
const history = { ok: true, addr: TARGET, owner: A, via: "nset", resolve: { addr: TARGET, owner: A, via: "nset" }, events: [{ txid: idOf(nClaim), height: H_N, pos: 0 }, { txid: idOf(nSet), height: H_S, pos: 0 }] };
const nameWallet = new Wallet(memoryStore());
await nameWallet.create("pw-node-form-name");

async function verifyWith(source) {
  nameWallet.nameSpvForTest = source;
  const origFetch = globalThis.fetch;
  globalThis.fetch = mkFetch({ [PRIMARY]: history, [CLARVIS]: history });
  try { return { v: await nameWallet.verifyName(NM), res: await nameWallet.resolveName(NM) }; }
  finally { globalThis.fetch = origFetch; }
}

const NAME_REASON = new RegExp(`^block ${H_N} from ${RPC.replace(/[.]/g, "\\.")} does not match its verified merkle root`);
for (const [label, target, mutate] of MUTATIONS) {
  const [targetId, otherId] = target === "propose" ? [idOf(nClaim), idOf(nAttest)] : [idOf(nAttest), idOf(nClaim)];
  const { v, res } = await verifyWith(mkSource(nameBlocks, TIP_N, mutated(H_N, targetId, otherId, mutate)));
  check(`verifyName, ${label}: not chain-verified, with the bind's reason (${v.verified}: ${v.reason})`, v.verified === false && NAME_REASON.test(String(v.reason)));
  check(`resolveName, ${label}: the recipient is marked not chain-verified (${res.verified})`, res.ok === true && res.verified === false && NAME_REASON.test(String(res.verifyReason)));
}
{
  const { v, res } = await verifyWith(mkSource(nameBlocks, TIP_N));
  check(`honest path: the name verifies to its owner's address from two sources (${v.verified}: ${v.reason ?? v.addr})`, v.verified === true && v.addr === TARGET && v.owner === A && v.sources === 2);
  check("honest path: resolveName serves the verified address", res.ok === true && res.verified === true && res.addr === TARGET);
}

done("spv-node-form");
