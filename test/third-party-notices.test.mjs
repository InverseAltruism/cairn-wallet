// The packaged wallet carries the copyright and permission notices of the MIT code it bundles: @noble/curves,
// @noble/hashes, @scure/base, @scure/bip32 and @scure/bip39 (Paul Miller) and the vendored QR generator (Project
// Nayuki). esbuild drops comments (legalComments "none") and the dependencies' LICENSE files never reached dist/, so
// the store package shipped without them. build.mjs writes dist/THIRD-PARTY-LICENSES.txt from
// scripts/third-party-notices.mjs, which reads each notice from its own source (the installed package's LICENSE, the
// vendored file's retained header).
// Run: npx tsx test/third-party-notices.test.mjs   (offline)
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { checker } from "./helpers/check.mjs";
import { thirdPartyNotices, BUNDLED_PACKAGES } from "../scripts/third-party-notices.mjs";

const { check, done } = checker("third-party notices in the package:");
const ROOT = join(import.meta.dirname, "..");
const text = thirdPartyNotices();
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
check(`every runtime dependency is listed (${BUNDLED_PACKAGES.join(", ")})`, Object.keys(pkg.dependencies).every((d) => BUNDLED_PACKAGES.includes(d)));
for (const name of BUNDLED_PACKAGES) {
  const lic = readFileSync(join(ROOT, "node_modules", name, "LICENSE"), "utf8").trim();
  check(`${name}: its LICENSE text, verbatim`, text.includes(lic) && text.includes(`${name} `));
}
check("Paul Miller's MIT notice is in it", /Copyright \(c\) 20\d\d Paul Miller/.test(text) && /Permission is hereby granted, free of charge/.test(text));
check("Project Nayuki's MIT notice for the QR generator is in it", /Copyright \(c\) Project Nayuki\. \(MIT License\)/.test(text) && /The above copyright notice and this permission notice shall be included/.test(text));
const build = readFileSync(join(ROOT, "build.mjs"), "utf8");
check("build.mjs writes it into dist/", /writeFileSync\("dist\/THIRD-PARTY-LICENSES\.txt", thirdPartyNotices\(\)\)/.test(build));
done("third-party-notices");
