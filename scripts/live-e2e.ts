// LIVE mainnet end-to-end test of the wallet core against the real CSD node.
// Operator-only (reads ~/.config/cairn/key.json). NOT part of `npm test`.
// Proves on real chain: plain `None` transfers, HD-derived key spendability, and
// multi-input coin selection from BOTH the funded key and a derived key — verifying
// each tx's input count by fetching it back from /tx/:id. Spends ~0.03 CSD in fees.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { fromPriv, deriveAccount, newMnemonic } from "../src/core/account.ts";
import * as node from "../src/core/node.ts";

const RPC = process.env.CAIRN_RPC || "http://127.0.0.1:8790";
const COIN = 1_000_000; // 0.01 CSD
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const key = JSON.parse(readFileSync(homedir() + "/.config/cairn/key.json", "utf8"));
const cairn = fromPriv(key.privkey.startsWith("0x") ? key.privkey : "0x" + key.privkey);

// Fresh HD wallet whose key we'll fund then spend back — proves HD keys are real.
const mnemonic = newMnemonic();
const hd = deriveAccount(mnemonic, 0);

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { console.log(`  ${c ? "✅" : "❌"} ${m}`); c ? pass++ : fail++; };

async function getJson(path: string) { const r = await fetch(RPC + path); return r.json(); }
async function bal(addr: string) { return node.balance(RPC, addr); }
async function txInputs(txid: string): Promise<number> {
  try { const j = await getJson(`/tx/${txid}`); const tx = j.tx ?? j.transaction ?? j; return (tx.inputs ?? []).length; } catch { return -1; }
}
async function waitFor(label: string, pred: () => Promise<boolean>, timeoutMs = 420_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await pred().catch(() => false)) { console.log(`  …${label}: ready (${Math.round((Date.now() - t0) / 1000)}s)`); return true; }
    await sleep(6000);
  }
  console.log(`  …${label}: TIMEOUT after ${Math.round(timeoutMs / 1000)}s`); return false;
}

(async () => {
  console.log("=== LIVE MAINNET WALLET E2E ===");
  console.log("RECOVERY (in case of interruption):");
  console.log("  mnemonic:", mnemonic);
  console.log("  hd priv :", hd.privkey, "\n  hd addr :", hd.addr);
  console.log("  cairn   :", cairn.addr, "\n");

  const start = await bal(cairn.addr);
  console.log(`cairn start: ${start.confirmed / 1e8} CSD across ${start.utxos.length} UTXOs`,
    start.utxos.map((u: any) => u.value));
  const big = [...start.utxos].sort((a: any, b: any) => b.value - a.value)[0];

  // ── A1: cairn → HD, single input (funds HD with a 1M coin) ──
  const a1 = await node.send(RPC, { to: hd.addr, amount: COIN, fee: COIN }, cairn.privkey);
  ok(a1.ok, `A1 cairn→HD (None transfer) accepted: ${a1.txid ?? a1.error}`);
  if (!a1.ok) return done();

  // wait until the node sees A1's spend (big coin leaves the available set), to avoid
  // a double-spend race when A2 selects coins.
  await waitFor("A1 spend visible", async () => (await bal(cairn.addr)).utxos.every((u: any) => u.txid !== big.txid), 120_000);

  // ── A2: cairn → HD, MULTI-input (only the 1M+2M coins remain available; need 3M) ──
  const preA2 = await bal(cairn.addr);
  console.log("  cairn available before A2:", preA2.utxos.map((u: any) => u.value), "(no single coin ≥ 3M ⇒ must combine)");
  const a2 = await node.send(RPC, { to: hd.addr, amount: 2 * COIN, fee: COIN }, cairn.privkey);
  ok(a2.ok, `A2 cairn→HD (multi-input) accepted: ${a2.txid ?? a2.error}`);

  // ── wait for A1+A2 to mine: HD must hold 2 confirmed coins (1M and 2M) ──
  await waitFor("A1+A2 mined → HD has 2 confirmed UTXOs", async () => {
    const b = await bal(hd.addr); return b.utxos.filter((u: any) => Number(u.confirmations) >= 1).length >= 2;
  });
  // NOW the txs are in a block (/tx returns the body) — verify input counts on-chain.
  ok((await txInputs(a1.txid!)) === 1, `A1 used 1 input (single-input send, confirmed via mined /tx)`);
  if (a2.ok) ok((await txInputs(a2.txid!)) >= 2, `A2 used ≥2 inputs (multi-input from funded key, confirmed via mined /tx)`);
  const hdBal = await bal(hd.addr);
  ok(hdBal.utxos.length >= 2, `HD received 2 coins: ${hdBal.utxos.map((u: any) => u.value)} (HD address is real + spendable)`);

  // ── B: HD → cairn, MULTI-input from the DERIVED key (coins 2M+1M, need 3M) ──
  const b = await node.send(RPC, { to: cairn.addr, amount: 2 * COIN, fee: COIN }, hd.privkey);
  ok(b.ok, `B HD→cairn (derived-key signature) accepted: ${b.txid ?? b.error}`);

  await waitFor("B mined → funds returned to cairn", async () => (await bal(cairn.addr)).confirmed >= start.confirmed - 4 * COIN);
  if (b.ok) ok((await txInputs(b.txid!)) >= 2, `B used ≥2 inputs (multi-input from HD-derived key, confirmed via mined /tx)`);
  const end = await bal(cairn.addr);
  console.log(`cairn end: ${end.confirmed / 1e8} CSD (net fee cost ≈ ${(start.confirmed - end.confirmed) / 1e8} CSD)`);
  done();
})();

function done() { console.log(`\n=== LIVE E2E: ${pass} passed, ${fail} failed ===`); process.exit(fail ? 1 : 0); }
