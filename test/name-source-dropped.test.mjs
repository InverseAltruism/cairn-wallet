// A name's Review whose header source is dropped under it, and the other ways a lookup and the source under it meet,
// on the real Wallet, names.ts, verifyNameUnion and liveSpvSource (the cut-table bundle on a chain generated above the
// real headers at 146,000, test/helpers/genchain.mjs). "dora" is registered by A (nfinalize at 146,313) and
// transferred to B at 146,600; the store holds headers to 146,400 and the node tip is 147,200. The primary name server
// serves all four records and answers B. The second server is current (the same), lagging (the registration only, and
// it answers A) or down.
//   (1) the endpoint changes while the union replay waits for the headers to 146,612, the second server lagging: the
//       Review shows B with the disagree line, as 0.3.5 does (whose old source went on to verify), never A as verified.
//       (1b) the same with both servers current; (1c) no change (the honest path); (1d) a second change during the
//       retry: no third source, the served address unverified (0.3.5, whose old sources go on, shows B verified).
//   (2) verifyNameUnion on a dropped source: no per-server recovery runs on it (one prepare), whether the drop comes
//       before the union's replay answers or during the recovery after a failed one. (2b) a union replay that failed on
//       a header page is read again as a whole and runs no recovery (test/namespv-union-short.test.mjs); (2c) one that
//       failed on a record
//       above the node's tip recovers, and a drop during that recovery leaves no answer.
//   (3) the first lookup after an install (the install hook's prewarm, then create): one replay, as 0.3.5 (asking for
//       the source drops the one built before the vault, and that is not a drop under the lookup); verified, it is
//       cached and the Confirm reads no block.
//   (4) a lookup that arrives while a failed background run waits on its persist runs its own sync and verifies, as
//       on 0.3.5 (which runs no background); with nothing parked, the same.
// Run: npx tsx test/name-source-dropped.test.mjs   (offline)
import "./helpers/backup-host.mjs";
import { checker } from "./helpers/check.mjs";
import { cutTableBundle } from "./helpers/cuttable.mjs";
import { genChain } from "./helpers/genchain.mjs";
import { headerOf, row } from "./helpers/spvfixture.mjs";
import { proposeTx, addrFromPriv, ctxid, rpcTxToTx, prevoutFor, pick, nodeBlockBody, FILLER, buildNameClaim, buildNameXfer, feeOut } from "./_spvrig.ts";

const { check, done } = checker("a name lookup and the header source under it");
const C = await cutTableBundle([
  'export { liveSpvSource, flushSpvStoreWrites, verifyNameUnion } from "./src/core/namespv.ts";',
  'export { Wallet } from "./src/core/wallet.ts";',
  'export { memoryStore } from "./src/core/storage.ts";',
  'export { recheckOutcome } from "./src/popup/clearsign.ts";',
  'export { LightClient, serializeHeader, nameCommit, nameCommitRecord, nameFinalize } from "./src/vendor/cairnx-spv.js";',
].join("\n"), { powList: true });

const F = 146000, H = 146400, TOP = 147200;
const PRIMARY = "https://cairn-substrate.com/trade/api", CLARVIS = "https://clarvis.cairn-substrate.com/trade/api";
const API_A = "https://cairn-substrate.com", API_B = "https://headers-b.cairn-substrate.test", API_C = "https://headers-c.cairn-substrate.test";
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const until = async (f, n = 4000) => { for (let i = 0; i < n && !f(); i++) await tick(); return f(); };
const now = (Number(headerOf(F).time) + 60 * 86400) * 1000;
Date.now = () => now;

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
const fillerHashes = new Set([...chain.rows.values()].map((r) => r.hash));

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const blank = () => ({ second: "lag", flagPrimary: false, primaryExtra: [], hold: () => false, held: [], fail500: () => false, pages: [], histories: 0, blocks: 0, tips: 0, prepares: 0 });
const net = blank();
const fresh = (extra) => Object.assign(net, blank(), extra);
const release = () => { for (const r of net.held.splice(0)) r(); };
const history = (claimed, events) => ({ ok: true, resolve: { addr: claimed, owner: claimed, via: "owner" }, events });
globalThis.fetch = async (url, init) => {
  const u = String(url);
  const m = /\/api\/headers\/(\d+)\/(\d+)$/.exec(u);
  if (m) {
    const from = Number(m[1]), n = Number(m[2]);
    if (from < 126976) { const rows = []; for (let h = from; h < from + n; h++) rows.push(row(h)); return json({ ok: true, from, count: n, headers: rows }); }
    net.pages.push({ host: new URL(u).origin, from });
    if (net.hold(from, u)) await new Promise((r, rej) => { net.held.push(r); init?.signal?.addEventListener("abort", () => rej(init.signal.reason), { once: true }); });
    if (net.fail500(from)) return json({ ok: false }, 500);
    if (from + n - 1 > TOP) return json({ ok: false }, 502);
    const rows = []; for (let h = from; h < from + n; h++) rows.push(chain.rowOn(h));
    return json({ ok: true, from, count: n, headers: rows });
  }
  const blk = /\/block\/(0x[0-9a-f]{64})$/.exec(u);
  if (blk && chain.bodyByHash.has(blk[1])) { net.blocks++; return new Response(nodeBlockBody(chain.bodyByHash.get(blk[1]).txs), { status: 200 }); }
  if (blk && fillerHashes.has(blk[1])) return new Response(nodeBlockBody([FILLER]), { status: 200 });
  if (u.endsWith("/tip")) { net.tips++; return json({ height: TOP, hash: chain.rows.get(TOP).hash }); }
  if (u.startsWith(`${PRIMARY}/cairnx/resolve/`)) return json({ addr: B, owner: B, via: "owner" });
  if (u.startsWith(`${PRIMARY}/cairnx/name-history/`)) { net.histories++; return json({ ...history(B, [...full, ...net.primaryExtra]), ...(net.flagPrimary ? { scopedReplaySufficient: false } : {}) }); }
  if (u.startsWith(`${CLARVIS}/cairnx/name-history/`)) {
    net.histories++;
    return net.second === "down" ? json({ ok: false }, 502) : net.second === "lag" ? json(history(A, stale)) : json(history(B, full));
  }
  return json({ ok: false }, 404);
};
const sources = [{ label: "primary", base: PRIMARY }, { label: "clarvis", base: CLARVIS }];

/** A wallet whose header sources are the real liveSpvSource on one store held to H; `built` lists their hosts. */
async function walletOn(st = chain.storeTo(H), { create = false } = {}) {
  const w = new C.Wallet(C.memoryStore(), C.memoryStore());
  const built = [], srcs = [];
  w.spvBuildForTest = async (o) => {
    built.push(o.headersBase);
    const s = await C.liveSpvSource({ ...o, store: async () => st, legacy: undefined });
    const src = { ...s, prepare: (h) => { net.prepares++; return s.prepare(h); }, prevoutScriptPubkey: async (p) => prevoutFor(p) };
    srcs.push(src);
    return src;
  };
  if (!create) { await w.importKey(keyB, "pw-name-source-dropped-1"); await w.setApi(API_A); }
  return { w, built, srcs, st };
}
const who = (a) => (a === A ? "A (the previous owner)" : a === B ? "B (the owner)" : String(a));
const line = (r) => `${who(r.addr)}, verified ${r.verified === true}, sole source ${r.soleSource === true}, disagree ${r.disagree === true}, sources ${r.sources}`;
// The endpoint changes while the union replay's first page (the one holding 146,401 to 146,431) waits.
async function reviewWithDrop(w) {
  net.hold = (from, u) => from === 145920 && u.startsWith(API_A);
  const pending = w.resolveName(NM);
  check("  setup: the union replay's first page was asked and waits", await until(() => net.held.length > 0));
  await w.setApi(API_B);
  net.hold = () => false;
  release();
  return pending;
}

console.log("1. the endpoint changes while a name's Review waits for its headers, the second server lagging:");
{
  fresh({ second: "lag" });
  const { w, built } = await walletOn();
  const r = await reviewWithDrop(w);
  check(`(1) the Review shows B, chain-backed with the disagree line, as 0.3.5 (${line(r)})`, r.ok === true && r.addr === B && r.verified === true && r.soleSource !== true && r.disagree === true && r.sources === 2);
  check(`(1) the current source answered it (${built.join(" then ")})`, built.join(",") === `${API_A},${API_B}`);
  const re = await w.confirmName(NM);
  check(`(1) the Confirm's second look gives the same address ("${C.recheckOutcome(r.addr, re, r.verified === true)}")`, C.recheckOutcome(r.addr, re, r.verified === true) === "same");
}
{
  console.log("(1b) the same with both servers current:");
  fresh({ second: "current" });
  const { w } = await walletOn();
  const r = await reviewWithDrop(w);
  check(`(1b) B, chain-backed, both servers agree (${line(r)})`, r.ok === true && r.addr === B && r.verified === true && r.disagree !== true && r.soleSource !== true && r.sources === 2);
}
{
  console.log("(1c) the honest path: no endpoint change, the second server lagging:");
  fresh({ second: "lag" });
  const { w, built } = await walletOn();
  const r = await w.resolveName(NM);
  check(`(1c) B with the disagree line, one source built (${line(r)}; ${built.length})`, r.ok === true && r.addr === B && r.verified === true && r.disagree === true && r.soleSource !== true && built.length === 1);
}
{
  console.log("(1d) a second change during the retry: one retry, the served address unverified:");
  fresh({ second: "lag" });
  const { w, built } = await walletOn();
  net.hold = (from, u) => from === 145920 && (u.startsWith(API_A) || u.startsWith(API_B));
  const pending = w.resolveName(NM);
  await until(() => net.held.length > 0);
  await w.setApi(API_B);
  release();
  await until(() => net.pages.some((p) => p.host === API_B) && net.held.length > 0);
  await w.setApi(API_C);
  net.hold = () => false;
  release();
  const r = await pending;
  check(`(1d) two sources asked (${built.join(" then ")}), the served B unverified (${line(r)})`, built.join(",") === `${API_A},${API_B}` && r.ok === true && r.addr === B && r.verified === false);
}

console.log("2. verifyNameUnion on a dropped source runs no per-server recovery on it:");
{
  fresh({ second: "lag" });
  const st = chain.storeTo(H);
  const stop = new AbortController();
  const s = await C.liveSpvSource({ rpcBase: `${API_A}/api/rpc`, headersBase: API_A, store: async () => st, legacy: undefined, signal: stop.signal });
  const prepared = [];
  const src = { ...s, prepare: (h) => { prepared.push(h); return s.prepare(h); }, prevoutScriptPubkey: async (p) => prevoutFor(p) };
  net.hold = (from) => from === 145920;
  const pending = C.verifyNameUnion(NM, sources, src);
  await until(() => net.held.length > 0);
  stop.abort();
  net.hold = () => false;
  release();
  const v = await pending;
  check(`(2) dropped while the union replay waits: not verified, the replacement named (${v.verified}, ${String(v.reason).slice(0, 90)})`, v.verified === false && /replaced/.test(String(v.reason)) && v.recovered !== true);
  check(`(2) one prepare, the union's: no per-server replay on the dropped source (${prepared.join(",")})`, prepared.length === 1);
}
{
  console.log("(2b) the union replay fails on a header page, and the source is dropped as the union is read again:");
  fresh({ second: "lag", fail500: (from) => from >= 146432 });
  const st = chain.storeTo(H);
  const stop = new AbortController();
  const s = await C.liveSpvSource({ rpcBase: `${API_A}/api/rpc`, headersBase: API_A, store: async () => st, legacy: undefined, signal: stop.signal });
  const prepared = [];
  // A union replay short of a header is read again as a whole: the second prepare is that retry (the union's height,
  // 146,600), and the drop as it starts ends the retries. A server's own replay would ask 146,313 (the lagging subset).
  const src = { ...s, prepare: (h) => { prepared.push(h); if (prepared.length === 2) stop.abort(); return s.prepare(h); }, prevoutScriptPubkey: async (p) => prevoutFor(p) };
  const v = await C.verifyNameUnion(NM, sources, src);
  check(`(2b) the lagging server's replay below the held tip is not an answer: one union retry, no server's replay (verified ${v.verified}, ${who(v.addr)}, prepares ${prepared.join(",")})`, v.verified === false && v.addr === undefined && prepared.length === 2 && prepared.every((h) => h === at.xfer));
}
{
  console.log("(2c) the union replay fails on a record above the node's tip, and the source is dropped during the recovery:");
  fresh({ second: "lag", primaryExtra: [{ txid: "0x" + "9d".repeat(32), height: TOP + 50, pos: 0, kind: "name" }] });
  const st = chain.storeTo(H);
  const stop = new AbortController();
  const s = await C.liveSpvSource({ rpcBase: `${API_A}/api/rpc`, headersBase: API_A, store: async () => st, legacy: undefined, signal: stop.signal });
  const prepared = [];
  const src = { ...s, prepare: (h) => { prepared.push(h); if (prepared.length === 2) stop.abort(); return s.prepare(h); }, prevoutScriptPubkey: async (p) => prevoutFor(p) };
  const v = await C.verifyNameUnion(NM, sources, src);
  check(`(2c) the lagging server's replay on the dropped source is not an answer (verified ${v.verified}, ${who(v.addr)}, prepares ${prepared.join(",")})`, v.verified === false && v.addr === undefined && prepared.length === 3);
}

console.log("3. the first lookup after an install: the install hook's prewarm, create, then the Review:");
{
  fresh({ second: "current", flagPrimary: true });
  const { w, built } = await walletOn(chain.storeTo(H), { create: true });
  w.prewarmSpv();
  await until(() => built.length > 0); await tick(20);
  await w.create("pw-name-source-dropped-3");
  const r = await w.resolveName(NM);
  check(`(3) a Review that ends unverified asks each name server once, as 0.3.5 (${net.histories} name-history requests)`, r.verified !== true && net.histories === 2);
}
{
  fresh({ second: "current" });
  const { w, built } = await walletOn(chain.storeTo(H), { create: true });
  w.prewarmSpv();
  await until(() => built.length > 0); await tick(20);
  await w.create("pw-name-source-dropped-3b");
  const r = await w.resolveName(NM);
  const b0 = net.blocks;
  const re = await w.confirmName(NM);
  check(`(3b) verified (${line(r)}), cached, and the Confirm reads no block, as 0.3.5 (${net.blocks - b0} block reads)`, r.verified === true && w.nameHintCacheForTest().has(NM) && re.verified === true && net.blocks === b0);
}

console.log("4. a lookup arriving while a failed background run waits on its persist:");
for (const parked of [true, false]) {
  fresh({ second: "down" });
  const st = chain.storeTo(H);
  // A chunk read below the table holds the serializer (an IndexedDB read the foreground gate does not count), so the
  // failed run's persist waits behind it while the lookup arrives.
  const getChunk = st.getChunk.bind(st);
  let holdChunk = false;
  const heldChunk = [];
  st.getChunk = async (k) => { if (k === 27 && holdChunk) await new Promise((r) => heldChunk.push(r)); return getChunk(k); };
  const { w, srcs } = await walletOn(st);
  let down = true;
  net.fail500 = () => down;
  await w.balance().catch(() => undefined);
  w.prewarmSpv();
  await until(() => srcs.length > 0);
  let occupy = null;
  if (parked) { holdChunk = true; occupy = srcs[0].hashAt(112000); await until(() => heldChunk.length > 0); }
  const bgAsked = net.pages.length;
  w.syncSpv();
  // The run's pages go 250 ms after the balance (QUIET_MS) and fail; 900 ms leaves the run ended when nothing is parked.
  await tick(900);
  check(`(4${parked ? "" : "b"}) setup: the background run's pages were asked and failed (${net.pages.length - bgAsked})`, net.pages.length > bgAsked);
  down = false;
  const pagesAtLookup = net.pages.length, prepares = net.prepares, tips = net.tips;
  const pending = w.resolveName(NM);
  // The lookup has read the node tip and waits on the run; then the chunk read is let go.
  if (parked) { await until(() => net.prepares > prepares && net.tips > tips); await tick(30); holdChunk = false; for (const r of heldChunk.splice(0)) r(); }
  const r = await pending;
  await occupy;
  check(`(4${parked ? "" : "b"}) the Review verifies B with one name server, as 0.3.5 (${line(r)}; ${String(r.verifyReason ?? "").slice(0, 80)}), with ${net.pages.length - pagesAtLookup} header pages of its own`, r.ok === true && r.addr === B && r.verified === true && net.pages.length - pagesAtLookup > 0);
}

await tick(50); await C.flushSpvStoreWrites();
done("name-source-dropped");
