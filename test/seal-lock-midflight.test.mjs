// A lock between a sealed commit's broadcast and its seal write must not lose the reveal preimage.
//
// sealClaim used to encrypt the {claim, nonce} preimage AFTER the commit broadcast, with the vault key.
// A lock (the idle auto-lock, or the user) landing in that window made the encryption throw and the
// record was dropped: the 0.25 CSD commit was paid and could never be revealed. The record is now
// encrypted before the broadcast and parked like a history row when the wallet is locked.
//   RED-FIRST: on the 0.2.73 code, case (1) fails (sealedClaims() after unlock has no record).
//   PAIRED HONEST PATH: (3) the popup's call shape, sealClaim({ claim }) on an unlocked wallet, stores
//   the encrypted record under the account's list exactly as before, parks nothing, and reveals.
//   RESET BOUNDARY: (4) a reset() in the same window drops the record.
//
// Run: node --import tsx test/seal-lock-midflight.test.mjs   (offline)
import assert from "node:assert/strict";
import { Wallet } from "../src/core/wallet.js";
import { memoryStore } from "../src/core/storage.js";
import { mkCoin, txReply } from "./_coin.js";

const PW = "pw-seal-midflight-1234";
const sealKey = (a) => "sealedClaims:" + a;
const settle = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };

// onSubmit runs inside the /tx/submit request, after the signed commit has left the wallet.
function mkFetch(coins, onSubmit) {
  const registered = [];
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.includes("/tx/submit")) { await onSubmit?.(); return { ok: true, status: 200, json: async () => ({ ok: true }) }; }
    if (u.includes("/api/content")) { registered.push(JSON.parse(init?.body ?? "{}")); return { ok: true, status: 200, json: async () => ({ ok: true }) }; }
    if (u.includes("/proposal/")) return { ok: true, status: 200, json: async () => ({ payload_hash: "0x" + "11".repeat(32) }) }; // the commit is mined
    if (u.includes("/utxos/")) return { ok: true, status: 200, json: async () => ({ confirmed_balance: coins.reduce((s, c) => s + c.coin.value, 0), utxos: coins.map((c) => c.coin) }) };
    if (u.endsWith("/tip")) return { ok: true, status: 200, json: async () => ({ height: 65_000 }) };
    const t = txReply(u, coins);
    if (t) return t;
    return { ok: false, status: 404, json: async () => ({}) };
  };
  return registered;
}

console.log("(1) an idle lock between the commit broadcast and the seal write keeps the reveal preimage");
{
  const st = memoryStore();
  const w = new Wallet(st);
  const { addr } = await w.create(PW);
  let lockNow = true;
  const registered = mkFetch([mkCoin(51_00000000)], async () => { if (lockNow) await w.lock(); });
  const CLAIM = "the sealed text whose nonce is the only reveal key";
  const r = await w.sealClaim({ claim: CLAIM });
  assert.equal(r.ok, true, "(1) the commit broadcast (its fee is spent)");
  assert.equal((await w.status()).unlocked, false, "(1) the wallet locked mid-flight");
  lockNow = false;
  await w.unlock(PW);
  const seals = await w.sealedClaims();
  assert.equal(seals.length, 1, "(1) the sealed claim is listed after unlock");
  assert.equal(seals[0].txid, r.txid);
  assert.equal(seals[0].claim, CLAIM, "(1) and its preimage decrypts");
  const stored = await st.get(sealKey(addr));
  assert.equal(stored?.length, 1, "(1) unlock wrote the parked record to storage");
  assert.ok(stored[0].enc && stored[0].claim === undefined && stored[0].nonce === undefined, "(1) stored encrypted, no plaintext");
  assert.equal(w.pendingSeals.length, 0, "(1) nothing left parked");
  const rv = await w.revealClaim(r.txid);
  assert.equal(rv.ok, true, "(1) the paid commit can be revealed");
  assert.equal(registered.at(-1)?.claim, CLAIM, "(1) the reveal publishes the original claim");
  console.log("  ok");
}

console.log("(2) the history row of the same commit also survives (and is written on unlock)");
{
  const st = memoryStore();
  const w = new Wallet(st);
  const { addr } = await w.create(PW);
  mkFetch([mkCoin(52_00000000)], async () => { await w.lock(); });
  const r = await w.sealClaim({ claim: "second" });
  mkFetch([mkCoin(52_00000000)]);
  await w.unlock(PW);
  const hist = await st.get("txHistory:" + addr);
  assert.equal(hist?.[0]?.txid, r.txid, "(2) the seal's history row is in storage after unlock");
  assert.equal(hist[0].type, "seal");
  console.log("  ok");
}

console.log("(3) paired: an unlocked commit seals and persists as before");
{
  const st = memoryStore();
  const w = new Wallet(st);
  const { addr } = await w.create(PW);
  const registered = mkFetch([mkCoin(53_00000000)]);
  const r = await w.sealClaim({ claim: "honest claim" });
  assert.equal(r.ok, true);
  const stored = await st.get(sealKey(addr));
  assert.equal(stored?.length, 1, "(3) the record is in storage when sealClaim returns");
  assert.deepEqual(Object.keys(stored[0]).sort(), ["committedTs", "domain", "enc", "revealed", "txid"], "(3) the record has the same fields as before");
  assert.equal(stored[0].txid, r.txid);
  assert.equal(stored[0].domain, "csd:sealed");
  assert.equal(stored[0].revealed, false);
  assert.equal(w.pendingSeals.length, 0, "(3) nothing parked");
  assert.equal((await w.revealClaim(r.txid)).ok, true);
  assert.equal(registered.at(-1)?.claim, "honest claim");
  assert.equal((await st.get(sealKey(addr)))[0].revealed, true, "(3) the reveal marks it revealed");
  console.log("  ok");
}

console.log("(4) a reset in the same window drops the record");
{
  const st = memoryStore();
  const w = new Wallet(st);
  const { addr } = await w.create(PW);
  let resetP = null;
  mkFetch([mkCoin(54_00000000)], async () => { resetP = w.reset(); });
  const r = await w.sealClaim({ claim: "gone with the reset" });
  assert.equal(r.ok, true);
  await resetP;
  await settle();
  assert.equal(w.pendingSeals.length, 0, "(4) nothing parked after a reset");
  assert.equal(await st.get(sealKey(addr)), null, "(4) nothing written under the old account");
  console.log("  ok");
}

console.log("\nseal-lock-midflight: all assertions passed");
