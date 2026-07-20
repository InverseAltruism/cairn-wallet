#!/usr/bin/env node
// Aggregating test runner (REBIND B0c, closes N5; mirrors cairn/test/run.mjs).
//
// `npm test` was a flat `tsx A && tsx B && ...` chain of 33 files: one early failure
// hid every file behind it, so a red suite reported exactly one defect no matter how
// many existed. Same defect class as cairn-sdk F13, here in the fund-custody endpoint.
//
// This runner globs test/*.{ts,mjs} (selftest first, then alphabetical), spawns each
// via the tsx loader, RUNS EVERY FILE even after a failure, prints a per-file verdict
// line, and exits non-zero if ANY file failed. Glob-driven so a new test file cannot
// be forgotten the way a hand-maintained chain forgets one. Underscore-prefixed files
// (test/_*.ts) are shared helper rigs, not tests, and are excluded; so are .d.ts files.
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

// selftest first (golden vectors and the fee-cap lock gate everything else conceptually),
// then every other test file in sorted order.
const FIRST = "selftest.ts";
const tests = [];
for (const f of readdirSync(here).sort()) {
  if (f === "run.mjs" || f === FIRST) continue;
  if (f.startsWith("_") || f.endsWith(".d.ts")) continue;
  if (f.endsWith(".ts") || f.endsWith(".mjs")) tests.push(join("test", f));
}
tests.unshift(join("test", FIRST));

// A test that exits 0 after printing a `SKIP:` line (an unmet optional prereq) is NOT a
// pass; counting it as one is the dead-green class that hides an unrun test. No wallet
// test skips today, but the classification is kept so a future skip is visible, never a
// silent pass. CAIRN_E2E_REQUIRED=1 turns a SKIP into a hard failure.
const requireE2E = process.env.CAIRN_E2E_REQUIRED === "1";
// Per-file wall-clock cap: a wedged test must FAIL, never hang the runner forever
// ("it didn't finish" is not "it passed"). Generous default; the whole suite runs in
// well under a minute today (slowest file ~4s).
const rawTimeout = process.env.CAIRN_TEST_TIMEOUT_MS;
const TIMEOUT_MS = rawTimeout === undefined ? 180_000 : Number(rawTimeout);
// Validate rather than letting NaN reach spawnSync, which throws ERR_OUT_OF_RANGE and
// kills the runner on the first file.
if (!Number.isFinite(TIMEOUT_MS) || TIMEOUT_MS <= 0) {
  process.stderr.write(`test/run.mjs: CAIRN_TEST_TIMEOUT_MS must be a positive number, got ${JSON.stringify(rawTimeout)}\n`);
  process.exit(2);
}
// Spawn node with the tsx loader DIRECTLY rather than via `npx tsx`: spawnSync's timeout
// kills only the immediate child, so the `npx -> sh -> .bin/tsx -> node` chain would
// orphan the real test process and leave it running past the cap.
const tsxDir = join(root, "node_modules", "tsx", "dist");
const nodeArgs = ["--require", join(tsxDir, "preflight.cjs"), "--import", pathToFileURL(join(tsxDir, "loader.mjs")).href];
let passed = 0;
const skipped = [];
const failed = [];
const slow = [];
for (const t of tests) {
  process.stdout.write(`\n== ${t} ==\n`);
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [...nodeArgs, t], {
    cwd: root, stdio: ["inherit", "pipe", "pipe"], encoding: "utf8", env: process.env,
    timeout: TIMEOUT_MS, killSignal: "SIGKILL",
    maxBuffer: 64 * 1024 * 1024,   // a chatty-but-passing test must not be mistaken for a hang (ENOBUFS)
  });
  const secs = (Date.now() - t0) / 1000;
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  if (secs >= TIMEOUT_MS / 1000 * 0.5) slow.push(`${t} (${secs.toFixed(1)}s)`);
  const didSkip = /^SKIP:/m.test(r.stdout || "");
  // Distinguish the kill reasons explicitly: a bare `status === null && signal` also fires
  // on ENOBUFS and on an external kill, and mislabelling either as a timeout misleads.
  let verdict;
  if (r.error?.code === "ETIMEDOUT") {
    verdict = `FAIL (TIMED OUT after ${TIMEOUT_MS / 1000}s: a hang is a failure, not a skip)`;
    failed.push(`${t} ${verdict.slice(5)}`);
  } else if (r.error) {
    verdict = `FAIL (runner error ${r.error.code || r.error.message} after ${secs.toFixed(1)}s)`;
    failed.push(`${t} ${verdict.slice(5)}`);
  } else if (r.status === null && r.signal) {
    verdict = `FAIL (killed by ${r.signal} after ${secs.toFixed(1)}s)`;
    failed.push(`${t} ${verdict.slice(5)}`);
  } else if (r.status === 0 && didSkip) {
    if (requireE2E) { verdict = "FAIL (SKIPPED but CAIRN_E2E_REQUIRED=1)"; failed.push(`${t} ${verdict.slice(5)}`); }
    else { verdict = "SKIP"; skipped.push(t); }
  } else if (r.status === 0) { verdict = "PASS"; passed++; }
  else { verdict = `FAIL (exit ${r.status})`; failed.push(`${t} (exit ${r.status})`); }
  process.stdout.write(`${verdict === "PASS" ? "PASS" : verdict} ${t} (${secs.toFixed(1)}s)\n`);
}

process.stdout.write(`\n========================================\n`);
process.stdout.write(`test/run.mjs: ${passed}/${tests.length} files passed${skipped.length ? `, ${skipped.length} SKIPPED` : ""}\n`);
if (skipped.length) process.stdout.write(`SKIPPED (unmet prereq; set CAIRN_E2E_REQUIRED=1 to require):\n  ${skipped.join("\n  ")}\n`);
// Early warning: a file creeping toward the cap is the shape a wedge takes before it hangs.
if (slow.length) process.stdout.write(`SLOW (over half the ${TIMEOUT_MS / 1000}s per-file cap):\n  ${slow.join("\n  ")}\n`);
if (failed.length) {
  process.stdout.write(`FAILED:\n  ${failed.join("\n  ")}\n`);
  process.exit(1);
}
process.stdout.write(skipped.length ? `ALL RUN TEST FILES PASS (${skipped.length} skipped)\n` : `ALL TEST FILES PASS\n`);
