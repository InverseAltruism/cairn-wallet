// The real background service worker, driven through its message listener with a mock `chrome`.
//
// (A) The connected-sites map is a read-modify-write in chrome.storage.local. A page's approved connect
//     (recordConsent) and the user's Disconnect of another site (revokeConsent) each read the map, change
//     one key and write the whole map back. Interleaved, the later write restores the key the earlier one
//     removed: the disconnected site is connected again without the user approving it.
//     RED-FIRST: drop the inConsentChain wrapper from recordConsent and revokeConsent in background.ts and
//     case (A1) fails (the disconnected origin is still in connectedSites).
//     PAIRED HONEST PATH: (A2) the approved connect that raced the Disconnect is itself recorded, and (A3) a
//     plain connect then Disconnect, one after the other, behave as before.
//
// (B) resolvePending's finish() returns the outcome to the approval window. It dropped `code`, so the
//     window could never show which refusal fired.
//     RED-FIRST: remove `code` from finish()'s return in background.ts and (B1) and (B2) fail.
//     PAIRED HONEST PATH: (B3) an approved connect returns ok with no code.
//
// (C) The approve-time signer check in resolvePending (displayed signer vs active account).
//     RED-FIRST: delete the `displayedSigner ... ACCOUNT_CHANGED` block in resolvePending and (C1) fails.
//     PAIRED HONEST PATH: (C2) the same propose under the displayed active account reaches the wallet.
//
// (E) A submit result carries `spentTxids` and `inputs` for the wallet's history; resolvePending strips both
//     before the page receives it (asserted on (C2)'s result).
//     RED-FIRST: pass `result` instead of `pageResult(result)` to finish() and (E1) fails.
//     PAIRED HONEST PATH: (E2) the page still receives ok and the txid.
//
// Run: node --import tsx test/background-consent-outcome.test.mjs   (offline)
import assert from "node:assert/strict";
import { buildNameRenew, CAIRNX_DOMAIN, TREASURY_ADDR } from "../src/core/cairnx.js";
import { mkCoin, txReply } from "./_coin.ts";

const PW = "correct horse battery staple";
const CONSENT_KEY = "connectedOrigins";

// ── mock chrome: storage.local with reads of the consent map that the test can hold and release ──────
const mem = new Map();
const held = [];          // held consent-map reads, each { release }
let holdConsentReads = false;
let listener = () => {};
globalThis.chrome = {
  runtime: {
    id: "cairnwallettestid",
    lastError: undefined,
    getURL: (p) => "chrome-extension://x/" + p,
    onMessage: { addListener: (fn) => { listener = fn; } },
    onConnect: { addListener: () => {} },
  },
  storage: { local: {
    get: async (k) => {
      // The value is captured at call time; only the answer is delayed. That is what a slow read is.
      const snap = structuredClone(mem.get(k));
      if (k === CONSENT_KEY && holdConsentReads) await new Promise((release) => held.push({ release }));
      return { [k]: snap };
    },
    set: async (o) => { for (const k of Object.keys(o)) mem.set(k, structuredClone(o[k])); },
    remove: async (k) => { mem.delete(k); },
  } },
  alarms: { create: () => {}, onAlarm: { addListener: () => {} } },
  action: { setBadgeText: () => {} },
  windows: { create: () => {} },
};
globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.endsWith("/tip")) return { ok: true, status: 200, json: async () => ({ height: 65_000 }) };
  if (u.includes("/utxos/")) return { ok: true, status: 200, json: async () => ({ confirmed_balance: 0, utxos: [] }) };
  return { ok: false, status: 404, json: async () => ({}) };
};

const SENDER = { id: "cairnwallettestid", url: "chrome-extension://x/approve.html", tab: { id: 1 } };
const popup = (method, ...args) => new Promise((res) => listener({ kind: "popup", method, args }, SENDER, res));
const dapp = (method, params, origin) => new Promise((res) => listener({ kind: "dapp", method, params }, { origin }, res));
const tick = () => new Promise((r) => setTimeout(r, 0));
const until = async (cond, what) => { for (let i = 0; i < 500; i++) { if (cond()) return; await tick(); } assert.fail("timed out waiting for " + what); };
const lastPending = async (method) => (await popup("pending")).result.filter((p) => p.method === method).slice(-1)[0];
const sites = async () => (await popup("connectedSites")).result.map((s) => s.origin).sort();

// Approve a queued connect from `origin` (the production shape: the dApp asks, the window resolves).
async function connect(origin) {
  const answer = dapp("connect", {}, origin);
  await tick(); await tick();
  const p = await lastPending("connect");
  assert.equal(p?.origin, origin, "the connect request is queued for " + origin);
  const r = await popup("resolve", p.id, true, (await popup("status")).result.addr);
  return { answer, r };
}

await import("../src/background.js");
await tick();
assert.equal((await popup("create", PW)).ok, true, "setup: the popup channel creates a wallet");

const A = "https://a.example", B = "https://b.example", C = "https://c.example";

// ── (A3) honest sequential path first, so the race below starts from a known map ──────────────────────
console.log("(A3) a connect, then a Disconnect, one after the other");
await connect(A);
await connect(B);
assert.deepEqual(await sites(), [A, B], "(A3) both approved connects are recorded");
const rev = await popup("disconnectSite", A);
assert.deepEqual(rev.result, { removed: true }, "(A3) Disconnect reports the removal");
assert.deepEqual(await sites(), [B], "(A3) the disconnected site is gone and the other stays");
await connect(A);
assert.deepEqual(await sites(), [A, B], "(A3) setup for the race: A and B connected");
console.log("  ok");

// ── (A1)/(A2) a page's connect racing the user's Disconnect of another site ───────────────────────────
console.log("(A1) a connect of C racing a Disconnect of B must not restore B");
const pendC = dapp("connect", {}, C);
await tick(); await tick();
const reqC = await lastPending("connect");
assert.equal(reqC?.origin, C);
const signer = (await popup("status")).result.addr;
holdConsentReads = true;
const approveC = popup("resolve", reqC.id, true, signer);
await until(() => held.length === 1, "the connect's consent read to start");
const disconnectB = popup("disconnectSite", B);
for (let i = 0; i < 20; i++) await tick();
// Release the NEWEST held read first. Unserialized, that is the Disconnect's read, which then writes {A}
// before the connect writes back the {A, B, C} it read earlier. Serialized, only one read is ever held.
let settled = false;
Promise.all([approveC, disconnectB]).then(() => { settled = true; });
while (!settled) {
  if (held.length) held.pop().release();
  await tick();
}
holdConsentReads = false;
const [rc, rd] = await Promise.all([approveC, disconnectB]);
await pendC;
assert.deepEqual(rd.result, { removed: true }, "(A1) the Disconnect reports the removal");
assert.ok(!(await sites()).includes(B), "(A1) the disconnected site B stays disconnected");
console.log("  ok");
console.log("(A2) the racing connect of C is itself recorded");
assert.equal(rc.result.ok, true, "(A2) the connect approval succeeded");
assert.deepEqual(await sites(), [A, C], "(A2) C is connected, A untouched");
console.log("  ok");

// ── (B) the outcome code reaches the approval window ─────────────────────────────────────────────────
console.log("(B1) a soft refusal from the signer carries its code to the window");
const zero = dapp("send", { to: "0x" + "00".repeat(20), amount: 1_00000000, fee: 1_000_000 }, A);
await tick(); await tick();
const reqZ = await lastPending("send");
const outZ = (await popup("resolve", reqZ.id, true, signer)).result;
assert.equal(outZ.ok, false, "(B1) the zero-address send is refused");
assert.equal(outZ.code, "ZERO_ADDR_REFUSED", "(B1) the window receives the machine code");
assert.match(outZ.error, /zero address/, "(B1) and the reason text");
const dappZ = await zero;
assert.equal(dappZ.result?.code, "ZERO_ADDR_REFUSED", "(B1) the page still receives the code as before");
console.log("  ok");

console.log("(B2) a refusal raised in resolvePending itself carries its code too");
const other = "0x" + "77".repeat(20);
const sendX = dapp("send", { to: other, amount: 1_00000000, fee: 1_000_000 }, A);
await tick(); await tick();
const reqX = await lastPending("send");
const outX = (await popup("resolve", reqX.id, true, other)).result;   // displayed signer != active account
assert.equal(outX.ok, false);
assert.equal(outX.code, "ACCOUNT_CHANGED", "(B2) the window receives ACCOUNT_CHANGED");
await sendX;
console.log("  ok");

console.log("(B3) paired: an approved connect returns ok with no code");
const { r: okConn } = await connect("https://d.example");
assert.equal(okConn.result.ok, true);
assert.equal(okConn.result.code, undefined, "(B3) no code on success");
console.log("  ok");

// ── (C) the approve-time signer check is the only one a `propose` gets ───────────────────────────────
// send, attest and fillOffer re-check the displayed signer inside the wallet (expectSigner); propose does
// not, so the check in resolvePending is all that stops it signing with an account the user never saw.
console.log("(C1) a propose approved under a different displayed signer is refused before the wallet runs");
const RENEW = buildNameRenew({ name: "satoshi" });
const proposeParams = { domain: CAIRNX_DOMAIN, uri: RENEW.uri, payloadHash: RENEW.payloadHash, expiresEpoch: 2_300, fee: 1_000_000, outputs: [{ to: TREASURY_ADDR, value: 100_000_000 }] };
// The active account holds one verifiable 10 CSD coin, so the honest path can sign and submit.
const coin = mkCoin(10_00000000);
const seen = [];
const baseFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const u = String(url);
  seen.push(u);
  if (u.includes(`/utxos/${signer}`)) return { ok: true, status: 200, json: async () => ({ confirmed_balance: coin.coin.value, utxos: [coin.coin] }) };
  if (u.includes("/tx/submit")) return { ok: true, status: 200, json: async () => ({ ok: true }) };
  return txReply(u, [coin]) ?? baseFetch(url, init);
};
const proposeP = dapp("propose", proposeParams, A);
await tick(); await tick();
const reqP = await lastPending("propose");
assert.equal(reqP?.origin, A, "setup: the propose is queued");
const outP = (await popup("resolve", reqP.id, true, other)).result;
assert.equal(outP.ok, false, "(C1) refused");
assert.equal(outP.code, "ACCOUNT_CHANGED", "(C1) with ACCOUNT_CHANGED");
assert.equal((await proposeP).code, "ACCOUNT_CHANGED", "(C1) the page receives the same code");
assert.deepEqual(seen.filter((u) => u.includes("/utxos/") || u.includes("/tx/submit")), [], "(C1) the wallet never selected coins or submitted");
console.log("  ok");

console.log("(C2) paired: the same propose approved under the displayed active account reaches the wallet");
seen.length = 0;
const proposeOk = dapp("propose", proposeParams, A);
await tick(); await tick();
const reqOk = await lastPending("propose");
const outOk = (await popup("resolve", reqOk.id, true, signer)).result;
assert.equal(outOk.ok, true, "(C2) approved: " + JSON.stringify(outOk));
assert.ok(seen.some((u) => u.includes(`/utxos/${signer}`)), "(C2) the wallet selected coins for the displayed account");
assert.equal(seen.filter((u) => u.includes("/tx/submit")).length, 1, "(C2) and submitted once");
const pageOk = await proposeOk;
assert.equal(pageOk.ok, true, "(C2) the page receives the success");
// (E) the wallet's history bookkeeping on a submit result stays off the page.
// RED-FIRST: pass `result` instead of `pageResult(result)` to finish() in resolvePending and (E1) fails.
assert.match(String(pageOk.result?.txid), /^0x[0-9a-f]{64}$/, "(E2) paired: the page still receives ok and the txid");
assert.equal("inputs" in pageOk.result, false, "(E1) the page result carries no spent outpoints");
assert.equal("spentTxids" in pageOk.result, false, "(E1) ...and no spent source txids");
globalThis.fetch = baseFetch;
// ── (D) a popup send while locked answers WALLET_LOCKED, not INTERNAL (Plan 85 7.3a, E1.lock) ────────
// RED-FIRST: use "INTERNAL" again in the popup listener's catch in background.ts and (D1) fails.
// PAIRED HONEST PATH: (D2) another thrown error keeps INTERNAL, and (D3) the unlocked send is not refused
// on the lock: it reaches the engine and returns its own SubmitResult.
console.log("(D1) a popup-channel send while locked answers WALLET_LOCKED");
await popup("lock");
const lockedSend = await popup("send", other, 1_00000000, 1_000_000);
assert.equal(lockedSend.ok, false);
assert.equal(lockedSend.code, "WALLET_LOCKED", "(D1) the locked popup send carries WALLET_LOCKED");
assert.equal(lockedSend.error, "locked", "(D1) the popup still receives the message it routes on");
console.log("  ok");
console.log("(D2) paired: an unrelated throw keeps INTERNAL");
const bad = await popup("setRpc", "ftp://not-allowed");
assert.equal(bad.ok, false);
assert.equal(bad.code, "INTERNAL", "(D2) a non-lock throw is still INTERNAL");
console.log("  ok");
console.log("(D3) paired: the same send unlocked reaches the engine");
assert.equal((await popup("unlock", PW)).ok, true);
const unlockedSend = await popup("send", other, 1_00000000, 1_000_000);
assert.equal(unlockedSend.ok, true, "(D3) the channel answers ok (the engine result rides inside)");
assert.equal(unlockedSend.result.code, "INSUFFICIENT", "(D3) the empty test wallet gets the engine's own refusal");
console.log("  ok");

console.log("\nbackground-consent-outcome: all assertions passed");
process.exit(0);
