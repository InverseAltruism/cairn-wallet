// create / restore / importKey must not change the wallet unless the new vault is sealed AND stored.
//
// The defect: each set this.accts (and the seed) first, then sealed. sealNew refuses a password under 8
// characters by throwing, so the wallet was left UNLOCKED on an account whose key was stored nowhere:
// funds sent to that address before the service worker restarted were lost. The same held for a failed
// store write after a good seal.
//   RED-FIRST: restore the `this.accts = [a]` assignment before `await this.sealFresh(...)` in create()
//   (the 0.2.73 shape) and case (1) fails: status() reads unlocked with an address and no vault.
//   PAIRED HONEST PATH: (4) the production call shapes (background runPopupMethod passes create(pw),
//   restore(phrase, pw), import(priv, pw)) with a valid password unlock, store the vault, and the stored
//   vault reopens to the same address after lock and unlock.
//
// Run: node --import tsx test/create-seal-atomic.test.mjs   (offline)
import assert from "node:assert/strict";
import { Wallet } from "../src/core/wallet.js";

const SHORT = "seven77";
const PW = "correct horse battery staple";
const PHRASE = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const PRIV = "0x" + "42".repeat(32);

function mkStore() {
  const m = new Map();
  let failVault = false;
  return {
    raw: m,
    failVaultWrites(on) { failVault = on; },
    store: {
      async get(k) { return m.has(k) ? structuredClone(m.get(k)) : null; },
      async set(k, v) {
        if (failVault && k === "vault") throw new Error("QuotaExceededError (simulated storage failure)");
        m.set(k, structuredClone(v));
      },
      async del(k) { m.delete(k); },
    },
  };
}

async function assertUntouched(w, st, label) {
  const s = await w.status();
  assert.equal(s.unlocked, false, `${label}: the wallet stays locked`);
  assert.equal(s.addr, null, `${label}: no address is exposed`);
  assert.equal(s.hasVault, false, `${label}: no vault was stored`);
  assert.equal(s.hasMnemonic, false, `${label}: no seed phrase is held in memory`);
  assert.deepEqual(w.accounts(), [], `${label}: no in-memory accounts`);
  assert.equal(st.raw.size, 0, `${label}: nothing was written to the store`);
}

const flows = [
  ["create", (w, pw) => w.create(pw)],
  ["restore", (w, pw) => w.restore(PHRASE, pw)],
  ["importKey", (w, pw) => w.importKey(PRIV, pw)],
];

console.log("(1) a password under 8 characters is refused and changes nothing");
for (const [name, run] of flows) {
  const st = mkStore();
  const w = new Wallet(st.store);
  await assert.rejects(run(w, SHORT), /password must be at least 8 characters/, `${name}: the short password is refused`);
  await assertUntouched(w, st, `(1) ${name}`);
  console.log(`  ok ${name}`);
}

console.log("(2) an empty password is refused and changes nothing");
for (const [name, run] of flows) {
  const st = mkStore();
  const w = new Wallet(st.store);
  await assert.rejects(run(w, ""), /password required/);
  await assertUntouched(w, st, `(2) ${name}`);
  console.log(`  ok ${name}`);
}

console.log("(3) a failed vault write after a good seal changes nothing in memory");
for (const [name, run] of flows) {
  const st = mkStore();
  st.failVaultWrites(true);
  const w = new Wallet(st.store);
  await assert.rejects(run(w, PW), /QuotaExceededError/);
  const s = await w.status();
  assert.equal(s.unlocked, false, `(3) ${name}: the wallet stays locked`);
  assert.equal(s.addr, null, `(3) ${name}: no address is exposed`);
  assert.deepEqual(w.accounts(), [], `(3) ${name}: no in-memory accounts`);
  console.log(`  ok ${name}`);
}

console.log("(4) paired: a valid password creates, stores and reopens the wallet");
for (const [name, run] of flows) {
  const st = mkStore();
  const w = new Wallet(st.store);
  // a refused attempt first, then the user retries with a good password on the same wallet instance
  await assert.rejects(run(w, SHORT));
  const r = await run(w, PW);
  assert.match(r.addr, /^0x[0-9a-f]{40}$/, `(4) ${name}: returns the new address`);
  const s = await w.status();
  assert.equal(s.unlocked, true, `(4) ${name}: unlocked`);
  assert.equal(s.addr, r.addr, `(4) ${name}: the active address is the returned one`);
  assert.equal(s.hasVault, true, `(4) ${name}: the vault is stored`);
  assert.equal(s.hasMnemonic, name !== "importKey", `(4) ${name}: seed phrase held only for HD wallets`);
  assert.deepEqual(st.raw.get("wallets"), [{ addr: r.addr, label: "Account 1", imported: name === "importKey" ? true : undefined }], `(4) ${name}: the cleartext mirror lists the account`);
  assert.equal(st.raw.get("active"), 0);
  await w.lock();
  await w.unlock(PW);
  assert.equal((await w.status()).addr, r.addr, `(4) ${name}: the stored vault reopens to the same address`);
  if (name === "create") assert.equal(await w.exportMnemonic(PW), r.mnemonic, "(4) create: the stored seed phrase is the one shown at backup");
  if (name === "importKey") assert.equal((await w.exportKey(PW)).toLowerCase(), PRIV, "(4) importKey: the stored key is the imported one");
  await assert.rejects(run(w, PW), /wallet already exists/, `(4) ${name}: a second create is still refused`);
  console.log(`  ok ${name}`);
}

console.log("\ncreate-seal-atomic: all assertions passed");
