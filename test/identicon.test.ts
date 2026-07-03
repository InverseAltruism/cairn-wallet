// Identicon unit tests: pins the gradient to the CNS reference implementation
// (golden vectors generated from cairn/public/names/profile.js avatarGradient) so the
// wallet and the website render the SAME identity gradient for the same seed, and
// asserts the numbers-only (injection-safe) output shape.
import { avatarGradient, monogram, identitySeed } from "../src/popup/identicon.js";
declare const process: { exit(code: number): void }; // repo tsconfig has "types": [] (same pattern as clearsign.ts)

let passed = 0, failed = 0;
function ok(cond: boolean, name: string) {
  if (cond) { passed++; console.log("  ✓ " + name); }
  else { failed++; console.error("  ✗ " + name); }
}

// golden vectors from the CNS reference (generated 2026-07-03, profile.js avatarGradient)
const GOLDEN: [string, string][] = [
  ["alice", "linear-gradient(135deg, hsl(0 65% 45%), hsl(102 70% 32%))"],
  ["satoshi", "linear-gradient(135deg, hsl(259 65% 45%), hsl(5 70% 32%))"],
  ["0xaaa6d63ff8e96fed06e33f85505177e624fed11d", "linear-gradient(135deg, hsl(196 65% 45%), hsl(51 70% 32%))"],
  ["", "linear-gradient(135deg, hsl(0 65% 45%), hsl(80 70% 32%))"],
];
for (const [seed, want] of GOLDEN) ok(avatarGradient(seed) === want, `CNS parity: ${JSON.stringify(seed)}`);

// determinism + injection-safe shape (numbers only, fixed template)
ok(avatarGradient("bob") === avatarGradient("bob"), "deterministic");
const SHAPE = /^linear-gradient\(135deg, hsl\(\d+ 65% 45%\), hsl\(\d+ 70% 32%\)\)$/;
for (const s of ["x", "<img onerror=1>", "a'b\"c", "0x" + "f".repeat(40)]) {
  ok(SHAPE.test(avatarGradient(s)), `numbers-only output for ${JSON.stringify(s.slice(0, 12))}`);
}

// monogram: name wins, else first address nibble, else "?"
ok(monogram("alice", "0xdead") === "A", "monogram from name");
ok(monogram("  zoe.csd", "0xdead") === "Z", "monogram trims + uppercases");
ok(monogram(null, "0xdeadbeef") === "D", "monogram from address nibble");
ok(monogram("", "") === "?", "monogram fallback");

// identity seed: bare name, else lowercased address
ok(identitySeed("alice", "0xAB") === "alice", "seed prefers name");
ok(identitySeed("", "0xAbCd") === "0xabcd", "seed lowercases address");
ok(identitySeed(null, null) === "", "seed empty fallback");

console.log(`identicon: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
