// Fund-safety invariant: a FULL chrome.storage.local quota can NEVER cost a user their keys. Revealing the
// recovery phrase / exporting a private key is a password-gated READ + in-memory decrypt (wallet.ts
// exportMnemonic / exportKey), so it must succeed even when every local write is failing AND while the
// wallet is locked. The SPV header snapshot grows with the chain and shares this quota, so this guarantee
// is what makes "the snapshot can fill storage" a mere annoyance instead of a lockout.
//
// Two failure models: (A) every local write throws (a wedged store), and (B) a realistic quota AT the cap
// where a same-size REPLACE is allowed but a growing write is rejected (how Chrome actually behaves).
//
// MUTATION CONTRACT — this FAILS if any of these regress:
//   * exportMnemonic/exportKey ever performs a blocking LOCAL write (Case A export checks would throw).
//   * unlock's vault re-seal stops being a same-size replace / grows storage (Case B "unlock at cap" fails).
//   * a NEW-account write is not rejected at the cap, or the seed/first key are not preserved when it is.
// Non-self-fulfilling: the quota is enforced by the store independently of the wallet, and injecting a
// `store.set(...)` into exportMnemonic makes Case A fail (verified by mutation when this test was added).
import { Wallet } from "../src/core/wallet.js";
import { memoryStore } from "../src/core/storage.js";

let pass = 0, fail = 0;
const check = (n, c) => { c ? (pass++, console.log("  ✓ " + n)) : (fail++, console.error("  ✗ " + n)); };
const PW = "correct horse battery staple";
const safe = (p) => p.then((v) => v, (e) => "THREW:" + (e?.message || e)); // a throw becomes a sentinel, never a crash

// a local store that enforces a byte cap: get always works; set rejects only a write that GROWS total past cap.
function quotaStore(capBytes, seed) {
  const m = new Map(seed ? Object.entries(seed) : []);
  const sz = (k, v) => k.length + JSON.stringify(v ?? null).length;
  const total = () => { let t = 0; for (const [k, v] of m) t += sz(k, v); return t; };
  return {
    store: {
      async get(k) { return m.has(k) ? m.get(k) : null; },
      async set(k, v) {
        const others = total() - (m.has(k) ? sz(k, m.get(k)) : 0);
        if (others + sz(k, v) > capBytes) throw new Error("QUOTA_BYTES_PER_ITEM quota exceeded");
        m.set(k, v);
      },
      async del(k) { m.delete(k); },
    },
    total, dump: () => Object.fromEntries(m),
  };
}
const throwOnEverySet = (seed) => { const m = new Map(Object.entries(seed || {})); return { async get(k) { return m.has(k) ? m.get(k) : null; }, async set() { throw new Error("QUOTA_BYTES quota exceeded"); }, async del(k) { m.delete(k); } }; };

// establish a real wallet and its TRUE secrets on a roomy store
const roomy = quotaStore(10_000_000);
const w0 = new Wallet(roomy.store, memoryStore());
const { addr } = await w0.create(PW);
const MNEMONIC = await w0.exportMnemonic(PW);
const PRIV = await w0.exportKey(PW);

console.log("quota-recovery:");
console.log(" Case A — every local write throws (wedged storage), wallet LOCKED:");
{
  const w = new Wallet(throwOnEverySet(roomy.dump()), memoryStore()); // fresh instance = locked
  check("exportMnemonic returns the real seed when every write throws", (await safe(w.exportMnemonic(PW))) === MNEMONIC);
  check("exportKey returns the real private key when every write throws", (await safe(w.exportKey(PW))) === PRIV);
  const u = await safe(w.unlock(PW)); // unlock re-seals (a write) so it MAY be blocked here; recovery above is what matters
  console.log(`   (unlock ${String(u).startsWith("THREW") ? "blocked by the failing re-seal write; recovery above unaffected" : "succeeded"})`);
}

console.log(" Case B — realistic quota AT the cap, wallet LOCKED then unlocked:");
{
  const CAP = 60_000;
  const qs = quotaStore(CAP, roomy.dump());
  await qs.store.set("spvHeaderChain", "x".repeat(CAP - qs.total() - 100)); // fill to just under the cap
  let cliff = false; try { await qs.store.set("spvHeaderChain2", "x".repeat(5_000)); } catch { cliff = true; }
  check("the store enforces the cap: a further growing write is rejected", cliff);

  const w = new Wallet(qs.store, memoryStore()); // locked, pointed at the full store
  check("LOCKED + FULL: exportMnemonic returns the real seed", (await safe(w.exportMnemonic(PW))) === MNEMONIC);
  check("LOCKED + FULL: exportKey returns the real private key", (await safe(w.exportKey(PW))) === PRIV);

  const u = await safe(w.unlock(PW));
  check("FULL: unlock SUCCEEDS (vault re-seal is a same-size replace, net-zero quota)", !!u && u.addr === addr);
  check("after unlock: exportMnemonic still returns the real seed", (await safe(w.exportMnemonic(PW))) === MNEMONIC);

  let addThrew = false; try { await w.addAccount("second"); } catch { addThrew = true; }
  check("adding a NEW account at the cap fails (growing write rejected)", addThrew);
  const w2 = new Wallet(qs.store, memoryStore()); // reopen = read the persisted vault
  check("the seed is INTACT after that failed add", (await safe(w2.exportMnemonic(PW))) === MNEMONIC);
  check("the original private key is INTACT after that failed add", (await safe(w2.exportKey(PW))) === PRIV);
}

console.log(`\nquota-recovery: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
