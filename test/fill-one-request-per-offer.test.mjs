// One fill request per offer in the wallet, through the REAL background worker channel: a mock chrome, the real
// onMessage listener and the real Wallet behind it, with the synthetic fill-SPV io of test/helpers/fillworld.mjs, so an
// approved fill runs the whole preflight and signs. While a fill request naming a target is queued, back in the queue
// for its reservation confirm step, or approved and still signing or sending, another fill request naming the same
// target (fillOffer in the site's whole, partial and token-priced shapes, or an attest at the token-fill confidence) is
// refused at queue time with FILL_IN_PROGRESS: it is not queued and signs nothing, and no window is created for it.
// The refusal brings forward the window that holds the first request: it focuses the open window, or opens the
// window again while the first is queued and has none (10); while the first is in flight it creates none (5).
//
// RED-FIRST: drop the hold check in background.ts queueDappRequest and sections 1, 2, 3, 5 and 8 fail: the second
// request queues and raises the approval window, and approving both signs two fills of one reservation. Drop the
// window call at the refusal and sections 1, 2, 5 and 10 fail; create a window for an in-flight holder and 5 fails.
// PAIRED HONEST PATHS: one fill queues and signs as before (1, 5); a fill of another offer, a claim attest of the same
// id and a send queue beside a held fill (4); after the first fill was sent (6), rejected (7), cancelled at its
// confirm step (8) or settled by closing the window (9), the next fill of the same offer queues, and in 7 signs.
//
// Run: npx tsx test/fill-one-request-per-offer.test.mjs   (offline)
import { isDeepStrictEqual } from "node:util";
import { checker } from "./helpers/check.mjs";
import { PRIV, world, stub, body, recordAnswer, truthful, H } from "./helpers/fillworld.mjs";
import { CONF_TOKEN_FILL } from "../src/core/cairnx.ts";

const tick = () => new Promise((r) => setTimeout(r, 0));
const settle = async () => { for (let i = 0; i < 10; i++) await tick(); };
const WIN = 77;
const mem = new Map();
let onRemoved = null;
const windowCalls = []; // every create and focus of the approval window, in order
let createFails = false; // a create whose window never reports in (chrome gives no window)
const ignore = () => undefined;
const chrome = {
  runtime: {
    id: "cairnwallettestid", lastError: undefined,
    getURL: (p) => "chrome-extension://x/" + p,
    onMessage: { addListener: (fn) => { chrome.listener = fn; } },
    onConnect: { addListener: ignore },
    onInstalled: { addListener: ignore },
  },
  storage: { local: {
    get: async (k) => ({ [k]: structuredClone(mem.get(k)) }),
    set: async (o) => { for (const k of Object.keys(o)) mem.set(k, structuredClone(o[k])); },
    remove: async (k) => { mem.delete(k); },
  } },
  alarms: { create: ignore, onAlarm: { addListener: ignore } },
  action: { setBadgeText: ignore },
  windows: {
    create: (opts, cb) => { windowCalls.push("create"); cb?.(createFails ? undefined : { id: WIN }); },
    update: () => { windowCalls.push("focus"); },
    onRemoved: { addListener: (fn) => { onRemoved = fn; } },
  },
};
globalThis.chrome = chrome;
globalThis.fetch = async () => ({ ok: false, status: 404, json: async () => ({}) });
globalThis.__CAIRN_TEST__ = true;
await import("../src/background.ts");
const bg = globalThis.__cairnBgWallet;

const APPROVE_PAGE = { id: "cairnwallettestid", url: "chrome-extension://x/approve.html", tab: { id: 1 } };
const popup = (method, ...args) => new Promise((res) => chrome.listener({ kind: "popup", method, args }, APPROVE_PAGE, res));
async function call(method, ...args) { const r = await popup(method, ...args); if (!r.ok) throw new Error(`${method}: ${r.error}`); return r.result; }
const ME = String((await call("import", PRIV, "pw-one-fill")).addr).toLowerCase();

// One open-lane reservation to buy, signable through the synthetic SPV io; clarvis is swappable for section 8.
const w = world(ME, null);
bg.fillSpvIoForTest = () => w.io();
let clarvis = truthful(w);
const st = stub(w, (init, u) => clarvis(init, u));
// clarvis has read 30 blocks past the reservation and does not know it: the confirm step (RESERVATION_UNCONFIRMED).
const unknown = (x) => (_i, u) => (String(u).includes("/record/") ? recordAnswer({ ...x, truthLog: [] }, x.fc.height + 30) : body(x.truth)());
// A submit can be held, to keep an approved fill in its signing step.
const stubFetch = globalThis.fetch;
let submitGate = null;
globalThis.fetch = async (url, init) => {
  if (submitGate && String(url).includes("/tx/submit")) { submitGate.reached(); await submitGate.open; }
  return stubFetch(url, init);
};

// The site's fill calls (cairn public/trade/fills.js): whole, partial and token-priced; FEE_ATTEST is 5,000,000.
const FEE_ATTEST = 5_000_000;
const X = w.fc.id; // the reservation (fclaim) an open-lane fill attests
const whole = (target = X) => ({ proposalId: target, outputs: w.outputs, fee: FEE_ATTEST });
const partial = (target = X) => ({ proposalId: target, outputs: w.outputs.map((o) => ({ ...o, value: Math.floor(o.value / 2) })), fee: FEE_ATTEST });
const token = (target) => ({ proposalId: target, outputs: [], score: 100, confidence: CONF_TOKEN_FILL, fee: FEE_ATTEST });
// The same token fill as a bare attest (Wallet.attest signs it through fillOffer).
const tokenAttest = (target) => ({ proposalId: target, score: 100, confidence: CONF_TOKEN_FILL, fee: FEE_ATTEST });

const SITE = "https://cairn-substrate.com", OTHER = "https://dapp.example";
let tabSeq = 1;
// A request as the content script relays it; every call is a new page (another tab, or the same tab after a reload).
function dapp(origin, method, params) {
  const out = { reply: undefined };
  chrome.listener({ kind: "dapp", method, params }, { origin, url: origin + "/trade", tab: { id: ++tabSeq } }, (r) => { out.reply = r; });
  return out;
}
const ids = async () => (await call("pending")).map((p) => p.id);
const lastId = async () => (await ids()).at(-1);
// The approval window's own calls (approve.ts): Approve sends the displayed signer and quote, Reject the signer.
const approve = (id) => call("resolve", id, true, ME, undefined);
const reject = (id) => call("resolve", id, false, ME);
const clear = async () => { for (const id of await ids()) await reject(id); };
const REFUSED = {
  ok: false, code: "FILL_IN_PROGRESS",
  error: "A payment request for this offer is already in your wallet, waiting for your answer or being sent. Answer that one in the wallet's approval window, or let it finish, instead of sending another: a second payment for the same offer could lose some or all of what it pays. Nothing was signed.",
};
const refused = (r) => isDeepStrictEqual(r, REFUSED);
const { check, done } = checker("one fill request per offer through the worker channel:");

// 1. Two sites' pages ask to fill one reservation.
{
  const n0 = st.submits.length;
  const a = dapp(SITE, "fillOffer", whole()); await settle();
  const aId = await lastId();
  check("1. honest path: the first request queues and raises the approval window, as before", a.reply === undefined && isDeepStrictEqual(await ids(), [aId]) && isDeepStrictEqual(windowCalls, ["create"]));
  const b = dapp(OTHER, "fillOffer", whole()); await settle();
  check("1. the other site's request for the same reservation is refused FILL_IN_PROGRESS", refused(b.reply));
  check("1. it is not queued", isDeepStrictEqual(await ids(), [aId]));
  check("1. the approval window that holds the first request is focused, and no window is created for the refused one", isDeepStrictEqual(windowCalls, ["create", "focus"]));
  for (const id of await ids()) await approve(id);
  check("1. approving every queued request signs one fill", st.submits.length - n0 === 1);
  check("1. honest path: the first page gets its txid", a.reply?.ok === true && typeof a.reply?.result?.txid === "string");
  await clear();
}

// 2 and 3. The same site after a reload, and every shape of a fill naming the held target.
{
  const a = dapp(SITE, "fillOffer", whole()); await settle();
  const aId = await lastId();
  const w0 = windowCalls.length;
  const b = dapp(SITE, "fillOffer", whole()); await settle();
  check("2. after a reload, the same site's new request is refused FILL_IN_PROGRESS", refused(b.reply));
  check("2. only the first is queued; its window is focused and none is created for the second", isDeepStrictEqual(await ids(), [aId]) && isDeepStrictEqual(windowCalls.slice(w0), ["focus"]));
  for (const [name, method, params] of [
    ["the target in upper case", "fillOffer", whole("0x" + X.slice(2).toUpperCase())],
    ["a partial fill's shape", "fillOffer", partial()],
    ["a token-priced fill's shape", "fillOffer", token(X)],
    ["an attest at the token-fill confidence", "attest", tokenAttest(X)],
  ]) {
    const r = dapp(OTHER, method, params); await settle();
    check(`3. ${name} is refused FILL_IN_PROGRESS`, refused(r.reply));
  }
  check("3. none of them is queued", isDeepStrictEqual(await ids(), [aId]));
  await reject(aId);
  check("2. honest path: the first page gets USER_REJECTED", a.reply?.code === "USER_REJECTED");
  await clear();
  const T = H(0x5150);
  const t = dapp(OTHER, "attest", tokenAttest(T)); await settle();
  const t2 = dapp(SITE, "fillOffer", token(T)); await settle();
  check("3. a token-priced fill of an offer a token-fill attest holds is refused FILL_IN_PROGRESS", t.reply === undefined && refused(t2.reply));
  await clear();
}

// 4. Requests that are not a fill of the held target queue beside it.
{
  dapp(SITE, "fillOffer", whole()); await settle();
  const others = [
    dapp(SITE, "fillOffer", whole(H(0x4242))),
    // the site's reservation claim (SCORE_CLAIM 50, confidence 0): an attest that is not a fill
    dapp(SITE, "attest", { proposalId: X, score: 50, confidence: 0, fee: FEE_ATTEST }),
    dapp(SITE, "send", { to: "0x" + "11".repeat(20), amount: 1e7, fee: 1e6 }),
  ];
  await settle();
  check("4. honest path: a fill of another offer, a claim attest of the same id and a send queue beside the held fill", others.every((r) => r.reply === undefined) && (await ids()).length === 4);
  await clear();
}

// 5. The first fill was approved and is still signing and sending.
{
  const n0 = st.submits.length;
  const a = dapp(SITE, "fillOffer", whole()); await settle();
  let reached, open;
  const atSubmit = new Promise((r) => { reached = r; });
  submitGate = { reached, open: new Promise((r) => { open = r; }) };
  const outcome = approve(await lastId());
  await atSubmit;
  check("5. the approved fill has left the queue and its page has no answer yet", (await ids()).length === 0 && a.reply === undefined);
  const w0 = windowCalls.length;
  const b = dapp(OTHER, "fillOffer", whole()); await settle();
  check("5. a request while the first is signing and sending is refused FILL_IN_PROGRESS", refused(b.reply));
  check("5. it is not queued; the open window that shows the first is focused and none is created", (await ids()).length === 0 && isDeepStrictEqual(windowCalls.slice(w0), ["focus"]));
  // The user closes the window while the first is in flight; another site's request queues but gets no window.
  onRemoved(WIN); await settle();
  createFails = true;
  const s = dapp(OTHER, "send", { to: "0x" + "11".repeat(20), amount: 1e7, fee: 1e6 }); await settle();
  createFails = false;
  const w1 = windowCalls.length;
  const c = dapp(SITE, "fillOffer", whole()); await settle();
  check("5. with the first in flight and no window open, a refused request creates no window, though another request is queued", refused(c.reply) && (await ids()).length === 1 && s.reply === undefined && windowCalls.length === w1);
  submitGate = null; open();
  const o = await outcome;
  check("5. honest path: the first fill signs once and its page gets the txid", o.done === true && o.ok === true && st.submits.length - n0 === 1 && a.reply?.ok === true && typeof a.reply?.result?.txid === "string");
  await clear();
}

// 6. Once the first fill was sent, the hold is gone; the wallet's own fill rules apply when the next one signs.
{
  const a = dapp(SITE, "fillOffer", whole()); await settle();
  check("6. honest path: after the first was sent, the next request for the offer queues", a.reply === undefined && (await ids()).length === 1);
  await clear();
}

// 7. The first was rejected: the next queues and signs.
{
  dapp(SITE, "fillOffer", whole()); await settle();
  await reject(await lastId());
  const b = dapp(OTHER, "fillOffer", whole()); await settle();
  check("7. honest path: after the first was rejected, the next request queues", b.reply === undefined && (await ids()).length === 1);
  const n0 = st.submits.length;
  const o = await approve(await lastId());
  check("7. honest path: and signs once", o.ok === true && st.submits.length - n0 === 1 && b.reply?.ok === true);
  await clear();
}

// 8. The first is back in the queue for its reservation confirm step.
{
  clarvis = unknown(w);
  const a = dapp(SITE, "fillOffer", whole()); await settle();
  const aId = await lastId();
  const r = await approve(aId);
  check("8. the confirm step keeps the first request queued, nothing signed", r.code === "RESERVATION_UNCONFIRMED" && isDeepStrictEqual(await ids(), [aId]) && a.reply === undefined);
  const b = dapp(SITE, "fillOffer", whole()); await settle();
  check("8. a request during the confirm step is refused FILL_IN_PROGRESS and not queued", refused(b.reply) && isDeepStrictEqual(await ids(), [aId]));
  await reject(aId);
  check("8. Cancel settles the first USER_REJECTED", a.reply?.code === "USER_REJECTED");
  clarvis = truthful(w);
  await clear();
  const c = dapp(SITE, "fillOffer", whole()); await settle();
  check("8. honest path: after Cancel the next request queues", c.reply === undefined && (await ids()).length === 1);
  await clear();
}

// 9. The window closed with the first still queued.
{
  const a = dapp(SITE, "fillOffer", whole()); await settle();
  onRemoved(WIN); await settle();
  check("9. closing the window settles the first APPROVAL_CLOSED", a.reply?.code === "APPROVAL_CLOSED");
  const b = dapp(SITE, "fillOffer", whole()); await settle();
  check("9. honest path: the next request queues and opens the window again", b.reply === undefined && (await ids()).length === 1 && windowCalls.at(-1) === "create");
  await clear();
}

// 10. The first is queued but its window never opened (chrome gave none): the refused retry opens it.
{
  onRemoved(WIN); await settle();
  createFails = true;
  const a = dapp(SITE, "fillOffer", whole()); await settle();
  createFails = false;
  const aId = await lastId();
  const w0 = windowCalls.length;
  const b = dapp(OTHER, "fillOffer", whole()); await settle();
  check("10. a refused retry opens the window that holds the queued first request, and is not queued itself", refused(b.reply) && isDeepStrictEqual(await ids(), [aId]) && isDeepStrictEqual(windowCalls.slice(w0), ["create"]));
  const n0 = st.submits.length;
  await approve(aId);
  check("10. honest path: the first fill then signs once", st.submits.length - n0 === 1 && a.reply?.ok === true);
  await clear();
}

done("fill-one-request-per-offer");
