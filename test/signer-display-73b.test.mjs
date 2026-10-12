// Plan 85 7.3b: signer-screen display and the engine edges it touches.
//
//   A. One bigint formatter. A CSD amount renders as an exact decimal (1 base unit = "0.00000001 CSD",
//      never "1e-8 CSD") on recipient rows, totals, fees and cost lines.
//      RED-FIRST: restore clearsign's `fmtCsd = (raw) => `${Number(raw) / 1e8} CSD`` (and feeLine's
//      `${fee / 1e8} CSD`) and A1-A4 fail. HONEST PATH: A5, A6. Equivalence of fmtBalance with the
//      float formatter it replaced, on values below 2^53: A7.
//   B. Token decimals outside the schema range (0..8) never scale a figure; a pinned ticker uses its
//      pinned decimals on the CSD-paid fill card.
//      RED-FIRST: B1 fails on the former formatBase (accepted 0..18), B2 on the unguarded
//      tokenAmountBothScales, B3 on fillViewHtml passing served decimals. HONEST PATH: B4, B5.
//   C. costLine for a fill no longer says the outputs go to the seller (they include the protocol fee
//      and the maker rebate). RED-FIRST: the former "paid to the seller" copy fails C1. HONEST PATH: C2.
//   D. expiryLine reads the vendored EPOCH_LEN. EPOCH_LEN is 30, the literal it replaced, so no
//      mutation can turn this red; D1 pins the output as an equivalence check.
//   E. registerContent is bounded. RED-FIRST: drop the `signal` from its fetch and E1, E2 fail
//      (E2 by timing out). HONEST PATH: E3.
//   F. A malformed fill id is refused by the fillOffer preflight itself (BAD_REQUEST), not passed
//      through as "proceed". RED-FIRST: return null for a malformed id and F1 fails. HONEST PATH: F2.
//   G. A saved remote RPC moves to the Cairn proxy on load and is announced once.
//      RED-FIRST: drop the migration block in Wallet.init and G1-G4 fail. HONEST PATH: G5-G7.
//
// Run: node --import tsx test/signer-display-73b.test.mjs   (offline)
import { checker } from "./helpers/check.mjs";
import { fmtCsd, fmtBalance, describe, costLine, feeLine, tokenQuoteHtml, tokenAmountBothScales, fillViewHtml, expiryLine } from "../src/popup/clearsign.ts";
import { registerContent } from "../src/core/node.ts";
import { Wallet } from "../src/core/wallet.ts";
import { memoryStore } from "../src/core/storage.ts";
import { EPOCH_LEN } from "../src/vendor/cairnx-spv.js";

const { check, done } = checker("signer display (Plan 85 7.3b):");
const A1 = "0x" + "a1".repeat(20), A2 = "0x" + "a2".repeat(20);
const PID = "0x" + "5e".repeat(32);
const PROXY = "https://cairn-substrate.com/api/rpc";

console.log("A. one exact CSD formatter");
check("A1 fmtCsd(1) is 0.00000001 CSD", fmtCsd(1) === "0.00000001 CSD");
const tiny = describe({ method: "send", params: { outputs: [{ to: A1, value: 1 }, { to: A2, value: 2 }], fee: 1 } });
check("A2 a send of 1 base unit renders exactly on its recipient row, total and fee", tiny.includes("0.00000001 CSD") && tiny.includes("total: <b>0.00000003 CSD</b>") && tiny.includes("fee: 0.00000001 CSD") && !/e-\d/.test(tiny));
check("A3 feeLine renders a 1 base unit fee exactly", feeLine(1) === "fee: 0.00000001 CSD");
check("A4 costLine renders a 1 base unit fee exactly", costLine({ method: "attest", params: { fee: 1 } }) === "cost: 0.00000001 CSD network fee.");
check("A5 honest: a 1.5 CSD send still reads 1.5 CSD", describe({ method: "send", params: { to: A1, amount: 150_000_000, fee: 1_000_000 } }).includes("<b>1.5 CSD</b>"));
check("A6 honest: a fee above the 5 CSD mark still warns, a normal fee does not", feeLine(600_000_000).includes("unusually large fee") && !feeLine(1_000_000).includes("unusually"));
{
  const old = (base) => (base / 1e8).toLocaleString(undefined, { maximumFractionDigits: 4 });
  const samples = [0, 1, 5_000, 12_345, 99_999_999, 100_000_000, 123_456_789, 1_054_000_000_000, -2_500_000, 2 ** 53 - 1];
  const diff = samples.filter((v) => fmtBalance(v) !== old(v));
  check(`A7 fmtBalance equals the float formatter it replaced on ${samples.length} values below 2^53`, diff.length === 0);
}

console.log("B. token decimals");
check("B1 tokenQuoteHtml shows base units only when served decimals are outside 0..8",
  (() => { const h = tokenQuoteHtml({ ok: true, ticker: "TOK", total: "500", amount: "490", fee: "10", wantDecimals: 12 }); return h.includes("<b>500</b> base units of <b>TOK</b>") && !h.includes("0.0000000005"); })());
check("B2 tokenAmountBothScales never presents base units as a human figure on out-of-range decimals",
  tokenAmountBothScales("500", 12, "TOK") === "500 base units of TOK");
check("B3 the CSD-paid fill card scales CAIRN by its pinned 8 decimals, not a served 0",
  fillViewHtml({ ok: true, offerId: PID, giveTicker: "CAIRN", giveAmount: "100000000", giveDecimals: 0 }, PID).includes("1 CAIRN = 100000000 base units"));
check("B4 honest: a served 2 on an unpinned token still scales", tokenQuoteHtml({ ok: true, ticker: "TOK", total: "500", amount: "490", fee: "10", wantDecimals: 2 }).includes("<b>5 TOK</b>"));
check("B5 honest: a fill card without decimals for an unpinned token shows base units",
  fillViewHtml({ ok: true, offerId: PID, giveTicker: "FOO", giveAmount: "7" }, PID).includes("7 base units of FOO"));

console.log("C. fill cost line");
const fill = { method: "fillOffer", params: { proposalId: PID, outputs: [{ to: A1, value: 500_000_000 }, { to: A2, value: 7_500_000 }], fee: 5_000_000 } };
check("C1 the fill cost line does not say the outputs go to the seller", !/seller/i.test(costLine(fill)));
check("C2 honest: it states the full amount out and the network fee", costLine(fill) === "cost: 5.075 CSD to the recipients listed above + 0.05 CSD network fee, atomic with the fill.");

console.log("D. epoch length");
check(`D1 24 epochs from now read as about a day (EPOCH_LEN ${EPOCH_LEN})`, expiryLine(124, 100).includes("in ~1 day(s)") && expiryLine(101, 100).includes("in ~1 h"));

console.log("E. registerContent timeout");
{
  const orig = globalThis.fetch;
  let seen = null;
  globalThis.fetch = (url, init) => { seen = init; return new Promise((_, rej) => init?.signal?.addEventListener("abort", () => rej(init.signal.reason))); };
  const p0 = registerContent("https://api.example", { v: 1 }, PID);
  check("E1 the production call passes an abort signal to fetch", seen?.signal instanceof AbortSignal && seen.signal.aborted === false);
  p0.catch(() => {});
  const r = await Promise.race([registerContent("https://api.example", { v: 1 }, PID, 50), new Promise((res) => setTimeout(() => res("hung"), 2000))]);
  check("E2 a hung POST resolves {ok:false} once the timeout fires", r !== "hung" && r?.ok === false);
  globalThis.fetch = async (_u, init) => ({ ok: true, json: async () => ({ ok: true, echo: JSON.parse(init.body).txid }) });
  const good = await registerContent("https://api.example", { v: 1 }, PID);
  check("E3 honest: a prompt answer passes through unchanged", good?.ok === true && good.echo === PID);
  globalThis.fetch = orig;
}

console.log("F. malformed fill id");
{
  const orig = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (u) => { urls.push(String(u)); return { ok: false, status: 404, json: async () => ({}) }; };
  const w = new Wallet(memoryStore()); await w.create("pw-73b-preflight");
  const me = (await w.status()).addr;
  const bad = await w["fillOfferPreflight"]("0x1234", [{ to: A1, value: 1 }], me);
  check("F1 a malformed id is refused BAD_REQUEST by the preflight, with no read", bad?.ok === false && bad.code === "BAD_REQUEST" && urls.length === 0);
  const honest = await w["fillOfferPreflight"](PID, [{ to: A1, value: 1 }], me);
  check("F2 honest: a well-formed id goes on to read the offer (404 here: OFFER_UNKNOWN)", urls.some((u) => u.includes(`/cairnx/offer/${PID}`)) && honest?.code === "OFFER_UNKNOWN");
  globalThis.fetch = orig;
}

console.log("G. saved remote RPC");
{
  const REMOTE = "https://my-node.example/rpc";
  const s = memoryStore();
  await s.set("rpc", REMOTE);
  await s.set("customRpcs", [REMOTE, "http://127.0.0.1:9000"]);
  const w = new Wallet(s); await w.init();
  check("G1 the wallet loads on the Cairn proxy", w.rpc === PROXY && (await s.get("rpc")) === PROXY);
  check("G2 status reports the moved RPC once for the popup notice", (await w.status()).rpcMovedFrom === REMOTE);
  check("G3 the remote entry leaves the RPC menu; the local one stays", JSON.stringify(await w.rpcList()) === JSON.stringify(["http://127.0.0.1:9000"]));
  const orig = globalThis.fetch; const urls = [];
  globalThis.fetch = async (u) => { urls.push(String(u)); return { ok: true, status: 200, json: async () => ({ height: 1 }) }; };
  await w.tip().catch(() => null);
  globalThis.fetch = orig;
  check("G4 the next chain read goes to the Cairn proxy, not the remote host", urls.length > 0 && urls.every((u) => u.startsWith(PROXY)));
  await w.dismissRpcNotice();
  const w2 = new Wallet(s); await w2.init();
  check("G5 honest: after the notice was shown, a reload says nothing more", (await w2.status()).rpcMovedFrom === null && w2.rpc === PROXY);
  for (const local of ["http://127.0.0.1:8789", "http://localhost:18789", "https://localhost:8443", PROXY]) {
    const sl = memoryStore(); await sl.set("rpc", local);
    const wl = new Wallet(sl); await wl.init();
    check(`G6 honest: a saved ${local} stays and raises no notice`, wl.rpc === local && (await wl.status()).rpcMovedFrom === null);
  }
  const fresh = new Wallet(memoryStore()); await fresh.init();
  check("G7 honest: a fresh install starts on the Cairn proxy with no notice", fresh.rpc === PROXY && (await fresh.status()).rpcMovedFrom === null);
}

done();
