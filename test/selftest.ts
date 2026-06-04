// Cairn Wallet core self-tests — oracle-based (consensus golden vectors + a real
// on-chain signature), plus keystore/account adversarial cases. No mocks of our own.
import { serialize, txid, sighash, verifySig, hash160, signSighash, cairnPayloadHash, stableStringify, type Tx } from "../src/core/csdtx.js";
import { generate, fromPriv, newMnemonic, deriveAccount, isValidMnemonic, hdPath } from "../src/core/account.js";
import { seal, open } from "../src/core/keystore.js";
import { Wallet, explorerTx, explorerAddr } from "../src/core/wallet.js";
import { memoryStore } from "../src/core/storage.js";
import { send, selectInputs } from "../src/core/node.js";
import { secp256k1 } from "@noble/curves/secp256k1";
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

  // ─── 6) BRUTAL security ──────────────────────────────────────────────────
  // (a) keystore tamper-resistance: any change to the vault → decrypt fails
  const PW = "s3cret-pass-phrase";
  const v = await seal(a.privkey, PW);
  const flip = (hex: string) => hex.slice(0, -2) + (hex.slice(-2) === "00" ? "01" : "00");
  let ctTamper = false; try { await open({ ...v, ct: flip(v.ct) }, PW); } catch { ctTamper = true; }
  check("keystore: tampered ciphertext rejected (GCM auth)", ctTamper);
  let ivTamper = false; try { await open({ ...v, iv: flip(v.iv) }, PW); } catch { ivTamper = true; }
  check("keystore: tampered IV rejected", ivTamper);
  let saltTamper = false; try { await open({ ...v, salt: flip(v.salt) }, PW); } catch { saltTamper = true; }
  check("keystore: tampered salt rejected (wrong key derived)", saltTamper);
  const v2 = await seal(a.privkey, PW);
  check("keystore: same key+pw → different vault (random salt/iv), both open", v2.ct !== v.ct && (await open(v2, PW)) === a.privkey);
  let emptyPw = false; try { await seal(a.privkey, ""); } catch { emptyPw = true; }
  check("keystore: empty password refused", emptyPw);

  // (b) key generation/import: bulk validity + uniqueness + strict import
  const keys = new Set<string>(); let allValid = true;
  for (let i = 0; i < 200; i++) { const k = generate(); keys.add(k.privkey); if (!/^0x[0-9a-f]{64}$/.test(k.privkey) || fromPriv(k.privkey).addr !== k.addr) allValid = false; }
  check("keygen: 200 keys all valid + addr-consistent", allValid);
  check("keygen: 200 keys all unique", keys.size === 200);
  const rej = (k: string) => { try { fromPriv(k); return false; } catch { return true; } };
  check("import rejects zero / order / short / nonhex / empty", rej("0x" + "00".repeat(32)) && rej("0x" + "ff".repeat(32)) && rej("0xabc") && rej("0x" + "zz".repeat(32)) && rej(""));

  // (c) TAMPER-EVIDENCE: the signature commits to the WHOLE tx, so a malicious RPC
  // / MITM that alters the recipient or amount makes the signature invalid → the
  // node rejects it. This is why routing submits through a proxy is safe.
  const TPRIV = "0x" + "11".repeat(32);
  const tx: Tx = { version: 1, locktime: 0, app: { type: "None" }, inputs: [{ prevTxid: "0x" + "ab".repeat(32), vout: 0, scriptSig: "0x" }], outputs: [{ value: 100, scriptPubkey: "0x" + "cc".repeat(20) }] };
  const sh = sighash(tx);
  const sgx = signSighash(sh, TPRIV);
  check("sig verifies for the intended tx", verifySig(sgx.sig64, sgx.pub33, sh));
  const tamperTo: Tx = { ...tx, outputs: [{ value: 100, scriptPubkey: "0x" + "dd".repeat(20) }] };       // attacker swaps recipient
  const tamperAmt: Tx = { ...tx, outputs: [{ value: 9_999_999, scriptPubkey: "0x" + "cc".repeat(20) }] }; // attacker inflates amount
  check("tamper: changing recipient changes sighash", sighash(tamperTo) !== sh);
  check("tamper: original sig is INVALID for altered recipient", !verifySig(sgx.sig64, sgx.pub33, sighash(tamperTo)));
  check("tamper: original sig is INVALID for altered amount", !verifySig(sgx.sig64, sgx.pub33, sighash(tamperAmt)));

  // (d) signatures: deterministic (RFC6979) + always LOW-S canonical
  check("sig deterministic (same key+msg → same sig)", signSighash(sh, TPRIV).sig64 === sgx.sig64);
  let lowSAll = true;
  for (let i = 0; i < 40; i++) { const d = "0x" + ((i + 1).toString(16).padStart(2, "0")).repeat(32); const s = signSighash(d, TPRIV); if (secp256k1.Signature.fromCompact(s.sig64.slice(2)).hasHighS()) lowSAll = false; }
  check("sig always LOW-S (no malleability)", lowSAll);

  // (e) send input validation (no network needed for these paths)
  check("send rejects non-address recipient", !(await send("x", { to: "0xnotanaddress", amount: 1e7, fee: 1e6 }, TPRIV)).ok);
  check("send rejects zero amount", !(await send("x", { to: "0x" + "cc".repeat(20), amount: 0, fee: 1e6 }, TPRIV)).ok);

  // (f) DURABLE content registration — the bug that showed posts as hash-only
  // placeholders. flushPending must: register+drop when mined, KEEP when not yet
  // mined (so a later alarm retries), DROP on 24h expiry, and DROP (not loop
  // forever) when mined-but-content-rejected. Drives the real node layer via a
  // stubbed fetch (URL-routed) — no internal mocks.
  const origFetch = (globalThis as any).fetch;
  const fakeFetch = (mined: boolean, contentOk = true) => async (url: any) => {
    const u = String(url);
    if (u.includes("/proposal/")) return { ok: true, status: 200, json: async () => (mined ? { payload_hash: "0x" + "11".repeat(32) } : {}) };
    if (u.includes("/api/content")) return { ok: true, status: 200, json: async () => ({ ok: contentOk }) };
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const mkWallet = async (item: any) => { const s = memoryStore(); const w = new Wallet(s); w.rpc = "http://t/rpc"; w.api = "http://t"; await s.set("pendingContent", [item]); return { w, s }; };
  const C = { v: 1, domain: "csd:apps", title: "t", body: "b", links: [] };
  const now = Date.now();
  try {
    (globalThis as any).fetch = fakeFetch(true, true);
    let { w, s } = await mkWallet({ content: C, txid: "0xaa", ts: now });
    await w.flushPending();
    check("flushPending: registers + drops a MINED item", ((await s.get("pendingContent")) || []).length === 0);

    (globalThis as any).fetch = fakeFetch(false);
    ({ w, s } = await mkWallet({ content: C, txid: "0xbb", ts: now }));
    await w.flushPending();
    check("flushPending: KEEPS a not-yet-mined item for later retry", ((await s.get("pendingContent")) || []).length === 1);

    (globalThis as any).fetch = fakeFetch(false);
    ({ w, s } = await mkWallet({ content: C, txid: "0xcc", ts: now - 90_000_000 }));
    await w.flushPending();
    check("flushPending: expires items older than 24h", ((await s.get("pendingContent")) || []).length === 0);

    (globalThis as any).fetch = fakeFetch(true, false); // mined but server rejects (hash mismatch)
    ({ w, s } = await mkWallet({ content: C, txid: "0xdd", ts: now }));
    await w.flushPending();
    check("flushPending: drops mined-but-rejected (no infinite retry)", ((await s.get("pendingContent")) || []).length === 0);

    ({ w, s } = await mkWallet({ content: C, txid: "0xee", ts: now }));
    check("hasPending true with queued item", (await w.hasPending()) === true);
    await s.set("pendingContent", []);
    check("hasPending false when queue empty", (await w.hasPending()) === false);
  } finally { (globalThis as any).fetch = origFetch; }

  // (g) explorer deep-links — must match the real explorer routes (verified live:
  // tx.html?txid= · address.html?addr=). These are what the wallet history links to.
  check("explorerTx → /tx.html?txid=", explorerTx("0xdeadbeef") === "https://explorer.computesubstrate.org/tx.html?txid=0xdeadbeef");
  check("explorerAddr → /address.html?addr=", explorerAddr("0x" + "ab".repeat(20)) === "https://explorer.computesubstrate.org/address.html?addr=0x" + "ab".repeat(20));

  // (h) transaction history — records on success, newest-first, idempotent, not on
  // failure. Drives the real send() path with a URL-routed stubbed fetch.
  const of2 = (globalThis as any).fetch;
  const COIN = { txid: "0x" + "cd".repeat(32), vout: 0, value: 100e8, confirmations: 10 };
  const txStub = (submitOk: boolean, fixedTxid?: string) => { let n = 0; return async (url: any) => {
    const u = String(url);
    if (u.includes("/utxos/")) return { ok: true, status: 200, json: async () => ({ confirmed_balance: 100e8, utxos: [COIN] }) };
    if (u.includes("/tx/submit")) { n++; return { ok: true, status: 200, json: async () => (submitOk ? { ok: true, txid: fixedTxid ?? ("0x" + String(n).padStart(64, "0")) } : { ok: false, err: "rejected" }) }; }
    return { ok: false, status: 404, json: async () => ({}) };
  }; };
  const RCPT = "0x" + "11".repeat(20);
  try {
    let w = new Wallet(memoryStore()); await w.create("super-secret-pw");
    (globalThis as any).fetch = txStub(true);
    await w.send(RCPT, 2e8, 1e6);
    await w.send(RCPT, 5e8, 1e6);
    let h = await w.history();
    check("history records 2 sends", h.length === 2);
    check("history newest-first (last send on top)", h[0].amount === 5e8 && h[1].amount === 2e8);
    check("history entry has type/to/txid", h[0].type === "send" && h[0].to === RCPT && /^0x/.test(h[0].txid));

    w = new Wallet(memoryStore()); await w.create("super-secret-pw");
    (globalThis as any).fetch = txStub(true, "0x" + "ff".repeat(32)); // same txid twice
    await w.send(RCPT, 1e8, 1e6); await w.send(RCPT, 1e8, 1e6);
    check("history idempotent on duplicate txid", (await w.history()).length === 1);

    w = new Wallet(memoryStore()); await w.create("super-secret-pw");
    (globalThis as any).fetch = txStub(false); // node rejects submit
    const fr = await w.send(RCPT, 1e8, 1e6);
    check("failed tx is NOT recorded", fr.ok === false && (await w.history()).length === 0);
  } finally { (globalThis as any).fetch = of2; }

  // (h1) multi-input coin selection — aggregate several coins, prefer non-coinbase,
  // largest-first (fewest inputs), and refuse when the whole balance is short.
  {
    let _v1 = 0; // distinct outpoints (real UTXOs differ; selectInputs now dedups by txid:vout)
    const u = (value: number, extra: any = {}) => ({ txid: "0x" + "ab".repeat(32), vout: _v1++, value, confirmations: 5, ...extra });
    const sel = selectInputs([u(3e8), u(5e8), u(1e8)], 7e8);
    check("selection aggregates multiple coins to cover need", !!sel && sel.total >= 7e8 && sel.inputs.length >= 2);
    check("selection is largest-first (fewest inputs: 5+3 covers 7)", !!sel && sel.inputs.length === 2 && sel.total === 8e8);
    check("selection returns null when balance is short", selectInputs([u(1e8), u(1e8)], 5e8) === null);
    check("selection skips unconfirmed coins", selectInputs([u(10e8, { confirmations: 0 })], 1e8) === null);
    const cb = selectInputs([u(2e8, { coinbase: true }), u(2e8)], 3e8);
    check("selection prefers non-coinbase but falls back to coinbase when needed", !!cb && cb.total >= 3e8 && cb.inputs.length === 2);
    // hardening: a hostile RPC can't pad the input set with duplicate outpoints…
    const dup = { txid: "0x" + "ee".repeat(32), vout: 0, value: 1e8, confirmations: 5 };
    check("selection DEDUPES duplicate outpoints (3 dupes = 1 coin)", selectInputs([dup, { ...dup }, { ...dup }], 2e8) === null);
    // …and a missing `confirmations` is treated as UNCONFIRMED (not spendable), not as 1
    check("selection treats MISSING confirmations as unconfirmed", selectInputs([{ txid: "0x" + "ff".repeat(32), vout: 0, value: 10e8 }], 1e8) === null);
  }

  // (h1b) BIP-39/BIP-32 HD wallet — deterministic derivation, restore round-trip,
  // recoverable extra accounts, and password-gated phrase export.
  {
    // a known BIP-39 test vector → fixed seed → our path must derive deterministically
    const VEC = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
    check("recognises a valid mnemonic", isValidMnemonic(VEC));
    check("rejects an invalid mnemonic", !isValidMnemonic("not a real recovery phrase at all here ok"));
    check("hd path is BIP-44 under CSD coin type", hdPath(0) === "m/44'/7779'/0'/0/0");
    const a0 = deriveAccount(VEC, 0), a0b = deriveAccount(VEC, 0), a1 = deriveAccount(VEC, 1);
    check("derivation is deterministic (same phrase+index → same addr)", a0.addr === a0b.addr);
    check("different indices → different addresses", a0.addr !== a1.addr);
    check("derived key is a valid CSD account (0x + 40 hex addr)", /^0x[0-9a-f]{40}$/.test(a0.addr));

    // create() mints a 12-word phrase; restore() reproduces the exact same account 0
    let w = new Wallet(memoryStore());
    const created = await w.create("pw-correct-horse");
    check("create returns a 12-word recovery phrase", created.mnemonic.split(" ").length === 12 && isValidMnemonic(created.mnemonic));
    check("status reports the wallet has a recovery phrase", (await w.status()).hasMnemonic === true);
    const r = await w.addAccount();                       // HD index 1
    const acctAddrs = (await w.status()).accounts.map((a: any) => a.addr);
    let w2 = new Wallet(memoryStore());
    const restored = await w2.restore(created.mnemonic, "different-pw");
    check("restore reproduces account 0 from the phrase", restored.addr === created.addr);
    await w2.addAccount();                                  // re-derive index 1
    const restoredAddrs = (await w2.status()).accounts.map((a: any) => a.addr);
    check("added accounts are recoverable from the phrase alone", restoredAddrs[1] === acctAddrs[1] && restoredAddrs[1] === r.addr);
    check("exportMnemonic round-trips the phrase (password-gated)", (await w.exportMnemonic("pw-correct-horse")) === created.mnemonic);
    let threw = false; try { await w.exportMnemonic("wrong"); } catch { threw = true; }
    check("exportMnemonic rejects a wrong password", threw);

    // an imported single key has NO recovery phrase
    let wi = new Wallet(memoryStore());
    await wi.importKey("0x" + "11".repeat(32), "pw");
    check("imported-key wallet reports no recovery phrase", (await wi.status()).hasMnemonic === false);
    let threw2 = false; try { await wi.exportMnemonic("pw"); } catch { threw2 = true; }
    check("imported-key wallet refuses exportMnemonic", threw2);
  }

  // (h1c) ADVERSARIAL: secrets never land in the cleartext "wallets" mirror, and the
  // overflow/garbage guards in selectInputs hold (a hostile RPC can't slip a value).
  {
    const store = memoryStore();
    const w = new Wallet(store);
    const { mnemonic } = await w.create("pw-secret-x");
    const priv = await w.exportKey("pw-secret-x");
    const mirror = JSON.stringify(await store.get("wallets"));
    const vault = JSON.stringify(await store.get("vault"));
    check("cleartext 'wallets' mirror contains NO mnemonic", !mirror.includes(mnemonic.split(" ")[0]) || !mirror.includes(mnemonic));
    check("cleartext 'wallets' mirror contains NO private key", !mirror.includes(priv.replace(/^0x/, "")));
    check("vault is sealed (no plaintext mnemonic/priv in stored vault)", !vault.includes(mnemonic) && !vault.includes(priv.replace(/^0x/, "")));

    let _v2 = 0;
    const u = (value: any, extra: any = {}) => ({ txid: "0x" + "cd".repeat(32), vout: _v2++, value, confirmations: 5, ...extra });
    check("selectInputs rejects an unsafe-magnitude UTXO value (no precision slip)", selectInputs([u(2 ** 60)], 1e8) === null);
    check("selectInputs rejects a sum that overflows the safe-integer range", selectInputs([u(2 ** 52), u(2 ** 52)], 2 ** 53) === null);
    check("selectInputs rejects a non-numeric UTXO value", selectInputs([u("not-a-number")], 1e8) === null);
    check("selectInputs ignores a NaN-valued coin", selectInputs([u(NaN)], 1e8) === null);
  }

  // (h2) sealed claims (commit-reveal): salted hash committed now, preimage revealed later.
  const of3 = (globalThis as any).fetch;
  const sealStub = () => { let n = 0; return async (url: any) => {
    const u = String(url);
    if (u.includes("/tip")) return { ok: true, status: 200, json: async () => ({ height: 21000 }) };
    if (u.includes("/utxos/")) return { ok: true, status: 200, json: async () => ({ confirmed_balance: 100e8, utxos: [COIN] }) };
    if (u.includes("/tx/submit")) { n++; return { ok: true, status: 200, json: async () => ({ ok: true, txid: "0x" + String(n).padStart(64, "0") }) }; }
    if (u.includes("/api/content")) return { ok: true, status: 200, json: async () => ({ ok: true, revealed: true }) };
    return { ok: false, status: 404, json: async () => ({}) };
  }; };
  try {
    const w = new Wallet(memoryStore()); await w.create("super-secret-pw");
    (globalThis as any).fetch = sealStub();
    const r1 = await w.sealClaim({ claim: "ETH > $4000 by Friday" });
    const r2 = await w.sealClaim({ claim: "ETH > $4000 by Friday" }); // identical claim text
    check("sealClaim returns ok + txid", r1.ok === true && /^0x/.test(String(r1.txid)) && r2.ok === true);
    const sc = await w.sealedClaims();
    check("sealedClaims persists both", sc.length === 2);
    check("sealed nonce is 32-byte hex (the salt)", /^[0-9a-f]{64}$/.test(sc[0].nonce));
    check("same claim → different nonce (unguessable before reveal)", sc[0].nonce !== sc[1].nonce);
    check("sealClaim defaults to the csd:sealed domain", sc[0].domain === "csd:sealed");
    const rv = await w.revealClaim(String(r1.txid));
    check("revealClaim succeeds", rv.ok === true);
    check("revealClaim marks the claim revealed", (await w.sealedClaims()).find((s: any) => s.txid === r1.txid)!.revealed === true);
    check("revealClaim rejects an unknown txid", !(await w.revealClaim("0xnope")).ok);

    // (h3) reset() must wipe ALL state, not just the key — otherwise a new wallet on
    // the same profile would surface the prior owner's history + sealed-claim preimages.
    const rs = memoryStore();
    const rw = new Wallet(rs); const ra = (await rw.create("super-secret-pw")).addr;
    (globalThis as any).fetch = sealStub();
    await rw.send(RCPT, 1e8); await rw.sealClaim({ claim: "secret pre-reveal claim" });
    check("pre-reset: state stored under the account's namespace",
      (await rs.get("txHistory:" + ra)) != null && (await rs.get("sealedClaims:" + ra)) != null);
    await rw.reset();
    check("reset deletes the account's history key", (await rs.get("txHistory:" + ra)) == null);
    check("reset deletes the account's sealed-claim preimages", (await rs.get("sealedClaims:" + ra)) == null);
    check("reset wipes vault (no wallet remains)", (await rw.status()).hasVault === false);

    // (h4) importKey must not silently overwrite an existing vault (mirrors create()).
    const ig = new Wallet(memoryStore()); await ig.create("super-secret-pw");
    let imported = false; try { await ig.importKey("0x" + "11".repeat(32), "pw"); imported = true; } catch { /* expected */ }
    check("importKey refuses to overwrite an existing wallet", imported === false);
  } finally { (globalThis as any).fetch = of3; }

  // (i) idle auto-lock — wipes the in-memory key after inactivity; stays unlocked while active.
  const wl = new Wallet(memoryStore()); await wl.create("super-secret-pw");
  wl.autoLock(60_000); check("auto-lock keeps wallet unlocked while active", (await wl.status()).unlocked === true);
  wl.autoLock(-1);     check("auto-lock wipes the key once idle past threshold", (await wl.status()).unlocked === false);

  // (j) keystore now uses 600k PBKDF2 iters (OWASP 2023), recorded per-vault for back-compat
  const kv = await seal(a.privkey, "super-secret-pw");
  check("vault records 600k PBKDF2 iterations", kv.iter === 600_000);

  console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
main();
