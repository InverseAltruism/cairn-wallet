// What the wallet remembers about the sites that ask it, through the REAL background worker and the REAL approval window
// (src/popup/approve.ts on helpers/approve-dom.mjs, its calls answered by the worker over the popup channel).
//   0. A listing reads memory only: while the stored list (approvedOrigins) has not loaded, or when it cannot be read,
//      it answers at once with the site as new; with every consent read held, a queued send lists, paints and arms on
//      its floor, and ten listings read no storage.
//   1. A site the user has approved nothing from says so in the header's ask line ("New site, which asks ..."). The
//      origin is recorded when the user approves a request from it, after the page has its answer and never failing
//      the approval; a paint, a rejection or a closed window records nothing. While that write waits, the next request
//      lists and paints (without the line for that site) and another connect's approval answers its page. Two queued
//      requests from a new site both carry the line until one is approved. A site in the consent map when the worker
//      starts is not new (a site connected before this list existed). The line changes no label and Approve arms at
//      its 700 ms floor.
//   2. Two approvals from two new origins recorded at once both stay (the list's own queue serialises the writes).
//   3. The list keeps the 500 origins approved last; the oldest goes and reads as new again.
//   4. An opaque origin ("null", "unknown") is never stored and gets no line.
//   5. A seal records the site that asked (the popup's records the wallet's own origin, an opaque one nothing); the
//      reveal card names it and cautions when another site asks for the reveal, both origins through the module's
//      escaping. A record without one says so.
//   6. No site gets an answer before the window that depends on the seals the wallet holds: an unknown txid from a
//      connected, unlocked site is queued; with the site's queue full a held and an unknown txid get the same
//      RATE_LIMITED; approved, an unknown txid is answered SEAL_UNKNOWN.
//   7. reset() clears the list with the consent map; an approval that completes after it records nothing; a held write
//      of the list does not delay it and a failing deletion does not fail it (the vault is gone, the wallet locked),
//      and the next write replaces the stored list.
//   8. A list belongs to one vault: stored as { vault, origins } under the vault's salt. After an approval and a worker
//      restart the site reads as known under the same vault; a list under another vault, with no vault or in the old
//      plain shape reads as empty; a write started before a reset and landing after it, a failed deletion followed by a
//      worker restart, and a write queued before a reset and run after it (its deletion failing) all leave their sites
//      new in the next wallet. Listings still read no storage.
// RED-FIRST, each run 2026-11-18 in a disposable worktree (failing checks of this file in brackets): record on every
// answer, rejections included: 1 [2]; record the head of the queue when it is listed (on paint): 1 [8]; ignore the
// consent map: 1 [1]; await the write before the answer, or inside the approval: 1 [2] each; drop the list's queue from
// recordApproved: 2 [1]; drop capApproved: 3 [2]; drop the opaqueOrigin check in recordApproved: 4 [2]; store an opaque
// sealing origin (wallet.ts): 5 [1]; drop the other-site caution: 5 [3]; leave the asking origin unescaped: 5 [1];
// answer the unknown reveal without a code: 6 [1 of 2 at the time]; a 1,900 ms arm floor: 1 [2]; drop the reset
// generation: 7 [1]. Against 3d45edb's src: 11 failed (sections 0, 1 by cascade, 6, 7). Then, each removing one fix:
// an answer before the window for a connected site's unknown txid: 6 [2]; a listing that reads the consent map: 0 and
// 1 [4]; flags not refreshed on a change: 1 [1]; reset awaiting the list's deletion: 7 [4]; a write after a failed
// deletion that adds to the stored list: 7 [1]. The vault binding, against d77eb02's src: 11 failed (section 8 and the
// sections reading the stored shape). Then, one per rule: a list read under any vault or none: 7 and 8 [7]; a write
// recorded under the vault current when it runs: 8 [2]; an approval recorded in memory under any vault: 7 [1].
// Run: npx tsx test/approve-first-request.test.mjs   (offline)
import { checker } from "./helpers/check.mjs";
import { mountApproveWindow, loadApprove, flush, sleep } from "./helpers/approve-dom.mjs";
import { mkCoin, txReply } from "./_coin.ts";

const { check, done } = checker("the first request from a site, and the site a seal belongs to:");
const ID = "cairnwallettestid";
const SELF = "chrome-extension://x";
const WINDOW_PAGE = { id: ID, url: `${SELF}/approve.html`, tab: { id: 1 } };
const SEEN = "approvedOrigins";
const A = "https://a.example", B = "https://b.example", C = "https://c.example";
const until = async (cond, n = 400) => { for (let i = 0; i < n && !cond(); i++) await sleep(5); return cond(); };
let listener = () => undefined;
const popup = (method, ...args) => new Promise((res) => listener({ kind: "popup", method, args }, WINDOW_PAGE, res));
const dapp = (method, params, origin) => { const out = { reply: undefined }; listener({ kind: "dapp", method, params }, origin === undefined ? {} : { origin, url: origin + "/", tab: { id: 2 } }, (r) => { out.reply = r; }); return out; };

const sent = [];
const handlers = new Proxy({}, { get: (_, method) => async (...args) => {
  sent.push([method, args]);
  const r = await popup(method, ...args);
  if (!r?.ok) throw new Error(r?.error ?? "error");
  return r.result;
} });
const { registry, deliver } = mountApproveWindow(handlers);
// The worker's other messages (the re-arm before a raise) reach the window, as the real channel delivers them.
const windowChannel = globalThis.chrome.runtime.sendMessage;
globalThis.chrome.runtime.sendMessage = (m, cb) => {
  if (m?.kind === "popup") return windowChannel(m, cb);
  return new Promise((res) => setTimeout(() => { const a = deliver(m, { id: ID, url: `${SELF}/background.js` }); setTimeout(() => res(a?.value), 0); }, 0));
};
globalThis.location = { origin: SELF };   // the window's own origin, which a popup seal records
// Reads of the approved list or the consent map can be held (the value is captured at the call and only the answer
// waits, as a slow read does), and the approved list's reads and writes can fail. The worker's first read of the list,
// at its start, is held until section 0 releases it.
const mem = new Map();
const held = [];
let holdSeen = true, failSeen = false, failSeenRead = false, holdConsent = false, failSeenRemove = false, holdSeenSet = false;
const heldSets = [];
const reads = { [SEEN]: 0, connectedOrigins: 0 };
let closeWindow = () => undefined;
const windowCalls = [];
globalThis.__CAIRN_TEST__ = true;
const windowOnMessage = globalThis.chrome.runtime.onMessage;   // the window's listeners; the worker's is `listener`
Object.assign(globalThis.chrome.runtime, { id: ID, getURL: (p) => `${SELF}/` + p, onMessage: { addListener: (fn) => { listener = fn; } }, onConnect: { addListener: () => undefined } });
Object.assign(globalThis.chrome, {
  storage: { local: {
    get: async (k) => {
      const snap = structuredClone(mem.get(k));
      if (k in reads) reads[k]++;
      if ((k === SEEN && holdSeen) || (k === "connectedOrigins" && holdConsent)) await new Promise((release) => held.push(release));
      if (k === SEEN && failSeenRead) throw new Error("read failed");
      return { [k]: snap };
    },
    set: async (o) => {
      if (failSeen && SEEN in o) throw new Error("quota");
      const copy = structuredClone(o);   // what the write sends; a held write lands it later
      if (holdSeenSet && SEEN in o) await new Promise((release) => heldSets.push(release));
      for (const k of Object.keys(copy)) mem.set(k, copy[k]);
    },
    remove: async (k) => { if (failSeenRemove && k === SEEN) throw new Error("remove failed"); mem.delete(k); },
  } },
  alarms: { create: () => undefined, onAlarm: { addListener: () => undefined } },
  action: { setBadgeText: () => undefined },
  windows: { create: (o, cb) => { windowCalls.push("create"); cb?.({ id: 77 }); }, update: () => { windowCalls.push("update"); }, onRemoved: { addListener: (fn) => { closeWindow = () => fn(77); } } },
});
const coin = mkCoin(5_000e8);
let me = "";
// The reveal's content registration can be held (section 7).
let holdContent = false;
const heldContent = [];
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u.includes("/tx/submit")) return { ok: true, status: 200, json: async () => ({ ok: true }) };
  if (u.includes("/api/content")) {
    if (holdContent) await new Promise((release) => heldContent.push(release));
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  }
  if (u.includes("/proposal/")) return { ok: true, status: 200, json: async () => ({ ok: true, proposal: { payload_hash: "0x" + "11".repeat(32) } }) };
  if (u.includes("/utxos/")) return { ok: true, status: 200, json: async () => ({ confirmed_balance: coin.coin.value, utxos: [coin.coin] }) };
  if (u.endsWith("/tip")) return { ok: true, status: 200, json: async () => ({ height: 65_000 }) };
  return txReply(u, [coin]) ?? { ok: false, status: 404, json: async () => ({}) };
};
// A site connected before this list existed: in the consent map the worker loads at its start, absent from the list.
const F = "https://f.example";
mem.set("connectedOrigins", { [F]: { addr: "0x" + "00".repeat(19) + "01", ts: 1 } });
await import("../src/background.ts");
globalThis.chrome.runtime.onMessage = windowOnMessage;
await flush();
check("setup: a wallet", (await popup("create", "pw-first-request-1")).ok === true);
me = String((await popup("status")).result.addr);

const ask = () => String(registry.get("ap-ask").textContent);
const seen = () => mem.get(SEEN)?.origins ?? {};   // the stored list: { vault, origins }
const queue = async () => (await popup("pending")).result;
const NEW = /^New site, which /;
const release = () => { while (held.length) held.shift()(); };
let tick = null;
// Queue a request and let the window paint it; returns the page's reply holder, the request and when it painted.
async function paint(method, params, origin) {
  const page = dapp(method, params, origin);
  await flush();
  const q = (await queue()).at(-1);
  tick ??= await loadApprove();
  await tick();
  const at = Date.now();
  await flush();
  return { page, q, at };
}
// When Approve arms after the paint: it must arm, at its 700 ms floor and with no added wait.
const ARM_MAX_MS = 1_500;
const armedAfter = async (at) => { await until(() => registry.get("btn-approve").disabled === false, 400); return { armed: registry.get("btn-approve").disabled === false, ms: Date.now() - at }; };
const armsOnFloor = (a) => a.armed && a.ms >= 650 && a.ms <= ARM_MAX_MS;
const click = async (which, page) => {
  await until(() => registry.get(which).disabled === false);
  await registry.get(which)._listeners.click();
  await until(() => page.reply !== undefined);
  await flush();
};
const SEND = { to: "0x" + "31".repeat(20), amount: 1e8, fee: 1e6 };
const resolveAll = async (approve) => { for (const q of await queue()) await popup("resolve", q.id, approve, me); await flush(); };

// ── 0. listings read memory only ──────────────────────────────────────────────────────────────────────────────────
{
  const Z = "https://z.example";
  const pz = dapp("connect", {}, Z); await flush();
  const t0 = Date.now();
  const listed = await Promise.race([popup("pending"), sleep(1_500).then(() => ({ ok: "no answer in 1.5 s", result: [] }))]);
  const ms = Date.now() - t0;
  check(`0. while the stored list has not loaded (${held.length} read held), a listing answers at once (${ms} ms) and the site reads as new`, listed.ok === true && ms < 200 && held.length >= 1 && listed.result.at(-1)?.first === true);
  failSeenRead = true; holdSeen = false; release(); await flush();
  const failed = await Promise.race([popup("pending"), sleep(1_500).then(() => ({ ok: "no answer in 1.5 s", result: [] }))]);
  check(`0. a list that cannot be read gives a listing, not an error (${failed.ok}, ${failed.code ?? "no code"}), with the line shown`, failed.ok === true && failed.result.at(-1)?.first === true);
  failSeenRead = false;
  await resolveAll(false);
  await until(() => pz.reply !== undefined);
  dapp("connect", {}, Z); await flush(); await resolveAll(false);   // a queued request tries the load again; it succeeds
  // With every read of the consent map held, a queued send lists at once and the window paints and arms on its floor,
  // and listings read no storage at all.
  holdConsent = true;
  const r = await Promise.race([paint("send", SEND, "https://k.example"), sleep(1_500).then(() => null)]);
  const before = { ...reads };
  const t1 = Date.now();
  for (let i = 0; i < 10; i++) await Promise.race([popup("pending"), sleep(1_500)]);
  const tenMs = Date.now() - t1;
  const a = r ? await armedAfter(r.at) : { armed: false, ms: -1 };
  check(`0. with the consent read held, a queued send lists and paints (${r !== null}) and Approve arms on its floor (${a.ms} ms)`, r !== null && r.q?.first === true && armsOnFloor(a));
  check(`0. ten listings answer at once (${tenMs} ms) and read no storage (${reads[SEEN] - before[SEEN]} list reads, ${reads.connectedOrigins - before.connectedOrigins} consent reads)`, tenMs < 500 && reads[SEEN] === before[SEEN] && reads.connectedOrigins === before.connectedOrigins);
  if (r) await click("btn-reject", r.page);
  holdConsent = false; release(); await flush();
}

// ── 1. a new site ─────────────────────────────────────────────────────────────────────────────────────────────────
{
  const r = await paint("connect", {}, A);
  check(`1. a site approved nothing from says so in the header ("${ask()}", "${registry.get("ap-ask").title}")`,
    ask() === "New site, which asks to connect to your wallet" && registry.get("ap-ask").title === "You have not approved a request from this site with this wallet before." && r.q.first === true);
  check(`1. the paint records nothing (${JSON.stringify(Object.keys(seen()))})`, !Object.hasOwn(seen(), A));
  await tick();
  check(`1. a repaint keeps the line ("${ask()}")`, NEW.test(ask()));
  const a = await armedAfter(r.at);
  check(`1. the line changes no label (${registry.get("btn-approve").textContent} / ${registry.get("btn-reject").textContent}) and Approve arms at its floor (${a.armed ? "armed" : "not armed"} after ${a.ms} ms, at most ${ARM_MAX_MS})`,
    registry.get("btn-approve").textContent === "Approve" && registry.get("btn-reject").textContent === "Reject" && armsOnFloor(a));
  await click("btn-reject", r.page);
  const afterReject = await paint("send", SEND, A);
  check(`1. a rejected request records nothing: the next request from ${A} still has the line (${r.page.reply?.code}; "${ask()}")`, r.page.reply?.code === "USER_REJECTED" && !Object.hasOwn(seen(), A) && afterReject.q.first === true && NEW.test(ask()));
  closeWindow();
  await flush();
  const afterClose = await paint("send", SEND, A);
  check(`1. a closed window records nothing: the next request still has the line (${afterReject.page.reply?.code}; "${ask()}")`, afterReject.page.reply?.code === "APPROVAL_CLOSED" && !Object.hasOwn(seen(), A) && afterClose.q.first === true && NEW.test(ask()));
  await click("btn-reject", afterClose.page);
  const c = await paint("connect", {}, A);
  await click("btn-approve", c.page);   // A is now connected to the active account (section 6)
  await until(() => Object.hasOwn(seen(), A));
  check(`1. honest path: Approve works on a new site's request (the connect is answered with the address) and records it`, c.page.reply?.result?.addr === me && Object.hasOwn(seen(), A));
  const later = await paint("send", SEND, A);
  const b = await armedAfter(later.at);
  check(`1. after an approval the next request from ${A} has no line ("${ask()}") and arms the same (${b.ms} ms)`, ask() === "asks you to sign a transaction" && later.q.first === false && armsOnFloor(b));
  await click("btn-reject", later.page);
  // The page's answer does not wait for the write: the write's read is held while the approval completes.
  const pb = dapp("connect", {}, B); await flush();
  const qb = await queue();
  holdSeen = true;
  const out = await Promise.race([popup("resolve", qb.at(-1).id, true, me), sleep(1_500).then(() => ({ result: { ok: "no answer in 1.5 s" } }))]);
  await until(() => pb.reply !== undefined, 100);
  check(`1. the page's answer and the window's outcome arrive while the write is still waiting (${pb.reply?.result?.addr === me}, ${out.result?.ok}, ${held.length} held)`, pb.reply?.result?.addr === me && out.result?.ok === true && held.length === 1 && !Object.hasOwn(seen(), B));
  // With that write still waiting: the next requests list and paint, and another connect's approval answers its page.
  const D2 = "https://d.example";
  const next = await Promise.race([paint("send", SEND, B), sleep(1_500).then(() => null)]);
  check(`1. while the write waits, the next request from ${B} lists and paints, with no line since its approval ("${ask()}")`, next !== null && next.q?.first === false && ask() === "asks you to sign a transaction" && held.length === 1);
  const pd = dapp("connect", {}, D2); await flush();
  const listedD = await Promise.race([queue(), sleep(1_500).then(() => null)]);
  check(`1. ...a new site's request lists with the line (${listedD?.at(-1)?.first})`, listedD?.at(-1)?.origin === D2 && listedD.at(-1).first === true);
  const outD = await Promise.race([popup("resolve", listedD?.at(-1)?.id, true, me), sleep(1_500).then(() => ({ result: { ok: "no answer in 1.5 s" } }))]);
  await until(() => pd.reply !== undefined, 100);
  check(`1. ...and its connect approval answers its page (${pd.reply?.result?.addr === me}, ${outD.result?.ok})`, pd.reply?.result?.addr === me && outD.result?.ok === true);
  if (next) await click("btn-reject", next.page);
  holdSeen = false; release();
  await until(() => Object.hasOwn(seen(), B));
  check("1. ...and the write lands after it", Object.hasOwn(seen(), B));
  failSeen = true;
  const pc = dapp("connect", {}, C); await flush();
  const outC = await Promise.race([popup("resolve", (await queue()).at(-1).id, true, me), sleep(1_500).then(() => ({ result: { ok: "no answer in 1.5 s" } }))]);
  await until(() => pc.reply !== undefined);
  check(`1. a write that fails does not fail the approval (${pc.reply?.result?.addr === me}, ${outC.result?.ok}) and leaves the site unrecorded`, pc.reply?.result?.addr === me && outC.result?.ok === true && !Object.hasOwn(seen(), C));
  failSeen = false;
  const e1 = dapp("send", SEND, "https://e.example"), e2 = dapp("send", SEND, "https://e.example"); await flush();
  const both = (await queue()).filter((q) => q.origin === "https://e.example");
  check(`1. two queued requests from a new site both carry the line (${both.map((q) => q.first)})`, both.length === 2 && both.every((q) => q.first === true));
  await popup("resolve", both[0].id, true, me);
  await until(() => Object.hasOwn(seen(), "https://e.example"));
  check(`1. ...until one is approved (${(await queue()).filter((q) => q.origin === "https://e.example").map((q) => q.first)})`, (await queue()).find((q) => q.id === both[1].id)?.first === false);
  await resolveAll(false);
  await until(() => e1.reply !== undefined && e2.reply !== undefined);
  // A site connected before this list existed: in the consent map, absent from approvedOrigins.
  const f = await paint("send", SEND, F);
  check(`1. a site connected before the update (in the consent map when the worker started, not in approvedOrigins) has no line ("${ask()}")`, !Object.hasOwn(seen(), F) && f.q.first === false && ask() === "asks you to sign a transaction");
  await click("btn-reject", f.page);
}

// ── 2. two approvals recorded at once ─────────────────────────────────────────────────────────────────────────────
{
  const G = "https://g.example", H = "https://h.example";
  const pg = dapp("connect", {}, G), ph = dapp("connect", {}, H);
  await flush();
  const [qg, qh] = (await queue()).slice(-2);
  holdSeen = true;
  await Promise.all([popup("resolve", qg.id, true, me), popup("resolve", qh.id, true, me)]);
  for (let i = 0; i < 400 && !(Object.hasOwn(seen(), G) && Object.hasOwn(seen(), H)); i++) { if (held.length) held.pop()(); await flush(1); }   // the newest read answers first
  holdSeen = false; release();
  check(`2. two approvals from two new origins at once are both recorded (${JSON.stringify(Object.keys(seen()))})`, Object.hasOwn(seen(), G) && Object.hasOwn(seen(), H) && pg.reply && ph.reply);
}

// ── 3. the bound ──────────────────────────────────────────────────────────────────────────────────────────────────
{
  // Sign-ins: an approval that records no connection, so only the approved list decides whether a site is new.
  const SIGNIN = { nonce: "Nonce1234abcdef" };
  const approve = async (origin) => {
    const pg = dapp("signinWithCsd", SIGNIN, origin); await flush();
    await popup("resolve", (await queue()).at(-1).id, true, me);
    await until(() => pg.reply !== undefined);
    await sleep(2);   // one approval per millisecond at most, so their times order them
  };
  for (let i = 0; i < 500; i++) await approve(`https://b${i}.example`);
  await approve("https://b0.example");
  await approve("https://new.example");
  await until(() => Object.hasOwn(seen(), "https://new.example"));
  const s = seen();
  const isNew = async (origin) => { dapp("signinWithCsd", SIGNIN, origin); await flush(); const f = (await queue()).at(-1).first; await resolveAll(false); return f; };
  check(`3. the stored list keeps 500 origins (${Object.keys(s).length}): the new one and the oldest one approved again stay, the oldest by last approval goes`,
    Object.keys(s).length === 500 && Object.hasOwn(s, "https://new.example") && Object.hasOwn(s, "https://b0.example") && !Object.hasOwn(s, "https://b1.example") && Object.hasOwn(s, "https://b2.example"));
  const reads = [await isNew("https://b1.example"), await isNew("https://b0.example"), await isNew("https://b2.example")];
  check(`3. the origin dropped past the bound reads as new again, the kept ones do not (${reads})`, reads.join() === "true,false,false");
}

// ── 4. opaque origins ─────────────────────────────────────────────────────────────────────────────────────────────
for (const [label, origin] of [["\"null\"", "null"], ["no origin (\"unknown\")", undefined]]) {
  const r = await paint("connect", {}, origin);
  check(`4. a request from ${label} has no line ("${ask()}")`, r.q.first === false && !NEW.test(ask()));
  await click("btn-approve", r.page);
  await flush();
  const stored = Object.keys(seen()).filter((o) => o === "null" || o === "unknown");
  check(`4. approving it stores no opaque origin (${JSON.stringify(stored)})`, stored.length === 0 && r.page.reply !== undefined);
}

let sealHeld = "";
// ── 5. the site a seal belongs to ─────────────────────────────────────────────────────────────────────────────────
const preview = () => String(registry.get("reveal-preview")?.innerHTML ?? "");
const text = (h) => h.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").replace(/ ([.,])/g, "$1").trim();
async function revealCard(txid, origin) {
  const r = await paint("revealClaim", txid, origin);
  await until(() => preview().length > 0);
  const html = preview();
  await armedAfter(r.at);
  await click("btn-reject", r.page);
  return html;
}
{
  const r = await paint("sealClaim", { claim: "mine first" }, A);
  await armedAfter(r.at);
  await click("btn-approve", r.page);
  const list = (await popup("sealedClaims")).result;
  const sealA = list.find((x) => x.claim === "mine first");
  check(`5. a seal asked by ${A} keeps that origin (${sealA?.origin})`, r.page.reply?.result?.ok === true && sealA?.origin === A);
  const byA = await revealCard(sealA.txid, A);
  check(`5. the reveal asked by the sealing site names it with no caution (${text(byA).slice(-60)})`, text(byA).includes(`Sealed by ${A}`) && !byA.includes("check caution"));
  const byB = await revealCard(sealA.txid, B);
  check(`5. the reveal asked by another site shows the caution with both origins (${text(byB).slice(0, 140)})`,
    byB.includes("check caution") && text(byB).includes(`This claim was sealed by ${A}, and ${B} is asking to reveal it. Approving makes the claim public.`));
  const own = await popup("sealClaim", { claim: "from the popup" });
  const sealOwn = (await popup("sealedClaims")).result.find((x) => x.claim === "from the popup");
  check(`5. a seal made in the popup records the wallet's own origin (${sealOwn?.origin})`, own.result?.ok === true && sealOwn?.origin === SELF);
  const ownCard = await revealCard(sealOwn.txid, A);
  check(`5. its reveal asked by a site says it was sealed in this wallet (${text(ownCard).slice(0, 110)})`, text(ownCard).includes(`This claim was sealed in this wallet, not by a site, and ${A} is asking to reveal it.`) && !text(ownCard).includes("Sealed by"));
  // Records as a build before this one wrote them (no origin), and one whose stored origin is hostile text.
  const k = "sealedClaims:" + me;
  const legacy = { txid: "0x" + "6a".repeat(32), domain: "csd:sealed", claim: "old", nonce: "n", committedTs: 1, revealed: false };
  const hostile = { ...legacy, txid: "0x" + "6b".repeat(32), origin: `https://x.example"><img src=x onerror=alert(1)>` };
  mem.set(k, [legacy, hostile, ...mem.get(k)]);
  const none = await revealCard(legacy.txid, A);
  check(`5. a claim stored without an origin says the sealing site is not recorded, with no caution (${text(none).slice(-40)})`, text(none).includes("Sealed by not recorded") && !none.includes("check caution"));
  const bad = await revealCard(hostile.txid, A);
  check("5. hostile text in a stored origin is rendered as text", !bad.includes("<img") && bad.includes("&lt;img src=x onerror=alert(1)&gt;") && bad.includes("&quot;&gt;"));
  const asker = await revealCard(sealA.txid, `https://y.example"><img src=x onerror=alert(2)>`);
  check("5. hostile text in the asking origin is rendered as text", byB.includes("check caution") && !asker.includes("<img") && asker.includes("&lt;img src=x onerror=alert(2)&gt;"));
  // A seal asked by an opaque origin keeps no origin: its card reads not recorded.
  const op = await paint("sealClaim", { claim: "from a sandboxed page" }, "null");
  await click("btn-approve", op.page);
  const sealOp = (await popup("sealedClaims")).result.find((x) => x.claim === "from a sandboxed page");
  const opCard = await revealCard(sealOp.txid, A);
  check(`5. a seal asked by an opaque origin stores none (${JSON.stringify(sealOp?.origin)}) and its card says not recorded, no caution`, op.page.reply?.result?.ok === true && sealOp && !("origin" in sealOp) && text(opCard).includes("Sealed by not recorded") && !opCard.includes("check caution"));
  sealHeld = sealA.txid;
}

// ── 6. a reveal of a seal this account does not hold ─────────────────────────────────────────────────────────────
{
  // No site gets an answer before the window: what a reveal answers never depends on which seals the wallet holds.
  const unknown = "0x" + "9d".repeat(32);
  const before = (await queue()).length;
  const r = dapp("revealClaim", unknown, A);
  await flush();
  check(`6. from ${A}, connected and unlocked: an unknown txid is queued for the window, no answer before it (${JSON.stringify(r.reply)})`, r.reply === undefined && (await queue()).length === before + 1);
  await resolveAll(false);
  const fill = Array.from({ length: 5 }, () => dapp("send", SEND, A)); await flush();
  const full = [dapp("revealClaim", sealHeld, A), dapp("revealClaim", unknown, A)]; await flush();
  check(`6. with ${A}'s queue full, a held and an unknown txid get the same answer (${JSON.stringify(full.map((x) => x.reply?.code))})`,
    full.every((x) => x.reply?.code === "RATE_LIMITED") && JSON.stringify(full[0].reply) === JSON.stringify(full[1].reply));
  await resolveAll(false);
  await until(() => fill.every((x) => x.reply !== undefined));
  const U = "https://u.example";
  const other = await paint("revealClaim", unknown, U);
  check(`6. from ${U}, not connected: queued for the window as before (${other.page.reply === undefined})`, other.page.reply === undefined && other.q?.method === "revealClaim");
  await armedAfter(other.at);
  await click("btn-approve", other.page);
  check(`6. approved, it is answered SEAL_UNKNOWN (${JSON.stringify(other.page.reply?.result)})`, other.page.reply?.ok === true && other.page.reply.result?.ok === false && other.page.reply.result.code === "SEAL_UNKNOWN");
}

// ── 7. reset ──────────────────────────────────────────────────────────────────────────────────────────────────────
{
  // An approval that completes after a reset records nothing: a reveal from S whose content registration answers after.
  const S = "https://s.example";
  const sealed = await paint("sealClaim", { claim: "sealed by s" }, S);
  await click("btn-approve", sealed.page);
  const txidS = (await popup("sealedClaims")).result.find((x) => x.claim === "sealed by s")?.txid;
  await until(() => Object.hasOwn(seen(), S));
  check(`7. setup: ${S} is recorded by its approved seal, and the list holds origins (${Object.keys(seen()).length})`, Object.hasOwn(seen(), S) && typeof txidS === "string");
  const asked = dapp("revealClaim", txidS, S); await flush();
  holdContent = true;
  const approved = popup("resolve", (await queue()).at(-1).id, true, me);
  await until(() => heldContent.length === 1);
  await popup("reset");
  await until(() => !mem.has(SEEN));
  check(`7. reset clears the list with the consent map (${JSON.stringify(mem.get(SEEN))}, ${JSON.stringify(mem.get("connectedOrigins"))})`, !mem.has(SEEN) && JSON.stringify(mem.get("connectedOrigins")) === "{}");
  holdContent = false; heldContent.shift()();
  await approved; await until(() => asked.reply !== undefined); await flush(20);
  dapp("connect", {}, S); await flush();
  check(`7. the reveal approved before the reset and answered after it leaves the list empty (${JSON.stringify(mem.get(SEEN))}) and ${S} reads as new`, !Object.hasOwn(seen(), S) && (await queue()).at(-1)?.first === true);
  await resolveAll(false);
  // The reset never waits on the list: with a write of it held, and with its deletion failing.
  const PW = "pw-first-request-2";
  check("setup: a wallet again", (await popup("create", PW)).ok === true);
  me = String((await popup("status")).result.addr);
  const R = "https://r.example";
  dapp("connect", {}, R); await flush();
  holdSeen = true;
  await popup("resolve", (await queue()).at(-1).id, true, me);
  await until(() => held.length === 1);
  const t0 = Date.now();
  const reset1 = await Promise.race([popup("reset"), sleep(1_500).then(() => ({ ok: "no answer in 1.5 s" }))]);
  const st1 = (await popup("status")).result;
  check(`7. with a write of the list held, the reset completes at once (${Date.now() - t0} ms): the vault is gone and the wallet locked`, reset1.ok === true && !mem.has("vault") && st1.unlocked === false && st1.hasVault === false);
  holdSeen = false; release(); await flush(20);
  check(`7. ...and the held write, from before the reset, writes nothing (${JSON.stringify(mem.get(SEEN))})`, !Object.hasOwn(seen(), R));
  check("setup: a wallet again", (await popup("create", PW)).ok === true);
  me = String((await popup("status")).result.addr);
  const R2 = "https://r2.example", Q = "https://q.example";
  dapp("connect", {}, R2); await flush();
  await popup("resolve", (await queue()).at(-1).id, true, me);
  await until(() => Object.hasOwn(seen(), R2));
  failSeenRemove = true;
  const reset2 = await popup("reset");
  await flush(20);
  const st2 = (await popup("status")).result;
  check(`7. with its deletion failing, the reset still completes (${reset2.ok}): the vault is gone, the wallet locked, the stored list still there (${JSON.stringify(Object.keys(seen()))})`,
    reset2.ok === true && !mem.has("vault") && st2.unlocked === false && Object.hasOwn(seen(), R2));
  failSeenRemove = false;
  dapp("connect", {}, R2); await flush();
  check("7. ...the site it held reads as new", (await queue()).at(-1)?.first === true);
  await resolveAll(false);
  check("setup: a wallet again", (await popup("create", PW)).ok === true);
  me = String((await popup("status")).result.addr);
  dapp("connect", {}, Q); await flush();
  await popup("resolve", (await queue()).at(-1).id, true, me);
  await until(() => Object.hasOwn(seen(), Q));
  check(`7. ...and the next write replaces the stored list (${JSON.stringify(Object.keys(seen()))})`, JSON.stringify(Object.keys(seen())) === JSON.stringify([Q]));
}
// ── 8. a list belongs to one vault ────────────────────────────────────────────────────────────────────────────────
{
  // A worker restart: the background built again over the same storage.
  let restarts = 0;
  const restart = async () => {
    await resolveAll(false);
    globalThis.chrome.runtime.onMessage = { addListener: (fn) => { listener = fn; } };
    await import(`../src/background.ts?restart=${++restarts}`);
    globalThis.chrome.runtime.onMessage = windowOnMessage;
    await flush(20);
  };
  const SIGNIN = { nonce: "Nonce1234abcdef" };
  const approveSignin = async (origin) => { const pg = dapp("signinWithCsd", SIGNIN, origin); await flush(); await popup("resolve", (await queue()).at(-1).id, true, me); await until(() => pg.reply !== undefined); };
  // Whether `origin` reads as new once the stored list has been read: the request starts the read when none is done.
  const readsNew = async (origin) => {
    const r0 = reads[SEEN];
    dapp("signinWithCsd", SIGNIN, origin); await flush();
    await until(() => reads[SEEN] > r0, 100); await flush(10);
    const f = (await queue()).at(-1)?.first;
    await resolveAll(false);
    return f;
  };
  const PW3 = "pw-first-request-3";
  const K = "https://k2.example";
  await approveSignin(K);
  await until(() => Object.hasOwn(seen(), K));
  const vault2 = mem.get(SEEN)?.vault;
  check(`8. the stored list names its vault (${String(vault2).slice(0, 8)}, the vault's salt ${String(mem.get("vault")?.salt).slice(0, 8)})`, typeof vault2 === "string" && vault2 === mem.get("vault")?.salt);
  await restart();
  check("setup: unlock after the restart", (await popup("unlock", "pw-first-request-2")).ok === true);
  check(`8. honest path: an approval, a worker restart and a listing: the site reads as known under the same vault`, (await readsNew(K)) === false);
  // A list under another vault, with no vault, or in the old plain shape reads as empty.
  for (const [label, shape] of [["under another vault", { vault: "ab".repeat(16), origins: { [K]: 1 } }], ["with no vault", { origins: { [K]: 1 } }], ["in the old plain shape", { [K]: 1 }]]) {
    mem.set(SEEN, shape);
    await restart();
    check(`8. a list stored ${label} reads as empty`, (await readsNew(K)) === true);
  }
  check("setup: unlock", (await popup("unlock", "pw-first-request-2")).ok === true);
  // A write already started before a reset, its storage write held across it, and the list's deletion failing.
  const R3 = "https://r3.example";
  holdSeenSet = true;
  await approveSignin(R3);
  await until(() => heldSets.length === 1);
  failSeenRemove = true;
  await popup("reset");
  check("setup: a new wallet", (await popup("create", PW3)).ok === true);
  me = String((await popup("status")).result.addr);
  holdSeenSet = false; heldSets.shift()(); await flush(20);
  failSeenRemove = false;
  check(`8. a write started before a reset and landing after it (${JSON.stringify(Object.keys(seen()))}) leaves its site new in the next wallet`, (await readsNew(R3)) === true);
  await restart();
  check("setup: unlock after the restart", (await popup("unlock", PW3)).ok === true);
  check("8. ...also after a worker restart, with the old list's deletion failed", (await readsNew(R3)) === true);
  // A write queued before a reset and run after it: it is not recorded under the next wallet's vault.
  const W1 = "https://w1.example", W2 = "https://w2.example";
  holdSeenSet = true;
  await approveSignin(W1);
  await until(() => heldSets.length === 1);
  await approveSignin(W2);   // its write waits behind W1's on the list's queue
  failSeenRemove = true;     // the reset's deletion is hygiene: nothing may rely on it
  await popup("reset");
  check("setup: another new wallet", (await popup("create", PW3)).ok === true);
  me = String((await popup("status")).result.addr);
  holdSeenSet = false; heldSets.shift()(); await flush(20);
  failSeenRemove = false;
  const Q4 = "https://q4.example";
  await approveSignin(Q4);
  await until(() => Object.hasOwn(seen(), Q4));
  check(`8. a write queued before a reset and run after it records nothing in the next wallet's list (${JSON.stringify(Object.keys(seen()))})`, !Object.hasOwn(seen(), W2) && !Object.hasOwn(seen(), W1) && mem.get(SEEN)?.vault === mem.get("vault")?.salt);
  check("8. ...and its site reads as new", (await readsNew(W2)) === true);
  // The earlier guarantees with the binding: a listing reads no storage.
  const before = { ...reads };
  for (let i = 0; i < 10; i++) await popup("pending");
  check(`8. listings still read no storage (${reads[SEEN] - before[SEEN]} list reads, ${reads.connectedOrigins - before.connectedOrigins} consent reads)`, reads[SEEN] === before[SEEN] && reads.connectedOrigins === before.connectedOrigins);
}
done("approve-first-request");
