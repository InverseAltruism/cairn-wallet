// B5g/B5h/B5i (REBIND, wallet display-truth): W8+F12 token amounts in BOTH scales, M3 quote attribution,
// M10 honest no-change tombstone, M14 reveal-claim preview, M15 capped-and-loud dApp text with money rows
// first, and the four clear-sign copy LOWs (the 1.5% fee strings, the ~40-block claim window, the missing
// fclaim case, the score-50 V28 no-op warning). Pure-formatter checks + source-pinned use-sites (the
// campaign's use-site pinning idiom: a helper test alone stays green if a caller reverts to the old render).
//
// MUTATION CONTRACT (each executed RED at authoring, see the batch record):
//   - reverting tc-amt / the sent toast to human-only fails the W8 pins
//   - restoring "You will pay" (first-person) fails the M3 attribution checks + pin
//   - restoring "likely never landed" fails the M10 pins
//   - restoring the 18-char txid slice / dropping #reveal-preview fails the M14 checks
//   - re-ordering uri above the money rows, or quiet-truncating, fails the M15 checks
//   - restoring "1%" / "~15 blocks", dropping the fclaim case or the V28 warn fails the LOW checks
//
// Run: node --import tsx test/display-truth.test.mjs   (offline)
import { readFileSync } from "node:fs";
import { describe, costLine, truncLoud, tokenAmountBothScales, tokenQuoteHtml, revealPreviewHtml } from "../src/popup/clearsign.ts";
import { canonicalJson, cairnxPayloadHash, CAIRNX_DOMAIN, V28_HEIGHT, CLAIM_WINDOW_BLOCKS_V20, FEE_BPS_V16 } from "../src/core/cairnx.ts";

let pass = 0, fail = 0;
const ok = (n, c) => { c ? pass++ : fail++; console.log(`  ${c ? "PASS" : "FAIL"} ${n}`); };
const ID = "0x" + "ab".repeat(32);

// Ground truth for the consensus values the copy now renders from (independent of the render under test:
// V16 stamped 150 bps on every offer since, and the legacy claim window is 40 blocks).
ok("ground truth: FEE_BPS_V16 is 150 bps (1.5%)", FEE_BPS_V16 === 150);
ok("ground truth: CLAIM_WINDOW_BLOCKS_V20 is 40", CLAIM_WINDOW_BLOCKS_V20 === 40);
ok("ground truth: V28_HEIGHT is 60000", V28_HEIGHT === 60_000);

// ── W8 + F12: both scales, single-sourced ────────────────────────────────────
ok("W8: both scales rendered (human + base units)", tokenAmountBothScales("500000000", 8, "TOK") === "5 TOK = 500000000 base units");
ok("W8: 0-decimals token still shows both scales", tokenAmountBothScales("7", 0, "ZRO") === "7 ZRO = 7 base units");
{
  // The point of the fix: a LYING decimals rescales the human half, but the signed base-unit half is
  // untouched, so the rescale is visible on the card instead of round-tripping invisibly (audit W8).
  const lied = tokenAmountBothScales("500000000", 2, "TOK"); // resolver claims 2 decimals instead of 8
  ok("W8: a decimals lie cannot touch the base-unit half (rescale becomes visible)",
    lied.startsWith("5000000 TOK") && lied.includes("= 500000000 base units"));
}

// ── M3: the token-fill quote is ATTRIBUTED, never a first-person debit ───────
{
  const q = { ok: true, ticker: "TOK", amount: "1000", fee: "15", total: "1015" };
  const html = tokenQuoteHtml(q);
  ok("M3: quote is attributed to the offer service", /per the offer service/i.test(html));
  ok("M3: no first-person debit assertion", !/you will pay/i.test(html));
  ok("M3: quote shows total + ticker in labeled base units", html.includes("1015") && html.includes("TOK") && html.includes("base units"));
  ok("M3: quote states the wallet cannot verify the number", /cannot verify/i.test(html));
  ok("M3: estimated flag still surfaces", tokenQuoteHtml({ ...q, estimated: true }).includes("estimated"));
  ok("M3: failed quote keeps the loud do-NOT-approve caution", /Do NOT approve/.test(tokenQuoteHtml({ ok: false, error: "offer gone" })));
  ok("M3: null quote (bridge threw) keeps the loud caution", /Do NOT approve/.test(tokenQuoteHtml(null)) && tokenQuoteHtml(null).includes("offer unavailable"));
  ok("M3: hostile quote error is escaped", !tokenQuoteHtml({ ok: false, error: "<img src=x>" }).includes("<img"));
}

// ── M14: reveal-claim shows WHICH secret goes public ─────────────────────────
{
  const html = describe({ method: "revealClaim", params: ID });
  ok("M14: the FULL seal txid is shown (not an 18-char slice)", html.includes(ID));
  ok("M14: the reveal preview slot is mounted for approve.ts", html.includes('id="reveal-preview"'));
  ok("M14: preview renders domain + claim text as going PUBLIC", (() => {
    const p = revealPreviewHtml({ domain: "csd:sealed", claim: "the earth is round" });
    return p.includes("csd:sealed") && p.includes("the earth is round") && /PUBLIC/.test(p);
  })());
  ok("M14: no record for this txid warns LOUDLY (nothing to reveal)", /NO sealed claim/.test(revealPreviewHtml(null)));
  ok("M14: a failed lookup is a DISTINCT caution (not 'no such claim')", (() => {
    const p = revealPreviewHtml({ failed: true });
    return /could not load/.test(p) && !/NO sealed claim/.test(p);
  })());
  ok("M14: an undecryptable record still warns a secret WILL be published", /could not be decrypted/.test(revealPreviewHtml({ domain: "d" })));
  ok("M14: a long claim is truncated LOUDLY at the stated cap", (() => {
    const p = revealPreviewHtml({ domain: "d", claim: "x".repeat(400) });
    return p.includes("truncated") && p.includes("300") && p.includes("400");
  })());
  ok("M14: hostile claim text is escaped", !revealPreviewHtml({ domain: "d", claim: "<script>alert(1)</script>" }).includes("<script>"));
}

// ── M15: capped-and-LOUD dApp text; money rows above free text ───────────────
ok("M15: truncLoud passes short text through untouched", truncLoud("hello", 20) === "hello");
ok("M15: truncLoud marks the cut with the cap AND the real length, err-class", (() => {
  const t = truncLoud("x".repeat(30), 20);
  return t.includes("showing the first 20 of 30 characters") && t.includes('class="err"');
})());
ok("M15: truncLoud escapes after slicing (no live markup)", (() => {
  const t = truncLoud("<b>" + "y".repeat(100), 10);
  return t.includes("&lt;b&gt;") && !t.includes("<b>y");
})());
{
  const ADDR = "0x" + "cd".repeat(20);
  const bigUri = "A".repeat(5000);
  const html = describe({ method: "propose", params: { domain: "evil:site", fee: 1_000_000, uri: bigUri, payloadHash: "0x" + "11".repeat(32), outputs: [{ to: ADDR, value: 300_000_000 }] } });
  ok("M15: an oversized dApp uri is truncated LOUDLY at the node's 512 cap", html.includes("truncated") && html.includes("512") && html.includes("5000"));
  ok("M15: the funds-out rows render ABOVE the dApp uri", html.indexOf("transfers funds OUT") !== -1 && html.indexOf("transfers funds OUT") < html.indexOf("uri:"));
  ok("M15: the fee row renders ABOVE the dApp domain + uri", html.indexOf("fee:") < html.indexOf("domain:") && html.indexOf("fee:") < html.indexOf("uri:"));
  ok("M15: a valid-length uri gets NO truncation marker (no false alarm)",
    !describe({ method: "propose", params: { domain: "evil:site", fee: 1_000_000, uri: "B".repeat(512) } }).includes("truncated"));
  // G9 (B8w): the domain display cap now tracks the node's MAX_DOMAIN_BYTES (128), so a 300-char domain
  // (well over the on-chain cap) still truncates LOUDLY, now at 128 rather than the old 64.
  const bigDomain = describe({ method: "propose", params: { domain: "D".repeat(300), fee: 1_000_000, uri: "u" } });
  ok("M15: an oversized dApp domain is truncated LOUDLY", bigDomain.includes("showing the first 128 of 300"));
  const seal = describe({ method: "sealClaim", params: { domain: "csd:sealed", claim: "C".repeat(500), fee: 25_000_000 } });
  ok("M15: sealClaim fee row renders ABOVE the dApp claim text", seal.indexOf("fee:") !== -1 && seal.indexOf("fee:") < seal.indexOf("claim:"));
  ok("M15: sealClaim claim text is truncated LOUDLY (no quiet ellipsis)", seal.includes("showing the first 200 of 500"));
  const bigId = describe({ method: "attest", params: { proposalId: "P".repeat(400), score: 80, confidence: 70, fee: 5_000_000 } });
  ok("M15: an oversized attest target id is truncated LOUDLY", bigId.includes("showing the first 80 of 400"));
}

// ── LOW: the fee-rate strings render the real 150 bps (was '1%') ─────────────
{
  const atok = describe({ method: "attest", params: { proposalId: ID, score: 100, confidence: 1_000_000, fee: 5_000_000 } });
  const ftok = describe({ method: "fillOffer", params: { proposalId: ID, score: 100, confidence: 1_000_000, outputs: [], fee: 5_000_000 } });
  const rate = `${FEE_BPS_V16 / 100}%`;
  ok("LOW-fee: token-fill attest states the 1.5% protocol fee", atok.includes(`${rate} protocol fee`) && !/\+ 1% /.test(atok));
  ok("LOW-fee: token-fill fillOffer states the 1.5% protocol fee", ftok.includes(`${rate} protocol fee`) && !/\+ 1% /.test(ftok));
  ok("LOW-fee: costLine(attest, token fill) states 1.5%", costLine({ method: "attest", params: { confidence: 1_000_000, fee: 5_000_000 } }).includes(rate));
}

// ── LOW: the score-50 reservation window is ~40 blocks (was '~15') ───────────
{
  const claim = describe({ method: "attest", params: { proposalId: ID, score: 50, confidence: 0, fee: 5_000_000 } });
  ok("LOW-window: the claim window renders from CLAIM_WINDOW_BLOCKS_V20 (~40 blocks)", claim.includes(`~${CLAIM_WINDOW_BLOCKS_V20} blocks`));
  ok("LOW-window: the false '~15 blocks' figure is gone", !claim.includes("~15 blocks"));
}

// ── LOW: score-50 past V28 warns it is a guaranteed on-chain no-op ───────────
{
  const base = { method: "attest", params: { proposalId: ID, score: 50, confidence: 0, fee: 5_000_000 } };
  ok("LOW-V28: no floor threaded, no warning (today's behavior)", !/REJECTED on-chain/.test(describe(base)));
  ok("LOW-V28: floor below the gate, no warning (no false alarm mid-transition)", !/REJECTED on-chain/.test(describe({ ...base, tipFloor: V28_HEIGHT - 1 })));
  const warned = describe({ ...base, tipFloor: V28_HEIGHT });
  ok("LOW-V28: PoW-backed floor at the gate warns REJECTED on-chain (fee-costing no-op)", /REJECTED on-chain/.test(warned) && warned.includes(String(V28_HEIGHT)));
  ok("LOW-V28: the warning is a warn, not a re-label (reserve copy still present)", /Reserve an open offer/.test(warned));
}

// ── LOW: the v2.8 fclaim record clear-signs structurally (no raw-JSON fallback) ─
{
  const rec = { v: 1, t: "fclaim", offer: "0x" + "ef".repeat(32) };
  const html = describe({ method: "propose", params: { domain: CAIRNX_DOMAIN, uri: canonicalJson(rec), payloadHash: cairnxPayloadHash(rec), fee: 25_000_000, expiresEpoch: 2000 } });
  ok("LOW-fclaim: a V28 open-lane claim clear-signs as a reservation", /Reserve an open offer/.test(html) && /moves no money/i.test(html));
  ok("LOW-fclaim: the claimed offer id is shown", html.includes("ef".repeat(32)));
  ok("LOW-fclaim: no raw-JSON fallback (the rubber-stamp failure mode)", !html.includes("Post a proposal"));
  ok("LOW-fclaim: the hold expiry (the carrying propose's) still renders", html.includes("expires"));
}

// ── N22 counter-case: a deploy's decimals are SIGNED bytes, so the human scale is provable ─
{
  const rec = { v: 1, t: "deploy", ticker: "TOK", decimals: 2, supply: "123456", mint: "issuer" };
  const html = describe({ method: "propose", params: { domain: CAIRNX_DOMAIN, uri: canonicalJson(rec), payloadHash: cairnxPayloadHash(rec), fee: 25_000_000 } });
  ok("N22: deploy supply renders base units AND the record-proven human scale", html.includes("123456") && html.includes("= 1234.56 at 2 decimals"));
}

// ── Source pins (use-site truth: a helper test alone cannot see a reverted caller) ─
{
  const popupSrc = readFileSync(new URL("../src/popup/popup.ts", import.meta.url), "utf8");
  const approveSrc = readFileSync(new URL("../src/popup/approve.ts", import.meta.url), "utf8");
  ok("PIN W8: the token review card renders via tokenAmountBothScales at its use-site", /\$\("tc-amt"\)\.textContent = tokenAmountBothScales\(/.test(popupSrc));
  ok("PIN W8: the sent toast renders via tokenAmountBothScales", popupSrc.includes("sent ${tokenAmountBothScales(base, tsend.decimals, tsend.ticker)}"));
  ok("PIN M10: the affirmative 'likely never landed' claim is gone from popup.ts", !popupSrc.includes("likely never landed"));
  ok("PIN M10: the >1h tombstone states the change-output blind spot honestly", popupSrc.includes("cannot be confirmed from here"));
  ok("PIN M3: approve.ts renders the quote via the attributed tokenQuoteHtml", approveSrc.includes("show(tokenQuoteHtml(q))"));
  ok("PIN M3: no first-person 'You will pay' debit assertion remains in approve.ts", !approveSrc.includes("You will pay"));
  ok("PIN M14: approve.ts wires fillRevealPreview into render()", approveSrc.includes("fillRevealPreview(current)"));
  ok("PIN M14: the preview reads the LOCAL sealedClaims store (no network)", approveSrc.includes('call("sealedClaims")'));
  ok("PIN B5h: a score-50 attest threads only the LOCAL tipFloor (no tip/network fetch added)", /method === "attest"[\s\S]{0,900}?call\("tipFloor"\)/.test(approveSrc) && !/method === "attest"[\s\S]{0,900}?call\("tip"\)[^F]/.test(approveSrc));
}

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
