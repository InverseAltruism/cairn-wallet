// The notices of the third-party code the wallet bundles, for dist/THIRD-PARTY-LICENSES.txt (build.mjs). Each comes
// from its own source: an npm dependency's LICENSE file as installed, and the vendored QR generator's retained
// upstream header. The Lucide icons (dist/icons.LICENSE.txt) and the Geist fonts (dist/ui/fonts/OFL.txt) ship their
// licences beside them.
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
/** The npm packages esbuild inlines into the extension: the four runtime dependencies and @scure/base, which the two
 *  @scure packages import. */
export const BUNDLED_PACKAGES = ["@noble/curves", "@noble/hashes", "@scure/base", "@scure/bip32", "@scure/bip39"];

function qrNotice() {
  const src = readFileSync(join(ROOT, "src/popup/qr/qrcodegen.ts"), "utf8");
  const m = /\/\*\s*\n( \* QR Code generator library[\s\S]*?)\*\//.exec(src);
  if (!m) throw new Error("third-party-notices: the QR generator's licence header was not found in src/popup/qr/qrcodegen.ts");
  return m[1].split("\n").map((l) => l.replace(/^ \* ?/, "").trimEnd()).join("\n").trim();
}

export function thirdPartyNotices() {
  const parts = ["Third-party software in Cairn Wallet, with the notices its licences require.", ""];
  for (const name of BUNDLED_PACKAGES) {
    const dir = join(ROOT, "node_modules", name);
    const { version } = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    parts.push(`== ${name} ${version} ==`, "", readFileSync(join(dir, "LICENSE"), "utf8").trim(), "");
  }
  parts.push("== QR Code generator library (TypeScript) v1.8.0, src/popup/qr/qrcodegen.ts ==", "", qrNotice(), "");
  return parts.join("\n");
}
