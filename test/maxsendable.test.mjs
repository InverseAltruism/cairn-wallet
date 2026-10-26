// The send sheet's Max (wallet 0.3.1, owner decision 2026-10-25): node.maxSendable runs the send engine's own
// selectVerified with a target that each round is the reported total of the 512 largest coins still eligible, so the
// figure is what one send accepts: every coin chain-verified, ghost, horizon and unrepresentable coins skipped as a
// send skips them, the 512-input cap and both fee caps applied. Each case then sends exactly that amount through the
// real Wallet.send (the call the popup makes) and one base unit more: the first is signed and submitted, the second
// is refused with the engine's own code, and nothing is submitted for it.
// Harness note (ghostcoin.test.mjs): node.ts keeps a session ghost cache, so every case uses distinct coin values.
// RED-FIRST: drop `.slice(0, MAX_TX_INPUTS)` from maxSendable's target and case 2 fails (Max over the input cap);
// count every reported coin, the round's exclusions ignored (`spendableCoins(utxos)`), and cases 3 and 4 fail; evaluate the
// target once instead of per round (`if (typeof needOf === "function" && round === 0)` in selectVerified) and the ghost
// and unrepresentable cases fail.
// Run: npx tsx test/maxsendable.test.mjs   (offline)
import { readFileSync } from "node:fs";
import { Wallet } from "../src/core/wallet.js";
import { memoryStore } from "../src/core/storage.js";
import { mkCoin, txReply } from "./_coin.js";
import { checker } from "./helpers/check.mjs";

const { check, done } = checker("Max: the most one send accepts");
const RCPT = "0x" + "11".repeat(20);
const FEE = 1_000_000; // the popup's SEND_FEE, 0.01 CSD
const hexOf = (bytes) => "0x" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
const inputsOf = (sub) => (sub?.tx?.inputs ?? []).map((i) => hexOf(i.prevout.txid).toLowerCase());

function stub({ coins, served, raw = {}, overrides = {} }) {
  const stats = { submits: [], tx: 0 };
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.includes("/tx/submit")) { stats.submits.push(JSON.parse(init?.body ?? "{}")); return { ok: true, status: 200, json: async () => ({ ok: true }) }; }
    if (u.includes("/utxos/")) return { ok: true, status: 200, json: async () => ({ confirmed_balance: coins.reduce((s, c) => s + c.coin.value, 0), utxos: coins.map((c) => c.coin) }) };
    const m = u.match(/\/tx\/(0x[0-9a-fA-F]{64})\b/);
    if (m) {
      stats.tx++;
      const id = m[1].toLowerCase();
      if (overrides[id]) return overrides[id]();
      if (raw[id]) return { ok: true, status: 200, json: async () => ({ ok: true, tx: JSON.parse(raw[id]) }) };
      return txReply(u, served);
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  return stats;
}
async function wallet() { const w = new Wallet(memoryStore()); await w.create("max-sendable-pw-1"); return w; }
/** Max, then the engine with one base unit more (refused, nothing submitted), then the engine with Max (signed). */
async function engineAccepts(name, w, stats, overCode) {
  const max = await w.maxSendable(FEE);
  if (!check(`${name}: Max answers (${max.error ?? max.amount})`, max.ok === true && max.amount > 0)) return { max };
  const over = await w.send(RCPT, max.amount + 1, FEE);
  check(`${name}: one base unit more is refused by the engine (${over.code})`, over.ok === false && over.code === overCode && stats.submits.length === 0);
  const r = await w.send(RCPT, max.amount, FEE);
  check(`${name}: the engine signs and submits exactly Max (${r.error ?? "ok"})`, r.ok === true && stats.submits.length === 1);
  return { max, sub: stats.submits[0] };
}

const origFetch = globalThis.fetch;
try {
  // 1. a few coins: Max is the verified total minus the fee, and the send leaves no change
  {
    const c = [mkCoin(5_00000001), mkCoin(3_00000001), mkCoin(2_00000001)];
    const s = stub({ coins: c, served: c });
    const { max, sub } = await engineAccepts("(1) three coins", await wallet(), s, "INSUFFICIENT");
    check("(1) Max = 10.00000003 CSD minus 0.01", max.amount === 10_00000003 - FEE && max.capped === false && max.inputs === 3 && max.skipped === 0);
    check("(1) the send spends all three coins and pays one output, no change", inputsOf(sub).length === 3 && sub?.tx?.outputs?.length === 1);
  }
  // 2. more coins than one transaction may spend: Max is the 512 largest, and the cap is said
  {
    const c = Array.from({ length: 600 }, (_, i) => mkCoin(1_000_000 * (1000 + i) + 7));
    const s = stub({ coins: c, served: c });
    const top = c.map((x) => x.coin.value).sort((a, b) => b - a).slice(0, 512).reduce((a, b) => a + b, 0);
    const { max, sub } = await engineAccepts("(2) 600 coins", await wallet(), s, "TOO_MANY_INPUTS");
    check(`(2) Max = the 512 largest coins minus the fee, capped (${max.inputs} of ${max.eligible})`, max.amount === top - FEE && max.capped === true && max.inputs === 512 && max.eligible === 600);
    check("(2) the send spends 512 coins", inputsOf(sub).length === 512);
  }
  // 3. a ghost coin (its source tx is on no chain the node has): Max leaves it out, as the send does
  {
    const ghost = mkCoin(50_00000003); ghost.coin.txid = "0x" + "93".repeat(32);
    const c = [mkCoin(4_00000003), mkCoin(3_00000003)];
    const s = stub({ coins: [ghost, ...c], served: c });
    const { max, sub } = await engineAccepts("(3) a ghost coin", await wallet(), s, "GHOST_INPUTS_SKIPPED");
    check(`(3) Max = the two provable coins minus the fee, one coin skipped (${max.skipped})`, max.amount === 7_00000006 - FEE && max.skipped === 1);
    check("(3) the ghost is not spent", !inputsOf(sub).includes(ghost.coin.txid));
  }
  // 4. an unrepresentable coin (no session cache): Max excludes it per round, and the send re-derives the same set
  {
    const id = "0x" + "8e".repeat(32);
    const P = "__P__";
    const poisonBody = JSON.stringify({ version: 1, locktime: 0, txid: id, app: { type: "Propose", domain: "spam:v1", payload_hash: "0x" + "0e".repeat(32), uri: "spam", expires_epoch: P },
      inputs: [{ prev_txid: "0x" + "11".repeat(32), vout: 0, script_sig: "0x" }], outputs: [{ value: 50_00000004, script_pubkey: "0x" + "cd".repeat(20) }] }).replace(`"${P}"`, "9007199254740993");
    const poison = { coin: { txid: id, vout: 0, value: 50_00000004, confirmations: 9 } };
    const c = [mkCoin(31_00000004), mkCoin(29_00000004)];
    const s = stub({ coins: [poison, ...c], served: c, raw: { [id]: poisonBody } });
    const { max, sub } = await engineAccepts("(4) an unrepresentable coin", await wallet(), s, "VERIFY_UNREPRESENTABLE");
    check(`(4) Max = the two representable coins minus the fee, one coin skipped (${max.skipped})`, max.amount === 60_00000008 - FEE && max.skipped === 1);
    check("(4) the unrepresentable coin is not spent", !inputsOf(sub).includes(id));
  }
  // 5. coinbase and ordinary coins together: Max covers both, as selectInputs' second pass does
  {
    const c = [mkCoin(50_00000005, 0, { coinbase: true }), mkCoin(3_00000005)];
    const s = stub({ coins: c, served: c });
    const { max } = await engineAccepts("(5) coinbase and ordinary coins", await wallet(), s, "INSUFFICIENT");
    check("(5) Max = both coins minus the fee", max.amount === 53_00000010 - FEE);
  }
  // 6. a coin the node reports above its chain value: no figure (a send of the reported total is refused too)
  {
    const real = mkCoin(2_00000006);
    const inflated = { coin: { ...real.coin, value: 20_00000006 }, body: real.body };
    stub({ coins: [inflated], served: [inflated] });
    const w = await wallet();
    const max = await w.maxSendable(FEE);
    check(`(6) an over-reported coin gives no Max (${max.code})`, max.ok === false && max.code === "INSUFFICIENT");
    const r = await w.send(RCPT, 20_00000006 - FEE, FEE);
    check("(6) ...and the engine refuses the reported total the same way", r.ok === false && r.code === "INSUFFICIENT");
  }
  // 7. unconfirmed coins do not count; no spendable coin is Max 0, not an error
  {
    const c = [mkCoin(9_00000007, 0, { confirmations: 0 })];
    const s = stub({ coins: c, served: c });
    const max = await (await wallet()).maxSendable(FEE);
    check(`(7) only an unconfirmed coin: Max is 0 (${max.error ?? max.amount})`, max.ok === true && max.amount === 0 && max.eligible === 0 && s.submits.length === 0);
    stub({ coins: [], served: [] });
    const none = await (await wallet()).maxSendable(FEE);
    check("(7) no coins: Max is 0", none.ok === true && none.amount === 0);
  }
  // 8. the fee caps apply as they do to a send
  {
    const c = [mkCoin(2_00000008)];
    stub({ coins: c, served: c });
    const w = await wallet();
    check("(8) a zero fee is refused", (await w.maxSendable(0)).code === "BAD_FEE");
    check("(8) a fee over 100 CSD is refused", (await w.maxSendable(101e8)).code === "FEE_CAP");
    const prop = await w.maxSendable(1_50000000);
    const sendProp = await w.send(RCPT, 1000, 1_50000000);
    check(`(8) a 1.5 CSD fee on 2 CSD of coins trips the proportional cap, like a send (${prop.code}, ${sendProp.code})`, prop.code === "FEE_CAP" && sendProp.code === "FEE_CAP");
  }
  // 9. a forged source tx refuses Max outright, as it refuses a send
  {
    const c = [mkCoin(6_00000009)];
    const other = mkCoin(6_10000009);
    stub({ coins: c, served: c, overrides: { [c[0].coin.txid.toLowerCase()]: () => ({ ok: true, status: 200, json: async () => ({ ok: true, tx: other.body }) }) } });
    const max = await (await wallet()).maxSendable(FEE);
    check(`(9) a forged source tx: no Max (${max.code})`, max.ok === false && max.code === "VERIFY_TAMPER");
  }
} finally { globalThis.fetch = origFetch; }

// Max is popup-only and signs nothing
const bg = readFileSync(new URL("../src/background.ts", import.meta.url), "utf8");
const dapp = /const DAPP_METHODS = new Set\(\[([^\]]*)\]\)/.exec(bg)?.[1] ?? "";
check("maxSendable is not a dApp method", dapp.length > 0 && !dapp.includes('"maxSendable"') && bg.includes('case "maxSendable": return wallet.maxSendable(args[0]);'));

done("maxsendable");
