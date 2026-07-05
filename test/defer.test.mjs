// Deferred finalize: the send-time gate (core/defer.ts decideDeferred) is the money-safety core —
// a held, SIGNED, fee-bearing nfinalize must broadcast ONLY while this wallet still holds the winning
// reservation inside its window; every other state drops or waits. Loss requires POSITIVE evidence
// (another owner / a shifted effectiveHeight); absence alone can only expire PAST the window, so a
// resolver blip or reorg snapshot can never trigger an early broadcast or an early drop.
import assert from "node:assert/strict";
import { decideDeferred, deferOutcomeCopy } from "../src/core/defer.js";

let pass = 0, fail = 0;
const ok = (n, c) => { c ? pass++ : (fail++, console.error("  FAIL " + n)); if (c) console.log("  PASS " + n); };

const ME = "0x" + "ab".repeat(20);
const OTHER = "0x" + "cd".repeat(20);
const item = { name: "alice", owner: ME, effectiveHeight: 1000, notBeforeHeight: 1011, notAfterHeight: 1026, feeTotal: 3e8, txJson: {}, outpoints: ["0x1:0"], createdAt: 0 };
const minePending = { owner: ME, pending: true, effectiveHeight: 1000 };

ok("no tip → wait (never act blind)", decideDeferred(item, minePending, 0) === "wait");
ok("inside the freeze → wait", decideDeferred(item, minePending, 1010) === "wait");
ok("first eligible height → broadcast", decideDeferred(item, minePending, 1011) === "broadcast");
ok("last eligible height → broadcast", decideDeferred(item, minePending, 1026) === "broadcast");
ok("past the window while still pending → expired (sending would burn)", decideDeferred(item, minePending, 1027) === "expired");
ok("registered to me → complete", decideDeferred(item, { owner: ME, pending: false }, 1015) === "complete");
ok("pending but owned by another → lost", decideDeferred(item, { owner: OTHER, pending: true, effectiveHeight: 998 }, 1015) === "lost");
ok("pending mine at a DIFFERENT effHeight (reorg/displacement) → lost", decideDeferred(item, { owner: ME, pending: true, effectiveHeight: 1002 }, 1015) === "lost");
ok("registered to another → lost", decideDeferred(item, { owner: OTHER, pending: false }, 1015) === "lost");
ok("name absent inside the window → wait (blip tolerance, never early-drop)", decideDeferred(item, null, 1015) === "wait");
ok("name absent past the window → expired", decideDeferred(item, null, 1027) === "expired");
ok("just broadcast → wait a block before re-submitting", decideDeferred({ ...item, broadcastTip: 1012 }, minePending, 1013) === "wait");
ok("broadcast stalled ≥2 blocks → broadcast again (mempool re-submit)", decideDeferred({ ...item, broadcastTip: 1012 }, minePending, 1014) === "broadcast");
ok("owner comparison is case-insensitive", decideDeferred(item, { owner: ME.toUpperCase().replace("0X", "0x"), pending: false }, 1015) === "complete");

ok("terminal copy exists for complete/lost/expired and not for wait/broadcast",
  !!deferOutcomeCopy("alice", "complete") && !!deferOutcomeCopy("alice", "lost") && !!deferOutcomeCopy("alice", "expired")
  && deferOutcomeCopy("alice", "wait") === null && deferOutcomeCopy("alice", "broadcast") === null);
ok("lost/expired copy carries the nothing-paid guarantee",
  /nothing was paid/i.test(deferOutcomeCopy("alice", "lost").message) && /nothing was paid/i.test(deferOutcomeCopy("alice", "expired").message));

console.log(`\ndefer: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
