// The approval window keeps the release bound when its reads from the background fail or time out. The REAL
// src/popup/approve.ts on the repo's fake DOM, its background answers served by the test: `tip` and `tipFloor`
// answer (a served tip of 39,000 and a floor of 0), reject, or never answer (the window's 2.5 s bound).
//   1. A site-built renewal of "abc" paying the 39,000 tier (5 CSD; 15 CSD at any height this release can see) is
//      warned as underpaid in all three cases; one paying 15 CSD is not.
//   2. A legacy reservation (score 50, confidence 0) carries the V28 warning in all three cases.
//   3. A fill card counts its blocks left only from a served tip at or above the release anchor. With the tip lower or
//      missing it shows the expiry block alone, and still names the refusal of an offer that expired below the anchor.
// The window combines the reads that answered with chainbound.ts lowestChainHeight; no read of its own carries the
// bound. RED-FIRST: drop the bound from describe()'s fee or V28 line, or from cardTip, and the matching cases fail.
//
// Run: TSX_DISABLE_CACHE=1 node --import tsx test/approve-bound-dom.test.mjs   (offline)
import { checker } from "./helpers/check.mjs";
import { installFakeDom, installBridge, flush } from "./_fakedom.mjs";
import { APPROVE_IDS } from "./helpers/approve-dom.mjs";
import { buildNameRenew, nameRegFee, buildFeeHeight, CAIRNX_DOMAIN, TREASURY_ADDR } from "../src/core/cairnx.ts";
import { SPV_NEWEST_HEIGHT } from "../src/core/spvnewest.ts";

const { check, done } = checker("the approval window keeps the release bound when its reads miss:");
const ME = "0x" + "ab".repeat(20), SELLER = "0x" + "30".repeat(20), LIST = "0x" + "a1".repeat(32);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { byId, registry, El } = installFakeDom();
for (const id of APPROVE_IDS) registry.set(id, new El(id));

// mode: "ok" answers, "reject" throws, "hang" never answers.
const state = { pending: [], mode: "ok", calls: [], expiresAt: SPV_NEWEST_HEIGHT + 30 };
const read = (value) => () => {
  if (state.mode === "reject") throw new Error("read failed");
  if (state.mode === "hang") return new Promise(() => { /* never answers: the window gives up after 2.5 s */ });
  if (state.mode === "high" && value === 39_000) return SPV_NEWEST_HEIGHT + 1_000;   // an honest tip past the anchor
  return value;
};
const h = {
  status: () => ({ unlocked: true, accounts: [{ label: "A1", addr: ME }], active: 0, addr: ME, tradeApi: "https://x/trade/api" }),
  pending: () => state.pending,
  balance: () => ({ confirmed: 100e8 }),
  history: () => [],
  sealedClaims: () => [],
  tokenDisplayMeta: () => ({}),
  epoch: () => 1_300,
  tip: (...a) => { state.calls.push("tip"); return read(39_000)(...a); },
  tipFloor: (...a) => { state.calls.push("tipFloor"); return read(0)(...a); },
  fillOfferView: () => ({ ok: true, offerId: LIST, giveTicker: "CAIRN", giveAmount: "100000000", giveDecimals: 8, expiresAt: state.expiresAt }),
  resolve: () => ({ ok: true, txid: "0x" + "ee".repeat(32) }),
};
installBridge(h);
globalThis.fetch = async () => ({ status: 200, ok: true, json: async () => ({ name: "abc", owner: ME, addr: ME, pending: false }) });
let tick = null;
const realSetInterval = globalThis.setInterval;
globalThis.setInterval = (fn) => { tick = fn; return 0; };
await import("../src/popup/approve.ts");
globalThis.setInterval = realSetInterval;

let n = 0;
async function paint(req, mode) {
  state.mode = mode; state.calls = [];
  state.pending = [{ ...req, id: `r${++n}` }];
  await tick(); await flush();
  await sleep(mode === "hang" ? 3_000 : 800); await flush();
  return { html: String(byId("req")?.innerHTML ?? ""), card: String(byId("fill-view")?.innerHTML ?? "") };
}

const abc = buildNameRenew({ name: "abc" });
const low = Number(nameRegFee("abc", buildFeeHeight(39_000)));
const right = Number(nameRegFee("abc", buildFeeHeight(SPV_NEWEST_HEIGHT)));
check(`fixture: "abc" costs ${low} at 39,000 and ${right} at the release anchor`, low === 500_000_000 && right === 1_500_000_000);
const renew = (paid) => ({ method: "propose", origin: "https://cairn-substrate.com", params: { domain: CAIRNX_DOMAIN, uri: abc.uri, payloadHash: abc.payloadHash, fee: 25_000_000, expiresEpoch: 5_000, outputs: [{ to: TREASURY_ADDR, value: paid }] } });
const UNDERPAID = /below the current price/;

console.log("1. the underpaid-fee warning on a site's renewal");
for (const mode of ["ok", "reject", "hang"]) {
  const { html } = await paint(renew(low), mode);
  check(`1. reads ${mode} (tip 39,000 and floor 0 when they answer): paying 5 CSD is warned as underpaid (reads ${state.calls.join(",")})`, UNDERPAID.test(html) && state.calls.includes("tip") && state.calls.includes("tipFloor"));
}
for (const mode of ["ok", "reject"]) {
  const { html } = await paint(renew(right), mode);
  check(`1. honest: reads ${mode}, paying 15 CSD is not warned`, /Renew/i.test(html) && !UNDERPAID.test(html));
}

console.log("2. the V28 warning on a legacy reservation");
const legacy = { method: "attest", origin: "https://cairn-substrate.com", params: { proposalId: "0x" + "ef".repeat(32), score: 50, confidence: 0, fee: 1_000_000 } };
for (const mode of ["ok", "reject", "hang"]) {
  const { html } = await paint(legacy, mode);
  check(`2. reads ${mode}: the legacy reservation says it is rejected on-chain, with no tip read (${state.calls.join(",") || "none"})`, /Reserve an open offer/.test(html) && /rejected<\/b> on-chain/.test(html) && !state.calls.includes("tip"));
}

console.log("3. the fill card's tip");
const fill = { method: "fillOffer", origin: "https://cairn-substrate.com", params: { proposalId: LIST, score: 100, confidence: 100, fee: 5_000_000, outputs: [{ to: SELLER, value: 100_000_000 }, { to: TREASURY_ADDR, value: 1_500_000 }] } };
const fmt = (v) => v.toLocaleString("en-US");
for (const mode of ["ok", "reject", "hang"]) {
  state.expiresAt = SPV_NEWEST_HEIGHT + 30;
  const live = (await paint(fill, mode)).card;
  check(`3. reads ${mode} (served tip 39,000 when it answers): the card shows the expiry block alone, no count`, live.includes(`Offer expires at block ${fmt(SPV_NEWEST_HEIGHT + 30)}.`) && !/blocks|refuse/.test(live));
  state.expiresAt = SPV_NEWEST_HEIGHT - 10;
  const gone = (await paint(fill, mode)).card;
  check(`3. reads ${mode}: an offer that expired below the anchor is shown as expired and refused`, gone.includes(`Offer expired at block ${fmt(SPV_NEWEST_HEIGHT - 10)} <span class="err">(the wallet will refuse this fill)</span>.`));
}
state.expiresAt = SPV_NEWEST_HEIGHT + 1_030;
const counted = (await paint(fill, "high")).card;
check("3. honest: a served tip past the anchor counts the blocks left from it (in 30 blocks)", counted.includes(`Offer expires at block ${fmt(SPV_NEWEST_HEIGHT + 1_030)}, in 30 blocks (~1 h).`));

done("approve-bound-dom");
