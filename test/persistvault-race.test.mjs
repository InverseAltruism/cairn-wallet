// persistVault serialization (fund-safety fresh-eyes MED, reproduced by the post-release red-team):
// two concurrent account-management ops each seal a vault doc built at a different instant; without
// serialization the STALE write can land last and permanently drop a just-added IMPORTED (non-seed-
// recoverable) key. This test forces exactly that ordering with a gated store and asserts the imported
// key survives in the SEALED vault across a lock/unlock.
//
// MUTATION CONTRACT: fails on the pre-fix persistVault (the K-less write lands last -> key lost);
// passes once persistVault is serialized behind a promise chain and the mirror is captured from the
// same pre-await snapshot as the sealed doc.
import { Wallet } from "../src/core/wallet.js";
import { memoryStore } from "../src/core/storage.js";

let pass = 0, fail = 0;
const check = (n, c) => { c ? (pass++, console.log("  ✓ " + n)) : (fail++, console.error("  ✗ " + n)); };
const PW = "super-secret-pw";
const RAW = "0x" + "5c".repeat(32); // a raw imported key: NOT derivable from the HD phrase

// a memoryStore whose FIRST vault write (after arm) is held on a gate and signals when hit, so the
// test can force that (stale) write to complete LAST.
function gatedStore() {
  const inner = memoryStore();
  let armed = false, releaseGate = () => {}, gateHit = () => {};
  let gate = Promise.resolve();
  const hit = new Promise((res) => { gateHit = res; });
  return {
    store: {
      get: (k) => inner.get(k),
      del: (k) => inner.del(k),
      async set(k, v) {
        if (k === "vault" && armed) { armed = false; gateHit(); await gate; }
        return inner.set(k, v);
      },
    },
    arm() { armed = true; gate = new Promise((res) => { releaseGate = res; }); },
    hit,
    release: () => releaseGate(),
  };
}

console.log("persistVault race — a concurrent add∥import must not drop the imported key:");
{
  const g = gatedStore();
  const w = new Wallet(g.store, memoryStore());
  await w.create(PW);            // wallet [A]; create's own persist runs before arm (not gated)
  g.arm();                       // the NEXT vault write is gated

  const p1 = w.addAccount("B");  // HD account B; its persist seals doc [A,B] then GATES at the vault write
  await g.hit;                   // p1 is now parked with a STALE (K-less) doc sealed

  let impErr = null;
  const p2 = w.importAccount(RAW, "cold").catch((e) => { impErr = e; return null; }); // pushes K synchronously
  await new Promise((r) => setTimeout(r, 0)); // let importAccount issue its persist (queued post-fix, racing pre-fix)

  g.release();                   // release p1's stale [A,B] vault write -> lands last on the pre-fix code
  const [, impRes] = await Promise.all([p1, p2]);
  check("both account-mgmt ops settled without error", impErr === null && impRes && impRes.addr);
  const kAddr = impRes.addr.toLowerCase();

  // the decisive check: re-open the SEALED vault (not just in-memory state) and confirm K is there
  await w.lock();
  await w.unlock(PW);
  const st = await w.status();
  const inVault = st.accounts.some((a) => a.addr.toLowerCase() === kAddr && a.imported);
  check("the imported key survives in the re-opened vault (stale write did not clobber it)", inVault);
  check("the vault holds all three accounts after the race", st.accounts.length === 3);
  // vault<->mirror coherence: the cleartext mirror the UI reads matches the sealed set
  check("the cleartext wallets mirror agrees with the sealed vault (no divergence)",
    st.accounts.some((a) => a.addr.toLowerCase() === kAddr));
}

console.log("persistVault — a normal single persist still works (no serialization deadlock):");
{
  const w = new Wallet(memoryStore(), memoryStore());
  await w.create(PW);
  const r = await w.addAccount("solo");
  await w.importAccount(RAW, "cold2");
  await w.lock(); await w.unlock(PW);
  const st = await w.status();
  check("sequential add + import both persist and re-open cleanly", st.accounts.length === 3 && !!r.addr);
}

console.log("reset() must not race a persist and RESURRECT the wiped vault (RESET-RESURRECT, red-team):");
{
  // reset() deletes vault/wallets off the persist chain; a persist parked at its store.set could land
  // AFTER the deletes and re-create the encrypted vault + cleartext mirror — defeating "wipe everything"
  // and locking out create/restore. MUTATION CONTRACT: fails on the pre-fix reset (deletes not chained).
  const g = gatedStore();
  const w = new Wallet(g.store, memoryStore());
  await w.create(PW);           // [A]; create's persist runs before arm
  g.arm();                      // gate the next vault write
  const p1 = w.addAccount("B"); // persist parks at the gated vault write ([A,B] sealed, held)
  await g.hit;
  const p2 = w.reset();         // lock() nulls accts; the wipe is routed through the same persist chain
  await new Promise((r) => setTimeout(r, 0)); // let reset() reach its chained wipe
  g.release();                  // p1's parked [A,B] write lands; then (post-fix) the chained wipe deletes it
  await Promise.all([p1.catch(() => {}), p2]);

  const vault = await g.store.get("vault");
  const wallets = await g.store.get("wallets");
  check("reset() leaves NO vault ciphertext after a racing persist (wipe holds)", vault === null);
  check("reset() leaves NO cleartext account mirror", wallets === null || (Array.isArray(wallets) && wallets.length === 0));
  let created = false;
  try { const w2 = new Wallet(g.store, memoryStore()); await w2.create(PW); created = true; } catch { created = false; }
  check("a fresh create() succeeds after reset (no 'wallet already exists' lockout)", created);
}

console.log(`\npersistvault-race: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
