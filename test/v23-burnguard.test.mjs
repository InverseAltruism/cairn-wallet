// v23-burnguard.test.mjs — two wallet-side properties the upstream consensus tests can't cover:
//   A. the M1 universal zero-address burn guard in core/node.ts: EVERY value-moving path (send, sendMany,
//      fillOffer, propose) refuses a 0x000…0 recipient client-side, before any network call. (The popup send
//      form already blocked it; the dApp paths bypass that form, so the backstop lives in assembleValueTx.)
//   B. the VENDORED resolver (src/vendor/cairnx-spv.js) actually carries the V23 clear branch: a >=V23
//      nset→zero clears n.addr (resolves to owner), and a <V23 one keeps the literal zero (old behavior).
//      This is a behavioral regression guard against shipping a stale vendor (the 0.2.34 stale-0.1.20 trap).
// Run: tsx test/v23-burnguard.test.mjs
import { send, sendMany, fillOffer, propose } from "../src/core/node.js";
import { buildNameClaim, buildNameSet, TREASURY_ADDR } from "../src/core/cairnx.ts";
import { resolve, V23_HEIGHT, ZERO_ADDR } from "../src/vendor/cairnx-spv.js";   // pull the gate height from the bundle so this test self-maintains when the release height changes

let pass = 0, fail = 0;
const ok = (n, c) => { c ? pass++ : fail++; console.log(`  ${c ? "✓" : "✗"} ${n}`); };

const ZERO = ZERO_ADDR;                    // "0x" + 40 zeros, straight from the vendored bundle
const PRIV = "0x" + "11".repeat(32);
const RPC = "http://127.0.0.1:0";          // never reached: the guard returns before any fetch
const HASH = "0x" + "ab".repeat(32);       // a well-formed payloadHash/proposalId
const isBurn = (r) => r && r.ok === false && /zero address/i.test(String(r.error));

console.log("A. universal zero-address burn guard (core/node.ts assembleValueTx) — every value path:");
{
  ok("send → 0x0 refused (no network)", isBurn(await send(RPC, { to: ZERO, amount: 1, fee: 1000 }, PRIV)));
  ok("sendMany → output to 0x0 refused", isBurn(await sendMany(RPC, { outputs: [{ to: ZERO, value: 1 }], fee: 1000 }, PRIV)));
  ok("fillOffer → output to 0x0 refused", isBurn(await fillOffer(RPC, { proposalId: HASH, score: 1, confidence: 1, outputs: [{ to: ZERO, value: 1 }], fee: 50_000_000 }, PRIV)));
  ok("propose → fee output to 0x0 refused", isBurn(await propose(RPC, { domain: "cairnx:v1", payloadHash: HASH, uri: "x", expiresEpoch: 100, fee: 1000, outputs: [{ to: ZERO, value: 1 }] }, PRIV)));
  // negative control: a mixed-case all-zero still all-zero (the /i flag) — still refused
  ok("send → mixed-case 0x0 still refused", isBurn(await send(RPC, { to: "0x" + "00".repeat(20), amount: 1, fee: 1000 }, PRIV)));
}

console.log("B. vendored resolver carries the V23 clear branch (regression guard vs a stale vendor):");
{
  const D = "0x" + "da".repeat(20);                 // the owner address
  const TREAS = String(TREASURY_ADDR).toLowerCase();
  const REG_FEE = 1_000_000_000;                    // 10 CSD — generously above any nameRegFee
  let _id = 0; const nid = () => "0x" + (++_id).toString(16).padStart(64, "0");
  const reg = (ev, name, h) => { const b = buildNameClaim({ name }); ev.push({ kind: "propose", id: nid(), proposer: D, uri: b.uri, payloadHash: b.payloadHash, expiresEpoch: 9_000_000_000_000, height: h, pos: 1, paidTo: { [TREAS]: REG_FEE.toString() } }); };
  const set = (ev, name, addr, h) => { const b = buildNameSet({ name, addr }); ev.push({ kind: "propose", id: nid(), proposer: D, uri: b.uri, payloadHash: b.payloadHash, expiresEpoch: 9_000_000_000_000, height: h, pos: 1, paidTo: {} }); };

  // gate boundary comes straight from the vendored bundle (self-maintaining across a release height change).
  const V23 = V23_HEIGHT;
  // above the gate: register, self-point, then clear → addr must be UNDEFINED (resolves to owner)
  const up = []; reg(up, "swap", V23 + 10); set(up, "swap", D, V23 + 12); set(up, "swap", ZERO, V23 + 14);
  const sUp = resolve(up, V23 + 20).names["swap"];
  ok("≥V23 nset→0x0 CLEARS addr (undefined)", sUp && sUp.addr === undefined && sUp.owner === D);

  // below the gate: the SAME clear keeps the literal zero (pre-V23 behavior, byte-identical to 0.1.20)
  const dn = []; reg(dn, "swap2", V23 - 40); set(dn, "swap2", D, V23 - 38); set(dn, "swap2", ZERO, V23 - 36);
  const sDn = resolve(dn, V23 - 20).names["swap2"];
  ok("<V23 nset→0x0 keeps literal zero (old behavior)", sDn && String(sDn.addr).toLowerCase() === ZERO);
}

console.log(`\nv23-burnguard: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
