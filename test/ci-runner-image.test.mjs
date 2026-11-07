// Every job in ci.yml and release.yml names a fixed runner image. playwright-core 1.60.0 installs its Chromium only on
// images it supports, and GitHub moved ubuntu-latest to 26.04, where that install fails (cairn's CI, 2026-11-05; this
// repo's ci.yml on 2026-11-07). The release build job installs the same Chromium, so a moving image can stop a tag.
// RED-FIRST: the last check runs the rule on a copy with one job moved back to ubuntu-latest and expects it to fail.
// Run: npx tsx test/ci-runner-image.test.mjs   (offline)
import { readFileSync } from "node:fs";
import { checker } from "./helpers/check.mjs";

const { check, done } = checker("ci runner image:");
const wf = (f) => readFileSync(new URL(`../.github/workflows/${f}`, import.meta.url), "utf8");
const images = (text) => [...text.matchAll(/^ {4}runs-on: *(\S+)/gm)].map((m) => m[1]);
const fixed = (text) => images(text).every((img) => !/latest/.test(img));

const ci = wf("ci.yml");
const rel = wf("release.yml");
check("ci.yml has its two jobs' runners", images(ci).length === 2);
check("release.yml has its three jobs' runners", images(rel).length === 3);
check("every ci.yml job names a fixed image", fixed(ci));
check("every release.yml job names a fixed image", fixed(rel));
check("the rule refuses a job on ubuntu-latest", !fixed(rel.replace(/^( {4}runs-on: *)\S+/m, "$1ubuntu-latest")));
done("ci-runner-image");
