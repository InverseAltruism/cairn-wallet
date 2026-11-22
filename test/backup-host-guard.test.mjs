// Every test file that stubs globalThis.fetch either imports test/helpers/backup-host.mjs or says it routes the default
// RPC's second host itself. The wallet sends each submit to the second host too; the helper answers it from the main
// host's answer and fails the file when the second host is sent a body the main host never received (a second
// signing), so a file that stubs fetch without it loses that check. The helper's own failure and its honest path are
// run here in child processes.
// RED-FIRST: drop the helper's import from any listed file and (1) fails; make the helper accept any body and (2) fails.
// Run: node --import tsx test/backup-host-guard.test.mjs   (offline)
import { readdirSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { checker } from "./helpers/check.mjs";

const { check, done } = checker("=== every fetch stub answers the second host ===");
const here = dirname(fileURLToPath(import.meta.url));
const STUBS = /(globalThis|global)\.fetch\s*=|globalThis as any\)\.fetch\s*=/;
const files = [...readdirSync(here).map((f) => join(here, f)), ...readdirSync(join(here, "helpers")).map((f) => join(here, "helpers", f))]
  .filter((f) => /\.(mjs|ts)$/.test(f) && !f.endsWith("backup-host.mjs") && !f.endsWith("backup-host-guard.test.mjs"));
const missing = files.filter((f) => { const s = readFileSync(f, "utf8"); return STUBS.test(s) && !s.includes("helpers/backup-host.mjs") && !s.includes('"./backup-host.mjs"') && !s.includes("// routes the second host itself"); });
const stubbing = files.filter((f) => STUBS.test(readFileSync(f, "utf8")));
check(`(1) all ${stubbing.length} files that stub fetch import the helper or route the second host themselves${missing.length ? ": missing in " + missing.map((f) => f.slice(here.length + 1)).join(", ") : ""}`, stubbing.length > 50 && missing.length === 0);

// The helper in a child process: the second host sent a body the main host received (honest), or another one.
const tsx = join(here, "..", "node_modules", "tsx", "dist");
const helperUrl = pathToFileURL(join(here, "helpers", "backup-host.mjs")).href;
const endpointsUrl = pathToFileURL(join(here, "..", "src", "core", "endpoints.ts")).href;
const dir = mkdtempSync(join(tmpdir(), "backup-host-"));
function child(secondBody) {
  const f = join(dir, `c${Math.random().toString(36).slice(2)}.mjs`);
  writeFileSync(f, `import ${JSON.stringify(helperUrl)};
import { DEFAULT_RPC, BACKUP_RPC } from ${JSON.stringify(endpointsUrl)};
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) });
const main = await (await fetch(DEFAULT_RPC + "/tx/submit", { method: "POST", body: "{\\"tx\\":1}" })).json();
let second; try { second = await (await fetch(BACKUP_RPC + "/tx/submit", { method: "POST", body: ${JSON.stringify(secondBody)} })).json(); } catch { second = "threw"; }
console.log(JSON.stringify({ main, second }));
process.exit(0);
`);
  return spawnSync(process.execPath, ["--require", join(tsx, "preflight.cjs"), "--import", pathToFileURL(join(tsx, "loader.mjs")).href, f], { encoding: "utf8" });
}
const honest = child('{"tx":1}');
check(`(2) paired: the same bytes to the second host: answered as the main host was, exit 0 (${honest.status}, ${honest.stdout.trim()})`,
  honest.status === 0 && honest.stdout.includes('"second":{"ok":true}'));
const stray = child('{"tx":2}');
check(`(2) another body to the second host: the file exits 1 and names it (${stray.status})`, stray.status === 1 && /never received/.test(stray.stderr));
rmSync(dir, { recursive: true, force: true });
done("backup-host-guard");
