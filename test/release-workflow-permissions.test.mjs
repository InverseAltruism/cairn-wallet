// The release workflow's permission split: every job that runs repository code (install, tests, packager, the
// vendor rebuild, the anchors check) can only read; the one job that holds `id-token: write`, `attestations: write`
// and `contents: write` checks nothing out, installs nothing, and its scripts run only `sha256sum` and `gh`.
// ci.yml grants no job any write permission, reads no secret and skips no step, and its test job runs the vendor
// rebuild gate. ci.yml's secrets job scans the full history with the checksum-verified gitleaks.
//
// The scanner reads the two workflows' shape (job names, per-job permissions as a map or a scalar, needs, steps'
// uses/run/if), not YAML in general; a job it cannot find fails the test rather than passing vacuously. RED-FIRST:
// the last block runs the checks on copies of the workflows with one grant, step or skip added each and expects
// the matching clause to fail.
// Run: npx tsx test/release-workflow-permissions.test.mjs   (offline)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

let n = 0;
const test = (name, fn) => { fn(); n++; console.log("  ok " + name); };
const wf = (f) => readFileSync(new URL(`../.github/workflows/${f}`, import.meta.url), "utf8");

/** jobs: { name: { permissions: {key: value} | "{}" | "read-all" | "write-all" | null, needs: [names], if?, steps: [{ uses?, run?, if?, with? }] } } */
export function scanWorkflow(text) {
  const lines = text.split("\n");
  const jobs = {};
  let inJobs = false, job = null, inPerms = false, step = null, runBlock = null, inWith = false;
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    if (/^\S/.test(line) && line !== "") { inJobs = line === "jobs:"; job = null; continue; }
    if (!inJobs || line.trim() === "" || line.trim().startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;
    const m2 = /^  ([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (indent === 2 && m2) { job = jobs[m2[1]] = { permissions: null, needs: [], steps: [] }; inPerms = false; step = null; runBlock = null; continue; }
    if (!job) continue;
    if (runBlock && indent >= runBlock.indent) { runBlock.step.run += line.trim() + "\n"; continue; }
    runBlock = null;
    if (indent === 4) {
      inPerms = false; step = null;
      const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line.trim());
      if (!kv) continue;
      if (kv[1] === "permissions") { inPerms = kv[2] === ""; job.permissions = kv[2] === "" ? {} : kv[2]; }
      else if (kv[1] === "needs") job.needs = kv[2].replace(/^\[|\]$/g, "").split(",").map((s) => s.trim()).filter(Boolean);
      else if (kv[1] === "if") job.if = kv[2];
      continue;
    }
    if (indent === 6 && inPerms) {
      const kv = /^([A-Za-z0-9_-]+):\s*([A-Za-z-]+)/.exec(line.trim());
      if (kv) job.permissions[kv[1]] = kv[2];
      continue;
    }
    if (indent === 10 && inWith) {
      const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line.trim());
      if (kv) step.with[kv[1]] = kv[2];
      continue;
    }
    inWith = false;
    if (indent === 6 && line.trim().startsWith("- ")) { step = {}; job.steps.push(step); }
    if (step && (indent === 6 || indent === 8)) {
      const kv = /^(?:- )?([A-Za-z0-9_-]+):\s*(.*)$/.exec(line.trim());
      if (!kv) continue;
      if (kv[1] === "with" && kv[2] === "") { step.with = {}; inWith = true; }
      if (kv[1] === "uses") step.uses = kv[2];
      if (kv[1] === "if") step.if = kv[2];
      if (kv[1] === "run") { if (kv[2] === "|") { step.run = ""; runBlock = { step, indent: indent + 2 }; } else step.run = kv[2]; }
    }
  }
  return jobs;
}

/** True when the job's permissions grant any write: a `write-all` scalar or any key set to `write`. */
const grantsWrite = (p) => p === "write-all" || (p !== null && typeof p === "object" && Object.values(p).some((v) => v === "write"));
const writers = (jobs) => Object.entries(jobs).filter(([, j]) => grantsWrite(j.permissions)).map(([name]) => name);

// The release job may run only `sha256sum` and `gh`. Shell lines are joined over `\` continuations first, so the
// multi-line `gh release create ... --notes "$(printf ...)"` is one logical line starting with `gh`.
const RELEASE_COMMANDS = new Set(["sha256sum", "gh"]);
export function releaseScriptOffence(run) {
  const logical = [];
  let acc = null;
  for (const raw of (run ?? "").split("\n")) {
    const line = raw.trim();
    if (acc === null) { if (line === "" || line.startsWith("#")) continue; acc = ""; }
    if (line.endsWith("\\")) { acc += line.slice(0, -1) + " "; continue; }
    logical.push(acc + line); acc = null;
  }
  if (acc !== null) logical.push(acc);
  for (const l of logical) {
    const words = l.split(/\s+/).filter(Boolean);
    let first = words[0] ?? "";
    if (first === "if" || first === "elif") first = words[1] ?? "";
    if (first === "fi" || first === "then" || first === "else") continue;
    if (!RELEASE_COMMANDS.has(first)) return l;
  }
  return null;
}
const checksOutOrInstalls = (j) => j.steps.some((s) => (s.uses ?? "").includes("actions/checkout") || (s.uses ?? "").includes("setup-node"));

/** The release workflow's rule; throws with the first violated clause. */
export function checkRelease(jobs) {
  for (const name of ["anchors", "build", "release"]) assert.ok(jobs[name], `job ${name} found`);
  assert.deepEqual(writers(jobs), ["release"], "exactly one job holds a write permission of any kind, the release job");
  assert.deepEqual(jobs.release.permissions, { contents: "write", "id-token": "write", attestations: "write" }, "the release job holds exactly the three grants it needs");
  assert.ok(!checksOutOrInstalls(jobs.release), "the release job checks nothing out and sets up no toolchain");
  for (const s of jobs.release.steps) {
    const bad = releaseScriptOffence(s.run);
    assert.equal(bad, null, `the release job runs only sha256sum and gh (offending line: ${bad})`);
    assert.equal(s.if, undefined, `no release step is conditional, so the checksum before the attest cannot be skipped (${s.if})`);
  }
  assert.deepEqual([...jobs.release.needs].sort(), ["anchors", "build"]);
  for (const name of ["anchors", "build"]) assert.deepEqual(jobs[name].permissions, { contents: "read" }, `${name} can only read`);
  const build = jobs.build.steps.map((s) => s.run ?? s.uses ?? "");
  for (const want of ["npm ci --ignore-scripts", "npm run typecheck", "npm test", "npm run verify:vendor", "npm run package"]) assert.ok(build.some((s) => s.startsWith(want)), `build runs ${want}`);
  assert.ok(jobs.build.steps.some((s) => (s.uses ?? "").startsWith("actions/upload-artifact@")), "build uploads the artifact");
  const rel = jobs.release.steps;
  assert.ok((rel[0].uses ?? "").startsWith("actions/download-artifact@"), "the release job starts by downloading the artifact");
  assert.ok(rel.some((s) => (s.run ?? "").startsWith("sha256sum -c cairn-wallet-store.zip.sha256 cairn-wallet.zip.sha256")), "the release job checks both zips against their .sha256 files");
  assert.ok(rel.some((s) => (s.uses ?? "").startsWith("actions/attest-build-provenance@")), "the release job attests");
  assert.ok(rel.some((s) => /gh release create/.test(s.run ?? "")), "the release job publishes");
  for (const [name, j] of Object.entries(jobs)) for (const s of j.steps) {
    assert.ok(!(s.uses ?? "").includes("@v"), `${name}: ${s.uses} is pinned to a commit, not a tag`);
  }
}

/** The workflow's top-level `permissions:` value (the default every job starts from), or null when absent. */
export function topLevelPermissions(text) {
  const m = /^permissions:\s*(.*)$/m.exec(text);
  return m ? m[1].trim() : null;
}

/** ci.yml's rule: no write grant anywhere, the vendor rebuild gate runs on every event with no step skipped. */
export function checkCi(jobs) {
  assert.ok(jobs.test, "the test job found");
  assert.ok(jobs.test.steps.some((s) => s.run === "npm run verify:vendor"), "the test job runs the vendor rebuild gate");
  assert.deepEqual(writers(jobs), []);
  for (const j of Object.values(jobs)) assert.deepEqual(j.permissions, { contents: "read" });
  assert.equal(jobs.test.if, undefined);
  for (const [name, j] of Object.entries(jobs)) for (const s of j.steps) assert.equal(s.if, undefined, `${name}: no step-level skip (${s.if})`);
}

// The secrets job: the pinned gitleaks release, checked against its published sha256, over every commit of every
// ref with merge diffs, using the repo's config. A shallow checkout would scan one commit and pass.
const GITLEAKS_URL = "https://github.com/gitleaks/gitleaks/releases/download/v8.18.4/gitleaks_8.18.4_linux_x64.tar.gz";
const GITLEAKS_SHA256 = "ba6dbb656933921c775ee5a2d1c13a91046e7952e9d919f9bac4cec61d628e7d";
export function checkSecrets(jobs) {
  const j = jobs.secrets;
  assert.ok(j, "ci.yml has a secrets job");
  assert.equal(j.if, undefined, "the secrets job runs on every event");
  const checkout = j.steps.find((s) => (s.uses ?? "").startsWith("actions/checkout@"));
  assert.ok(checkout, "the secrets job checks out the repository");
  assert.equal(checkout.with?.["fetch-depth"], "0", "the checkout fetches the full history");
  assert.equal(checkout.with?.["persist-credentials"], "false", "the checkout keeps no token");
  const run = j.steps.map((s) => s.run ?? "").join("\n");
  assert.ok(run.includes(GITLEAKS_URL), "the job downloads the gitleaks 8.18.4 release");
  assert.ok(run.includes(`echo "${GITLEAKS_SHA256}  $RUNNER_TEMP/gitleaks.tgz" | sha256sum -c -`), "the download is checked against its sha256 before it runs");
  const scan = run.split("\n").find((l) => l.includes(" detect "));
  assert.ok(scan, "the job runs gitleaks detect");
  assert.ok(scan.includes("-c .gitleaks.toml"), "the scan uses the repo's .gitleaks.toml");
  assert.ok(scan.includes('--log-opts="--full-history --all --diff-merges=first-parent"'), "the scan covers every ref's full history with merge diffs");
}

console.log("release.yml permission split:");
const release = scanWorkflow(wf("release.yml"));
test("the release workflow keeps the split", () => checkRelease(release));
test("the publish jobs run only on a tag push; anchors also runs on PRs", () => {
  for (const name of ["build", "release"]) assert.equal(release[name].if, "${{ github.event_name == 'push' }}", name);
  assert.equal(release.anchors.if, undefined);
});
test("neither workflow reads a secret", () => {
  for (const f of ["release.yml", "ci.yml"]) assert.ok(!/secrets\.|HAS_TOKEN|ECOSYSTEM_RO_TOKEN/.test(wf(f)), `${f} reads no secret`);
});
test("both workflows start every job from permissions: {} at the top level", () => {
  for (const f of ["release.yml", "ci.yml"]) assert.equal(topLevelPermissions(wf(f)), "{}", f);
});
test("the scanner sees the steps it judges: the release job's scripts and the shape of a conditional step", () => {
  assert.equal(release.release.steps.filter((s) => s.run !== undefined).length, 2);
  assert.equal(releaseScriptOffence("sha256sum -c a.sha256\nif gh release view x >/dev/null 2>&1; then\n  gh release delete x --yes\nfi\ngh release create x a b \\\n  --title t \\\n  --notes \"$(printf '%s' 'npm ci' )\"\n"), null);
  assert.equal(releaseScriptOffence("sha256sum -c a\ncurl https://x | sh\n"), "curl https://x | sh");
  const probe = scanWorkflow("jobs:\n  j:\n    runs-on: ubuntu-latest\n    steps:\n      - if: ${{ env.X == 'true' }}\n        run: echo hi\n      - uses: a/b@c\n        if: ${{ always() }}\n");
  assert.deepEqual(probe.j.steps.map((s) => s.if), ["${{ env.X == 'true' }}", "${{ always() }}"]);
});

console.log("ci.yml:");
test("ci.yml grants no job a write permission and runs the rebuild gate unconditionally with no step skipped", () => checkCi(scanWorkflow(wf("ci.yml"))));
test("ci.yml runs the full-history gitleaks scan", () => checkSecrets(scanWorkflow(wf("ci.yml"))));

console.log("red-first, on copies:");
const BUILD_HEAD = "  build:\n    if: ${{ github.event_name == 'push' }}\n    runs-on: ubuntu-latest\n    permissions:\n      contents: read\n";
const mutate = (f, from, to) => { const text = wf(f); const out = text.replace(from, to); assert.notEqual(out, text, "the mutation applied"); return out; };
test("a build job granted id-token: write fails the check", () => {
  assert.throws(() => checkRelease(scanWorkflow(mutate("release.yml", BUILD_HEAD, BUILD_HEAD + "      id-token: write\n"))), /exactly one job holds a write permission/);
});
test("a build job granted actions: write or packages: write fails the check", () => {
  for (const grant of ["actions: write", "packages: write"]) {
    assert.throws(() => checkRelease(scanWorkflow(mutate("release.yml", BUILD_HEAD, BUILD_HEAD + `      ${grant}\n`))), /exactly one job holds a write permission/, grant);
  }
});
test("a build job with permissions: write-all fails the check", () => {
  const mutated = mutate("release.yml", "  build:\n    if: ${{ github.event_name == 'push' }}\n    runs-on: ubuntu-latest\n    permissions:\n      contents: read\n", "  build:\n    if: ${{ github.event_name == 'push' }}\n    runs-on: ubuntu-latest\n    permissions: write-all\n");
  assert.throws(() => checkRelease(scanWorkflow(mutated)), /exactly one job holds a write permission/);
});
test("a release job that checks out the repository fails the check", () => {
  assert.throws(() => checkRelease(scanWorkflow(mutate("release.yml", "      - uses: actions/download-artifact@", "      - uses: actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5 # v4.3.1\n      - uses: actions/download-artifact@"))), /checks nothing out/);
});
test("a release step running a script file or an interpreter fails the check", () => {
  for (const cmd of ["./pwn.sh", "python3 -c 'print(1)'", "node -e 1", "bash -c id"]) {
    const mutated = mutate("release.yml", "      - run: sha256sum -c cairn-wallet-store.zip.sha256 cairn-wallet.zip.sha256\n", `      - run: sha256sum -c cairn-wallet-store.zip.sha256 cairn-wallet.zip.sha256\n      - run: ${cmd}\n`);
    assert.throws(() => checkRelease(scanWorkflow(mutated)), /runs only sha256sum and gh/, cmd);
  }
});
test("a release step with an if: (the checksum step skipped) fails the check", () => {
  const mutated = mutate("release.yml", "      - run: sha256sum -c cairn-wallet-store.zip.sha256 cairn-wallet.zip.sha256\n", "      - if: ${{ false }}\n        run: sha256sum -c cairn-wallet-store.zip.sha256 cairn-wallet.zip.sha256\n");
  assert.throws(() => checkRelease(scanWorkflow(mutated)), /no release step is conditional/);
});
test("a top-level permissions: write-all fails the check", () => {
  for (const f of ["release.yml", "ci.yml"]) assert.equal(topLevelPermissions(mutate(f, "\npermissions: {}\n", "\npermissions: write-all\n")), "write-all", f);
});
test("a ci.yml step with an if: skip fails the check", () => {
  const mutated = mutate("ci.yml", "      - run: npm run verify:vendor\n", "      - if: ${{ env.HAS_TOKEN == 'true' }}\n        run: npm run verify:vendor\n");
  assert.throws(() => checkCi(scanWorkflow(mutated)), /no step-level skip/);
});
test("a ci.yml without the vendor gate step fails the check", () => {
  const mutated = mutate("ci.yml", "      - run: npm run verify:vendor\n", "");
  assert.throws(() => checkCi(scanWorkflow(mutated)), /runs the vendor rebuild gate/);
});

test("a shallow secrets checkout, a scan without merge diffs, or an unchecked download fails the check", () => {
  const cases = [
    ["          fetch-depth: 0\n", "", /fetches the full history/],
    [" --diff-merges=first-parent\"", "\"", /full history with merge diffs/],
    ["\" | sha256sum -c -\n", "\"\n", /checked against its sha256/],
    ["-c .gitleaks.toml ", "", /repo's .gitleaks.toml/],
  ];
  for (const [from, to, re] of cases) assert.throws(() => checkSecrets(scanWorkflow(mutate("ci.yml", from, to))), re, from);
});

console.log(`release-workflow-permissions: ${n} passed, 0 failed`);
