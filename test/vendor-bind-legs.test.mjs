// The vendored bindOfferTerms contract (cairnx-core 0.2.0, csd-sdk packages/cairnx/CHANGELOG.md "Migration"): the
// give and wantType legs are on by default, `{ give: false, wantType: false }` returns the pre-0.2.0 verdict, and
// the wallet's own call (both legs passed explicitly, wallet.ts provenTermsMismatch) gives the same verdict as the
// default. Real on-chain offer records from the proven-terms corpus, terms minted by the vendored provenOfferTerms.
// Red first: against the 0.1.44 bundle the two-argument call accepts the inflated give and the want-type flip.
// Run: npx tsx test/vendor-bind-legs.test.mjs
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { provenOfferTerms, bindOfferTerms } from "../src/vendor/cairnx-spv.js";
import { checker } from "./helpers/check.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const corpus = JSON.parse(readFileSync(join(ROOT, "test/fixtures/proven-terms-corpus.json"), "utf8"));
const entry = (id) => { const e = corpus.find((x) => x.id === id); if (!e) throw new Error(`corpus entry ${id} missing`); return e; };
const LEGS = { give: true, wantType: true };
const LEGACY = { give: false, wantType: false };
const served = (e, t) => ({ height: e.height, feeBps: t.feeBps, give: { ...e.rec.give }, want: { ...e.rec.want }, ...(e.rec.taker ? { taker: e.rec.taker } : {}) });

const t = checker("vendored bindOfferTerms: cairnx-core 0.2.0 legs");

// A token-for-CSD offer (give 25 XE5XNS for 1 CSD) and a token-for-token offer (want 50 XE5XNS), both mined.
const csd = entry("0x93dfe69034222cf5235be6b4167acf616c76423823eecb4b0019fe712f46bd10");
const tok = entry("0x8bbd2a964a6659fe9ccb2db784a7b638de06265610ea8842cbb0a6a7b4971160");
for (const [label, e] of [["CSD-priced", csd], ["token-priced", tok]]) {
  const terms = provenOfferTerms(e.rec, e.height);
  const honest = served(e, terms);
  const inflated = { ...honest, give: { ...honest.give, amount: honest.give.amount + "000000" } };
  const flipped = { ...honest, want: e.rec.want.ticker ? { value: "1" } : { ...honest.want, ticker: "CAIRN", amount: "1" } };

  t.check(`${label}: the honest served offer passes with the default legs`, bindOfferTerms(honest, terms) === false);
  t.check(`${label}: the honest served offer passes with the wallet's call shape`, bindOfferTerms(honest, terms, LEGS) === false);
  t.check(`${label}: an inflated give refuses with the default legs`, bindOfferTerms(inflated, terms) === true);
  t.check(`${label}: a flipped want type refuses with the default legs`, bindOfferTerms(flipped, terms) === true);
  t.check(`${label}: the wallet's call shape gives the default's verdict on both lies`,
    bindOfferTerms(inflated, terms, LEGS) === bindOfferTerms(inflated, terms) && bindOfferTerms(flipped, terms, LEGS) === bindOfferTerms(flipped, terms));
  t.check(`${label}: both legs off returns the pre-0.2.0 verdict (the give lie passes)`, bindOfferTerms(inflated, terms, LEGACY) === false);
  // One leg off leaves the other on (the CHANGELOG's "opting out of one leg leaves the other on").
  t.check(`${label}: give off, wantType still refuses the flip`, bindOfferTerms(flipped, terms, { give: false }) === true);
}

t.done();
