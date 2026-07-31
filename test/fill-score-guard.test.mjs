// XR-1/FL-1 (Plan 75 P75-7): the fill SCORE guard + the token-lane CSD-output (N26) guard, on the SHIPPED
// wallet artifact, mutation-verified.
//
// XR-1/FL-1: a fill's on-chain score MUST be SCORE_FILL (100); resolve() silently NO-OPS any other score
// AFTER the payment moved (the SCORE-BURN class). The wallet REFUSES a caller-supplied score that is present
// and != 100 (never coerces), and hardcodes the signed score to 100. The live site never passes a score (CSD
// lanes default; the token lane passes 100), so this declines no honest fill.
//
// XR-1 (N26, second leg): a TOKEN-priced fill routes NO CSD (its on-chain tx is the Attest with outputs:[]).
// A DIRECT dApp fillOffer against a token-priced served offer CAN still carry CSD outputs, which the token
// lane never checked. The guard REFUSES a non-empty CSD output set on a token fill (a lying resolver/dApp
// smuggling CSD through a "token" fill the clear-sign renders as token-only).
//
// RED-FIRST: each guard's mutation (source-line removal of its MUTATE_ marker) makes the matching attack
// SUBMIT. PAIRED HAPPY-PATH: a score-OMITTED fill and a score:100 fill both submit; an honest token fill
// (outputs:[]) submits (that last one is also covered by fill-token-content.test.mjs).
//
// Run: node --import tsx test/fill-score-guard.test.mjs   (offline)
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { Wallet } from "../src/core/wallet.js";
import { memoryStore } from "../src/core/storage.js";
import { requiredFillOutputs, TREASURY_ADDR } from "../src/core/cairnx.js";
import { mkCoin, txReply } from "./_coin.js";

let pass = 0, fail = 0;
const check = (n, c) => { c ? (pass++, console.log("  ✓ " + n)) : (fail++, console.error("  ✗ " + n)); };
const origFetch = globalThis.fetch;

const SELLER = "0x" + "ee".repeat(20);
const ATTACKER = "0x" + "a7".repeat(20);
const OID = "0x" + "22".repeat(32);      // CSD-priced, taker-bound (legacy lane)
const TOID = "0x" + "77".repeat(32);     // token-priced, taker-bound
const V = 40_000_000;                    // want.value (0.4 CSD)
const coin = mkCoin(2_000_000_002);      // ~20 CSD: covers the 5-CSD attacker leg + fee + change
const served = [coin];

// The CSD taker-bound offer + its honest merkle-proven terms (injected via provenPaytoForTest so the live
// SPV path is not needed). The need-map is the whole-fill seller payment + treasury fee.
const csdOffer = (me) => ({ id: OID, seller: SELLER, status: "open", give: { ticker: "AAA", amount: "10" }, want: { value: String(V), payto: SELLER }, taker: me, height: 34000, feeBps: 150 });
const csdProven = (me) => ({ payto: SELLER.toLowerCase(), seller: SELLER.toLowerCase(), terms: { height: 34000, feeBps: 150, value: String(V), taker: me.toLowerCase(), bid: undefined, giveTicker: "AAA", giveAmount: "10", giveName: undefined, wantType: "csd" } });
const csdOuts = (me) => requiredFillOutputs(csdOffer(me), BigInt(V)).map(({ to, value }) => ({ to, value: Number(value) }));

// The token taker-bound offer + its honest token terms.
const tokOffer = (me) => ({ id: TOID, seller: SELLER, status: "open", give: { ticker: "AAA", amount: "10" }, want: { ticker: "USDX", amount: "40000000" }, taker: me, height: 34000, feeBps: 150 });
const tokProven = (me) => ({ payto: SELLER.toLowerCase(), seller: SELLER.toLowerCase(), terms: { height: 34000, feeBps: 150, value: undefined, taker: me.toLowerCase(), bid: undefined, giveTicker: "AAA", giveAmount: "10", giveName: undefined, wantType: "token" }, wantTicker: "USDX", wantAmount: "40000000" });

function mkStub(offerFor) {
  const stats = { submits: [] };
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.includes("/tx/submit")) { stats.submits.push(JSON.parse(init?.body || "{}")); return { ok: true, status: 200, json: async () => ({ ok: true, txid: "0x" + "aa".repeat(32) }) }; }
    if (u.match(/\/utxos\//)) return { ok: true, status: 200, json: async () => ({ confirmed_balance: coin.coin.value, utxos: [coin.coin] }) };
    if (u.endsWith("/tip")) return { ok: true, status: 200, json: async () => ({ height: 50_000 }) };
    if (u.includes("/cairnx/offer/")) { const id = u.split("/cairnx/offer/")[1].split("?")[0]; return { ok: true, status: 200, json: async () => offerFor(id) }; }
    const t = txReply(u, served);
    if (t) return t;
    return { ok: false, status: 404, json: async () => ({}) };
  };
  return stats;
}
async function freshWallet(pw, WalletCtor = Wallet) {
  const w = new WalletCtor(memoryStore());
  const { addr } = await w.create(pw);
  const me = addr.toLowerCase();
  w.provenPaytoForTest = (offerId) => String(offerId).toLowerCase() === TOID.toLowerCase() ? tokProven(me) : csdProven(me);
  const s = mkStub((id) => String(id).toLowerCase() === TOID.toLowerCase() ? tokOffer(me) : csdOffer(me));
  return { w, addr: me, s };
}

console.log("XR-1/FL-1 - fill score guard + token-lane CSD-output (N26) guard:\n");

// ── 1. SCORE guard: a present score != 100 is REFUSED (SCORE-BURN averted). ──
{
  const { w, addr, s } = await freshWallet("pw-score80-123");
  const r = await w.fillOffer({ proposalId: OID, outputs: csdOuts(addr), score: 80 });
  check(`a fill with score:80 (present, != 100) is REFUSED with FILL_UNSAFE (${r?.error})`, r?.ok === false && r?.code === "FILL_UNSAFE");
  check("...and nothing was submitted (the SCORE-BURN did not happen)", s.submits.length === 0);
}

// ── 2. TOKEN-outputs (N26) guard: a token fill carrying CSD outputs is REFUSED. ──
{
  const { w, s } = await freshWallet("pw-tokcsd-123");
  const r = await w.fillOffer({ proposalId: TOID, outputs: [{ to: ATTACKER, value: 5_00000000 }] });
  check(`a token fill carrying an ATTACKER CSD output is REFUSED with FILL_UNSAFE (${r?.error})`, r?.ok === false && r?.code === "FILL_UNSAFE" && /token purchase is paid in tokens/i.test(String(r?.error)));
  check("...and nothing was submitted (no CSD smuggled through a token fill)", s.submits.length === 0);
}

// ── PAIRED HAPPY-PATH (MANDATORY): the exact live-site call shapes still submit. ──
console.log("\nPAIRED HAPPY-PATH (honest fills still submit):");
{
  // (a) the load-bearing one: a fill with score OMITTED (the CSD site call shape) submits.
  const { w, addr, s } = await freshWallet("pw-omit-123");
  const r = await w.fillOffer({ proposalId: OID, outputs: csdOuts(addr) });
  check(`a fill with score OMITTED still submits (the live-site CSD call shape) (${r?.error ?? "ok"})`, r?.ok === true && s.submits.length === 1);
}
{
  // (b) a fill with score:100 (the token-lane site call shape) submits.
  const { w, addr, s } = await freshWallet("pw-100-123");
  const r = await w.fillOffer({ proposalId: OID, outputs: csdOuts(addr), score: 100 });
  check(`a fill with score:100 still submits (${r?.error ?? "ok"})`, r?.ok === true && s.submits.length === 1);
}
{
  // (c) an honest token fill (outputs:[]) submits (sums.size === 0, no token-outputs refusal) — the exact
  // attest->fillOffer reroute shape (outputs:[]) the site uses at actions.js:397.
  const { w, s } = await freshWallet("pw-tokhonest-123");
  const r = await w.fillOffer({ proposalId: TOID, outputs: [] });
  check(`an honest token fill (outputs:[]) still submits (${r?.error ?? "ok"})`, r?.ok === true && s.submits.length === 1);
}

// ── RED-FIRST: source-line removal of each guard's marker makes the matching attack SUBMIT. ──
console.log("\nMUTATION (each guard is the sole rejecter):");
const here = path.dirname(fileURLToPath(import.meta.url));
const WSRC = path.join(here, "..", "src", "core", "wallet.ts");
async function withGuardRemoved(marker, run) {
  const lines = readFileSync(WSRC, "utf8").split("\n");
  const kept = lines.filter((l) => !l.includes(marker));
  if (kept.length !== lines.length - 1) throw new Error(`marker ${marker} must match exactly one line (matched ${lines.length - kept.length})`);
  const tmp = path.join(here, "..", "src", "core", `__mutant_scoreguard_${Date.now()}.ts`);
  writeFileSync(tmp, kept.join("\n"));
  try { return await run(await import(pathToFileURL(tmp).href)); }
  finally { unlinkSync(tmp); }
}
{
  const mut = await withGuardRemoved("MUTATE_SCORE_GUARD", async (mod) => {
    const { w, addr, s } = await freshWallet("pw-scoremut-123", mod.Wallet);
    const r = await w.fillOffer({ proposalId: OID, outputs: csdOuts(addr), score: 80 });
    return { r, submits: s.submits.length };
  });
  check("MUTATION[MUTATE_SCORE_GUARD removed]: the score:80 fill now SUBMITS (guard is the sole rejecter)", mut.r?.ok === true && mut.submits === 1);
}
{
  const mut = await withGuardRemoved("MUTATE_TOKEN_OUTPUTS_GUARD", async (mod) => {
    const { w, s } = await freshWallet("pw-tokmut-123", mod.Wallet);
    const r = await w.fillOffer({ proposalId: TOID, outputs: [{ to: ATTACKER, value: 5_00000000 }] });
    // the signed tx carries the attacker's 5-CSD CSD output (smuggled through a "token" fill).
    const outs = s.submits[0]?.tx?.outputs ?? [];
    const smuggled = s.submits.length === 1 && outs.some((o) => Number(o.value) === 5_00000000);
    return { r, submits: s.submits.length, smuggled };
  });
  check("MUTATION[MUTATE_TOKEN_OUTPUTS_GUARD removed]: the attacker-CSD token fill now SUBMITS with the CSD output (guard is the sole rejecter)", mut.r?.ok === true && mut.submits === 1 && mut.smuggled === true);
}

globalThis.fetch = origFetch;
console.log(`\nfill-score-guard: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
