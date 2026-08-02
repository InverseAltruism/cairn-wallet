// W6 (ND-1): ONE dust coin from a stranger permanently bricked consolidate(). AVAILABILITY of funds.
//
// The attack, end to end. Consensus puts NO upper bound on a Propose's `expires_epoch`
// (compute-substrate app_state.rs compares it only against the CURRENT epoch), so an attacker anchors one
// tx with `expires_epoch = 9007199254740993` and pays the victim 1 sat. The node serves that number
// verbatim; `JSON.parse` rounds it to 9007199254740992; the wallet's recomputed codecTxid therefore
// differs from the outpoint's real txid, which classified "tamper"; and tamper is DECISIVE for the whole
// spend. consolidate() selects SMALLEST-first, so the dust coin is in every pool: VERIFY_TAMPER forever,
// permanently, for the price of one dust transaction, on the documented remedy for the large-send class.
// Ordinary sends survive because selectInputs is greedy largest-first; near-full-balance sends brick too.
//
// The fix is a fifth verdict, "unrepresentable", classified on the RAW body BEFORE nodeTxToTx/codecTxid
// (after JSON.parse the precision loss is invisible), mirroring "horizon": per-coin skippable, its own
// array, its own reporting line after horizon and before notfound, its own code VERIFY_UNREPRESENTABLE.
// It is deliberately NOT aliased to "notfound", whose copy would tell the user a real coin "could not be
// found on the chain", and it adds NO rung to the decisive tamper/transient fold.
//
// MODELLING NOTE, stated rather than hidden: JavaScript cannot hold 9007199254740993, so this test cannot
// compute the real chain txid of the attacker's tx. It serves the poisoned number as RAW JSON TEXT (so
// the stub's own JSON.parse reproduces production's exact precision loss) and models the real chain txid
// as a distinct 32-byte id, which is the situation on the wire: a txid committing to the exact u64 can
// never equal the recompute of the rounded value.
//
//   RED-FIRST: delete the `if (!bodyNumbersRepresentable(body)) return "unrepresentable";` line and cases
//   (1) and (2) go red with VERIFY_TAMPER, which is the brick, seen.
//   PAIRED HAPPY-PATH: case (3) a genuinely forged body (well-formed numbers, wrong txid) STILL returns
//   tamper and still refuses the whole spend, and case (4) a real multi-coin consolidate and a real send
//   over clean bodies verify and sign with byte-identical inputs and totals.
//
// Run: node --import tsx test/unrepresentable-coin.test.mjs   (offline)
import { Wallet } from "../src/core/wallet.js";
import { memoryStore } from "../src/core/storage.js";
import { mkCoin, txReply } from "./_coin.js";

let pass = 0, fail = 0;
const check = (n, c) => { c ? (pass++, console.log("  ✓ " + n)) : (fail++, console.error("  ✗ " + n)); };
const origFetch = globalThis.fetch;
const RCPT = "0x" + "66".repeat(20);
const SPK = "0x" + "cd".repeat(20);
const hexOf = (bytes) => "0x" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
const submittedInputTxids = (sub) => (sub?.tx?.inputs ?? []).map((i) => hexOf(i.prevout.txid).toLowerCase());

// A coin whose SOURCE TX body carries an out-of-range expires_epoch. `bodyJson` is raw text: the stub
// parses it, exactly as production parses the node's response, and loses the low bit in the same place.
function poisonCoin(value, realTxid, field = "expires_epoch", poison = "9007199254740993") {
  const P = "__P__";
  const bodyJson = JSON.stringify({
    version: field === "version" ? P : 1,
    locktime: field === "locktime" ? P : 0,
    txid: realTxid,
    app: { type: "Propose", domain: "spam:v1", payload_hash: "0x" + "0e".repeat(32), uri: "spam", expires_epoch: field === "expires_epoch" ? P : 3 },
    inputs: [{ prev_txid: "0x" + "11".repeat(32), vout: 0, script_sig: "0x" }],
    outputs: [{ value: field === "value" ? P : value, script_pubkey: SPK }],
  }).replace(`"${P}"`, String(poison));
  // Pre-fix, the wallet parses this body, loses the low bit, and either recomputes a txid that differs
  // from `realTxid` or throws inside the codec. BOTH classify "tamper", which is the decisive refusal.
  return { coin: { txid: realTxid, vout: 0, value, confirmations: 9 }, bodyJson };
}

// URL-routed stub (ghostcoin.test.mjs pattern). `poisons` are served from raw JSON text; `served` are
// ordinary mkCoin bodies; `overrides` lets a case serve a forged body under a real txid.
function mkStub({ coins, served, poisons = [], overrides = {} }) {
  const stats = { submits: [], tx: 0 };
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.includes("/tx/submit")) { stats.submits.push(JSON.parse(init?.body ?? "{}")); return { ok: true, status: 200, json: async () => ({ ok: true, txid: "0x" + "aa".repeat(32) }) }; }
    if (u.includes("/utxos/")) return { ok: true, status: 200, json: async () => ({ confirmed_balance: coins.reduce((s, c) => s + c.coin.value, 0), utxos: coins.map((c) => c.coin) }) };
    if (u.endsWith("/tip")) return { ok: true, status: 200, json: async () => ({ height: 65_000 }) };
    const m = u.match(/\/tx\/(0x[0-9a-fA-F]{64})\b/);
    if (m) {
      stats.tx++;
      const id = m[1].toLowerCase();
      if (overrides[id]) return overrides[id]();
      const p = poisons.find((x) => x.coin.txid.toLowerCase() === id);
      if (p) return { ok: true, status: 200, json: async () => ({ ok: true, tx: JSON.parse(p.bodyJson) }) };
      return txReply(u, served);
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  return stats;
}
const freshWallet = async (pw) => { const w = new Wallet(memoryStore()); const { addr } = await w.create(pw); return { w, addr }; };

console.log("W6 (ND-1) - one dust coin from a stranger must not brick consolidate():\n");

// ── 1. consolidate() over a pool whose SMALLEST coin is the poison dust ────────────────────────────────
{
  const poison = poisonCoin(1, "0x" + "9d".repeat(32));
  const g = [mkCoin(41_00000000), mkCoin(43_00000000), mkCoin(47_00000000)];
  const s = mkStub({ coins: [poison, ...g], served: g, poisons: [poison] });
  const { w } = await freshWallet("pw-unrep-consol-123");
  const r = await w.consolidate(1_000_000);
  check(`(1) W6: consolidate() COMPLETES over the remaining coins (${r?.error ?? "ok"})`, r?.ok === true);
  check("(1) W6: ...and it is NOT the VERIFY_TAMPER brick", r?.code !== "VERIFY_TAMPER");
  const ins = submittedInputTxids(s.submits[0]);
  check(`(1) the poison coin was EXCLUDED, the three good ones merged (merged=${r?.merged})`,
    ins.length === 3 && !ins.includes(poison.coin.txid.toLowerCase()) && g.every((c) => ins.includes(c.coin.txid.toLowerCase())));
  const outVal = Number(s.submits[0]?.tx?.outputs?.[0]?.value ?? 0);
  check(`(1) the merged output is the verified total minus the fee (${outVal})`, outVal === 41_00000000 + 43_00000000 + 47_00000000 - 1_000_000);
}

// ── 2. a near-full-balance SEND that needs the poison coin: honest refusal, never "not found" ──────────
{
  const poison = poisonCoin(5_00000000, "0x" + "8c".repeat(32));
  const g = [mkCoin(29_00000000), mkCoin(31_00000000)];
  mkStub({ coins: [poison, ...g], served: g, poisons: [poison] });
  const { w } = await freshWallet("pw-unrep-send-123");
  const r = await w.send(RCPT, 62_00000000, 1_000_000);   // needs everything, so the poison IS selected
  check(`(2) the send is refused (nothing unverified is ever signed) (${r?.code})`, r?.ok === false);
  check("(2) W6: with the new honest code, not VERIFY_TAMPER", r?.code === "VERIFY_UNREPRESENTABLE");
  check("(2) W6: the copy never says the coin could not be FOUND (that is the notfound lie)", !/could not be found/i.test(String(r?.error)));
  check("(2) W6: the copy never says tampered / could not be verified", !/tamper|could not be verified/i.test(String(r?.error)));
  check("(2) W6: the copy says what is actually true (a number it cannot represent exactly)", /cannot represent exactly/i.test(String(r?.error)));
}

// ── 2b. the same poison, but a send the REMAINING coins can cover: it just goes through ────────────────
{
  const poison = poisonCoin(2_00000000, "0x" + "7b".repeat(32));
  const g = [mkCoin(19_00000000), mkCoin(23_00000000)];
  const s = mkStub({ coins: [poison, ...g], served: g, poisons: [poison] });
  const { w } = await freshWallet("pw-unrep-send2-123");
  const r = await w.send(RCPT, 20_00000000, 1_000_000);
  check(`(2b) a send the provable coins CAN cover still succeeds around the poison coin (${r?.error ?? "ok"})`, r?.ok === true);
  check("(2b) ...and the poison coin was never spent", !submittedInputTxids(s.submits[0]).includes(poison.coin.txid.toLowerCase()));
}

// ── 2c. every enumerated numeric field, not just expires_epoch ─────────────────────────────────────────
{
  for (const [field, poison] of [["locktime", "9007199254740993"], ["version", "9007199254740993"], ["value", "9007199254740993"]]) {
    const tag = { locktime: "6a", version: "5a", value: "4a" }[field];
    const base = { locktime: 13_00000000, version: 17_00000000, value: 19_00000000 }[field];
    const p = poisonCoin(3, "0x" + tag.repeat(32), field, poison);
    const g = [mkCoin(base), mkCoin(base + 1_00000000)];
    mkStub({ coins: [p, ...g], served: g, poisons: [p] });
    const { w } = await freshWallet(`pw-unrep-${field}-123`);
    const r = await w.consolidate(1_000_000);
    check(`(2c) an out-of-range \`${field}\` is also classified unrepresentable (consolidate completes)`, r?.ok === true);
  }
}

// ── 3. PAIRED HAPPY-PATH: a genuinely forged body still refuses the WHOLE spend ────────────────────────
console.log("\nPAIRED HAPPY-PATH (the tamper refusal is untouched):");
{
  const good = [mkCoin(53_00000000), mkCoin(59_00000000)];
  const decoy = mkCoin(61_00000000);
  // a WELL-FORMED body (every number exactly representable) served under a DIFFERENT txid: the recompute
  // mismatches, which is a forging RPC and must still kill the whole spend with no retry.
  const s = mkStub({
    coins: good, served: good,
    overrides: { [good[0].coin.txid.toLowerCase()]: () => ({ ok: true, status: 200, json: async () => ({ ok: true, tx: decoy.body }) }) },
  });
  const { w } = await freshWallet("pw-forged-123");
  const r = await w.send(RCPT, 100_00000000, 1_000_000);   // needs BOTH coins, so the forged one is selected
  check(`(3) a forged (well-formed, wrong txid) body still returns VERIFY_TAMPER (${r?.code})`, r?.ok === false && r?.code === "VERIFY_TAMPER");
  check("(3) ...and nothing was signed", s.submits.length === 0);
  const rc = await w.consolidate(1_000_000);
  check(`(3) consolidate() also still refuses the whole merge on a forged body (${rc?.code})`, rc?.ok === false && rc?.code === "VERIFY_TAMPER");
}

// ── 4. PAIRED HAPPY-PATH: clean bodies verify and sign with byte-identical inputs and totals ───────────
{
  const g = [mkCoin(71_00000000), mkCoin(73_00000000), mkCoin(79_00000000)];
  const s = mkStub({ coins: g, served: g });
  const { w, addr } = await freshWallet("pw-clean-unrep-123");
  const rc = await w.consolidate(1_000_000);
  check(`(4) a real multi-coin consolidate() over clean bodies succeeds (${rc?.error ?? "ok"})`, rc?.ok === true && rc?.merged === 3);
  const ins = submittedInputTxids(s.submits[0]).sort();
  check("(4) it spends exactly the three coins", JSON.stringify(ins) === JSON.stringify(g.map((c) => c.coin.txid.toLowerCase()).sort()));
  check("(4) into ONE self-output of total minus fee",
    (s.submits[0]?.tx?.outputs ?? []).length === 1
    && Number(s.submits[0].tx.outputs[0].value) === 71_00000000 + 73_00000000 + 79_00000000 - 1_000_000
    && hexOf(s.submits[0].tx.outputs[0].script_pubkey).toLowerCase() === addr.toLowerCase());
}
{
  const g = [mkCoin(83_00000000), mkCoin(89_00000000)];
  const s = mkStub({ coins: g, served: g });
  const { w, addr } = await freshWallet("pw-clean-send-unrep-123");
  const r = await w.send(RCPT, 50_00000000, 1_000_000);
  check(`(4) a real send over clean bodies succeeds (${r?.error ?? "ok"})`, r?.ok === true);
  const outs = s.submits[0]?.tx?.outputs ?? [];
  const paid = outs.filter((o) => hexOf(o.script_pubkey).toLowerCase() === RCPT.toLowerCase()).reduce((a, o) => a + Number(o.value), 0);
  const change = outs.filter((o) => hexOf(o.script_pubkey).toLowerCase() === addr.toLowerCase()).reduce((a, o) => a + Number(o.value), 0);
  const spent = submittedInputTxids(s.submits[0]).length === 1 ? 89_00000000 : 83_00000000 + 89_00000000;
  check(`(4) the recipient is paid exactly the amount (${paid})`, paid === 50_00000000);
  check(`(4) change to self is exactly inputs minus amount minus fee (${change})`, change === spent - 50_00000000 - 1_000_000);
}

globalThis.fetch = origFetch;
console.log(`\nunrepresentable-coin: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
