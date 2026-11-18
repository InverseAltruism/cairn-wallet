// The wallet's own site's requests still paint their cards, and nothing in the card text changes what can be approved.
// The requests are the cairn repo's golden wallet requests (the site's real call shapes, one per user flow): every call
// that is a proposal, an attest, a send or a fill, copied into test/fixtures/wallet-requests-golden-calls.json from
// cairn test/fixtures/wallet-requests-golden.json at origin/master 856f02b97c5ead6ff27331ca77687d448384dcb2 (the file
// last changed in 192d9fef9a03247eb1e80652793e52440bddb006), source sha256
// 0854d2d573b509e2e4601084e4fe054336c246d6d998dac62c1f4b622d27c4db. The copy keeps each call's case name, method and
// params as the site sends them, in file order; the fixture's own sha256 is pinned below, so an edit to it fails here.
// For each call, from the wallet's own origin: describe() paints a titled card with the cost block and no refusal, and
// what the window and the signer act on (the signed fee, the signed outputs, the debit, whether it is a token fill) is
// pinned by a digest taken before the card wording of 2026-11-18 changed. A taker the site names in an answer to a bid
// gets no first-time notice (only the look-alike check runs on a taker).
//   RED-FIRST: tier a taker with the first-time notice (drop the LOOKALIKE_ONLY test in recipientFlags) and the two
//   golden answers to a bid and the token-priced offer fail the taker check.
// Run: npx tsx test/golden-requests-cards.test.mjs   (offline)
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { checker } from "./helpers/check.mjs";
import { describe, debitOf, signedFee, signedOutputs, requestRecipients, recipientFlags } from "../src/popup/clearsign.ts";
import { isTokenFill } from "../src/core/signfields.ts";

const { check, done } = checker("the site's golden requests paint their cards:");
const FIXTURE = new URL("./fixtures/wallet-requests-golden-calls.json", import.meta.url);
const bytes = readFileSync(FIXTURE);
const sha = createHash("sha256").update(bytes).digest("hex");
check(`fixture sha256 is the one copied (${sha})`, sha === "3485cd5e56a5e35f58b662d1b221dcf595fdd04abf74006427016f564f8ab091");
const { calls } = JSON.parse(bytes.toString("utf8"));
check(`39 calls: proposals, attests and fills (${calls.length})`, calls.length === 39 && calls.every((c) => ["propose", "attest", "send", "fillOffer"].includes(c.method)));

const ORIGIN = "https://cairn-substrate.com";
const ME = "0x" + "7a".repeat(20);
// What the card would say the wallet refuses to sign; none of the site's requests may carry one.
const REFUSAL = /approving refuses it|will refuse this request and sign nothing|Refusing to sign|the node will refuse it/;
const acted = [];
for (const [i, c] of calls.entries()) {
  const r = { id: `g${i}`, method: c.method, origin: ORIGIN, params: c.params };
  const html = describe(r);
  const title = html.match(/<div class="ap-title">([\s\S]*?)<\/div>/)?.[1]?.replace(/<[^>]+>/g, "") ?? "";
  check(`${c.case} (${c.method}): paints "${title}" with its cost block and no refusal`, title.length > 0 && html.includes('id="cost"') && !REFUSAL.test(html));
  const flags = recipientFlags(requestRecipients(r), [], [ME]);
  check(`${c.case}: no taker is flagged on a wallet with no history (${flags.map((f) => f.kind).join(",") || "no taker flag"})`, !flags.some((f) => f.kind === "taker"));
  acted.push({ case: c.case, method: c.method, fee: String(signedFee(r)), outputs: signedOutputs(r).map((o) => [String(o.to), String(o.value)]), debit: debitOf(r), tokenFill: isTokenFill(c.method, c.params) });
}
const digest = createHash("sha256").update(JSON.stringify(acted)).digest("hex");
check(`what the window and the signer act on is unchanged (digest ${digest})`, digest === "ce7804fcf84555bfb1bc2da7b36a1f59b03d26f3b022a54cfb417af06131366a");
done("golden-requests-cards");
