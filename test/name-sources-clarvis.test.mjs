// Wallet.verifyName unions the configured primary resolver with clarvis, the second source (same operator, so not
// independent of the default primary).
// That second entry is what defeats a primary that withholds the winning claim: with the primary alone the
// SPV replay proves the attacker's later claim, a valid record on its own, and the name verifies green to
// the attacker's address. The list is Wallet.nameSources(), which the confirm-time hint check reads too.
//   RED-FIRST: drop the clarvis entry from Wallet.nameSources() and (1) fails (the name verifies to
//   ATTACKER, from one source, and clarvis is never asked).
//   PAIRED HONEST PATH: (2) both sources honest: verified to the owner's address, two sources, no
//   disagreement, with the production call shape (default trade API, live clarvis base).
// Run: node --import tsx test/name-sources-clarvis.test.mjs   (offline)
import { Wallet } from "../src/core/wallet.ts";
import { memoryStore } from "../src/core/storage.ts";
import { checker } from "./helpers/check.mjs";
import { buildNameClaim, buildNameSet, addrFromPriv, ctxid, rpcTxToTx, REG_FEE, proposeTx, world, source, feeOut, pick, mkFetch } from "./_spvrig.ts";

const { check, done } = checker("Wallet.verifyName source list (primary + clarvis):");

const PRIMARY = "https://cairn-substrate.com/trade/api";            // the wallet's default trade API
const CLARVIS = "https://clarvis.cairn-substrate.com/trade/api";
const keyA = "0x" + "11".repeat(32), keyB = "0x" + "22".repeat(32);
const A = addrFromPriv(keyA).toLowerCase(), B = addrFromPriv(keyB).toLowerCase();
const TARGET = "0x" + "cd".repeat(20), ATTACKER = "0x" + "ee".repeat(20);

// A registers first and points the name at TARGET; B's later claim loses on chain but is a valid record.
const NM = "bob";
const aClaim = proposeTx({ ...pick(buildNameClaim({ name: NM })), priv: keyA, outputs: feeOut() });
const aNset = proposeTx({ ...pick(buildNameSet({ name: NM, addr: TARGET })), priv: keyA });
const bClaim = proposeTx({ ...pick(buildNameClaim({ name: NM })), priv: keyB, outputs: feeOut(REG_FEE + 1) });
const bNset = proposeTx({ ...pick(buildNameSet({ name: NM, addr: ATTACKER })), priv: keyB });
const { blocks } = world([{ height: 33700, tx: aClaim }, { height: 33705, tx: bClaim }, { height: 33710, tx: aNset }, { height: 33715, tx: bNset }]);
const H = (tx, h) => ({ txid: ctxid(rpcTxToTx(tx)), height: h, pos: 0 });
const withheld = { ok: true, resolve: { addr: ATTACKER, owner: B, via: "nset" }, events: [H(bClaim, 33705), H(bNset, 33715)] };
const honest = { ok: true, resolve: { addr: TARGET, owner: A, via: "nset" }, events: [H(aClaim, 33700), H(aNset, 33710)] };

const w = new Wallet(memoryStore());
await w.create("pw-name-sources");
w.nameSpvForTest = source(blocks, 33800);
const origFetch = globalThis.fetch;
const asked = [];
const serve = (byBase) => { const f = mkFetch(byBase); return async (url, init) => { asked.push(String(url)); return f(url, init); }; };

try {
  // (1) the primary withholds A's winning claim
  globalThis.fetch = serve({ [PRIMARY]: withheld, [CLARVIS]: honest });
  const r1 = await w.verifyName(NM);
  check("(1) clarvis is asked for the name history", asked.some((u) => u.startsWith(CLARVIS + "/cairnx/name-history/")));
  check("(1) a withholding primary is defeated: the name verifies to the chain winner's address", r1.verified === true && r1.addr === TARGET);
  check("(1) ...never to the attacker's", r1.addr !== ATTACKER);
  check("(1) two sources were used and the primary is flagged as disagreeing", r1.sources === 2 && r1.disagree === true);

  // (2) paired: both sources honest
  asked.length = 0;
  globalThis.fetch = serve({ [PRIMARY]: honest, [CLARVIS]: honest });
  const r2 = await w.verifyName(NM);
  check("(2) paired: both honest, verified to the owner's address", r2.verified === true && r2.addr === TARGET && r2.owner === A);
  check("(2) paired: two sources, no disagreement", r2.sources === 2 && r2.disagree === false);
  check("(2) paired: the primary is asked as well", asked.some((u) => u.startsWith(PRIMARY + "/cairnx/name-history/")));
} finally { globalThis.fetch = origFetch; }

done("name-sources-clarvis");
