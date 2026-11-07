// The repo's gitleaks config carries csd-sdk's named-hex-private-key rule: 64 hex digits assigned to a name containing
// priv, secret or seed. The default rules missed the codebase's own spellings (`PRIV = "0x.."`, `{ priv: "0x.." }`,
// a typed `const PRIV: string =`, a unit's `Environment=MM_PRIV=..`). The rule's regex is RE2; this reads it from
// .gitleaks.toml and runs it in JavaScript (the same syntax for these shapes) over worthless keys. CI's secrets job runs
// the real gitleaks over the full history with this file.
// Run: npx tsx test/gitleaks-rule.test.mjs   (offline)
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { checker } from "./helpers/check.mjs";

const { check, done } = checker("gitleaks named-hex rule:");
const toml = readFileSync(join(import.meta.dirname, "..", ".gitleaks.toml"), "utf8");
const block = /\[\[rules\]\]\nid = "named-hex-private-key"\n[\s\S]*?\nregex = '''([^\n]*)'''\nsecretGroup = 1\n/.exec(toml);
check("the rule is present with its secret group", !!block);
const src = block?.[1] ?? "";
check("its regex is case-insensitive by an inline (?i)", src.startsWith("(?i)"));
const re = new RegExp(src.replace(/^\(\?i\)/, ""), "i");
const K = "5a".repeat(32);
for (const line of [`const PRIV = "0x${K}";`, `const w = { priv: "0x${K}" };`, `const PRIV2: string = "0x${K}";`, `Environment=MM_PRIV=${K}`, `let seed_hex := "${K}"`, `CLIENT_SECRET => '${K}'`])
  check(`caught: ${line.replace(K, "<64 hex>")}`, re.exec(line)?.[1] === K);
for (const line of [`const txid = "0x${K}";`, `const key = "0x${K}";`, `payloadHash: "0x${K}"`, `const PRIV = "0x${K.slice(2)}";`])
  check(`not caught: ${line.replace(K, "<64 hex>").replace(K.slice(2), "<62 hex>")}`, !re.test(line));
done("gitleaks-rule");
