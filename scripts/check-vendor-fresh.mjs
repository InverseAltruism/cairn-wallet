#!/usr/bin/env node
// Vendor-freshness gate for the committed SPV bundle.
//
// The committed src/vendor/cairnx-spv.js is a hand-built bundle of csd-sdk's AUDITED dists (the light
// client + consensus codec/crypto + the CairnX resolver) that the wallet's fund-path name-verify replays.
// Nothing else guaranteed it matched the source it claims to mirror; that is exactly how a STALE pre-V19
// bundle once shipped (the original H6). This gate makes the invariant enforceable:
//
//   1. (always, no csd-sdk needed) the committed bundle's sha256 == src/vendor/PROVENANCE.json, so the
//      bundle can't be hand-edited or left stale without the provenance being deliberately updated.
//   2. (always) the wallet's @noble pins == PROVENANCE.noble: the second crypto mirror (npm signing path
//      vs the @noble inlined in the bundle's SPV path) must agree, or namespv could derive a different
//      address than the signing path (NSPV-MIRROR-1).
//   3. (when the sibling csd-sdk checkout is present) REBUILD the bundle from the current dists and require
//      byte-identity with the committed file, and require csd-sdk's declared @noble versions == the wallet's.
//      This catches drift vs source. If csd-sdk isn't checked out (e.g. a minimal CI job) the rebuild is
//      skipped with a warning; the cheap checks (1,2) still run, so the gate never blocks unnecessarily.
//
// Usage:
//   node scripts/check-vendor-fresh.mjs            verify (CI / pre-publish gate; exit 1 on drift)
//   node scripts/check-vendor-fresh.mjs --write     regenerate PROVENANCE.json after a legit rebuild
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

const WALLET = join(import.meta.dirname, "..");
const ROOT = join(WALLET, "..");
// Locate the csd-sdk source. Defaults to the sibling checkout (../csd-sdk); CI can point it elsewhere via
// CSD_SDK_DIR (e.g. a token-gated cross-repo checkout) so the full rebuild-vs-source byte-diff runs there too.
const SDK = process.env.CSD_SDK_DIR ? join(process.env.CSD_SDK_DIR) : join(ROOT, "csd-sdk");
const OUT = join(WALLET, "src/vendor/cairnx-spv.js");
const PROV = join(WALLET, "src/vendor/PROVENANCE.json");
const WRITE = process.argv.includes("--write");

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const fail = (m) => { console.error(`  ✗ ${m}`); process.exitCode = 1; };
const ok = (m) => console.log(`  ✓ ${m}`);

const pkg = JSON.parse(readFileSync(join(WALLET, "package.json"), "utf8"));
const walletNoble = { "@noble/curves": pkg.dependencies?.["@noble/curves"], "@noble/hashes": pkg.dependencies?.["@noble/hashes"] };
const bundleSha = sha256(readFileSync(OUT));

// The rebuild below runs scripts/build-spv-vendor.sh itself, so the entry (which dists, which exports) is
// defined in one place. A partially built csd-sdk fails that script, which fails this gate.
const sdkPresent = existsSync(join(SDK, "packages/cairnx/dist/index.js"));

// csd-sdk's declared version + noble (read from package.json; pnpm hoists node_modules so we trust the
// exact pins the packages declare, which are themselves what the dist was built against).
let sdkVersion = null, sdkNoble = null, sdkCommit = null;
if (sdkPresent) {
  sdkVersion = JSON.parse(readFileSync(join(SDK, "packages/cairnx/package.json"), "utf8")).version;
  const cryptoPkg = JSON.parse(readFileSync(join(SDK, "packages/crypto/package.json"), "utf8"));
  sdkNoble = { "@noble/curves": cryptoPkg.dependencies?.["@noble/curves"], "@noble/hashes": cryptoPkg.dependencies?.["@noble/hashes"] };
  // M1: record the exact csd-sdk source COMMIT (not just the mutable version string) for provenance. Best-effort:
  // a tarball/non-git checkout leaves it null. The byte-diff remains the integrity gate; this pins source identity.
  try { sdkCommit = execFileSync("git", ["-C", SDK, "rev-parse", "HEAD"], { encoding: "utf8" }).trim() || null; } catch { sdkCommit = null; }
}

if (WRITE) {
  if (!sdkPresent) { console.error("--write needs the csd-sdk sibling checkout + built dists"); process.exit(1); }
  const prov = {
    note: "Provenance for src/vendor/cairnx-spv.js (the vendored SPV bundle). Rebuild with scripts/build-spv-vendor.sh, then regenerate with `node scripts/check-vendor-fresh.mjs --write`. Verified by scripts/check-vendor-fresh.mjs (audit NSPV-SUPPLY-1 / NSPV-MIRROR-1).",
    csdSdkVersion: sdkVersion,
    csdSdkCommit: sdkCommit,
    bundleSha256: bundleSha,
    noble: sdkNoble,
  };
  writeFileSync(PROV, JSON.stringify(prov, null, 2) + "\n");
  console.log("wrote", PROV, "\n", JSON.stringify(prov, null, 2));
  process.exit(0);
}

console.log("Vendor-freshness gate (src/vendor/cairnx-spv.js):");
if (!existsSync(PROV)) { fail("src/vendor/PROVENANCE.json missing; run with --write to create it"); process.exit(1); }
const prov = JSON.parse(readFileSync(PROV, "utf8"));

// 1. committed bundle == recorded provenance
if (bundleSha === prov.bundleSha256) ok(`bundle sha256 matches PROVENANCE (${bundleSha.slice(0, 12)}…)`);
else fail(`bundle sha256 ${bundleSha.slice(0, 12)}… != PROVENANCE ${String(prov.bundleSha256).slice(0, 12)}…: bundle edited/stale without updating provenance`);

// 2. wallet @noble pins == recorded provenance (the second crypto mirror must agree)
for (const k of ["@noble/curves", "@noble/hashes"]) {
  if (walletNoble[k] && walletNoble[k] === prov.noble?.[k]) ok(`${k} pin ${walletNoble[k]} matches provenance`);
  else fail(`${k}: wallet pins ${walletNoble[k]} but provenance has ${prov.noble?.[k]} (crypto-mirror drift)`);
}

// 3. if csd-sdk is present, rebuild + byte-diff and check source noble equality
if (!sdkPresent) {
  console.log("  • csd-sdk sibling/dists not present; skipping rebuild-diff (cheap checks above still gate)");
} else {
  // source noble == wallet noble (the inlined SPV crypto came from here)
  for (const k of ["@noble/curves", "@noble/hashes"]) {
    if (sdkNoble[k] === walletNoble[k]) ok(`csd-sdk crypto ${k} ${sdkNoble[k]} == wallet pin`);
    else fail(`csd-sdk crypto ${k} ${sdkNoble[k]} != wallet pin ${walletNoble[k]} (would inline a different @noble than the signing path)`);
  }
  // rebuild the bundle from current dists into a temp dir, removed on every path, and require byte-identity
  const tmp = mkdtempSync(join(tmpdir(), "vendor-fresh-"));
  const outTmp = join(tmp, "out.js");
  let rebuilt = null;
  try {
    execFileSync("bash", [join(WALLET, "scripts/build-spv-vendor.sh")],
      { env: { ...process.env, CSD_SDK_DIR: SDK, VENDOR_OUT: outTmp }, stdio: ["ignore", "ignore", "inherit"] });
    rebuilt = readFileSync(outTmp);
  } catch { fail("rebuild failed (scripts/build-spv-vendor.sh could not bundle the current dists)"); }
  finally { rmSync(tmp, { recursive: true, force: true }); }
  if (!rebuilt) process.exit(1);
  const rebuiltSha = sha256(rebuilt);
  if (rebuiltSha === bundleSha) ok(`committed bundle is byte-identical to a rebuild from csd-sdk@${sdkVersion} dists`);
  else fail(`STALE/DRIFTED: a rebuild from csd-sdk@${sdkVersion} dists (${rebuiltSha.slice(0, 12)}…) != committed bundle (${bundleSha.slice(0, 12)}…); run scripts/build-spv-vendor.sh && node scripts/check-vendor-fresh.mjs --write`);
  // Advisory only (console.warn, exitCode untouched): the byte-diff above is the load-bearing check.
  // In CI the csd-sdk checkout is made AT PROVENANCE.csdSdkCommit, so this arm compares the pin with itself.
  if (prov.csdSdkCommit && sdkCommit) {
    if (prov.csdSdkCommit === sdkCommit) ok(`csd-sdk source commit ${sdkCommit.slice(0, 12)}… matches PROVENANCE (advisory)`);
    else console.warn(`  ⚠ ADVISORY, does not fail this gate: csd-sdk HEAD ${sdkCommit.slice(0, 12)}… != PROVENANCE csdSdkCommit ${String(prov.csdSdkCommit).slice(0, 12)}…. The byte-diff above is the load-bearing check; re-run --write if the bundle was rebuilt on purpose.`);
  } else if (!prov.csdSdkCommit) {
    console.log("  • PROVENANCE has no csdSdkCommit (older provenance); run --write to record it");
  }
}

if (process.exitCode) console.error("\nvendor-freshness gate FAILED");
else console.log("\nvendor-freshness gate PASSED");
