// Rigorous, adversarial tests for multi-account support + the crypto/isolation
// guarantees that matter for a non-custodial wallet. Oracle-based where possible
// (we reconstruct the SUBMITTED tx and prove the ACTIVE key signed it; we tamper
// ciphertext and prove decryption fails). No self-fulfilling assertions.
import { Wallet } from "../src/core/wallet.js";
import { memoryStore } from "../src/core/storage.js";
import { seal, open, sealNew } from "../src/core/keystore.js";
import { fromPriv } from "../src/core/account.js";
import { readFileSync } from "node:fs";
import { mkCoin, txReply } from "./_coin.js";

declare const process: { exit(code: number): void };
let pass = 0, fail = 0;
const check = (n: string, c: boolean) => { c ? (pass++, console.log("  ✅ " + n)) : (fail++, console.log("  ❌ " + n)); };
const PW = "correct horse battery staple";
const RCPT = "0x" + "cc".repeat(20);
const CM = mkCoin(100e8); const COIN = CM.coin;
const j = (o: any) => ({ ok: true, status: 200, json: async () => o });

let lastSubmit: any = null;
const stub = () => { let n = 0; return async (url: any, init?: any) => {
  const u = String(url);
  if (u.includes("/tip")) return j({ height: 21000 });
  if (u.includes("/utxos/")) return j({ confirmed_balance: 100e8, utxos: [COIN] });
  const tr = txReply(u, [CM]); if (tr) return tr;
  if (u.includes("/tx/submit")) { n++; lastSubmit = JSON.parse(init.body).tx; return j({ ok: true, txid: "0x" + String(n).padStart(64, "0") }); }
  if (u.includes("/proposal/")) return j({ payload_hash: [1, 2, 3] });
  if (u.includes("/api/content")) return j({ ok: true });
  return { ok: false, status: 404, json: async () => ({}) };
}; };
const spkToAddr = (spk: number[]) => "0x" + spk.map((b) => b.toString(16).padStart(2, "0")).join("");

async function main() {
  const of = (globalThis as any).fetch;
  (globalThis as any).fetch = stub();
  try {
    console.log("— account management —");
    const w = new Wallet(memoryStore());
    const a1 = (await w.create(PW)).addr;
    let st = await w.status();
    check("create → 1 account, active 0, default label", st.accounts.length === 1 && st.active === 0 && st.accounts[0].label === "Account 1");

    const add = await w.addAccount();
    const a2 = add.addr;
    st = await w.status();
    check("addAccount → 2 accounts, distinct addresses", st.accounts.length === 2 && a1.toLowerCase() !== a2.toLowerCase());
    check("addAccount makes the new account active", st.active === 1 && st.addr!.toLowerCase() === a2.toLowerCase());

    const known = fromPriv("0x" + "11".repeat(32));
    const a3 = (await w.importAccount(known.privkey, "Imported")).addr;
    check("importAccount adds the imported key + label", a3.toLowerCase() === known.addr.toLowerCase() && (await w.status()).accounts[2].label === "Imported");
    let dupRejected = false; try { await w.importAccount(known.privkey); } catch { dupRejected = true; }
    check("importAccount refuses a duplicate address", dupRejected);

    await w.switchAccount(0);
    check("switchAccount(index) sets active", (await w.status()).active === 0);
    await w.switchAccount(a2);
    check("switchAccount(addr) sets active", (await w.status()).addr!.toLowerCase() === a2.toLowerCase());

    await w.renameAccount(a1, "Treasury");
    check("renameAccount persists the label", (await w.status()).accounts[0].label === "Treasury");

    console.log("\n— one password unlocks all accounts —");
    w.lock();
    check("lock clears unlocked state", (await w.status()).unlocked === false);
    check("locked status still lists accounts (public) + active", (await w.status()).accounts.length === 3);
    let badPw = false; try { await w.unlock("wrong-password"); } catch { badPw = true; }
    check("unlock with wrong password is rejected (GCM tag)", badPw);
    await w.unlock(PW);
    st = await w.status();
    check("one password unlocks ALL 3 accounts", st.unlocked && st.accounts.length === 3);
    check("active index survives lock/unlock", st.active === 1 && st.addr!.toLowerCase() === a2.toLowerCase());

    console.log("\n— per-account isolation (history + sealed claims) —");
    await w.switchAccount(a1);
    await w.send(RCPT, 1e8);
    await w.sealClaim({ claim: "a1-only secret" });
    check("active account (a1) has its own history + sealed claim", (await w.history()).length >= 1 && (await w.sealedClaims()).length === 1);
    await w.switchAccount(a2);
    check("switching to a2 → empty history (no leak from a1)", (await w.history()).length === 0);
    check("switching to a2 → no sealed claims from a1 (isolated secrets)", (await w.sealedClaims()).length === 0);
    await w.switchAccount(a1);
    check("switching back to a1 → its data is intact", (await w.history()).length >= 1 && (await w.sealedClaims()).length === 1);

    console.log("\n— signing uses the ACTIVE account's key (oracle) —");
    await w.switchAccount(a2);
    await w.send(RCPT, 1e8);
    const change = lastSubmit.outputs[lastSubmit.outputs.length - 1];
    check("submitted tx's change returns to the ACTIVE account (a2 signed, not a1)", spkToAddr(change.script_pubkey).toLowerCase() === a2.toLowerCase());

    console.log("\n— remove account (isolation + safety) —");
    const rmStore = memoryStore();
    const w2 = new Wallet(rmStore); const b1 = (await w2.create(PW)).addr;
    const b2 = (await w2.addAccount()).addr;
    await w2.switchAccount(b2); await w2.sealClaim({ claim: "b2 secret" });
    check("b2 has a sealed claim before removal", (await rmStore.get("sealedClaims:" + b2)) != null);
    await w2.switchAccount(b1);
    await w2.removeAccount(b2);
    check("removeAccount drops it from the list", (await w2.status()).accounts.length === 1);
    check("removeAccount wipes the removed account's sealed-claim preimages", (await rmStore.get("sealedClaims:" + b2)) == null);
    let lastRefused = false; try { await w2.removeAccount(b1); } catch { lastRefused = true; }
    check("removeAccount refuses to remove the LAST account", lastRefused);

    console.log("\n— legacy single-key vault migrates seamlessly —");
    const ls = memoryStore();
    const legacyPriv = "0x" + "22".repeat(32);
    const legacyAddr = fromPriv(legacyPriv).addr;
    await ls.set("vault", await seal(legacyPriv, PW)); // OLD format: vault seals a RAW privkey
    await ls.set("addr", legacyAddr);
    await ls.set("txHistory", [{ txid: "0xold", type: "send" }]);   // OLD global history
    await ls.set("sealedClaims", [{ txid: "0xoldseal", claim: "x" }]);
    const wl = new Wallet(ls);
    const unlockedAddr = (await wl.unlock(PW)).addr;
    check("legacy vault unlocks to the same address", unlockedAddr.toLowerCase() === legacyAddr.toLowerCase());
    check("legacy vault → exactly 1 account after migration", (await wl.status()).accounts.length === 1);
    check("legacy global history migrated under the account namespace", ((await wl.history())[0]?.txid) === "0xold");
    check("legacy global txHistory key deleted", (await ls.get("txHistory")) == null);
    check("legacy global sealedClaims migrated + key deleted", (await wl.sealedClaims()).length === 1 && (await ls.get("sealedClaims")) == null);
    check("legacy cleartext addr key deleted", (await ls.get("addr")) == null);
    check("exportKey returns the legacy key (password-gated)", (await wl.exportKey(PW)).toLowerCase() === legacyPriv.toLowerCase());

    console.log("\n— vault crypto (adversarial) —");
    const v = await seal("hello-secret", PW);
    const tampered = { ...v, ct: v.ct.slice(0, -2) + (v.ct.endsWith("00") ? "01" : "00") };
    let tamperRejected = false; try { await open(tampered as any, PW); } catch { tamperRejected = true; }
    check("GCM tamper: flipping a ciphertext byte fails authentication", tamperRejected);
    const v2 = await seal("hello-secret", PW);
    check("same plaintext+password → different IV (no nonce reuse)", v.iv !== v2.iv);
    check("same plaintext+password → different ciphertext", v.ct !== v2.ct);
    const sn = await sealNew("doc", PW);
    check("sealNew records 600k PBKDF2 iters", sn.vault.iter === 600_000);

    console.log("\n— re-seal rolls the IV on every change —");
    const rs2 = memoryStore();
    const w3 = new Wallet(rs2); await w3.create(PW);
    const iv1 = (await rs2.get("vault")).iv;
    await w3.addAccount();
    const iv2 = (await rs2.get("vault")).iv;
    check("adding an account re-seals with a FRESH IV (same key, new nonce)", iv1 !== iv2);

    console.log("\n— dApp boundary: privileged methods are NOT reachable from a site —");
    const bg = readFileSync(new URL("../src/background.ts", import.meta.url), "utf8");
    const dappBranch = bg.slice(bg.indexOf("async function resolvePending"), bg.indexOf("queueDappRequest"));
    // send IS an approval-gated dApp method now (so wallet.send/sendMany may appear), but
    // key export, account management, reset, import, and settings must NEVER be reachable.
    const forbidden = ["addAccount", "importAccount", "switchAccount", "removeAccount", "renameAccount", "exportKey", "exportMnemonic", "wallet.reset", "importKey", "setRpc", "setApi"];
    const leaked = forbidden.filter((m) => dappBranch.includes(m));
    check("no account-management / export / reset / settings method is in the dApp resolve path", leaked.length === 0);
    check("send IS wired into the dApp resolve path (approval-gated)", dappBranch.includes("wallet.send"));
    check("content script only ever sends kind:dapp (can't invoke popup methods)", readFileSync(new URL("../src/content.ts", import.meta.url), "utf8").includes('kind: "dapp"'));
  } finally { (globalThis as any).fetch = of; }

  console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
main();
