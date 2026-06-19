// BRUTE-UNLOCK coverage: the password-gated paths lock out after repeated failures WHEN a session store
// is present (extension), and are completely inert without one (tests/Node) so correct usage is never
// gated. Run: tsx test/bruteforce.test.mjs
import { Wallet } from "../src/core/wallet.ts";
import { memoryStore } from "../src/core/storage.ts";

const PW = "correct-horse-battery";
let failed = 0;
const ok = (n, c) => { console.log(`  ${c ? "✅" : "❌"} ${n}`); if (!c) failed++; };

// (1) session present → lockout after 5 bad attempts
{
  const w = new Wallet(memoryStore(), memoryStore()); // 2nd arg = session store ⇒ guard ACTIVE
  await w.create(PW);
  await w.lock();
  for (let i = 0; i < 5; i++) {
    let badPw = false;
    try { await w.unlock("wrong-" + i); } catch (e) { badPw = /bad password/i.test(String(e.message)); }
    ok(`bad attempt ${i + 1}/5 rejected as "bad password"`, badPw);
  }
  let lockedOut = false;
  try { await w.unlock(PW); } catch (e) { lockedOut = /too many failed attempts/i.test(String(e.message)); }
  ok("after 5 failures, the next attempt is LOCKED OUT even with the correct password", lockedOut);
}

// (2) no session store (tests / non-extension) → guard inert, correct password always works
{
  const w = new Wallet(memoryStore()); // no session ⇒ guard inert
  await w.create(PW);
  await w.lock();
  for (let i = 0; i < 8; i++) { try { await w.unlock("nope"); } catch { /* expected bad password */ } }
  let stillWorks = false;
  try { stillWorks = (await w.unlock(PW)).addr != null; } catch { /* */ }
  ok("no-session wallet is NEVER gated — 8 failures then correct password still unlocks", stillWorks);
}

console.log(failed ? `\nBRUTE-UNLOCK TEST: ${failed} FAILED` : "\nBRUTE-UNLOCK TEST: ALL PASS");
process.exit(failed ? 1 : 0);
