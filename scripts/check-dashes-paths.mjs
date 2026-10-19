#!/usr/bin/env node
// Fails when a tracked .md outside docs/archive/ contains an em dash (U+2014), or when tracked code reads a
// sibling checkout (a parent-relative cairn* or csd-* directory, or the host's absolute checkout root). Docs may
// name those paths; only code is checked for them. Run: node scripts/check-dashes-paths.mjs [repo root]
// KEEP-IN-SYNC with cairn-sdk's scripts/check-dashes-paths.mjs: the same checks with each repo's own exceptions (the
// wallet takes no shared npm package, so the script has no common home).
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Code allowed to read a sibling checkout, each with its reason.
export const PATH_EXCEPTIONS = {
  "scripts/build-spv-vendor.sh": "rebuilds the vendored bundle from a csd-sdk checkout; CSD_SDK_DIR overrides the sibling default (AGENTS.md, vendor-fresh-full)",
  "scripts/check-vendor-fresh.mjs": "the vendor-freshness gate re-runs build-spv-vendor.sh against the same CSD_SDK_DIR default",
  "test/check-dashes-paths.test.mjs": "fixtures for this check",
};

const SIBLING = /\.\.\/(?:cairn[a-z-]*|csd-[a-z-]+)(?![\w.])|\/opt\/cairn_substrate\//;
const CODE = /\.(?:[cm]?js|[cm]?ts|tsx|sh|json|ya?ml|html)$/;

export function offences(root) {
  const files = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean);
  const out = [];
  for (const f of files) {
    const isDoc = f.endsWith(".md") && !f.startsWith("docs/archive/");
    const isCode = CODE.test(f) && !(f in PATH_EXCEPTIONS);
    if (!isDoc && !isCode) continue;
    const text = readFileSync(join(root, f), "utf8");
    if (isDoc && text.includes("\u2014")) out.push(`${f}: em dash (U+2014)`);
    if (isCode && SIBLING.test(text)) out.push(`${f}: reads a sibling checkout (${text.match(SIBLING)[0]})`);
  }
  return out;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const found = offences(resolve(process.argv[2] ?? "."));
  for (const line of found) console.error(line);
  console.log(found.length === 0 ? "check-dashes-paths: clean" : `check-dashes-paths: ${found.length} offence(s)`);
  process.exit(found.length === 0 ? 0 : 1);
}
