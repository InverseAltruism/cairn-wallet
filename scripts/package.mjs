// Deterministic packager: zips dist/ with a fixed layout, fixed timestamps, and STORE
// (no compression) so the output is BYTE-IDENTICAL on every machine for the same source.
// That makes the published SHA-256 reproducible: anyone can `npm ci && npm run package`
// and confirm the hash matches the release. Dependency-free (no `zip` binary, no archiver
// lib) — minimal ZIP writer below.
//
// Emits TWO reproducible artifacts from the SAME dist/:
//   • cairn-wallet-store.zip — manifest.json at the ROOT. THIS is what you upload to the
//     Chrome Web Store (the store rejects a zip without a root-level manifest).
//   • cairn-wallet.zip       — nested under cairn-wallet/ for convenient "Load unpacked".
// Both are byte-identical across machines and each gets a .sha256 so CI can attest both.
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

const ROOT = join(import.meta.dirname, "..");
const DIST = join(ROOT, "dist");

// collect dist files, sorted for a stable order
function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}
const distFiles = walk(DIST);

// CRC-32 (IEEE)
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(buf) { let c = ~0; for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (~c) >>> 0; }

const DOS_TIME = 0, DOS_DATE = 0x21; // fixed 1980-01-01 00:00:00 → deterministic

// Build one deterministic STORE zip from dist/, optionally under a path prefix.
function buildZip(prefix) {
  const files = distFiles.map((abs) => ({
    name: (prefix ? prefix + "/" : "") + relative(DIST, abs).split("\\").join("/"),
    data: readFileSync(abs),
  })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const locals = [], central = [];
  let offset = 0;
  for (const f of files) {
    const nameBuf = Buffer.from(f.name, "utf8");
    const crc = crc32(f.data), size = f.data.length;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0, 6); lh.writeUInt16LE(0, 8);
    lh.writeUInt16LE(DOS_TIME, 10); lh.writeUInt16LE(DOS_DATE, 12); lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(size, 18); lh.writeUInt32LE(size, 22); lh.writeUInt16LE(nameBuf.length, 26); lh.writeUInt16LE(0, 28);
    locals.push(lh, nameBuf, f.data);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0, 8); ch.writeUInt16LE(0, 10);
    ch.writeUInt16LE(DOS_TIME, 12); ch.writeUInt16LE(DOS_DATE, 14); ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(size, 20); ch.writeUInt32LE(size, 24); ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt16LE(0, 30); ch.writeUInt16LE(0, 32); ch.writeUInt16LE(0, 34); ch.writeUInt16LE(0, 36);
    ch.writeUInt32LE(0, 38); ch.writeUInt32LE(offset, 42);
    central.push(ch, nameBuf);
    offset += lh.length + nameBuf.length + f.data.length;
  }
  const localPart = Buffer.concat(locals);
  const centralPart = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(files.length, 8); eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralPart.length, 12); eocd.writeUInt32LE(localPart.length, 16);
  return { zip: Buffer.concat([localPart, centralPart, eocd]), count: files.length };
}

function emit(outName, prefix) {
  const { zip, count } = buildZip(prefix);
  const sha = createHash("sha256").update(zip).digest("hex");
  writeFileSync(join(ROOT, outName), zip);
  writeFileSync(join(ROOT, outName + ".sha256"), sha + "  " + outName + "\n");
  console.log(`✓ ${outName} (${count} files, ${zip.length} bytes)`);
  console.log(`  sha256: ${sha}`);
  return sha;
}

// package.json is the single source of truth for the release version (build.mjs enforces the
// manifest/inpage lockstep at build time).
export const PKG_VERSION = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;

// B8w: the CWS upload artifact carries the version IN ITS FILENAME. The old stable name
// `cairn-wallet-store.zip` carried no version, so a stale LOCAL copy from an earlier build looked
// identical to a fresh one and nothing stopped an operator uploading it by mistake (audit LOW; the
// OP-01/OP-14 near-miss where a v0.2.63 tag was first cut on the 0.2.62 tree is exactly this class).
// A version-stamped name makes a stale file self-evident.
export const storeZipName = (version) => `cairn-wallet-store-${version}.zip`;

// B8w packaging assertion: the manifest.json that lands at the ROOT of the store zip is what the Chrome
// Web Store shows as the version. It MUST equal package.json. build.mjs already checks this at build
// time, but package.mjs can be pointed at a stale dist/ when run standalone (OP-01 prep packaged an
// existing dist), so this is the backstop that turns "package a stale build" into a hard failure rather
// than a silent wrong-version zip. Pinned by test/package-assert.test.mjs.
export function manifestVersionInDist(distDir) {
  return JSON.parse(readFileSync(join(distDir, "manifest.json"), "utf8")).version;
}
export function assertVersionLockstep(pkgVersion, distManifestVersion) {
  if (pkgVersion !== distManifestVersion) {
    throw new Error(`✗ package aborted: dist/manifest.json is ${distManifestVersion} but package.json is ${pkgVersion}; rebuild (npm run build) before packaging; do not ship a stale dist.`);
  }
}

function main() {
  // fail HARD before writing any artifact if the built manifest drifted from package.json
  assertVersionLockstep(PKG_VERSION, manifestVersionInDist(DIST));
  // the CWS upload artifact (manifest at root) FIRST, version-STAMPED so a stale local file can't be
  // silently uploaded. The stable name stays too (release.yml attaches it), byte-identical to the stamped
  // copy since both zip the SAME dist with the empty prefix.
  const stampedSha = emit(storeZipName(PKG_VERSION), "");   // → upload THIS to the Chrome Web Store
  emit("cairn-wallet-store.zip", "");                        // stable name (CI/back-compat; identical bytes)
  emit("cairn-wallet.zip", "cairn-wallet");                 // → nested, for `Load unpacked`
  console.log(`\n✓ CWS upload target: ${storeZipName(PKG_VERSION)}\n  sha256: ${stampedSha}`);
}

// Run the packaging only when invoked directly (`node scripts/package.mjs`); importing this module (the
// test) gets the pure helpers without writing any artifact or touching dist/.
if (import.meta.url === pathToFileURL(process.argv[1] || "").href) main();
