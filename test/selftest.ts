// Cairn Wallet core self-tests — oracle-based (consensus golden vectors + a real
// on-chain signature), plus keystore/account adversarial cases. No mocks of our own.
import { serialize, txid, sighash, verifySig, hash160, signSighash, cairnPayloadHash, stableStringify, type Tx } from "../src/core/csdtx.js";
import { generate, fromPriv } from "../src/core/account.js";
import { seal, open } from "../src/core/keystore.js";
import { Wallet } from "../src/core/wallet.js";
import { memoryStore } from "../src/core/storage.js";
import { bytesToHex } from "@noble/hashes/utils";

declare const process: { exit(code: number): void };
let pass = 0, fail = 0;
const check = (n: string, c: boolean) => { c ? (pass++, console.log("  ✅ " + n)) : (fail++, console.log("  ❌ " + n)); };

// 1) consensus golden vectors (Rust tests/golden_vectors.rs) — external oracle
const makeTx: Tx = {
  version: 1, locktime: 0x3939, app: { type: "None" },
  inputs: [{ prevTxid: "0x" + "00".repeat(32), vout: 3, scriptSig: "0x0102030405" }],
  outputs: [{ value: 42, scriptPubkey: "0x" + "09".repeat(20) }, { value: 1000, scriptPubkey: "0x" + "08".repeat(20) }],
};
check("codec bytes == golden", "0x" + bytesToHex(serialize(makeTx)) === "0x0100000001000000000000000000000000000000000000000000000000000000000000000000000000000000030000000500000000000000010203040502000000000000002a000000000000000909090909090909090909090909090909090909e80300000000000008080808080808080808080808080808080808083939000000000000");
check("codec txid == golden", txid(makeTx) === "0x876f5cbd6770ce8679730b8ad565ba136fa30bd750ef4f3345b8f7289393dd6b");
check("codec sighash == golden", sighash(makeTx) === "0x4a852522eed155b7763f425df1233daa132482e47249696905cdcc775a5113e2");

// 2) real on-chain attestation (block 21043): its signature verifies vs recomputed sighash
const ss = "0x4016e7795e7626209cbe8ba924beffec0480cc50335e946fbd532be8dfc2d4d27f3bc6bf031c82f92f3ee424fcb0d11dcc4b387efee81855fc3284685511a41297210225bde0772dec16dfb50d04b832d9ddfe7f0cc11d88d8a074167c4ad8e1a14024";
const onchain: Tx = {
  version: 1, locktime: 0,
  inputs: [{ prevTxid: "0x436e0101f16fd3469c5916c8d6985fac3e0fd21649bb64baa88b6400acfdebe3", vout: 0, scriptSig: ss }],
  outputs: [{ value: 25000000, scriptPubkey: "0x6eda635deaa2f710213942cc97c19b7e008fc694" }],
  app: { type: "Attest", proposalId: "0xd46770cdef6fc5d0c7b0680ed58d1af04be939f3739b9d34c174e5071341048b", score: 100, confidence: 90 },
};
const oSig = "0x" + ss.slice(4, 132), oPub = "0x" + ss.slice(134);
check("real on-chain sig verifies vs recomputed sighash", verifySig(oSig, oPub, sighash(onchain)));
check("hash160(on-chain pub) == signer addr", hash160(Uint8Array.from(oPub.slice(2).match(/../g)!.map((x) => parseInt(x, 16)))) === "0x6eda635deaa2f710213942cc97c19b7e008fc694");

// 2b) Cairn content hash (must match the board/server item.ts: sorted keys, single sha256)
check("stableStringify sorts keys (order-independent)", stableStringify({ b: 1, a: 2 }) === stableStringify({ a: 2, b: 1 }));
const cc = { v: 1, domain: "csd:apps", title: "t", body: "b", links: [] };
check("cairnPayloadHash is 0x+64hex and stable", /^0x[0-9a-f]{64}$/.test(cairnPayloadHash(cc)) && cairnPayloadHash(cc) === cairnPayloadHash({ links: [], body: "b", title: "t", domain: "csd:apps", v: 1 }));

// 3) account keygen/import
const a = generate();
check("generate yields a valid account (priv/pub/addr)", /^0x[0-9a-f]{64}$/.test(a.privkey) && /^0x[0-9a-f]{66}$/.test(a.pubkey) && /^0x[0-9a-f]{40}$/.test(a.addr));
check("import roundtrips to same addr", fromPriv(a.privkey).addr === a.addr);
let badRej = false; try { fromPriv("0x" + "00".repeat(32)); } catch { badRej = true; }
check("import rejects out-of-range key (all zero)", badRej);
let shortRej = false; try { fromPriv("0xdead"); } catch { shortRej = true; }
check("import rejects malformed key", shortRej);

async function main() {
  // 4) keystore: seal → open roundtrip; wrong password fails (GCM auth)
  const vault = await seal(a.privkey, "correct horse battery staple");
  const opened = await open(vault, "correct horse battery staple");
  check("keystore seal→open roundtrip recovers the key", opened === a.privkey);
  check("keystore vault stores no plaintext key", !JSON.stringify(vault).includes(a.privkey.slice(2)));
  let wrongPw = false; try { await open(vault, "wrong password"); } catch { wrongPw = true; }
  check("keystore wrong password is rejected (no plaintext leak)", wrongPw);

  // signing roundtrip
  const PRIV = "0x" + "11".repeat(32);
  const dg = "0x" + "ab".repeat(32);
  const sg = signSighash(dg, PRIV);
  check("sign→verify roundtrip", verifySig(sg.sig64, sg.pub33, dg));
  check("verify rejects tampered sig", !verifySig("0x00" + sg.sig64.slice(4), sg.pub33, dg));

  // 5) Wallet brain (memory store) — lifecycle + locked-op guards
  const w = new Wallet(memoryStore());
  const c1 = await w.create("pw1");
  check("wallet create → addr + unlocked", /^0x[0-9a-f]{40}$/.test(c1.addr) && (await w.status()).unlocked);
  w.lock();
  check("lock → locked but vault persists", !(await w.status()).unlocked && (await w.status()).hasVault);
  let lockedThrew = false; try { await w.balance(); } catch { lockedThrew = true; }
  check("operations throw when locked", lockedThrew);
  check("unlock restores same addr", (await w.unlock("pw1")).addr === c1.addr);
  let badUnlock = false; try { await w.unlock("wrong"); } catch { badUnlock = true; }
  check("unlock rejects wrong password", badUnlock);
  const exported = await w.exportKey("pw1");
  check("exportKey returns privkey for matching addr", /^0x[0-9a-f]{64}$/.test(exported) && fromPriv(exported).addr === c1.addr);
  const w2 = new Wallet(memoryStore());
  check("import sets the matching addr", (await w2.importKey(exported, "pw2")).addr === c1.addr);
  let dupThrew = false; try { await w.create("x"); } catch { dupThrew = true; }
  check("create refuses to overwrite an existing wallet", dupThrew);

  console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
main();
