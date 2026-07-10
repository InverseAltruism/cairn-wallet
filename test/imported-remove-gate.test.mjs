// A2 (Plans/68 F4): imported-key removal is password-gated; HD removal stays one-click.
//
// An IMPORTED raw key is not derivable from the recovery phrase, so removing it without a backup is
// PERMANENT fund loss — and pre-0.2.57 it was a single inline click. removeAccount now requires the
// wallet password for imported accounts only, through the same brute-guarded openVaultDoc gate as
// export (wrong attempts increment the auth guard; the decrypted doc is discarded). The sentinel
// REMOVE_IMPORTED_REAUTH is popup-handled (FEE_CHANGED precedent), never a dApp code: removeAccount
// stays absent from DAPP_METHODS.
//
// MUTATION CONTRACT: the no-password and wrong-password refusal cases FAIL on 0.2.56 (the account is
// simply removed). Session store wired so the auth guard is LIVE (bruteforce.test.mjs posture).
import { Wallet } from "../src/core/wallet.js";
import { memoryStore } from "../src/core/storage.js";
import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
const check = (n, c) => { c ? pass++ : (fail++, console.error("  ✗ " + n)); if (c) console.log("  ✓ " + n); };
const PW = "super-secret-pw";
// a valid secp256k1 raw key (any 32-byte scalar in range)
const RAW = "0x" + "7b".repeat(32);

const store = memoryStore(), session = memoryStore();
const w = new Wallet(store, session);
await w.create(PW);
const { addr: hd } = await w.addAccount("hd-two");
const { addr: imp } = await w.importAccount(RAW, "cold-import");

console.log("A2 — imported-key removal gate:");
{
  // HD accounts stay frictionless (re-derivable from the phrase): no password required.
  await w.removeAccount(hd);
  const st = await w.status();
  check("HD remove without a password succeeds (no UX regression)", !st.accounts.some((a) => a.addr.toLowerCase() === hd.toLowerCase()));

  // imported + no password → the popup sentinel, account SURVIVES
  let sentinel = "";
  try { await w.removeAccount(imp); } catch (e) { sentinel = String(e?.message || e); }
  const st2 = await w.status();
  check("imported remove without a password throws REMOVE_IMPORTED_REAUTH", sentinel === "REMOVE_IMPORTED_REAUTH");
  check("…and the imported account survives", st2.accounts.some((a) => a.addr.toLowerCase() === imp.toLowerCase()));

  // wrong password → 'bad password' via the brute-guarded gate, guard increments, account SURVIVES
  let wrong = "";
  try { await w.removeAccount(imp, "not-the-password"); } catch (e) { wrong = String(e?.message || e); }
  const guard = await session.get("authGuard");
  const st3 = await w.status();
  check("wrong password throws 'bad password' (no oracle beyond the unlock path's own)", /bad password/i.test(wrong));
  check("…the auth guard incremented (brute-force protection is live on this path)", Number(guard?.failed) >= 1);
  check("…and the imported account survives", st3.accounts.some((a) => a.addr.toLowerCase() === imp.toLowerCase()));

  // correct password → removed, per-account data wiped
  await store.set("txHistory:" + imp, [{ txid: "0x" + "11".repeat(32), ts: 1 }]);
  await store.set("sealedClaims:" + imp, [{ salt: "s" }]);
  await w.removeAccount(imp, PW);
  const st4 = await w.status();
  check("correct password removes the imported account", !st4.accounts.some((a) => a.addr.toLowerCase() === imp.toLowerCase()));
  check("…and wipes its history + sealed-claim keys", (await store.get("txHistory:" + imp)) == null && (await store.get("sealedClaims:" + imp)) == null);
}

console.log("A2 — removeAccount stays off the dApp surface:");
{
  const src = readFileSync(new URL("../src/background.ts", import.meta.url), "utf8");
  const dappList = src.match(/const DAPP_METHODS = new Set\(\[([^\]]*)\]\)/)?.[1] ?? "";
  check("DAPP_METHODS does not contain removeAccount", !/removeAccount/.test(dappList));
}

console.log(`\nimported-remove-gate: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
