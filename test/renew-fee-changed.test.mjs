// The wallet's own renewal signs exactly the fee the user reviewed: when the tip crossed a fee gate between Review
// and Confirm (the live fee differs), cairnxNameRenew throws FEE_CHANGED:<live fee> and submits nothing; the popup
// re-opens the review at the new price. Without the check it would sign the reviewed fee, which the resolver
// no-ops when it underpays while the treasury output is paid. Paired: the matching fee signs and pays the treasury.
// Run: npx tsx test/renew-fee-changed.test.mjs   (offline)
import { checker } from "./helpers/check.mjs";
import { Wallet } from "../src/core/wallet.js";
import { memoryStore } from "../src/core/storage.js";
import { nameRegFee, buildFeeHeight, TREASURY_ADDR, V24_HEIGHT } from "../src/vendor/cairnx-spv.js";
import { mkCoin, txReply } from "./_coin.js";

const { check, done } = checker("renewal: the reviewed fee or FEE_CHANGED:");
const TIP = 67_500, NAME = "alice";
const coin = mkCoin(2_000_000_000);
const submits = [];
const w = new Wallet(memoryStore());
const { addr: ME } = await w.create("pw-renew-fee-123");
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u.includes("/cairnx/name/")) return { ok: true, status: 200, json: async () => ({ name: NAME, owner: ME }) };
  if (u.includes("/tx/submit")) { submits.push(JSON.parse(init?.body ?? "{}")); return { ok: true, status: 200, json: async () => ({ ok: true, txid: "0x" + "aa".repeat(32) }) }; }
  if (u.endsWith("/tip")) return { ok: true, status: 200, json: async () => ({ height: TIP }) };
  if (u.includes("/utxos/")) return { ok: true, status: 200, json: async () => ({ confirmed_balance: coin.coin.value, utxos: [coin.coin] }) };
  return txReply(u, [coin]) ?? { ok: false, status: 404, json: async () => ({}) };
};
const hex = (b) => "0x" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const toTreasury = (sub) => (sub?.tx?.outputs ?? []).filter((o) => hex(o.script_pubkey).toLowerCase() === TREASURY_ADDR.toLowerCase()).reduce((a, o) => a + Number(o.value), 0);

const live = Number(nameRegFee(NAME, buildFeeHeight(TIP)));
const stale = Number(nameRegFee(NAME, buildFeeHeight(V24_HEIGHT - 100)));   // the price before the V24 gate
check(`the gate moved this name's fee (${stale} before, ${live} now)`, stale !== live);
let err = null;
try { await w.cairnxNameRenew(NAME, stale); } catch (e) { err = String(e?.message ?? e); }
check(`a renewal reviewed at the old price throws FEE_CHANGED with the live fee (${err})`, err === `FEE_CHANGED:${live}`);
check("...and submits nothing", submits.length === 0);
const r = await w.cairnxNameRenew(NAME, live);
check(`the reviewed fee equal to the live fee signs once (${r?.ok}, ${submits.length} submit)`, r?.ok === true && submits.length === 1);
check(`...and pays that fee to the treasury (${toTreasury(submits[0])})`, toTreasury(submits[0]) === live);

done("renew-fee-changed");
