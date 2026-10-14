// scripts/check-vendor-fresh.mjs rebuilds the bundle into a temp dir; it must remove that dir on every path
// (it left one behind per run, 341 under /tmp on the maintainer host by 2026-10-14). Runs the real script with
// TMPDIR pointed at a private dir: (1) a csd-sdk checkout whose dists are incomplete, so the rebuild fails and
// the gate exits 1; (2) when CSD_SDK_DIR names a built csd-sdk at the PROVENANCE commit, the passing gate.
// Run: npx tsx test/check-vendor-fresh-tmp.test.mjs   (offline)
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checker } from "./helpers/check.mjs";

const { check, done } = checker();
const WALLET = join(import.meta.dirname, "..");
const SCRIPT = join(WALLET, "scripts/check-vendor-fresh.mjs");
const pkg = JSON.parse(readFileSync(join(WALLET, "package.json"), "utf8"));
const leftovers = (dir) => readdirSync(dir).filter((n) => n.startsWith("vendor-fresh-"));
const run = (env) => {
  try { execFileSync(process.execPath, [SCRIPT], { env: { ...process.env, ...env }, stdio: "pipe" }); return 0; }
  catch (e) { return e.status ?? -1; }
};

const work = mkdtempSync(join(tmpdir(), "vftmp-test-"));
try {
  // A csd-sdk with the cairnx dist (so the gate attempts the rebuild) and none of the others (so it fails).
  const sdk = join(work, "sdk");
  mkdirSync(join(sdk, "packages/cairnx/dist"), { recursive: true });
  mkdirSync(join(sdk, "packages/crypto"), { recursive: true });
  writeFileSync(join(sdk, "packages/cairnx/dist/index.js"), "export {};\n");
  writeFileSync(join(sdk, "packages/cairnx/package.json"), JSON.stringify({ version: "0.0.0" }));
  writeFileSync(join(sdk, "packages/crypto/package.json"), JSON.stringify({ dependencies: { "@noble/curves": pkg.dependencies["@noble/curves"], "@noble/hashes": pkg.dependencies["@noble/hashes"] } }));
  const tmp1 = join(work, "tmp1");
  mkdirSync(tmp1);
  const code = run({ CSD_SDK_DIR: sdk, TMPDIR: tmp1 });
  check(`a rebuild that fails exits 1 (got ${code})`, code === 1);
  check(`...and leaves no temp dir behind (${leftovers(tmp1).join(",") || "none"})`, leftovers(tmp1).length === 0);

  const real = process.env.CSD_SDK_DIR;
  if (real && existsSync(join(real, "packages/cairnx/dist/index.js"))) {
    const tmp2 = join(work, "tmp2");
    mkdirSync(tmp2);
    const ok = run({ CSD_SDK_DIR: real, TMPDIR: tmp2 });
    check(`honest path: the gate passes against CSD_SDK_DIR (exit ${ok})`, ok === 0);
    check(`...and leaves no temp dir behind (${leftovers(tmp2).join(",") || "none"})`, leftovers(tmp2).length === 0);
  } else {
    console.log("  • CSD_SDK_DIR not set to a built csd-sdk: the passing-gate leg is covered by the vendor-fresh-full CI job");
  }
} finally { rmSync(work, { recursive: true, force: true }); }

done("check-vendor-fresh-tmp");
