// B8w: packaging safety pins for scripts/package.mjs (audit LOW: the stale store-zip trap).
//
// Two defenses, both tested against the REAL exported helpers (main() is run-as-main-guarded, so importing
// the module writes no artifact):
//   1. a version-STAMPED CWS upload filename, so a stale local file can't be silently uploaded;
//   2. a packaging assertion that the manifest bytes going into the zip match package.json, so packaging a
//      stale dist/ is a hard failure, not a silent wrong-version ship.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PKG_VERSION, storeZipName, assertVersionLockstep, manifestVersionInDist } from "../scripts/package.mjs";

let pass = 0, fail = 0;
const ok = (name, fn) => { try { fn(); pass++; console.log("  ✓", name); } catch (e) { fail++; console.log("  ✗", name, "\n      ", e.message); } };

console.log("package.mjs guards:");

// (1) the CWS upload filename carries the version.
ok("storeZipName stamps the version into the filename", () => {
  assert.equal(storeZipName("0.2.64"), "cairn-wallet-store-0.2.64.zip");
});
ok("the real CWS upload target embeds package.json's version (no unversioned upload target)", () => {
  const name = storeZipName(PKG_VERSION);
  assert.match(name, /^cairn-wallet-store-\d+\.\d+\.\d+\.zip$/, "must be cairn-wallet-store-<semver>.zip");
  assert.ok(name.includes(PKG_VERSION), "the filename must contain the exact package.json version");
});

// (2) the packaging assertion catches a manifest/package version drift (the stale-dist trap).
ok("assertVersionLockstep passes when the dist manifest matches package.json", () => {
  assertVersionLockstep("0.2.64", "0.2.64"); // must NOT throw
});
ok("assertVersionLockstep THROWS on a stale dist manifest (the trap)", () => {
  assert.throws(() => assertVersionLockstep("0.2.64", "0.2.63"), /0\.2\.63.*0\.2\.64|stale dist/);
});

// manifestVersionInDist reads the version from a fixture manifest at the dist root.
ok("manifestVersionInDist reads the manifest version from the (would-be-zipped) dist root", () => {
  const dir = mkdtempSync(join(tmpdir(), "wallet-pkg-"));
  try {
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ version: "9.9.9", name: "x" }));
    assert.equal(manifestVersionInDist(dir), "9.9.9");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

console.log(`package-assert: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
