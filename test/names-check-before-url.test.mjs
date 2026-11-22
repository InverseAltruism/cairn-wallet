// A .csd recipient never reaches a URL unvalidated (AGENTS.md, "Rules learned from incidents"): resolveName, verifyName
// and confirmName (names.ts) check the name against NAME_RE before any request, so a name with `/`, `..`, `%`, a query
// or a fragment cannot steer a resolver path. encodeURIComponent stays behind the check. The real Wallet on a fetch
// stub that records every URL; the SPV source is a stub that makes no request.
//   1. Twelve names that are not .csd names: each of the three methods refuses each, and no request is made.
//   2. Paired: a real name in another case and with ".csd" is looked up as the plain name.
//   RED-FIRST: drop the check in resolveName (names.ts, the first `isPlainName`) or in verifyName (the second) and 1
//   fails for that method (the audit of 2026-11-19 found no test red under either).
// Run: npx tsx test/names-check-before-url.test.mjs   (offline)
import "./helpers/backup-host.mjs";
import { checker } from "./helpers/check.mjs";
import { Wallet } from "../src/core/wallet.ts";
import { memoryStore } from "../src/core/storage.ts";
import { DEFAULT_TRADE_API } from "../src/core/endpoints.ts";
import { world, source } from "./_spvrig.ts";

const { check, done } = checker("a name is checked before any request:");
const w = new Wallet(memoryStore());
await w.create("pw-names-check-before-url");
w.nameSpvForTest = { ...source(world([]).blocks, 100_000), hashAt: async (h) => "0x" + h.toString(16).padStart(64, "0") };
const seen = [];
globalThis.fetch = async (url) => { seen.push(String(url)); return { ok: false, status: 404, json: async () => ({}) }; };

// 1. Not names: path separators, traversal, escapes, query, fragment, space, hyphen at an end, too long, empty, a dot,
// a full-width letter.
for (const bad of ["a/b", "../x", "a%2fb", "a?b=1", "a#b", "a b", "-a", "a-", "a".repeat(33), "", "a.b", "ａlice"]) {
  const before = seen.length;
  const r = await w.resolveName(bad), v = await w.verifyName(bad), c = await w.confirmName(bad);
  check(`1. ${JSON.stringify(bad)}: resolveName, verifyName and confirmName refuse it with no request (${seen.length - before} requests)`,
    r.ok === false && v.verified === false && c.ok === false && seen.length === before);
}

// 2. Paired: a real name is looked up, lower-cased and without ".csd".
{
  const before = seen.length;
  await w.resolveName("Alice.CSD");
  check(`2. honest: "Alice.CSD" is looked up as alice (${seen.slice(before)[0]})`, seen.slice(before)[0] === `${DEFAULT_TRADE_API}/cairnx/resolve/alice`);
}
done("names-check-before-url");
