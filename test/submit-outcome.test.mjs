// Plan 85 7.3a: the engine reports what actually happened, so the popup can say it.
//
// (A) A /tx/submit answered with a 2xx body that is not a JSON object (null, an array, a number) used to
//     throw out of signAndSubmit AFTER the tx was submitted (null) or read as a definitive rejection.
//     The popup relies on "a method that threw submitted nothing", so the outcome must come back as a value.
//     RED-FIRST: drop the non-object branch in node.ts post() and A1-A3 fail.
// (B) VC-01: a /utxos body without a `utxos` array threw out of the pre-sign path (selectVerified's map,
//     consolidate's iteration) or was read as an empty or character-split coin list.
//     RED-FIRST: restore `utxos: j.utxos ?? []` in node.ts balance() and B1-B4 fail.
// (C) VC-02: running out of the three selection rounds while untried coins remain was reported as "the
//     remaining provable coins couldn't cover this spend" (non-retryable) for a spend they could cover.
//     RED-FIRST: drop the `if (!selExhausted) return roundsExhausted(...)` line and C1 fails; restore the
//     old consolidate tail and C4 fails.
// (D) Reveal waits for the mined commit. RED-FIRST: drop the getProposal check in revealClaim and D1 fails.
// (E) fillOfferView feeds the CSD-paid fill card. RED-FIRST: n/a (new read); E3 pins the failure shape.
// PAIRED HONEST PATHS: A4, B5, C2, C3, D2, E1, E2 run the production call shapes and still succeed.
//
// Run: node --import tsx test/submit-outcome.test.mjs   (offline)
import assert from "node:assert/strict";
import { Wallet } from "../src/core/wallet.js";
import { memoryStore } from "../src/core/storage.js";
import { mkCoin, txReply } from "./_coin.js";

let pass = 0, fail = 0;
const t = async (name, fn) => { try { await fn(); pass++; console.log("  ✓ " + name); } catch (e) { fail++; console.error("  ✗ " + name + "\n    " + String(e?.message || e).split("\n")[0]); } };
const RCPT = "0x" + "11".repeat(20);
const origFetch = globalThis.fetch;
const wallet = async () => { const w = new Wallet(memoryStore()); await w.create("super-secret-pw"); return w; };
const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

// One URL-routed node. `utxosBody` overrides the /utxos answer; `horizon` txids answer 503 SCAN_HORIZON.
function node({ coins = [], utxosBody, submit, horizon = new Set(), proposal, offers = {}, extra } = {}) {
  const stats = { submits: 0, content: [] };
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (extra) { const r = await extra(u); if (r) return r; }
    if (u.includes("/tx/submit")) { stats.submits++; return submit ? submit() : json(200, { ok: true }); }
    if (u.includes("/utxos/")) return json(200, utxosBody !== undefined ? utxosBody : { confirmed_balance: coins.reduce((s, c) => s + c.coin.value, 0), utxos: coins.map((c) => c.coin) });
    const id = u.match(/\/tx\/(0x[0-9a-f]{64})\b/i)?.[1]?.toLowerCase();
    if (id && horizon.has(id)) return json(503, { ok: false, code: "SCAN_HORIZON" });
    const tr = txReply(u, coins); if (tr) return tr;
    if (u.endsWith("/tip")) return json(200, { height: 60_000 });
    if (u.includes("/proposal/")) return proposal ? json(200, proposal) : json(404, {});
    if (u.includes("/api/content")) { stats.content.push(JSON.parse(init?.body ?? "{}")); return json(200, { ok: true }); }
    const off = u.match(/\/cairnx\/offer\/(0x[0-9a-f]{64})/i)?.[1]?.toLowerCase();
    if (off) return offers[off] ? json(200, offers[off]) : json(404, {});
    return json(404, {});
  };
  return stats;
}

try {
  console.log("(A) a submit answer that is not a JSON object is ambiguous, returned, never thrown");
  for (const [label, body] of [["A1 null", null], ["A2 an array", []], ["A3 a number", 5]]) {
    await t(`${label}: SUBMIT_MAYBE_INFLIGHT with the local txid, recorded maybe in history`, async () => {
      const coin = mkCoin(7e8 + Math.floor(Math.random() * 1e6));
      const s = node({ coins: [coin], submit: () => json(200, body) });
      const w = await wallet();
      const r = await w.send(RCPT, 1e8, 1e6);
      assert.equal(r.ok, false); assert.equal(r.code, "SUBMIT_MAYBE_INFLIGHT"); assert.match(String(r.txid), /^0x[0-9a-f]{64}$/);
      assert.equal(s.submits, 1);
      const h = await w.history();
      assert.equal(h[0]?.txid, r.txid); assert.equal(h[0]?.maybe, true);
    });
  }
  await t("A4 honest: a 2xx {ok:true} is a successful send", async () => {
    node({ coins: [mkCoin(7_100_000_00)] });
    const r = await (await wallet()).send(RCPT, 1e8, 1e6);
    assert.equal(r.ok, true);
  });

  console.log("(B) VC-01: a /utxos body without a utxos array refuses before signing, retryably");
  for (const [label, body, run] of [
    ["B1 send, utxos is an object", { confirmed_balance: 5e8, utxos: {} }, (w) => w.send(RCPT, 1e8, 1e6)],
    ["B2 send, utxos missing", { confirmed_balance: 5e8 }, (w) => w.send(RCPT, 1e8, 1e6)],
    ["B3 merge, utxos is an object", { confirmed_balance: 5e8, utxos: {} }, (w) => w.consolidate(1e6)],
    ["B4 merge, utxos is a string", { confirmed_balance: 5e8, utxos: "abc" }, (w) => w.consolidate(1e6)],
  ]) {
    await t(`${label}: VERIFY_UNAVAILABLE, nothing submitted`, async () => {
      const s = node({ utxosBody: body });
      const r = await run(await wallet());
      assert.equal(r.ok, false); assert.equal(r.code, "VERIFY_UNAVAILABLE"); assert.match(r.error, /nothing was signed/);
      assert.equal(s.submits, 0);
    });
  }
  await t("B5 honest: an array body still sends", async () => {
    node({ coins: [mkCoin(7_200_000_00)] });
    assert.equal((await (await wallet()).send(RCPT, 1e8, 1e6)).ok, true);
  });

  console.log("(C) VC-02: the round budget running out is retryable, not 'cannot cover'");
  {
    const [a, b, c, d] = [13e8, 12e8, 11e8, 10e8].map((v) => mkCoin(v + 123));
    const horizon = new Set([a, b, c].map((x) => x.coin.txid.toLowerCase()));
    const w = await wallet();
    let s = node({ coins: [a, b, c, d], horizon });
    let r;
    await t("C1 three horizon coins exhaust the rounds while a provable coin covers it: VERIFY_UNAVAILABLE", async () => {
      r = await w.send(RCPT, 5e8, 1e6);
      assert.equal(r.ok, false); assert.equal(r.code, "VERIFY_UNAVAILABLE");
      assert.match(r.error, /could not prove 3 coin\(s\) totalling 36\.00000369 CSD yet/); assert.match(r.error, /Nothing was signed; try again shortly/);
      assert.doesNotMatch(r.error, /couldn't cover/);
      assert.equal(s.submits, 0);
    });
    await t("C2 honest: the retry the copy asks for succeeds with the provable coin", async () => {
      s = node({ coins: [a, b, c, d], horizon });
      r = await w.send(RCPT, 5e8, 1e6);
      assert.equal(r.ok, true); assert.equal(s.submits, 1);
    });
    await t("C3 honest: a genuine shortfall behind a horizon coin is still VERIFY_HORIZON", async () => {
      const [e, f] = [mkCoin(20e8 + 7), mkCoin(1e8 + 7)];
      node({ coins: [e, f], horizon: new Set([e.coin.txid.toLowerCase()]) });
      const r2 = await (await wallet()).send(RCPT, 5e8, 1e6);
      assert.equal(r2.code, "VERIFY_HORIZON");
    });
    await t("C4 merge: horizon coins entering every round exhaust the budget: VERIFY_UNAVAILABLE", async () => {
      const coins = Array.from({ length: 520 }, (_, i) => mkCoin(1_000_000 + i * 1000 + 31));
      const hz = new Set([coins[0], coins[512], coins[513]].map((x) => x.coin.txid.toLowerCase()));
      const s4 = node({ coins, horizon: hz });
      const r4 = await (await wallet()).consolidate(1e6);
      assert.equal(r4.ok, false); assert.equal(r4.code, "VERIFY_UNAVAILABLE"); assert.match(r4.error, /could not prove 3 coin\(s\)/);
      assert.equal(s4.submits, 0);
    });
  }

  console.log("(D) reveal waits for the mined commit");
  {
    const coin = mkCoin(9e8 + 99);
    let s = node({ coins: [coin], submit: () => json(200, { ok: true }) });
    const w = await wallet();
    const sealed = await w.sealClaim({ claim: "a sealed claim" });
    assert.equal(sealed.ok, true, "setup: the seal is submitted");
    await t("D1 a commit not mined yet: SEAL_NOT_MINED, nothing published", async () => {
      s = node({ coins: [coin] });
      const r = await w.revealClaim(sealed.txid);
      assert.equal(r.ok, false); assert.equal(r.code, "SEAL_NOT_MINED"); assert.match(r.error, /nothing was revealed/);
      assert.equal(s.content.length, 0);
    });
    await t("D2 honest: once the commit is mined the reveal publishes", async () => {
      s = node({ coins: [coin], proposal: { payload_hash: "0x" + "22".repeat(32) } });
      const r = await w.revealClaim(sealed.txid);
      assert.equal(r.ok, true); assert.equal(s.content.length, 1); assert.equal(s.content[0].claim, "a sealed claim");
    });
  }

  console.log("(E) fillOfferView: the listing and what it gives");
  {
    const LIST = "0x" + "a1".repeat(32), RES = "0x" + "b2".repeat(32);
    const listing = { id: LIST, status: "open", give: { ticker: "CAIRN", amount: "18401371902" }, want: { value: "197039600", payto: RCPT } };
    const tokens = (u) => (u.endsWith("/cairnx/tokens") ? json(200, [{ ticker: "CAIRN", decimals: 8, deployId: "0x" + "cc".repeat(32) }]) : null);
    node({ offers: { [LIST]: listing, [RES]: listing }, extra: tokens });
    const w = await wallet();
    await t("E1 a direct fill: the listing id equals the target, the give is read with its decimals", async () => {
      const v = await w.fillOfferView(LIST);
      assert.equal(v.ok, true); assert.equal(v.offerId, LIST); assert.equal(v.giveTicker, "CAIRN"); assert.equal(v.giveAmount, "18401371902");
    });
    await t("E2 a reservation target: the view names the listing behind it", async () => {
      const v = await w.fillOfferView(RES);
      assert.equal(v.ok, true); assert.equal(v.offerId, LIST);
    });
    await t("E3 an unknown target fails soft", async () => {
      const v = await w.fillOfferView("0x" + "dd".repeat(32));
      assert.equal(v.ok, false);
    });
  }
} finally { globalThis.fetch = origFetch; }

console.log(`\nsubmit-outcome: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
