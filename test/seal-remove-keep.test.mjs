// Removing an account keeps its unrevealed sealed claims. Each holds the only copy of a paid commit's reveal nonce
// (32 random bytes made at seal time, not derived from the phrase or the key), so deleting the record forfeits the
// claim for good. The revealed records go; the unrevealed ones stay sealed under the vault key and list and reveal
// again once the same address is back in this wallet. reset() deletes them too.
//   RED-FIRST: put back removeAccount's deletion of sealedClaims:<addr> (the 0.3.2 line) and sections 1, 2 and 4 fail.
//   PAIRED HONEST PATHS: an account with no seals is removed and re-imported as before, leaving nothing behind (3);
//   reset() still leaves no sealed-claim list (5); the remove step's count reads 0 for an account with none (1).
// Run: npx tsx test/seal-remove-keep.test.mjs   (offline)
import { Wallet } from "../src/core/wallet.js";
import { memoryStore } from "../src/core/storage.js";
import { mkCoin, txReply } from "./_coin.js";
import { checker } from "./helpers/check.mjs";

const { check, done } = checker("account removal keeps unrevealed sealed claims:");
const PW = "correct horse battery staple";
const CM = mkCoin(100e8);
const j = (o) => ({ ok: true, status: 200, json: async () => o });
const posted = [];
let n = 0;
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u.includes("/tip")) return j({ height: 21000 });
  if (u.includes("/utxos/")) return j({ confirmed_balance: 100e8, utxos: [CM.coin] });
  if (u.includes("/tx/submit")) { n++; return j({ ok: true, txid: "0x" + String(n).padStart(64, "0") }); }
  const tr = txReply(u, [CM]); if (tr) return tr;
  if (u.includes("/proposal/")) return j({ payload_hash: [1, 2, 3] });   // every commit reads as mined
  if (u.includes("/api/content")) { posted.push(JSON.parse(init.body)); return j({ ok: true }); }
  return { ok: false, status: 404, json: async () => ({}) };
};
const sealKey = (a) => "sealedClaims:" + a;

// 1. An HD account with one revealed and one unrevealed claim: removal drops the revealed one and keeps the other.
const store = memoryStore();
const w = new Wallet(store);
const a1 = (await w.create(PW)).addr;
const a2 = (await w.addAccount()).addr;
const a2key = await w.exportKey(PW);
const kept = await w.sealClaim({ claim: "kept secret" });
const gone = await w.sealClaim({ claim: "already public" });
check("1. setup: two seals on the second account", kept.ok === true && gone.ok === true && (await w.sealedClaims()).length === 2);
check("1. setup: the second is revealed", (await w.revealClaim(gone.txid))?.ok === true && posted.length === 1);
check(`1. the remove step's count is the one unrevealed claim (${await w.unrevealedSeals(a2)})`, (await w.unrevealedSeals(a2)) === 1);
check(`1. honest path: an account with no seals counts 0 (${await w.unrevealedSeals(a1)})`, (await w.unrevealedSeals(a1)) === 0);
await w.switchAccount(a1);
await w.removeAccount(a2);
const left = (await store.get(sealKey(a2))) || [];
check(`1. after removal the store keeps exactly the unrevealed record (${left.length} kept)`, left.length === 1 && left[0].txid === kept.txid && !left[0].revealed);
check("1. the kept record is still sealed: no claim or nonce in clear", !!left[0]?.enc && !("nonce" in (left[0] ?? {})) && !("claim" in (left[0] ?? {})));

// 2. The same key imported back: the claim lists with its text and reveals.
const back = await w.importAccount(a2key, "back");
check("2. the same address is back", back.addr.toLowerCase() === a2.toLowerCase());
const listed = await w.sealedClaims();
check(`2. its unrevealed claim lists again, with its text (${JSON.stringify(listed.map((x) => x.claim))})`, listed.length === 1 && listed[0].claim === "kept secret" && listed[0].revealed === false);
const r = await w.revealClaim(kept.txid);
const last = posted.at(-1);
check(`2. it reveals: the preimage is posted and the server says ok (${JSON.stringify(r)})`, r?.ok === true && posted.length === 2 && last?.claim === "kept secret" && /^[0-9a-f]{64}$/.test(String(last?.nonce)));

// 3. Honest path: an account with no seals leaves nothing behind.
const a3 = (await w.addAccount()).addr;
await w.switchAccount(a1);
await w.removeAccount(a3);
check("3. honest path: removing an account with no seals stores no list for it", (await store.get(sealKey(a3))) == null);

// 4. A seal parked by a failed write (the only copy of its nonce, in RAM) is written to the kept list on removal.
const ps = memoryStore();
let failSeals = false;
const pstore = { ...ps, async set(k, v) { if (failSeals && k.startsWith("sealedClaims:")) throw new Error("quota"); return ps.set(k, v); } };
const pw = new Wallet(pstore);
const b1 = (await pw.create(PW)).addr;
const b2 = (await pw.addAccount()).addr;
failSeals = true;
const parked = await pw.sealClaim({ claim: "parked secret" });
failSeals = false;
check("4. setup: the seal is paid and parked, not stored", parked.ok === true && (await ps.get(sealKey(b2))) == null && (await pw.unrevealedSeals(b2)) === 1);
await pw.switchAccount(b1);
await pw.removeAccount(b2);
const pl = (await ps.get(sealKey(b2))) || [];
check(`4. the parked record is in the kept list after removal (${pl.length})`, pl.length === 1 && pl[0].txid === parked.txid);

// 4b. The address index is written before the kept list, so a worker stopped between the two writes never leaves a
// kept list reset() does not know (RED-FIRST: swap the two writes in keepUnrevealedOf).
{
  const os = memoryStore(), order = [];
  const ostore = { ...os, async set(k, v) { order.push(k); return os.set(k, v); } };
  const ow = new Wallet(ostore);
  const c1 = (await ow.create(PW)).addr;
  const c2 = (await ow.addAccount()).addr;
  await ow.sealClaim({ claim: "ordered" });
  await ow.switchAccount(c1);
  order.length = 0;
  await ow.removeAccount(c2);
  const iIndex = order.indexOf("keptSealAddrs"), iList = order.indexOf(sealKey(c2));
  check(`4b. on removal the address index is written before the kept list (${order.filter((k) => k === "keptSealAddrs" || k.startsWith("sealedClaims:")).join(" then ")})`, iIndex >= 0 && iList > iIndex);
}

// 5. reset() deletes the kept lists of removed accounts too.
await pw.reset();
check("5. reset deletes a removed account's kept list", (await ps.get(sealKey(b2))) == null && (await ps.get("keptSealAddrs")) == null);
await w.removeAccount(a2, PW);   // re-imported, so an imported key: removal takes the password
check("5. setup: removing the account again drops its list (its one claim is revealed now); the kept-address list still names it", (await store.get(sealKey(a2))) == null && ((await store.get("keptSealAddrs")) || []).includes(a2));
await w.reset();
check("5. honest path: after reset no sealed-claim list is left for any address", (await store.get(sealKey(a2))) == null && (await store.get(sealKey(a1))) == null && (await store.get("keptSealAddrs")) == null);
done("seal-remove-keep");
