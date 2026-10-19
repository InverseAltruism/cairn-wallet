// scripts/check-dashes-paths.mjs on a throwaway git sandbox (one file per case) and on this repo.
// Run: npx tsx test/check-dashes-paths.test.mjs   (offline)
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { offences, PATH_EXCEPTIONS } from "../scripts/check-dashes-paths.mjs";
import { checker } from "./helpers/check.mjs";

const t = checker("check-dashes-paths:");
const root = fileURLToPath(new URL("..", import.meta.url));
const EM = "\u2014";

const real = offences(root);
t.check(`this repo is clean (${real.join("; ") || "no offences"})`, real.length === 0);
t.check("every exception names its reason", Object.values(PATH_EXCEPTIONS).every((r) => typeof r === "string" && r.length > 10));

const dir = mkdtempSync(join(tmpdir(), "wallet-dashes-"));
try {
  const put = (f, text, track = true) => {
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    writeFileSync(join(dir, f), text);
    if (track) execFileSync("git", ["add", f], { cwd: dir });
  };
  execFileSync("git", ["init", "-q"], { cwd: dir });
  put("README.md", `a ${EM} b\n`);
  put("docs/archive/old.md", `a ${EM} b\n`);
  put("notes.txt", `a ${EM} b\n`);
  put("untracked.md", `a ${EM} b\n`, false);
  put("docs/guide.md", "load ../cairn-wallet/dist and /opt/cairn_substrate/csd-sdk\n");
  put("src/reads-sdk.mjs", 'const d = process.env.X ?? "../csd-sdk/packages";\n');
  put("src/reads-host.ts", 'import x from "/opt/cairn_substrate/cairn/public/a.js";\n');
  put("tools/run.sh", 'cd "${DIR:-../cairnx}"\n');
  put("src/core/local.ts", 'import { a } from "../cairnx.js";\nimport { b } from "../csd-local.ts";\n');
  put("scripts/build-spv-vendor.sh", 'SDK="${CSD_SDK_DIR:-../csd-sdk}"\n');
  const found = offences(dir).map((l) => l.split(":")[0]).sort();
  t.check(`only the tracked offences outside the exceptions are reported (${found.join(", ")})`, JSON.stringify(found) === JSON.stringify([
    "README.md", "src/reads-host.ts", "src/reads-sdk.mjs", "tools/run.sh",
  ]));
  t.check("an em dash is reported as one", offences(dir).includes("README.md: em dash (U+2014)"));
  t.check("a sibling read names the path it matched", offences(dir).includes("src/reads-sdk.mjs: reads a sibling checkout (../csd-sdk)"));
} finally {
  rmSync(dir, { recursive: true, force: true });
}

t.done("check-dashes-paths");
