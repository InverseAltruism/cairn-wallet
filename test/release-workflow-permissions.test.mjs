// The release workflow's permission split: every job that runs repository code (install, tests, packager, the
// vendor rebuild, the anchors check) can only read, and the one job that holds `id-token: write`,
// `attestations: write` and `contents: write` checks nothing out, installs nothing and only downloads, checks,
// attests and publishes the build job's zips. ci.yml grants no job a write permission, and neither workflow gates
// the csd-sdk rebuild on a secret (csd-sdk is public).
//
// The scanner reads the two workflows' shape (job names, per-job permissions, needs, steps' uses/run), not YAML
// in general; a job it cannot find fails the test rather than passing vacuously. RED-FIRST: the last block runs the
// scanner on a copy of release.yml that grants the build job `id-token: write` and expects the check to fail.
// Run: npx tsx test/release-workflow-permissions.test.mjs   (offline)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

let n = 0;
const test = (name, fn) => { fn(); n++; console.log("  ok " + name); };
const wf = (f) => readFileSync(new URL(`../.github/workflows/${f}`, import.meta.url), "utf8");

/** jobs: { name: { permissions: {key: value} | "{}", needs: [names], steps: [{ uses?, run? }] } } */
export function scanWorkflow(text) {
  const lines = text.split("\n");
  const jobs = {};
  let inJobs = false, job = null, inPerms = false, step = null, runBlock = null;
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
      if (kv[1] === "permissions") { inPerms = kv[2] === ""; job.permissions = kv[2] === "{}" ? "{}" : {}; }
      else if (kv[1] === "needs") job.needs = kv[2].replace(/^\[|\]$/g, "").split(",").map((s) => s.trim()).filter(Boolean);
      else if (kv[1] === "if") job.if = kv[2];
      continue;
    }
    if (indent === 6 && inPerms) {
      const kv = /^([A-Za-z0-9_-]+):\s*([A-Za-z]+)/.exec(line.trim());
      if (kv) job.permissions[kv[1]] = kv[2];
      continue;
    }
    if (indent === 6 && line.trim().startsWith("- ")) { step = { uses: undefined, run: undefined }; job.steps.push(step); }
    if (step && (indent === 6 || indent === 8)) {
      const kv = /^(?:- )?([A-Za-z0-9_-]+):\s*(.*)$/.exec(line.trim());
      if (!kv) continue;
      if (kv[1] === "uses") step.uses = kv[2];
      if (kv[1] === "run") { if (kv[2] === "|") { step.run = ""; runBlock = { step, indent: indent + 2 }; } else step.run = kv[2]; }
    }
  }
  return jobs;
}

const WRITES = ["id-token", "attestations", "contents"];
const writers = (jobs) => Object.entries(jobs).filter(([, j]) => j.permissions && j.permissions !== "{}" && WRITES.some((k) => j.permissions[k] === "write")).map(([name]) => name);
// A step runs repository code when it checks the repository out, sets up node, or a line of its script starts a
// package manager or interpreter (the first word of each line; the release notes mention `npm` inside a string).
const CODE_RUNNERS = new Set(["npm", "npx", "node", "pnpm", "tsx", "bash", "sh"]);
const runsCode = (j) => j.steps.some((s) => (s.uses ?? "").includes("actions/checkout") || (s.uses ?? "").includes("setup-node")
  || (s.run ?? "").split("\n").some((l) => CODE_RUNNERS.has(l.trim().split(/\s+/)[0] ?? "")));

/** The release workflow's rule; throws with the first violated clause. */
export function checkRelease(jobs) {
  for (const name of ["anchors", "vendor-fresh-full", "build", "release"]) assert.ok(jobs[name], `job ${name} found`);
  assert.deepEqual(writers(jobs), ["release"], "exactly one job holds a write permission, the release job");
  assert.deepEqual(jobs.release.permissions, { contents: "write", "id-token": "write", attestations: "write" });
  assert.ok(!runsCode(jobs.release), "the release job checks nothing out and runs no npm, node or pnpm");
  assert.deepEqual([...jobs.release.needs].sort(), ["anchors", "build", "vendor-fresh-full"]);
  for (const name of ["anchors", "vendor-fresh-full", "build"]) assert.deepEqual(jobs[name].permissions, { contents: "read" }, `${name} can only read`);
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

console.log("release.yml permission split:");
const release = scanWorkflow(wf("release.yml"));
test("the release workflow keeps the split", () => checkRelease(release));
test("the publish jobs run only on a tag push; anchors also runs on PRs", () => {
  for (const name of ["vendor-fresh-full", "build", "release"]) assert.equal(release[name].if, "${{ github.event_name == 'push' }}", name);
  assert.equal(release.anchors.if, undefined);
});
test("no job gates the csd-sdk rebuild on a secret", () => {
  for (const f of ["release.yml", "ci.yml"]) assert.ok(!/secrets\.|HAS_TOKEN|ECOSYSTEM_RO_TOKEN/.test(wf(f)), `${f} reads no secret`);
});

console.log("ci.yml:");
const ci = scanWorkflow(wf("ci.yml"));
test("ci.yml grants no job a write permission and runs the rebuild gate unconditionally", () => {
  assert.ok(ci.test && ci["vendor-fresh-full"], "both jobs found");
  assert.deepEqual(writers(ci), []);
  for (const j of Object.values(ci)) assert.deepEqual(j.permissions, { contents: "read" });
  assert.equal(ci["vendor-fresh-full"].if, undefined);
  assert.ok(ci["vendor-fresh-full"].steps.every((s) => !("if" in s)), "no step-level skips");
});

console.log("red-first, on a copy:");
test("a build job granted id-token: write fails the check", () => {
  const mutated = wf("release.yml").replace("  build:\n    if: ${{ github.event_name == 'push' }}\n    runs-on: ubuntu-latest\n    permissions:\n      contents: read\n", "  build:\n    if: ${{ github.event_name == 'push' }}\n    runs-on: ubuntu-latest\n    permissions:\n      contents: read\n      id-token: write\n");
  assert.notEqual(mutated, wf("release.yml"), "the mutation applied");
  assert.throws(() => checkRelease(scanWorkflow(mutated)), /exactly one job holds a write permission/);
});
test("a release job that checks out the repository fails the check", () => {
  const mutated = wf("release.yml").replace("      - uses: actions/download-artifact@", "      - uses: actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5 # v4.3.1\n      - uses: actions/download-artifact@");
  assert.notEqual(mutated, wf("release.yml"), "the mutation applied");
  assert.throws(() => checkRelease(scanWorkflow(mutated)), /checks nothing out/);
});

console.log(`release-workflow-permissions: ${n} passed, 0 failed`);
