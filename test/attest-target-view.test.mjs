// The cancel title's read: what an attest's target is, from the node's /proposal answer (cairnxview.ts
// attestTargetView), and the approval window's use of it before the paint (approve.ts).
//   RED-FIRST: drop the attestTarget read in approve.ts and section 3's own-offer case reads "Support / review" with the
//   unknown note; classify every target as "other" and sections 1 and 3 fail.
//   PAIRED HONEST PATHS: a proposal of another domain is "other" (1); an unreadable or malformed answer is not ok, so
//   the window says what it knows (2); another account's offer keeps "Support / review" (3).
// Run: npx tsx test/attest-target-view.test.mjs   (offline)
import "./helpers/backup-host.mjs";
import { attestTargetView } from "../src/core/cairnxview.ts";
import { offer, bid } from "../src/vendor/cairnx-spv.js";
import { CAIRNX_DOMAIN } from "../src/core/cairnx.ts";
import { mountApproveWindow, loadApprove, flush, sleep } from "./helpers/approve-dom.mjs";
import { checker } from "./helpers/check.mjs";

const { check, done } = checker("an attest's target, for the cancel title:");
const RPC = "https://rpc.example/api/rpc";
const ME = "0x" + "a1".repeat(20), THEM = "0x" + "b2".repeat(20);
const id = (b) => "0x" + b.repeat(32);
const OFFER = offer({ give: { ticker: "AAA", amount: "10" }, want: { value: "100000000" } });
const BID = bid({ want: { ticker: "AAA", amount: "10" }, give: { value: "100000000" } });
const proposals = new Map([
  [id("01"), { domain: CAIRNX_DOMAIN, uri: OFFER.uri, payload_hash: OFFER.payloadHash, proposer: ME.toUpperCase().replace("0X", "0x") }],
  [id("02"), { domain: CAIRNX_DOMAIN, uri: BID.uri, payload_hash: BID.payloadHash, proposer: ME }],
  [id("03"), { domain: "board:v1", uri: "data:,hi", payload_hash: id("ee"), proposer: ME }],
  [id("04"), { domain: CAIRNX_DOMAIN, uri: OFFER.uri, payload_hash: id("ee"), proposer: ME }],   // hash does not commit the record
  [id("05"), { domain: CAIRNX_DOMAIN, uri: OFFER.uri, payload_hash: OFFER.payloadHash, proposer: "nobody" }],
  [id("06"), { domain: CAIRNX_DOMAIN, uri: OFFER.uri, payload_hash: OFFER.payloadHash, proposer: THEM }],
]);
const reads = [];
globalThis.fetch = async (url) => {
  const u = String(url);
  reads.push(u);
  const m = u.match(/\/proposal\/(0x[0-9a-f]{64})$/);
  const p = m && proposals.get(m[1]);
  if (p) return { ok: true, status: 200, json: async () => ({ ok: true, proposal: { proposal_id: m[1], ...p } }) };
  return { ok: true, status: 200, json: async () => ({ ok: false, err: "not found" }) };
};

// 1. Offers and bids by their own record, with the proposer in lower case; any other proposal is "other".
{
  const o = await attestTargetView(RPC, id("01")), b = await attestTargetView(RPC, id("02")), x = await attestTargetView(RPC, id("03"));
  check(`1. an offer record reads as an offer by its proposer, lower-cased (${JSON.stringify(o)})`, o.ok && o.kind === "offer" && o.proposer === ME);
  check(`1. a bid record reads as a bid (${JSON.stringify(b)})`, b.ok && b.kind === "bid");
  check(`1. honest path: a proposal of another domain is "other" (${JSON.stringify(x)})`, x.ok && x.kind === "other");
  const h = await attestTargetView(RPC, id("04"));
  check(`1. a record its payload hash does not commit is "other", as the resolver ignores it (${JSON.stringify(h)})`, h.ok && h.kind === "other");
}
// 2. What cannot be read is not ok: no proposal, a bad proposer, a malformed id (refused before any read).
{
  const n0 = reads.length;
  const bad = await attestTargetView(RPC, "0x1234");
  check("2. a malformed id is not ok and makes no read", !bad.ok && reads.length === n0);
  check("2. a proposal the node does not know is not ok", !(await attestTargetView(RPC, id("09"))).ok);
  check("2. a proposer that is not an address is not ok", !(await attestTargetView(RPC, id("05"))).ok);
  globalThis.fetch = async () => { throw new Error("offline"); };
  check("2. an unreachable node is not ok", !(await attestTargetView(RPC, id("01"))).ok);
}

// 3. The approval window reads the target before it paints a score-0 attest and titles it for the account on screen.
{
  const views = new Map([[id("01"), { ok: true, kind: "offer", proposer: ME }], [id("06"), { ok: true, kind: "offer", proposer: THEM }]]);
  let queue = [];
  const asked = [];
  const { registry } = mountApproveWindow({
    status: async () => ({ hasVault: true, unlocked: true, addr: ME, active: 0, accounts: [{ addr: ME, label: "Main" }] }),
    pending: async () => queue,
    attestTarget: async (pid) => { asked.push(pid); return views.get(pid) ?? { ok: false }; },
    tipFloor: async () => null, balance: async () => ({ confirmed: 10e8, utxos: [] }), history: async () => [], tip: async () => 1,
  });
  const tick = await loadApprove();
  const show = async (pid) => { queue = [{ id: "r-" + pid.slice(2, 6), origin: "https://cairn-substrate.com", method: "attest", params: { proposalId: pid, score: 0, confidence: 100, fee: 5_000_000 } }]; await tick(); await sleep(50); await flush(); return String(registry.get("req").innerHTML); };
  const mine = await show(id("01"));
  check(`3. the window asked for the target before painting (${asked.join(",").slice(0, 80)})`, asked.includes(id("01")));
  check("3. the site's cancel of the user's own offer paints 'Cancel your offer'", /Cancel your offer/.test(mine));
  const theirs = await show(id("06"));
  check("3. honest path: score 0 on another account's offer keeps 'Support / review'", /Support \/ review/.test(theirs) && !/Cancel your/.test(theirs));
  const unknown = await show(id("07"));
  check("3. an unreadable target says what is known", /could not read the target/.test(unknown));
}
done("attest-target-view");
