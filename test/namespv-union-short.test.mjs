// A name's union replay that stopped on a read the wallet could not make (a header page, the node tip, a block body, a
// spent coin) is tried again as a whole and is never answered by one server's records: a lagging server's records would
// prove an older holding while the unread record goes unread. On the real popup.ts (fake
// DOM) over the real Wallet, names.ts, verifyNameUnion and liveSpvSource (the cut-table bundle on a generated chain,
// test/helpers/genchain.mjs). "dora": A registers it (nfinalize at 146,313) and transfers it to B at 146,600; the store
// holds headers to 146,400 and the node tip is 147,200. The primary name server serves all four records and answers B;
// the second server lags (the registration only, and it answers A).
//   (1) every header page above the store fails, at Review and at Confirm: the Review shows the served B unverified,
//       and one Confirm click signs B, not A.
//   (2) the node tip cannot be read: the same, B unverified.
//   (3) the header route is back by Confirm: B verifies at Confirm and the first click signs B.
//   (4) honest: the header route works: B, chain-backed, the second server flagged as disagreeing.
//   (5) honest: a record above the node's tip (one server's junk hint) with the header route working: the per-server
//       recovery still proves B.
//   (6) the stated cost: a hostile primary host adds a record between the held tip and the node's tip and fails its
//       header pages: the Review shows the primary's own address unverified, where without the rule the second
//       server's records prove its answer.
//   (7) both servers current, one read fails once (a header page, the node tip): the retry verifies B.
//   (8) the second server lagging, the transfer's block body (429) or its spent coin cannot be read: the served B
//       unverified, and one click signs B. (9) honest: a block body failing once with both current verifies B.
// Mutations: the early return marked MUTATE_UNION_SHORT removed makes (1a), (1b), (2), (3), (6) and (8) fail; the retry
// marked MUTATE_SHORT_RETRY removed makes (7) fail.
// Run: npx tsx test/namespv-union-short.test.mjs   (offline)
import "./helpers/backup-host.mjs";
import { checker } from "./helpers/check.mjs";
import { cutTableBundle } from "./helpers/cuttable.mjs";
import { genChain } from "./helpers/genchain.mjs";
import { headerOf, row } from "./helpers/spvfixture.mjs";
import { installFakeDom, installBridge, flush } from "./_fakedom.mjs";
import { proposeTx, addrFromPriv, ctxid, rpcTxToTx, prevoutFor, pick, nodeBlockBody, FILLER, buildNameClaim, buildNameXfer, feeOut } from "./_spvrig.ts";

const { check, done } = checker("a name's union replay short of a header");
const C = await cutTableBundle([
  'export { liveSpvSource, flushSpvStoreWrites } from "./src/core/namespv.ts";',
  'export { Wallet } from "./src/core/wallet.ts";',
  'export { memoryStore } from "./src/core/storage.ts";',
  'export { LightClient, serializeHeader, nameCommit, nameCommitRecord, nameFinalize } from "./src/vendor/cairnx-spv.js";',
].join("\n"), { powList: true });

const F = 146000, H = 146400, TOP = 147200;
const PRIMARY = "https://cairn-substrate.com/trade/api", CLARVIS = "https://clarvis.cairn-substrate.com/trade/api";
const now = (Number(headerOf(F).time) + 60 * 86400) * 1000;
Date.now = () => now;
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const until = async (f, n = 4000) => { for (let i = 0; i < n && !f(); i++) await tick(); return f(); };

const keyA = "0x" + "11".repeat(32), keyB = "0x" + "22".repeat(32);
const A = addrFromPriv(keyA).toLowerCase(), B = addrFromPriv(keyB).toLowerCase();
const NM = "dora", salt = "5a".repeat(16);
const commit = proposeTx({ ...pick(C.nameCommitRecord({ commit: C.nameCommit(NM, salt, A) })), priv: keyA });
const reveal = proposeTx({ ...pick(buildNameClaim({ name: NM, salt })), priv: keyA });
const finalize = proposeTx({ ...pick(C.nameFinalize({ name: NM, salt })), priv: keyA, outputs: feeOut() });
const xfer = proposeTx({ ...pick(buildNameXfer({ name: NM, to: B })), priv: keyA });
const at = { commit: 146300, reveal: 146305, finalize: 146313, xfer: 146600 };
const chain = await genChain(C, { fork: F, tip: TOP, placed: new Map([[at.commit, [commit]], [at.reveal, [reveal]], [at.finalize, [finalize]], [at.xfer, [xfer]]]) });
const hint = (tx, h) => ({ txid: ctxid(rpcTxToTx(tx)), height: h, pos: 0, kind: "name" });
const full = [hint(commit, at.commit), hint(reveal, at.reveal), hint(finalize, at.finalize), hint(xfer, at.xfer)];
const stale = full.slice(0, 3);
const junk = { txid: "0x" + "9d".repeat(32), height: TOP + 50, pos: 0, kind: "name" };
const fillerHashes = new Set([...chain.rows.values()].map((r) => r.hash));

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const history = (claimed, events) => ({ ok: true, resolve: { addr: claimed, owner: claimed, via: "owner" }, events });
const X = "0x" + "c3".repeat(20);
const junkBelowTip = { txid: "0x" + "9e".repeat(32), height: 147000, pos: 0, kind: "name" };
const honestNet = { headersDown: false, tipDown: false, first: full, served: B, second: stale, secondClaims: A, pageFails: 0, tipFails: 0, bodyFails: 0, bodyDown: false, prevoutDown: false };
const xferHash = chain.rows.get(at.xfer).hash, xferPrevout = String(rpcTxToTx(xfer).inputs[0].prevTxid).toLowerCase();
const net = { ...honestNet };
globalThis.fetch = async (url) => {
  const u = String(url);
  const m = /\/api\/headers\/(\d+)\/(\d+)$/.exec(u);
  if (m) {
    const from = Number(m[1]), n = Number(m[2]);
    if (from < 126976) { const rows = []; for (let h = from; h < from + n; h++) rows.push(row(h)); return json({ ok: true, from, count: n, headers: rows }); }
    if (from + n - 1 > H && (net.headersDown || (net.pageFails > 0 && net.pageFails--))) return json({ ok: false }, 500);
    if (from + n - 1 > TOP) return json({ ok: false }, 502);
    const rows = []; for (let h = from; h < from + n; h++) rows.push(chain.rowOn(h));
    return json({ ok: true, from, count: n, headers: rows });
  }
  const blk = /\/block\/(0x[0-9a-f]{64})$/.exec(u);
  if (blk && blk[1] === xferHash && (net.bodyDown || (net.bodyFails > 0 && net.bodyFails--))) return json({ ok: false }, 429);
  if (blk && chain.bodyByHash.has(blk[1])) return new Response(nodeBlockBody(chain.bodyByHash.get(blk[1]).txs), { status: 200 });
  if (blk && fillerHashes.has(blk[1])) return new Response(nodeBlockBody([FILLER]), { status: 200 });
  if (u.endsWith("/tip")) return net.tipDown || (net.tipFails > 0 && net.tipFails--) ? json({ ok: false }, 502) : json({ height: TOP, hash: chain.rows.get(TOP).hash });
  if (u.startsWith(`${PRIMARY}/cairnx/resolve/`)) return json({ addr: net.served, owner: net.served, via: "owner" });
  if (u.startsWith(`${PRIMARY}/cairnx/name-history/`)) return json(history(net.served, net.first));
  if (u.startsWith(`${CLARVIS}/cairnx/name-history/`)) return json(history(net.secondClaims, net.second));
  return json({ ok: false }, 404);
};

/** A wallet on the real liveSpvSource over a fresh store held to H. */
async function walletOn() {
  const w = new C.Wallet(C.memoryStore(), C.memoryStore());
  const st = chain.storeTo(H);
  w.spvBuildForTest = async (o) => {
    const s = await C.liveSpvSource({ ...o, store: async () => st, legacy: undefined });
    // namespv.ts prevoutScriptPubkey answers null for a read of the spent coin's transaction that failed.
    return { ...s, prevoutScriptPubkey: async (p) => (net.prevoutDown && String(p).toLowerCase() === xferPrevout ? null : prevoutFor(p)) };
  };
  await w.importKey(keyB, "pw-namespv-union-short");
  await w.setApi("https://cairn-substrate.com");
  return w;
}
const who = (a) => (a === A ? "A (the previous owner)" : a === B ? "B (the owner)" : a === X ? "X (the primary's)" : String(a));
const line = (r) => `${who(r?.addr)}, verified ${r?.verified === true}, sole source ${r?.soleSource === true}, disagree ${r?.disagree === true}`;

// The popup over the current wallet: its Review and Confirm reach the wallet through the bridge, as the background does.
let cur = null;
const seen = { review: null, confirm: null };
const { byId } = installFakeDom({ autoCreate: true });
const ME = "0x" + "ab".repeat(20);
const sends = [];
installBridge({
  status: () => ({ hasVault: true, unlocked: true, addr: ME, accounts: [{ label: "A1", addr: ME }], active: 0, rpc: "https://x", api: "https://x", tradeApi: "https://x/trade/api", explorer: "cairn", hasMnemonic: true }),
  balance: () => ({ confirmed: 100e8, utxos: [] }),
  pendingMerge: () => ({ pending: false, amount: 0, maybe: false }),
  cairnxAssets: () => ({ ok: true, balances: {}, names: [], nameDetails: [], primaryName: null, tipHeight: 1 }),
  cairnxTokens: () => ({ ok: true, tokens: [] }),
  prewarmSpv: () => ({ ok: true }), pending: () => [], sealedClaims: () => [], history: () => [],
  resolveName: async (n) => (seen.review = await cur.resolveName(n)),
  confirmName: async (n) => (seen.confirm = await cur.confirmName(n)),
  send: (...args) => { sends.push(args); return { ok: true, txid: "0x" + "7e".repeat(32) }; },
});
globalThis.setInterval = () => 0;
await import("../src/popup/popup.ts");
await flush();

async function review(w) {
  cur = w; seen.review = null; seen.confirm = null;
  byId("btn-send-back").click(); await flush();
  byId("s-to").disabled = false; byId("s-amt").disabled = false;
  byId("s-to").value = `${NM}.csd`; byId("s-amt").value = "1";
  byId("btn-send").click();
  await until(() => seen.review !== null && !byId("send-confirm").hidden);
  await flush(40);
  return seen.review;
}
async function confirmOnce() {
  const s0 = sends.length;
  byId("btn-send-confirm").click();
  await until(() => seen.confirm !== null && (sends.length > s0 || byId("send-confirm").hidden || byId("btn-send-confirm").textContent !== "Confirm send"));
  await flush(40);
  return sends.slice(s0);
}
const unverifiedShown = () => String(byId("c-warn").innerHTML).includes("Not chain-verified: confirm the address.");

console.log("1. the header route fails at Review and at Confirm, the second server lagging by the transfer:");
{
  Object.assign(net, { ...honestNet, headersDown: true });
  const r = await review(await walletOn());
  check(`(1a) the Review shows the served B unverified, with no recovery (${line(r)}; ${String(r.verifyReason).slice(0, 70)})`,
    r.ok === true && r.addr === B && r.verified === false && r.soleSource !== true && unverifiedShown());
  const sent = await confirmOnce();
  check(`(1b) one Confirm click signs B, not the previous owner (${sent.length} sent${sent.length ? ` to ${who(sent[0][0])}` : ""}; Confirm's look-up ${line(seen.confirm)})`,
    sent.length === 1 && sent[0][0] === B && seen.confirm?.verified === false);
}

console.log("2. the node tip cannot be read:");
{
  Object.assign(net, { ...honestNet, tipDown: true });
  const w = await walletOn();
  const r = await w.resolveName(NM);
  check(`(2) the served B unverified, with no recovery (${line(r)})`, r.ok === true && r.addr === B && r.verified === false && r.soleSource !== true);
}

console.log("3. the header route is back by Confirm:");
{
  Object.assign(net, { ...honestNet, headersDown: true });
  const r = await review(await walletOn());
  net.headersDown = false;
  const sent = await confirmOnce();
  check(`(3) Review B unverified (${line(r)}); Confirm verifies B (${line(seen.confirm)}) and the first click signs it (${sent.length} sent)`,
    r.addr === B && r.verified === false && seen.confirm?.verified === true && seen.confirm?.addr === B && sent.length === 1 && sent[0][0] === B);
}

console.log("4. honest: the header route works, the second server lagging:");
{
  Object.assign(net, { ...honestNet });
  const r = await review(await walletOn());
  const sent = await confirmOnce();
  check(`(4) B, chain-backed, the lagging server flagged (${line(r)}), one click signs B (${sent.length} sent)`,
    r.addr === B && r.verified === true && r.disagree === true && r.soleSource !== true && sent.length === 1 && sent[0][0] === B);
}

console.log("5. honest: one server adds a record above the node's tip, the header route works:");
{
  Object.assign(net, { ...honestNet, second: [...full, junk], secondClaims: B });
  const w = await walletOn();
  const r = await w.resolveName(NM);
  check(`(5) the per-server recovery still proves B (${line(r)})`, r.ok === true && r.addr === B && r.verified === true && r.soleSource === true && r.disagree === true);
}

console.log("6. the stated cost: a hostile primary host adds a record below the node's tip and fails its header pages:");
{
  Object.assign(net, { ...honestNet, headersDown: true, first: [...stale, junkBelowTip], served: X });
  const w = await walletOn();
  const r = await w.resolveName(NM);
  check(`(6) the primary's own address, unverified, not the second server's proven answer (${line(r)})`, r.ok === true && r.addr === X && r.verified === false && r.soleSource !== true);
}

console.log("7. both servers current, one read fails once:");
for (const [label, set] of [["the first header page above the store", { pageFails: 1 }], ["the node tip", { tipFails: 1 }]]) {
  Object.assign(net, { ...honestNet, second: full, secondClaims: B, ...set });
  const w = await walletOn();
  const r = await w.resolveName(NM);
  check(`(7) ${label} fails once: the union read again verifies B, both servers agreeing (${line(r)})`, r.ok === true && r.addr === B && r.verified === true && r.soleSource !== true && r.disagree !== true);
}

console.log("8. the second server lagging, a read of the transfer's records fails:");
for (const [label, set] of [["its block body answers 429", { bodyDown: true }], ["its spent coin cannot be read", { prevoutDown: true }]]) {
  Object.assign(net, { ...honestNet, ...set });
  const r = await review(await walletOn());
  const sent = await confirmOnce();
  check(`(8) ${label}: the served B unverified, not the previous owner from one server (${line(r)}), one click signs B (${sent.length} sent${sent.length ? ` to ${who(sent[0][0])}` : ""})`,
    r.ok === true && r.addr === B && r.verified === false && r.soleSource !== true && unverifiedShown() && sent.length === 1 && sent[0][0] === B);
}

console.log("9. honest: both servers current, the transfer's block body fails once:");
{
  Object.assign(net, { ...honestNet, second: full, secondClaims: B, bodyFails: 1 });
  const r = await (await walletOn()).resolveName(NM);
  check(`(9) the union read again verifies B (${line(r)})`, r.ok === true && r.addr === B && r.verified === true && r.soleSource !== true);
}

await tick(50); await C.flushSpvStoreWrites();
done("namespv-union-short");
