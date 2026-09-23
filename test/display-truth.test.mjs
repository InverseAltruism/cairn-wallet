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
import { describe, costLine, debitOf, fmtCsd, truncLoud, tokenAmountBothScales, tokenQuoteHtml, revealPreviewHtml } from "../src/popup/clearsign.ts";
import { canonicalJson, cairnxPayloadHash, defaultFeeFor, CAIRNX_DOMAIN, V28_HEIGHT, CLAIM_WINDOW_BLOCKS_V20, FEE_BPS_V16 } from "../src/core/cairnx.ts";
import { MIN_FEE_PROPOSE, MIN_FEE_ATTEST } from "../src/vendor/cairnx-spv.js";

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
  ok("M3: quote is attributed to the offer service", /quoted by the offer service/i.test(html));
  ok("M3: no first-person debit assertion", !/you will pay/i.test(html));
  ok("M3: quote shows total + ticker in labeled base units", html.includes("1015") && html.includes("TOK") && html.includes("base units"));
  // 0.2.71 (CX-15): the signer now binds this number to the proven record, so the copy says what the
  // wallet does (refuse on mismatch) instead of "cannot verify", which was no longer true.
  ok("M3: quote states the wallet refuses when the on-chain record differs", /refuses to sign if the offer's on-chain record differs/i.test(html));
  ok("0.2.71: human units shown beside base units when decimals are known",
    /1\.015 TOK/.test(tokenQuoteHtml({ ...q, wantDecimals: 3 })) && /1015 base units/.test(tokenQuoteHtml({ ...q, wantDecimals: 3 })));
  ok("M3: estimated flag still surfaces", tokenQuoteHtml({ ...q, estimated: true }).includes("estimated"));
  ok("M3: failed quote says the wallet will not sign until the amount is shown", /will not sign this fill until the amount can be shown/.test(tokenQuoteHtml({ ok: false, error: "offer gone" })));
  ok("M3: null quote (bridge threw) keeps the loud caution", /will not sign/.test(tokenQuoteHtml(null)) && tokenQuoteHtml(null).includes("offer unavailable"));
  ok("M3: hostile quote error is escaped", !tokenQuoteHtml({ ok: false, error: "<img src=x>" }).includes("<img"));
  const text = (h) => h.replace(/<[^>]+>/g, "");
  ok("M3: give ticker/amount paint on the card (base units when decimals are unknown)", /You receive 10 base units of AAA/.test(text(tokenQuoteHtml({ ...q, giveTicker: "AAA", giveAmount: "10" }))));
  ok("0.2.71: give paints in human units when its decimals are known", /You receive 0\.1 AAA \(10 base units\)/.test(text(tokenQuoteHtml({ ...q, giveTicker: "AAA", giveAmount: "10", giveDecimals: 2 }))));
  ok("M3: give name paints as .csd", /You receive alice\.csd/.test(text(tokenQuoteHtml({ ...q, giveName: "alice" }))));
  ok("0.2.71: a look-alike ticker gets the not-verified warning; CAIRN with the real deploy does not",
    /not verified/.test(tokenQuoteHtml({ ...q, ticker: "BTC" })) && !/not verified|not Cairn/.test(tokenQuoteHtml({ ...q, ticker: "CAIRN", wantDeployId: "0xdf7113afc41319b700c26f26ba657c8267533a3dd511cc59776601a9aba03517" }))
    && /not Cairn's token/.test(tokenQuoteHtml({ ...q, ticker: "CAIRN", wantDeployId: "0x" + "ab".repeat(32) })));
  ok("review D-1: CAIRN whose deploy id did not load warns instead of reading as verified",
    /Could not confirm this CAIRN/.test(tokenQuoteHtml({ ...q, ticker: "CAIRN" })) && /Could not confirm this CAIRN/.test(tokenQuoteHtml({ ...q, ticker: "CAIRN", wantDeployId: undefined })));
  ok("M3: hostile give ticker is escaped", !tokenQuoteHtml({ ...q, giveTicker: "<img src=x>" }).includes("<img"));
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
  ok("PIN 0.2.70: armButtons fail-softs a rejected fillSendWarning (Approve/Reject cannot stay disabled)",
    /Promise\.all\(\[minWait, Promise\.resolve\(warnPainted\)\.catch\(\(\) => \{\}\)\]\)/.test(approveSrc) && /Promise\.all\(\[base, Promise\.resolve\(tokenPainted\)\.catch\(\(\) => \{\}\)\]\)/.test(approveSrc));
  ok("PIN M14: approve.ts wires fillRevealPreview into render()", approveSrc.includes("fillRevealPreview(current)"));
  ok("PIN M14: the preview reads the LOCAL sealedClaims store (no network)", approveSrc.includes('call("sealedClaims")'));
  ok("PIN B5h: a score-50 attest threads only the LOCAL tipFloor (no tip/network fetch added)", /method === "attest"[\s\S]{0,900}?call\("tipFloor"\)/.test(approveSrc) && !/method === "attest"[\s\S]{0,900}?call\("tip"\)[^F]/.test(approveSrc));
}

// ── B9 (M8 batch): ONE default-fee table — screen rows can never disagree again ─────────────
// RED-FIRST (authored against the pre-fix tree): a fee-less bare attest rendered "fee: 0 CSD" in
// describe() beside "cost: 0.05 CSD" in costLine() with debitOf() counting 0; a fee-less propose
// rendered 0.01 CSD — an amount the NODE refuses (utxo.rs validate_app_sanity enforces
// MIN_FEE_PROPOSE / MIN_FEE_ATTEST on every app tx). The engine meanwhile ERRORED (BAD_FEE) on the
// omitted fee, so no on-screen number was ever what got signed.
{
  // Ground truth, independent of the table under test: the vendored consensus mirror's floors.
  ok("B9 ground truth: MIN_FEE_PROPOSE is 0.25 CSD", MIN_FEE_PROPOSE === 25_000_000);
  ok("B9 ground truth: MIN_FEE_ATTEST is 0.05 CSD", MIN_FEE_ATTEST === 5_000_000);

  // The table itself.
  ok("B9 table: send → 0.01 CSD (no app floor; relay feerate only)", defaultFeeFor("send") === 1_000_000);
  ok("B9 table: propose → the node propose floor", defaultFeeFor("propose") === MIN_FEE_PROPOSE);
  ok("B9 table: sealClaim → the propose floor (a seal anchors AS a Propose)", defaultFeeFor("sealClaim") === MIN_FEE_PROPOSE);
  ok("B9 table: attest → the node attest floor", defaultFeeFor("attest") === MIN_FEE_ATTEST);
  ok("B9 table: fillOffer → the attest floor (a fill IS an Attest + outputs)", defaultFeeFor("fillOffer") === MIN_FEE_ATTEST);
  ok("B9 table: unknown method → 0 (no assumption)", defaultFeeFor("someFutureMethod") === 0);

  // Cross-row consistency: with NO dApp-supplied fee, the fee row in describe(), the cost row, and
  // the balance-after debit must ALL be the table value — the number the engine will sign.
  const feeTxt = (base) => `fee: ${base / 1e8} CSD`;
  const bareAttest = { method: "attest", params: { proposalId: ID, score: 80, confidence: 70 } };
  ok("B9: bare attest fee row shows the floor the engine signs", describe(bareAttest).includes(feeTxt(MIN_FEE_ATTEST)));
  ok("B9: bare attest cost row agrees", costLine(bareAttest).includes(`cost: ${fmtCsd(MIN_FEE_ATTEST)} network fee`));
  ok("B9: bare attest debit agrees", debitOf(bareAttest) === MIN_FEE_ATTEST);

  const claim = { method: "attest", params: { proposalId: ID, score: 50, confidence: 0 } };
  ok("B9: a claim reservation shows its real attest fee (it is not free)", describe(claim).includes(feeTxt(MIN_FEE_ATTEST)));

  const barePropose = { method: "propose", params: { domain: "csd:test", payloadHash: ID, uri: "u" } };
  ok("B9: bare propose shows the node-enforced 0.25 floor (not a rejected 0.01)", describe(barePropose).includes(feeTxt(MIN_FEE_PROPOSE)));
  ok("B9: bare propose cost row agrees", costLine(barePropose).includes(`${fmtCsd(MIN_FEE_PROPOSE)} network fee`));
  ok("B9: bare propose debit agrees", debitOf(barePropose) === MIN_FEE_PROPOSE);

  const cxRec = { v: 1, t: "transfer", ticker: "TOK", amount: "5", to: "0x" + "cd".repeat(20) };
  const cxPropose = { method: "propose", params: { domain: CAIRNX_DOMAIN, uri: canonicalJson(cxRec), payloadHash: cairnxPayloadHash(cxRec) } };
  ok("B9: a cairnx propose shows the 0.25 anchor floor (was a 25x understatement)", describe(cxPropose).includes(feeTxt(MIN_FEE_PROPOSE)));

  // Happy-path anchors (these were already consistent and must stay so).
  const bareSend = { method: "send", params: { to: "0x" + "ab".repeat(20), amount: 100 } };
  ok("B9: send still shows 0.01 and debits amount+fee", describe(bareSend).includes(feeTxt(1_000_000)) && debitOf(bareSend) === 100 + 1_000_000);
  const bareFill = { method: "fillOffer", params: { proposalId: ID, outputs: [{ to: "0x" + "ab".repeat(20), value: 1000 }] } };
  ok("B9: fillOffer still shows 0.05 and debits outputs+fee", describe(bareFill).includes(feeTxt(MIN_FEE_ATTEST)) && debitOf(bareFill) === 1000 + MIN_FEE_ATTEST);
  const nullScore = { method: "fillOffer", params: { proposalId: ID, outputs: [], score: null } };
  ok("0.2.70: score:null paints 100 (null ?? 100; paint logic unchanged)", /score 100/.test(describe(nullScore)));
  ok("0.2.70: MUT score:null is not painted as 0", !/score 0/.test(describe(nullScore)));
  ok("B9: sealClaim still shows 0.25", describe({ method: "sealClaim", params: { claim: "x" } }).includes(feeTxt(MIN_FEE_PROPOSE)));

  // An EXPLICIT dApp fee still wins over the table everywhere (the table is a default, not a clamp).
  const explicit = { method: "attest", params: { proposalId: ID, score: 80, confidence: 70, fee: 9_000_000 } };
  ok("B9: an explicit fee is shown and debited as given", describe(explicit).includes(feeTxt(9_000_000)) && debitOf(explicit) === 9_000_000);

  // Use-site pins: the display layer must read the table (no hand-typed fallback literals), and the
  // engine must APPLY the table where it used to error on an omitted fee.
  const clearsignSrc = readFileSync(new URL("../src/popup/clearsign.ts", import.meta.url), "utf8");
  const walletSrc = readFileSync(new URL("../src/core/wallet.ts", import.meta.url), "utf8");
  ok("PIN B9: every feeLine use-site reads defaultFeeFor(r.method)",
    (clearsignSrc.match(/feeLine\(p\.fee, defaultFeeFor\(r\.method\)\)/g) || []).length >= 7
    && !/feeLine\(p\.fee(, ?\d|(, ?CAIRNX_PROPOSE_FEE)?\))/.test(clearsignSrc.replace(/feeLine\(p\.fee, defaultFeeFor\(r\.method\)\)/g, "")));
  ok("PIN B9: cost/debit fallbacks read the table, not literals", !/\|\| ?(1_000_000|5_000_000|1000000|5000000)\)/.test(clearsignSrc));
  ok("PIN B9: the engine defaults an omitted propose fee (was BAD_FEE after approval)", walletSrc.includes('defaultFeeFor("propose")'));
  ok("PIN B9: the engine defaults an omitted attest fee", walletSrc.includes('defaultFeeFor("attest")'));
  ok("PIN B9: the drift-prone ATTEST_FLOOR twin const is gone", !walletSrc.includes("const ATTEST_FLOOR"));
}

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
