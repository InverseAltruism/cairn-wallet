// What the wallet remembers about the sites that ask it, through the REAL background worker and the REAL approval window
// (src/popup/approve.ts on helpers/approve-dom.mjs, its calls answered by the worker over the popup channel).
//   1. A site the user has approved nothing from says so in the header's ask line ("New site, which asks ..."). The
//      origin is recorded (approvedOrigins) when the user approves a request from it, after the page has its answer and
//      never failing the approval; a paint, a rejection or a closed window records nothing. Two queued requests from a
//      new site both carry the line until one is approved. A site in the consent map is not new (a site connected
//      before this list existed). The line changes no label and Approve arms at its 700 ms floor.
//   2. Two approvals from two new origins recorded at once both stay (the consent chain serialises the writes).
//   3. The list keeps the 500 origins approved last; the oldest goes and reads as new again.
//   4. An opaque origin ("null", "unknown") is never stored and gets no line.
//   5. A seal records the site that asked (the popup's records the wallet's own origin, an opaque one nothing); the
//      reveal card names it and cautions when another site asks for the reveal, both origins through the module's
//      escaping. A record without one says so.
//   6. A reveal of a seal this account does not hold is SEAL_UNKNOWN: before any window and with no queue slot only for
//      a site connected to the active account while unlocked; after approval (nested) for any other site, whose request
//      queues as before, as does a connected site's while the wallet is locked or another account is active.
//   7. reset() clears the list with the consent map.
// RED-FIRST, each run 2026-11-18 in a disposable worktree (failing checks of this file in brackets): record on every
// answer, rejections included: 1 [2]; record the head of the queue when it is listed (on paint): 1 [8]; ignore the
// consent map: 1 [1]; await the write before the answer, or inside the approval: 1 [2] each; drop inConsentChain from
// recordApproved: 2 [1]; drop capApproved: 3 [2]; drop the opaqueOrigin check in recordApproved: 4 [2]; store an opaque
// sealing origin (wallet.ts): 5 [1]; drop the other-site caution: 5 [3]; leave the asking origin unescaped: 5 [1];
// answer the unknown reveal without a code: 6 [2]; drop the active-address comparison: 6 [1]; drop the unlocked
// condition: 6 [1]; drop the connected-site condition: 6 [3]; a 1,900 ms arm floor: 1 [2].
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
// Reads of the seen list can be held (the value is captured at the call and only the answer waits, as a slow read does)
// and its writes can fail.
const mem = new Map();
const held = [];
let holdSeen = false, failSeen = false;
let closeWindow = () => undefined;
const windowCalls = [];
globalThis.__CAIRN_TEST__ = true;
const windowOnMessage = globalThis.chrome.runtime.onMessage;   // the window's listeners; the worker's is `listener`
Object.assign(globalThis.chrome.runtime, { id: ID, getURL: (p) => `${SELF}/` + p, onMessage: { addListener: (fn) => { listener = fn; } }, onConnect: { addListener: () => undefined } });
Object.assign(globalThis.chrome, {
  storage: { local: {
    get: async (k) => { const snap = structuredClone(mem.get(k)); if (k === SEEN && holdSeen) await new Promise((release) => held.push(release)); return { [k]: snap }; },
    set: async (o) => { if (failSeen && SEEN in o) throw new Error("quota"); for (const k of Object.keys(o)) mem.set(k, structuredClone(o[k])); },
    remove: async (k) => { mem.delete(k); },
  } },
  alarms: { create: () => undefined, onAlarm: { addListener: () => undefined } },
  action: { setBadgeText: () => undefined },
  windows: { create: (o, cb) => { windowCalls.push("create"); cb?.({ id: 77 }); }, update: () => { windowCalls.push("update"); }, onRemoved: { addListener: (fn) => { closeWindow = () => fn(77); } } },
});
const coin = mkCoin(5_000e8);
let me = "";
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u.includes("/tx/submit")) return { ok: true, status: 200, json: async () => ({ ok: true }) };
  if (u.includes("/api/content")) return { ok: true, status: 200, json: async () => ({ ok: true }) };
  if (u.includes("/proposal/")) return { ok: true, status: 200, json: async () => ({ ok: true, proposal: { payload_hash: "0x" + "11".repeat(32) } }) };
  if (u.includes(`/utxos/${me}`)) return { ok: true, status: 200, json: async () => ({ confirmed_balance: coin.coin.value, utxos: [coin.coin] }) };
  if (u.endsWith("/tip")) return { ok: true, status: 200, json: async () => ({ height: 65_000 }) };
  return txReply(u, [coin]) ?? { ok: false, status: 404, json: async () => ({}) };
};
await import("../src/background.ts");
globalThis.chrome.runtime.onMessage = windowOnMessage;
await flush();
check("setup: a wallet", (await popup("create", "pw-first-request-1")).ok === true);
me = String((await popup("status")).result.addr);

const ask = () => String(registry.get("ap-ask").textContent);
const seen = () => mem.get(SEEN) ?? {};
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
  const F = "https://f.example";
  mem.set("connectedOrigins", { ...mem.get("connectedOrigins"), [F]: { addr: me, ts: 1 } });
  const f = await paint("send", SEND, F);
  check(`1. a site connected before the update (in the consent map, not in approvedOrigins) has no line ("${ask()}")`, !Object.hasOwn(seen(), F) && f.q.first === false && ask() === "asks you to sign a transaction");
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
  mem.set(SEEN, Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`https://old${i}.example`, 1_000 + i])));
  const approve = async (origin) => { dapp("connect", {}, origin); await flush(); await popup("resolve", (await queue()).at(-1).id, true, me); await until(() => (seen()[origin] ?? 0) > 2_000); };
  await approve("https://old0.example");
  await approve("https://new.example");
  const s = seen();
  check(`3. the list keeps 500 origins (${Object.keys(s).length}): the new one and the oldest one approved again stay, the oldest by last approval goes`,
    Object.keys(s).length === 500 && Object.hasOwn(s, "https://new.example") && Object.hasOwn(s, "https://old0.example") && !Object.hasOwn(s, "https://old1.example") && Object.hasOwn(s, "https://old2.example"));
  dapp("connect", {}, "https://old1.example"); await flush();
  check("3. the origin dropped past the bound reads as new again", (await queue()).at(-1).first === true);
  await resolveAll(false);
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
  const unknown = "0x" + "9d".repeat(32);
  const before = (await queue()).length, calls = windowCalls.length;
  const r = dapp("revealClaim", unknown, A);
  await flush();
  check(`6. from ${A}, connected to the active account: SEAL_UNKNOWN before any window, no queue slot (${JSON.stringify(r.reply)})`,
    r.reply?.ok === false && r.reply.code === "SEAL_UNKNOWN" && (await queue()).length === before && windowCalls.length === calls);
  const held2 = (await popup("sealedClaims")).result[0].txid;
  const ok = dapp("revealClaim", held2, A);
  await flush();
  check("6. honest path: the same site's reveal of a seal it holds is queued for the window", ok.reply === undefined && (await queue()).length === before + 1);
  await popup("resolve", (await queue()).at(-1).id, false);
  // Connected, but locked: the silent getAddress path would not answer either, so neither does this.
  await popup("lock");
  const locked = dapp("revealClaim", unknown, A);
  await flush();
  check(`6. from ${A} while the wallet is locked: queued, no answer before the window (${JSON.stringify(locked.reply)})`, locked.reply === undefined && (await queue()).length === before + 1);
  await resolveAll(false);
  check("setup: unlock", (await popup("unlock", "pw-first-request-1")).ok === true);
  // Connected under the first account while another is active, for an unknown txid and for one the first account holds.
  const second = (await popup("addAccount")).result;
  await popup("switchAccount", second.addr);
  const otherUnknown = dapp("revealClaim", unknown, A), otherHeld = dapp("revealClaim", sealHeld, A);
  await flush();
  check(`6. from ${A} with another account active: both an unknown txid and one the connected account holds are queued (${JSON.stringify([otherUnknown.reply, otherHeld.reply])})`,
    otherUnknown.reply === undefined && otherHeld.reply === undefined && (await queue()).length === before + 2);
  await resolveAll(false);
  await popup("switchAccount", me);
  const U = "https://u.example";
  const other = await paint("revealClaim", unknown, U);
  check(`6. from ${U}, not connected: queued for the window as before (${other.page.reply === undefined})`, other.page.reply === undefined && other.q?.method === "revealClaim");
  await armedAfter(other.at);
  await click("btn-approve", other.page);
  check(`6. approved, it is answered SEAL_UNKNOWN (${JSON.stringify(other.page.reply?.result)})`, other.page.reply?.ok === true && other.page.reply.result?.ok === false && other.page.reply.result.code === "SEAL_UNKNOWN");
}

// ── 7. reset ──────────────────────────────────────────────────────────────────────────────────────────────────────
{
  check(`7. setup: the list holds origins (${Object.keys(seen()).length})`, Object.keys(seen()).length > 0);
  await popup("reset");
  check(`7. reset clears the list with the consent map (${JSON.stringify(mem.get(SEEN))}, ${JSON.stringify(mem.get("connectedOrigins"))})`, !mem.has(SEEN) && JSON.stringify(mem.get("connectedOrigins")) === "{}");
}
done("approve-first-request");
