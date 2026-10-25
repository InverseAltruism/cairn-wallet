// scripts/check-vendor-fresh.mjs rebuilds the bundle into a temp dir; it must remove that dir on every path
// (it left one behind per run, 341 under /tmp on the maintainer host by 2026-10-14). Runs the real script with
// TMPDIR pointed at a private dir: (1) a copy of the wallet whose package.json pins a csd-sdk version other than the
// installed one, so the rebuild refuses and the gate exits 1; (2) the gate in this tree, which passes.
// Run: npx tsx test/check-vendor-fresh-tmp.test.mjs   (offline)
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, cpSync, symlinkSync, writeFileSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checker } from "./helpers/check.mjs";

const { check, done } = checker();
const WALLET = join(import.meta.dirname, "..");
// The gate's rebuild dir and the build script's entry dir (mktemp -d, removed by its trap).
const leftovers = (dir) => readdirSync(dir).filter((n) => n.startsWith("vendor-fresh-") || n.startsWith("tmp."));
const run = (root, env) => {
  try { execFileSync(process.execPath, [join(root, "scripts/check-vendor-fresh.mjs")], { env: { ...process.env, ...env }, stdio: "pipe" }); return { code: 0, err: "" }; }
  catch (e) { return { code: e.status ?? -1, err: String(e.stderr ?? "") }; }
};

const work = mkdtempSync(join(tmpdir(), "vftmp-test-"));
try {
  const copy = join(work, "wallet");
  mkdirSync(join(copy, "src"), { recursive: true });
  for (const p of ["scripts", "src/vendor", "package.json", "package-lock.json"]) cpSync(join(WALLET, p), join(copy, p), { recursive: true });
  symlinkSync(join(WALLET, "node_modules"), join(copy, "node_modules"));
  const pkg = JSON.parse(readFileSync(join(copy, "package.json"), "utf8"));
  pkg.devDependencies["@inversealtruism/cairnx-core"] = "0.0.0";
  writeFileSync(join(copy, "package.json"), JSON.stringify(pkg, null, 2));
  const tmp1 = join(work, "tmp1");
  mkdirSync(tmp1);
  const { code, err } = run(copy, { TMPDIR: tmp1 });
  check(`a rebuild that fails exits 1 through the gate's own message, not a crash (got ${code})`, code === 1 && /rebuild failed/.test(err) && /installed 0\.\d+\.\d+, package\.json pins 0\.0\.0/.test(err) && !/^\s+at /m.test(err));
  check(`...and leaves no temp dir behind (${leftovers(tmp1).join(",") || "none"})`, leftovers(tmp1).length === 0);

  const tmp2 = join(work, "tmp2");
  mkdirSync(tmp2);
  const { code: ok, err: okErr } = run(WALLET, { TMPDIR: tmp2 });
  check(`honest path: the gate passes on this tree (exit ${ok}${okErr ? `: ${okErr.trim().slice(0, 200)}` : ""})`, ok === 0);
  check(`...and leaves no temp dir behind (${leftovers(tmp2).join(",") || "none"})`, leftovers(tmp2).length === 0);
} finally { rmSync(work, { recursive: true, force: true }); }

done("check-vendor-fresh-tmp");
