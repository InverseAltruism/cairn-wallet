// The finalize card's lede says what a finalize costs. A finalize the chain does not credit (a displaced or late
// reservation, signed while the name service could not be asked) still pays its fee and registers nothing, so the card
// may not say "a lost race is never charged" beside the window's own burn warning. Through describe() with a real
// nfinalize record, the shape approve.ts paints.
// Run: npx tsx test/nfinalize-lede.test.mjs   (offline)
import { checker } from "./helpers/check.mjs";
import { describe } from "../src/popup/clearsign.js";
import { CAIRNX_DOMAIN, TREASURY_ADDR } from "../src/core/cairnx.js";
import { nameFinalize } from "../src/vendor/cairnx-spv.js";

const { check, done } = checker("finalize card: an uncredited finalize still pays:");
const rec = nameFinalize({ name: "alice", salt: "1".repeat(16) });
const html = describe({ method: "propose", origin: "https://cairn-substrate.com", currentEpoch: 3_900, currentTip: 117_000,
  params: { domain: CAIRNX_DOMAIN, uri: rec.uri, payloadHash: rec.payloadHash, expiresEpoch: 3_905, fee: 25_000_000, outputs: [{ to: TREASURY_ADDR, value: 500_000_000 }] } });
const text = html.replace(/<[^>]+>/g, "");
check(`the card is the finalize step (${/step 3 of 3/.test(text)})`, /finalize and pay/.test(text));
check("it no longer says a lost race is never charged", !/never charged/.test(text));
check("it says a finalize the chain does not credit still pays the fee", /a finalize the chain does not credit still pays the fee/.test(text) && /approve only at the site's finalize step/.test(text));
done("nfinalize-lede");
