// The fill lanes take two bounds from the vendored cairnx-core instead of local copies: FCLAIM_MAX_HOLD_SPAN (how far
// past its grant an fclaim hold lasts; the fclaim scan's window adds it to MAX_SCAN) and offerFillTooLate (whether a
// fill at a tip can still be mined before the offer expires; the offer-id lanes refuse on it and the fill card names
// that refusal).
//   (1) no module declares either; each user imports it from the bundle (red on a local copy).
//   (2) equivalence: the bundle's values are the ones the local copies computed.
// Run: npx tsx test/fill-bounds-vendored.test.mjs   (offline)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { checker } from "./helpers/check.mjs";
import { FCLAIM_MAX_HOLD_SPAN, offerFillTooLate, EPOCH_LEN, FCLAIM_MAX_EPOCH_AHEAD, FILL_TIP_MARGIN } from "../src/vendor/cairnx-spv.js";

const { check, done } = checker("fill bounds come from the vendored cairnx-core:");
const ROOT = join(import.meta.dirname, "..");
const read = (f) => readFileSync(join(ROOT, f), "utf8");

const files = [];
const walk = (d) => { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) { if (n !== "vendor") walk(p); } else if (p.endsWith(".ts")) files.push(p); } };
walk(join(ROOT, "src"));
const declares = files.filter((f) => /(function\s+offerFillTooLate\b|(const|let)\s+\w*HOLD_SPAN\w*\s*=|FCLAIM_MAX_EPOCH_AHEAD\s*\+\s*1)/.test(readFileSync(f, "utf8")));
check(`no module declares a hold span or offerFillTooLate (${declares.map((f) => f.slice(ROOT.length + 1)).join(", ") || "none"})`, declares.length === 0);
const fromBundle = (src, name) => new RegExp(`import \\{[^}]*\\b${name}\\b[^}]*\\} from "\\.\\./vendor/cairnx-spv\\.js";`).test(src);
check("fillspv.ts imports FCLAIM_MAX_HOLD_SPAN from the bundle and sizes its scan window with it",
  fromBundle(read("src/core/fillspv.ts"), "FCLAIM_MAX_HOLD_SPAN") && /verifiedTip - \(MAX_SCAN \+ FCLAIM_MAX_HOLD_SPAN\)/.test(read("src/core/fillspv.ts")));
check("fillpreflight.ts and clearsign.ts import offerFillTooLate from the bundle",
  fromBundle(read("src/core/fillpreflight.ts"), "offerFillTooLate") && fromBundle(read("src/popup/clearsign.ts"), "offerFillTooLate"));

check(`FCLAIM_MAX_HOLD_SPAN is the 89 blocks the local copy computed (${FCLAIM_MAX_HOLD_SPAN})`,
  FCLAIM_MAX_HOLD_SPAN === 89 && FCLAIM_MAX_HOLD_SPAN === EPOCH_LEN * (FCLAIM_MAX_EPOCH_AHEAD + 1) - 1);
let same = 0, total = 0;
for (let tip = 1000; tip < 1010; tip++) for (let at = tip - 3; at < tip + FILL_TIP_MARGIN + 4; at++) {
  total++;
  if (offerFillTooLate(at, tip) === (at - 1 < tip + FILL_TIP_MARGIN)) same++;
}
check(`offerFillTooLate is the local rule expiresAt - 1 < tip + FILL_TIP_MARGIN at every edge (${same} of ${total})`, same === total);
check("...too late at the margin, in time one block past it", offerFillTooLate(1000 + FILL_TIP_MARGIN, 1000) === true && offerFillTooLate(1001 + FILL_TIP_MARGIN, 1000) === false);

done("fill-bounds-vendored");
