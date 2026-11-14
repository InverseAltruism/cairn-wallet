// Every setup-node step in ci.yml and release.yml names one Node major, 26: the runtime the release host runs since
// 2026-11-13, so the local CI-equivalent run (cairn scripts/ci-local.sh, which refuses a workflow whose node-version
// differs from the host's major) and a maintainer's reproduce-then-publish build use the Node the workflows use. The
// release zips were byte-identical across Node 22 (the v0.3.2 release job) and Node 26 (local rebuilds on 2026-11-14).
//   RED-FIRST: the last check runs the rule on a copy with one job back on "22" and expects it to fail.
// Run: npx tsx test/ci-node-version.test.mjs   (offline)
import { readFileSync } from "node:fs";
import { checker } from "./helpers/check.mjs";

const { check, done } = checker("ci node version:");
const wf = (f) => readFileSync(new URL(`../.github/workflows/${f}`, import.meta.url), "utf8");
const versions = (text) => [...text.matchAll(/uses: actions\/setup-node@[0-9a-f]{40}[^\n]*\n\s+with:\n(?:\s+\w[\w-]*:[^\n]*\n)*?\s+node-version: "?([^"\n]+)"?/g)].map((m) => m[1]);
const steps = (text) => (text.match(/uses: actions\/setup-node@/g) || []).length;
const on26 = (text) => versions(text).length === steps(text) && versions(text).every((v) => v === "26");
const ci = wf("ci.yml"), rel = wf("release.yml");
check(`ci.yml: its setup-node step names Node 26 (${versions(ci).join(",")})`, steps(ci) === 1 && on26(ci));
check(`release.yml: its two setup-node steps (anchors, build) name Node 26 (${versions(rel).join(",")})`, steps(rel) === 2 && on26(rel));
check("the rule refuses a job on another major", !on26(rel.replace('node-version: "26"', 'node-version: "22"')));
done("ci-node-version");
