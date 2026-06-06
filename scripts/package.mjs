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

// the upload artifact (manifest at root) FIRST — it's the one that matters for the store
emit("cairn-wallet-store.zip", "");      // → upload this to the Chrome Web Store
emit("cairn-wallet.zip", "cairn-wallet"); // → nested, for `Load unpacked`
