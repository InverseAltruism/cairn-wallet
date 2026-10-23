#!/usr/bin/env node
// Vendor-freshness gate for the committed SPV bundle (src/vendor/cairnx-spv.js) and its types (cairnx-spv.d.ts).
//
// Both are built by scripts/build-spv-vendor.sh from the published csd-sdk packages pinned in package.json and
// installed by `npm ci`. The gate requires:
//   1. the committed bundle's and .d.ts's sha256 equal src/vendor/PROVENANCE.json, so neither can be hand-edited
//      or left stale without the provenance changing with it;
//   2. the pinned csd-sdk package versions and their package-lock.json integrity equal PROVENANCE.json;
//   3. the wallet's @noble pins equal PROVENANCE.noble and the @noble versions the installed csd-crypto declares,
//      so the bundle's crypto (the SPV path) and the signing path use the same @noble;
//   4. a rebuild into a temp dir from the installed packages is byte-identical to both committed files.
//
// Usage:
//   node scripts/check-vendor-fresh.mjs            verify (CI and pre-publish gate; exit 1 on drift)
//   node scripts/check-vendor-fresh.mjs --write    regenerate PROVENANCE.json after a deliberate rebuild
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

const WALLET = join(import.meta.dirname, "..");
const VENDOR = join(WALLET, "src/vendor");
const FILES = ["cairnx-spv.js", "cairnx-spv.d.ts"];
const PROV = join(VENDOR, "PROVENANCE.json");
const WRITE = process.argv.includes("--write");

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const fail = (m) => { console.error(`  ✗ ${m}`); process.exitCode = 1; };
const ok = (m) => console.log(`  ✓ ${m}`);
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));

const pkg = readJson(join(WALLET, "package.json"));
const lock = readJson(join(WALLET, "package-lock.json"));
const NOBLE = ["@noble/curves", "@noble/hashes"];
const walletNoble = Object.fromEntries(NOBLE.map((k) => [k, pkg.dependencies?.[k]]));
const shas = Object.fromEntries(FILES.map((f) => [f, sha256(readFileSync(join(VENDOR, f)))]));
// The csd-sdk packages the bundle is built from: every @inversealtruism dev dependency, with the integrity
// package-lock.json records for its registry tarball.
const packages = Object.fromEntries(Object.entries(pkg.devDependencies ?? {})
  .filter(([name]) => name.startsWith("@inversealtruism/"))
  .map(([name, version]) => [name, { version, integrity: lock.packages?.[`node_modules/${name}`]?.integrity ?? null }]));
const cryptoPkgPath = join(WALLET, "node_modules/@inversealtruism/csd-crypto/package.json");
const sdkNoble = existsSync(cryptoPkgPath) ? Object.fromEntries(NOBLE.map((k) => [k, readJson(cryptoPkgPath).dependencies?.[k]])) : null;

if (WRITE) {
  const prov = {
    note: "Provenance for src/vendor/cairnx-spv.js and cairnx-spv.d.ts. Built by scripts/build-spv-vendor.sh from the csd-sdk packages below; regenerate with `node scripts/check-vendor-fresh.mjs --write`; verified by scripts/check-vendor-fresh.mjs.",
    packages,
    sha256: shas,
    noble: sdkNoble,
  };
  writeFileSync(PROV, JSON.stringify(prov, null, 2) + "\n");
  console.log("wrote", PROV, "\n", JSON.stringify(prov, null, 2));
  process.exit(0);
}

console.log("Vendor-freshness gate (src/vendor/cairnx-spv.js, cairnx-spv.d.ts):");
if (!existsSync(PROV)) { fail("src/vendor/PROVENANCE.json missing; run with --write to create it"); process.exit(1); }
const prov = readJson(PROV);

// 1. committed files == recorded provenance
for (const f of FILES) {
  if (shas[f] === prov.sha256?.[f]) ok(`${f} sha256 matches PROVENANCE (${shas[f].slice(0, 12)}…)`);
  else fail(`${f} sha256 ${shas[f].slice(0, 12)}… != PROVENANCE ${String(prov.sha256?.[f]).slice(0, 12)}…: edited or stale without updating provenance`);
}

// 2. pinned package versions and lockfile integrity == recorded provenance
const names = [...new Set([...Object.keys(packages), ...Object.keys(prov.packages ?? {})])].sort();
for (const name of names) {
  const a = packages[name], b = prov.packages?.[name];
  if (a && b && a.version === b.version && a.integrity && a.integrity === b.integrity) ok(`${name} ${a.version} matches PROVENANCE`);
  else fail(`${name}: package.json/package-lock.json have ${a ? `${a.version} ${a.integrity}` : "none"}, PROVENANCE has ${b ? `${b.version} ${b.integrity}` : "none"}`);
}

// 3. the second crypto mirror: wallet @noble pins == provenance == what the installed csd-crypto declares
for (const k of NOBLE) {
  if (walletNoble[k] && walletNoble[k] === prov.noble?.[k] && walletNoble[k] === sdkNoble?.[k]) ok(`${k} ${walletNoble[k]}: wallet pin, PROVENANCE and csd-crypto agree`);
  else fail(`${k}: wallet pins ${walletNoble[k]}, PROVENANCE has ${prov.noble?.[k]}, csd-crypto declares ${sdkNoble?.[k]} (crypto-mirror drift)`);
}

// 4. rebuild from the installed packages into a temp dir, removed on every path, and require byte-identity
const tmp = mkdtempSync(join(tmpdir(), "vendor-fresh-"));
let rebuilt = null;
try {
  execFileSync("bash", [join(WALLET, "scripts/build-spv-vendor.sh")],
    { env: { ...process.env, VENDOR_OUT_DIR: tmp }, stdio: ["ignore", "ignore", "inherit"] });
  rebuilt = Object.fromEntries(FILES.map((f) => [f, sha256(readFileSync(join(tmp, f)))]));
} catch { fail("rebuild failed (scripts/build-spv-vendor.sh could not bundle the installed packages; run `npm ci`)"); }
finally { rmSync(tmp, { recursive: true, force: true }); }
if (rebuilt) {
  for (const f of FILES) {
    if (rebuilt[f] === shas[f]) ok(`${f} is byte-identical to a rebuild from the pinned packages`);
    else fail(`STALE: a rebuild of ${f} (${rebuilt[f].slice(0, 12)}…) != committed (${shas[f].slice(0, 12)}…); run scripts/build-spv-vendor.sh && node scripts/check-vendor-fresh.mjs --write`);
  }
}

if (process.exitCode) console.error("\nvendor-freshness gate FAILED");
else console.log("\nvendor-freshness gate PASSED");
