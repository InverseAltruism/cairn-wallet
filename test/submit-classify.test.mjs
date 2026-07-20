// N18 (B8w): pin the SUBMIT_DUPLICATE classifier to the node's tx_submit error contract.
//
// The wallet classifies a failed /tx/submit as SUBMIT_DUPLICATE (a byte-identical resubmit whose tx is
// already pending) vs SUBMIT_REJECTED (a definitive no) by matching the node's error STRING. That is a
// coupling to wording this wallet does not own, so it needs a test that goes RED if either side drifts;
// the same rule the campaign applies to every guard. Before B8w the match was an inline `/already
// present/i`; it now lives in the named, exported `isSubmitDuplicateErr`, tested here.
//
// The two strings below are COPIED VERBATIM from the node's contract (compute-substrate
// src/api/mod.rs, tx_submit, the Ok(false) branch). If the node ever rewords them, THIS fixture is the
// documented maintenance point: update the frozen strings here in lockstep with the node, deliberately.
import * as node from "../src/core/node.js";

let pass = 0, fail = 0;
const check = (name, cond) => { cond ? (pass++, console.log("  ✅ " + name)) : (fail++, console.log("  ❌ " + name)); };

// ── the exact node strings (frozen from compute-substrate api/mod.rs tx_submit Ok(false)) ──
const NODE_DUPLICATE = "already present in mempool";
const NODE_CONFLICT = "mempool conflict: a different pending transaction spends these coins";

console.log("=== N18: isSubmitDuplicateErr pins the node tx_submit contract ===");

// A genuine duplicate (this exact tx held) MUST classify as a duplicate: a tx spending these coins is
// pending, so telling the user "nothing was sent" would be false.
check("the node DUPLICATE string classifies as a duplicate", node.isSubmitDuplicateErr(NODE_DUPLICATE) === true);

// The critical fail-safe direction: a CONFLICT (a DIFFERENT tx spends an input) must NEVER read as a
// duplicate. Misclassifying it would tell the user their payment "should settle" when it never will.
check("the node CONFLICT string does NOT classify as a duplicate (must fall through to SUBMIT_REJECTED)",
  node.isSubmitDuplicateErr(NODE_CONFLICT) === false);

// It is the narrow substring, not the whole phrase, so a re-wrapped proxy message still matches.
check("a proxy-wrapped duplicate message still matches (narrow substring, case-insensitive)",
  node.isSubmitDuplicateErr("/tx/submit -> ALREADY PRESENT in mempool (via proxy)") === true);

// Non-duplicate rejections and empty/absent errors are not duplicates.
check("a plain rejection is not a duplicate", node.isSubmitDuplicateErr("bad signature") === false);
check("mempool-full is not a duplicate", node.isSubmitDuplicateErr("mempool full; feerate not competitive") === false);
check("empty string is not a duplicate", node.isSubmitDuplicateErr("") === false);
check("null is not a duplicate (no throw)", node.isSubmitDuplicateErr(null) === false);
check("undefined is not a duplicate (no throw)", node.isSubmitDuplicateErr(undefined) === false);

console.log(`\nsubmit-classify: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
