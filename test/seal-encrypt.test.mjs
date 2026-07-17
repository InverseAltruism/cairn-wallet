// L5 (Plan 70 R2): sealed-claim reveal PREIMAGES ({claim, nonce}) are encrypted at rest. sealClaim persists
// the record under sealKey(addr) in chrome.storage.local; the {claim, nonce} are the reveal preimage + salt
// (a force-revealable front-running lever). The vault key lives only in memory (chrome.storage.session), so
// sealClaim now AES-GCM-encrypts ONLY those two fields under it (fresh IV per seal) before storing, leaving
// txid/domain/committedTs/revealed/maybe plaintext. revealClaim decrypts with the unlocked key. A LEGACY
// plaintext record keeps working and re-encrypts on the next write (lazy migration).
//
// MUTATION CONTRACT — fails if any of these regress:
//   * sealClaim writes the claim/nonce in CLEARTEXT (the "no plaintext on disk" / "ciphertext ≠ claim" checks).
//   * revealClaim posts a WRONG preimage (the exact-claim + committed-hash checks).
//   * the lazy migration stops re-encrypting a legacy record on reveal (the legacy re-encrypt check).
//   * the popup preview stops decrypting (sealedClaims claim-preview check) — a UX regression.
// Run: tsx test/seal-encrypt.test.mjs
import { Wallet } from "../src/core/wallet.js";
import { memoryStore } from "../src/core/storage.js";
import { cairnPayloadHash } from "../src/core/csdtx.js";
import { checker } from "./_check.ts";
import { mkCoin, txReply } from "./_coin.js";

const { check, done } = checker("L5 sealed-claim preimage encryption at rest:");
const PW = "correct horse battery staple";

// ── mock the node/API so a seal (propose) + reveal (POST /api/content) succeed and we can inspect both ──
const MC = mkCoin(1_000_000_000, 0, { coinbase: false });
const MOCK_UTXO = MC.coin;
let lastSubmit = null, lastContent = null, submitN = 0;
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u.includes("/utxos/")) return { ok: true, json: async () => ({ ok: true, confirmed_balance: MOCK_UTXO.value, utxos: [MOCK_UTXO] }) };
  if (u.endsWith("/tip")) return { ok: true, json: async () => ({ ok: true, height: 34000 }) };
  const tr = txReply(u, [MC]); if (tr) return tr; // source-tx reads for TXB-1 input verification
  if (u.includes("/tx/submit")) { lastSubmit = JSON.parse(init.body); const id = "0x" + (submitN++).toString(16).padStart(64, "5"); return { ok: true, json: async () => ({ ok: true, txid: id }) }; }
  if (u.includes("/api/content")) { lastContent = JSON.parse(init.body); return { ok: true, json: async () => ({ ok: true }) }; }
  return { ok: true, json: async () => ({ ok: true }) };
};
const hexOf = (bytes) => "0x" + bytes.map((b) => Number(b).toString(16).padStart(2, "0")).join("");

const store = memoryStore();
const w = new Wallet(store, memoryStore());
await w.create(PW);
const addr = (await w.status()).addr;
const sealKey = "sealedClaims:" + addr;

// ── SEAL a claim while UNLOCKED ──
const DOMAIN = "csd:sealed";
const CLAIM = "i called dibs on the-good-name.csd at 2026-07-17T12:00Z — my secret preimage";
const r = await w.sealClaim({ domain: DOMAIN, claim: CLAIM });
check("sealClaim returns ok + a txid", r.ok === true && /^0x[0-9a-f]{64}$/.test(String(r.txid)));
const committedHash = hexOf(lastSubmit?.tx?.app?.Propose?.payload_hash ?? []); // the on-chain commitment
check("the seal committed a real payloadHash on-chain", /^0x[0-9a-f]{64}$/.test(committedHash));

// ── on-disk: the preimage is CIPHERTEXT, not plaintext ──
const onDisk = (await store.get(sealKey)).find((x) => x.txid === r.txid);
check("L5: the on-disk record has an encrypted `enc` blob (iv + ct)", !!onDisk.enc && /^[0-9a-f]+$/.test(String(onDisk.enc.iv)) && /^[0-9a-f]+$/.test(String(onDisk.enc.ct)));
check("L5: the on-disk record carries NO plaintext claim/nonce", onDisk.claim === undefined && onDisk.nonce === undefined);
check("L5: the ciphertext does not contain the cleartext claim", !JSON.stringify(onDisk.enc).includes(CLAIM));
check("L5: txid/domain/committedTs/revealed stay plaintext (already on-chain / not the lever)", onDisk.domain === DOMAIN && typeof onDisk.committedTs === "number" && onDisk.revealed === false);

// ── the popup preview still shows the claim TEXT (decrypted for display; no UX regression) ──
const preview = (await w.sealedClaims()).find((x) => x.txid === r.txid);
check("L5: sealedClaims() decrypts the claim TEXT for the popup preview (UX preserved)", preview.claim === CLAIM);

// ── REVEAL: decrypts and posts the EXACT original preimage; sha256 matches the committed hash ──
const rr = await w.revealClaim(r.txid);
check("revealClaim returns ok", rr.ok === true);
check("L5: reveal posts the EXACT original claim (survives encrypt→decrypt)", lastContent.claim === CLAIM);
const recomputed = cairnPayloadHash({ v: 1, sealed: 1, domain: DOMAIN, claim: lastContent.claim, nonce: lastContent.nonce });
check("L5: the revealed preimage sha256 == the committed on-chain hash (no corruption)", recomputed.toLowerCase() === committedHash.toLowerCase());

// ── LEGACY plaintext record: still reveals, and re-encrypts on the next write (lazy migration) ──
const LTXID = "0x" + "ab".repeat(32);
const LCLAIM = "legacy plaintext claim from a pre-L5 seal";
const LNONCE = "0x" + "cd".repeat(32);
const legacyCommitted = cairnPayloadHash({ v: 1, sealed: 1, domain: DOMAIN, claim: LCLAIM, nonce: LNONCE });
const list = (await store.get(sealKey)) || [];
list.unshift({ txid: LTXID, domain: DOMAIN, claim: LCLAIM, nonce: LNONCE, committedTs: Date.now(), revealed: false }); // pre-L5 shape
await store.set(sealKey, list);
lastContent = null;
const lr = await w.revealClaim(LTXID);
check("legacy: a pre-L5 plaintext record still reveals", lr.ok === true);
check("legacy: reveal posts the exact legacy preimage", lastContent.claim === LCLAIM && lastContent.nonce === LNONCE);
check("legacy: the revealed legacy preimage hashes to its committed hash", cairnPayloadHash({ v: 1, sealed: 1, domain: DOMAIN, claim: lastContent.claim, nonce: lastContent.nonce }).toLowerCase() === legacyCommitted.toLowerCase());
const legacyAfter = (await store.get(sealKey)).find((x) => x.txid === LTXID);
check("legacy: the record is RE-ENCRYPTED on the next write (lazy migration)", !!legacyAfter.enc && legacyAfter.claim === undefined && legacyAfter.nonce === undefined && legacyAfter.revealed === true);

done("seal-encrypt");
