#!/usr/bin/env node
// Byte gate for the vendored cairn-ui copy in src/vendor/cairn-ui/: every file must have the sha256 recorded in
// PROVENANCE.json, and the directory must hold exactly the recorded files. PROVENANCE.json also names the upstream
// cairn-ui commit; this script does not compare against that commit (no network, no sibling checkout), so a file
// changed together with a rewritten PROVENANCE.json passes here and is caught only in review of that diff.
// build.mjs runs the same check before it copies the files into dist/ui/.
//
// Usage:
//   node scripts/check-ui-vendor.mjs                    verify (exit 1 on any mismatch)
//   node scripts/check-ui-vendor.mjs --write <commit>   rewrite PROVENANCE.json after re-vendoring that commit
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const UI_VENDOR_DIR = join(import.meta.dirname, "..", "src", "vendor", "cairn-ui");
const PROVENANCE = "PROVENANCE.json";
/** The vendored files the extension ships, under dist/ui/ (types and provenance records stay in the repo). */
export const UI_SHIP = ["tokens.css", "fonts.css", "theme.css", "theme-init.js", "theme.js", "fonts/Geist-Latin.woff2", "fonts/GeistMono-Latin.woff2", "fonts/OFL.txt"];

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

function listFiles(dir) {
  const out = [];
  const walk = (d) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(relative(dir, p).split("\\").join("/"));
    }
  };
  walk(dir);
  return out.filter((f) => f !== PROVENANCE);
}

/** The problems found in `dir` against its PROVENANCE.json; an empty list means the copy is intact. */
export function verifyUiVendor(dir = UI_VENDOR_DIR) {
  let prov;
  try {
    prov = JSON.parse(readFileSync(join(dir, PROVENANCE), "utf8"));
  } catch (e) {
    return [`${PROVENANCE} unreadable: ${e instanceof Error ? e.message : String(e)}`];
  }
  const recorded = prov && typeof prov.files === "object" && prov.files !== null ? prov.files : {};
  if (!/^[0-9a-f]{40}$/.test(String(prov?.commit ?? ""))) return [`${PROVENANCE}: commit is not a 40-hex git id`];
  const problems = [];
  const present = new Set(listFiles(dir));
  for (const [file, want] of Object.entries(recorded)) {
    if (!present.has(file)) {
      problems.push(`${file}: recorded but missing`);
      continue;
    }
    const got = sha256(readFileSync(join(dir, file)));
    if (got !== want) problems.push(`${file}: sha256 ${got} differs from the recorded ${want}`);
  }
  for (const file of present) if (!(file in recorded)) problems.push(`${file}: present but not recorded`);
  if (Object.keys(recorded).length === 0) problems.push(`${PROVENANCE}: records no files`);
  return problems;
}

function write(dir, commit) {
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error("--write needs the full 40-hex cairn-ui commit");
  const files = {};
  for (const f of listFiles(dir)) files[f] = sha256(readFileSync(join(dir, f)));
  const prov = {
    note: "cairn-ui files vendored byte for byte from the commit below: each is `git show <commit>:<path>` of the file listed in that commit's package.json `files`. Verified by scripts/check-ui-vendor.mjs (also run by build.mjs). To update: copy the files from a new commit, then run `node scripts/check-ui-vendor.mjs --write <commit>`.",
    repository: "https://github.com/InverseAltruism/cairn-ui",
    commit,
    files,
  };
  writeFileSync(join(dir, PROVENANCE), `${JSON.stringify(prov, null, 2)}\n`);
  return Object.keys(files).length;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const at = process.argv.indexOf("--write");
  if (at !== -1) {
    const n = write(UI_VENDOR_DIR, String(process.argv[at + 1] ?? ""));
    console.log(`check-ui-vendor: recorded ${n} files`);
  } else {
    const problems = verifyUiVendor();
    for (const p of problems) console.error(`  ✗ ${p}`);
    console.log(problems.length === 0 ? "check-ui-vendor: every vendored cairn-ui file matches PROVENANCE.json" : `check-ui-vendor: ${problems.length} problem(s)`);
    process.exit(problems.length === 0 ? 0 : 1);
  }
}
