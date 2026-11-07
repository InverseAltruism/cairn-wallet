// The store's post-publish check (store/PUBLISH-RUNBOOK.md step 8) and the release notes verify the attestation's
// signer and tag, not only that a bundle exists, and the CRX comparison sets aside only the root manifest.json and
// _metadata/ the store adds. `diff -x manifest.json` skips every file of that name at any depth, and a bare
// `gh attestation verify --repo` accepts an attestation from any workflow run of the repo.
// Run: npx tsx test/publish-verify-step.test.mjs   (offline)
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { checker } from "./helpers/check.mjs";

const { check, done } = checker("publish verify step:");
const ROOT = join(import.meta.dirname, "..");
const runbook = readFileSync(join(ROOT, "store/PUBLISH-RUNBOOK.md"), "utf8");
const step8 = runbook.slice(runbook.indexOf("8. **Post-publish CRX check.**"), runbook.indexOf("9. **Publish the version"));
const IDENTITY = "https://github.com/InverseAltruism/cairn-wallet/.github/workflows/release.yml@refs/tags/v$V";
check("step 8 pins the attestation to the release workflow and the tag", step8.includes(`--cert-identity "${IDENTITY}"`));
check("step 8 runs a negative control on another tag's identity", /! gh attestation verify[^\n]*\\\n\s*--cert-identity "[^"]*@refs\/tags\/v0\.0\.0"/.test(step8));
check("step 8 says which gh it needs", /gh 2\.49 or later/.test(step8));
check("the CRX diff excludes no name at every depth", !/diff -r[^\n]*-x /.test(step8) && /rm -rf served\/_metadata/.test(step8) && /mv served\/manifest\.json/.test(step8));
const rel = readFileSync(join(ROOT, ".github/workflows/release.yml"), "utf8");
check("the release notes' verify line pins the workflow and the tag", /gh attestation verify cairn-wallet-store\.zip --repo \$\{\{ github\.repository \}\} --cert-identity https:\/\/github\.com\/\$\{\{ github\.repository \}\}\/\.github\/workflows\/release\.yml@refs\/tags\/\$\{GITHUB_REF_NAME\}/.test(rel));
done("publish-verify-step");
