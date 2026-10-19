// biome.json enables exactly four rules (STANDARDS section 8): unused imports, focused tests and ts-ignore directives are
// errors, so `npm run lint` fails on them; empty blocks are a warning until the 104 existing ones are fixed. Every
// other rule and the formatter are off. Runs the real Biome binary on a throwaway git sandbox holding one
// violation of each rule plus code that the recommended preset would flag.
// Run: npx tsx test/lint-config.test.mjs   (offline)
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { checker } from "./helpers/check.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const biome = join(root, "node_modules", "@biomejs", "biome", "bin", "biome");
const t = checker("lint config:");

const dir = mkdtempSync(join(tmpdir(), "wallet-lint-"));
try {
  copyFileSync(join(root, "biome.json"), join(dir, "biome.json"));
  spawnSync("git", ["init", "-q"], { cwd: dir });
  writeFileSync(join(dir, "b.ts"), "export const x = 1;\n");
  writeFileSync(join(dir, "violations.ts"), [
    'import { x } from "./b";',
    "// @ts-ignore",
    "const y: number = 1;",
    "try { void y; } catch {}",
    'test.only("t", () => 1);',
    "",
  ].join("\n"));
  writeFileSync(join(dir, "other.ts"), "var z = 1; if (z == 2) { debugger; }\nexport   const   w=z;\n");
  writeFileSync(join(dir, "clean.ts"), 'import { x } from "./b";\ntry { void x; } catch { /* reason */ }\nexport {};\n');

  const run = spawnSync(process.execPath, [biome, "lint", "--reporter=json", "--max-diagnostics=none", "."], { cwd: dir, encoding: "utf8" });
  const report = JSON.parse(run.stdout);
  const found = report.diagnostics.filter((d) => d.category?.startsWith("lint/")).map((d) => `${d.location.path}|${d.category}|${d.severity}`).sort();
  t.check(`the four rules fire on the sandbox with the configured severities (${found.join(", ")})`, JSON.stringify(found) === JSON.stringify([
    "violations.ts|lint/correctness/noUnusedImports|error",
    "violations.ts|lint/suspicious/noEmptyBlockStatements|warning",
    "violations.ts|lint/suspicious/noFocusedTests|error",
    "violations.ts|lint/suspicious/noTsIgnore|error",
  ]));
  t.check("an error-level finding fails the run", run.status === 1);
  t.check("Biome reports nothing about the config itself (no deprecated or unknown key)", !report.diagnostics.some((d) => d.location?.path === "biome.json"));

  rmSync(join(dir, "violations.ts"));
  const clean = spawnSync(process.execPath, [biome, "check", "."], { cwd: dir, encoding: "utf8" });
  t.check("`biome check` (lint, formatter, assist) passes var, ==, debugger, unformatted code and a catch with its reason inside", clean.status === 0);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

t.done("lint-config");
