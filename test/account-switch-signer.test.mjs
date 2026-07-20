// A1 (Plans/68 FILL-RACE-1 + POPUP-SEND-RACE-2): signing-context integrity across account switches.
//
// fillOffer is the ONE signing method with awaits between validation and the key read: its preflight
// awaits the offer fetch and the chain tip. Pre-0.2.57, a switchAccount parked in those awaits made the
// preflight validate account A while account B's key signed and paid — pay-without-delivery on a
// taker-bound offer (the resolver delivers to A, B paid), whole-payment loss on the open-CSD lane.
// The fix captures the signer BEFORE the first await (captureSigner), threads the captured address into
// the preflight as `me`, re-asserts the signer at the sign tick (signerUnchanged), and signs/records
// with the CAPTURED key/histKey. expectSigner is the same guard for callers that displayed a signer
// (popup review snapshots, the background's displayedSigner) — refusal-only, never widens what signs.
//
// MUTATION CONTRACT: the race case and the expectSigner case FAIL on 0.2.56 (the fill submits from the
// switched-to account; send ignores the 4th argument). Harness style: consolidate.test.mjs (URL-routed
// fetch stub, real Wallet + memoryStore, mkCoin/txReply for TXB-1 verification).
import { Wallet } from "../src/core/wallet.js";
import { memoryStore } from "../src/core/storage.js";
import { requiredFillOutputs, TREASURY_ADDR } from "../src/core/cairnx.js";
import { mkCoin, txReply } from "./_coin.js";

let pass = 0, fail = 0;
const check = (n, c) => { c ? pass++ : (fail++, console.error("  ✗ " + n)); if (c) console.log("  ✓ " + n); };
const FEE = 1_000_000;
const origFetch = globalThis.fetch;

// URL-routed stub: per-address /utxos, TXB-1 /tx bodies, captured submits, an open taker-bound offer at
// /cairnx/offer/<id>, and a /tip whose FIRST call can be parked on a deferred promise (the race window).
function mkStub({ coinsByAddr, served, offer, parkFirstTip = false }) {
  const stats = { submits: [], tipParked: null, releaseTip: null };
  let firstTip = true;
  if (parkFirstTip) stats.tipParked = new Promise((res) => { stats.tipArmed = res; });
  const fetchStub = async (url, init) => {
    const u = String(url);
    if (u.includes("/tx/submit")) {
      stats.submits.push(JSON.parse(init?.body ?? "{}"));
      return { ok: true, status: 200, json: async () => ({ ok: true, txid: "0x" + "aa".repeat(32) }) };
    }
    const um = u.match(/\/utxos\/(0x[0-9a-fA-F]{40})/);
    if (um) {
      const coins = coinsByAddr[um[1].toLowerCase()] ?? [];
      return { ok: true, status: 200, json: async () => ({ confirmed_balance: coins.reduce((s, c) => s + c.coin.value, 0), utxos: coins.map((c) => c.coin) }) };
    }
    if (u.endsWith("/tip")) {
      if (parkFirstTip && firstTip) {
        firstTip = false;
        stats.tipArmed();                                     // signal: the preflight is now parked here
        await new Promise((res) => { stats.releaseTip = res; });
      }
      return { ok: true, status: 200, json: async () => ({ height: 50_000 }) };
    }
    if (u.includes("/cairnx/offer/")) {
      return { ok: true, status: 200, json: async () => offer };
    }
    const t = txReply(u, served);
    if (t) return t;
    return { ok: false, status: 404, json: async () => ({}) };
  };
  return { fetchStub, stats };
}

// Two accounts, coins for both (so a pre-fix wrong-signer build SUCCEEDS and the mutation is vivid:
// the fill submits from B instead of refusing).
const w = new Wallet(memoryStore());
const { addr: A } = await w.create("super-secret-pw");
// F2-legacy: the legacy/dApp CSD lane now binds the payment recipient to the merkle-proven offer author. This
// test's offer is honest (payto 0xce, seller 0xcd), so inject the proven author so the bind passes and the flow
// reaches the account-switch (sign-tick) checks under test.
w.provenPaytoForTest = () => ({ payto: "0x" + "ce".repeat(20), seller: "0x" + "cd".repeat(20), terms: { height: 47_000, feeBps: 150, value: "5000000", taker: String(A).toLowerCase(), bid: undefined, giveTicker: "TKN", giveAmount: "5", giveName: undefined, wantType: "csd" } });   // B7e: proven give matches the served offer (give leg passes)
const { addr: B } = await w.addAccount("second");
await w.switchAccount(A);

const coinA = mkCoin(100_000_000);      // 1 CSD
const coinB = mkCoin(100_000_001);      // distinct value ⇒ distinct txid (module-level served map)
const served = [coinA, coinB];
const coinsByAddr = { [A.toLowerCase()]: [coinA], [B.toLowerCase()]: [coinB] };

// A taker-bound CSD-want open offer bound to A (the reviewed account). Outputs sized by the SAME
// vendored requiredFillOutputs the wallet preflight checks against, so the need-map passes exactly.
const offer = {
  id: "0x" + "5e".repeat(32), seller: "0x" + "cd".repeat(20),
  give: { ticker: "TKN", amount: "5" }, want: { value: "5000000", payto: "0x" + "ce".repeat(20) },
  status: "open", expiresEpoch: 9e15, height: 47_000, feeBps: 150, taker: A,
};
const outputs = requiredFillOutputs(offer, 5_000_000n).map(({ to, value }) => ({ to, value: Number(value) }));

console.log("A1 — fillOffer account-switch race (the FILL-RACE-1 mutation case):");
{
  const { fetchStub, stats } = mkStub({ coinsByAddr, served, offer, parkFirstTip: true });
  globalThis.fetch = fetchStub;
  const p = w.fillOffer({ proposalId: offer.id, outputs });
  await stats.tipParked;                                     // preflight is parked in the tip await…
  await w.switchAccount(B);                                  // …the user switches accounts…
  stats.releaseTip();                                        // …and the await releases
  const r = await p;
  check("a switch parked in the preflight refuses with ACCOUNT_CHANGED (never signs)", r?.ok === false && r?.code === "ACCOUNT_CHANGED");
  check("nothing was submitted", stats.submits.length === 0);
  await w.switchAccount(A);
}

console.log("A1 — no-switch control (no over-refusal on the legit path):");
{
  const { fetchStub, stats } = mkStub({ coinsByAddr, served, offer });
  globalThis.fetch = fetchStub;
  const r = await w.fillOffer({ proposalId: offer.id, outputs });
  check("the identical fill without a switch proceeds and submits", r?.ok === true && stats.submits.length === 1);
}

console.log("A1 — expectSigner backstop on send:");
{
  const { fetchStub, stats } = mkStub({ coinsByAddr, served, offer });
  globalThis.fetch = fetchStub;
  await w.switchAccount(B);
  const r = await w.send("0x" + "ef".repeat(20), 2_000_000, FEE, A);   // reviewed A, active B
  check("send with expectSigner=A while B is active refuses with ACCOUNT_CHANGED", r?.ok === false && r?.code === "ACCOUNT_CHANGED");
  check("nothing was submitted", stats.submits.length === 0);
  const r2 = await w.send("0x" + "ef".repeat(20), 2_000_000, FEE, B);  // matching signer proceeds
  check("send with the MATCHING expectSigner proceeds", r2?.ok === true && stats.submits.length === 1);
  const r3 = await w.fillOffer({ proposalId: offer.id, outputs, expectSigner: A }); // reviewed A, active B
  check("fillOffer with a mismatched expectSigner refuses before any network fetch", r3?.ok === false && r3?.code === "ACCOUNT_CHANGED");
  await w.switchAccount(A);
}

globalThis.fetch = origFetch;
console.log(`\naccount-switch-signer: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
