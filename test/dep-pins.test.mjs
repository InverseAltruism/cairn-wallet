// Every dependency and devDependency in package.json is an exact version, and it is the version the committed
// lockfile installs. A range lets a lockfile refresh move a toolchain package (the bundler that writes the store
// zip, the test loader) without a reviewed package.json diff.
// Run: npx tsx test/dep-pins.test.mjs   (offline)
import { readFileSync } from "node:fs";
import { checker } from "./helpers/check.mjs";

const EXACT = /^\d+\.\d+\.\d+$/;

/** One line per offence: a range, a lockfile root entry that differs, or an installed version that differs. */
export function pinOffences(pkg, lock) {
  const out = [];
  const root = lock.packages?.[""] ?? {};
  for (const field of ["dependencies", "devDependencies"]) {
    for (const [name, spec] of Object.entries(pkg[field] ?? {})) {
      if (!EXACT.test(spec)) out.push(`${field}.${name}: "${spec}" is not an exact version`);
      if (root[field]?.[name] !== spec) out.push(`${field}.${name}: the lockfile root records "${root[field]?.[name]}"`);
      const installed = lock.packages?.[`node_modules/${name}`]?.version;
      if (installed !== spec) out.push(`${field}.${name}: the lockfile installs ${installed}`);
    }
  }
  return out;
}

const read = (f) => JSON.parse(readFileSync(new URL(`../${f}`, import.meta.url), "utf8"));
const pkg = read("package.json");
const lock = read("package-lock.json");
const t = checker("dependency pins:");

const real = pinOffences(pkg, lock);
t.check(`package.json pins every dependency to the version package-lock.json installs (${real.join("; ") || "no offences"})`, real.length === 0);
t.check("the check saw the dev toolchain", ["esbuild", "tsx", "typescript"].every((n) => n in (pkg.devDependencies ?? {})));

const clone = (o) => JSON.parse(JSON.stringify(o));
const caret = clone(pkg);
caret.devDependencies.tsx = "^" + caret.devDependencies.tsx;
t.check("a caret range on a dev dependency is an offence", pinOffences(caret, lock).some((l) => l.startsWith("devDependencies.tsx:") && l.includes("not an exact version")));
const drift = clone(lock);
drift.packages["node_modules/typescript"].version = "0.0.1";
t.check("a lockfile that installs another version is an offence", pinOffences(pkg, drift).some((l) => l === "devDependencies.typescript: the lockfile installs 0.0.1"));
const rootDrift = clone(lock);
rootDrift.packages[""].dependencies["@noble/hashes"] = "^1.8.0";
t.check("a lockfile root specifier that differs from package.json is an offence", pinOffences(pkg, rootDrift).some((l) => l.startsWith("dependencies.@noble/hashes: the lockfile root")));

t.done("dep-pins");
