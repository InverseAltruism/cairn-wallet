// QR encoder tests (Receive panel). The encoder is the vendored Nayuki qrcodegen (see the
// provenance banner in src/popup/qr/qrcodegen.ts). These tests do NOT trust the encoder for
// their expectations: the structural checks (finder rings, timing pattern, format-info BCH)
// are computed here directly from the ISO/IEC 18004 formulas, so a corrupted or mis-adapted
// vendored file fails loudly. A pinned matrix snapshot guards against silent drift, and the
// final gate before ship is a real phone-scan of a rendered address (release checklist).
import qrcodegen from "../src/popup/qr/qrcodegen.js";
declare const process: { exit(code: number): void };

let passed = 0, failed = 0;
function ok(cond: boolean, name: string) {
  if (cond) { passed++; console.log("  ✓ " + name); }
  else { failed++; console.error("  ✗ " + name); }
}

const ADDR = "0x1111111111111111111111111111111111111111";
const enc = (s: string) => qrcodegen.QrCode.encodeText(s, qrcodegen.QrCode.Ecc.MEDIUM);
const qr = enc(ADDR);

// 1. shape: size is 17 + 4*version, version in range
ok(qr.size === 17 + 4 * qr.version, `size ${qr.size} == 17 + 4*v${qr.version}`);
ok(qr.version >= 1 && qr.version <= 40, "version in [1,40]");

// 2. determinism: byte-identical matrix across two encodes
{
  const a = enc(ADDR), b = enc(ADDR);
  let same = a.size === b.size;
  for (let y = 0; same && y < a.size; y++) for (let x = 0; same && x < a.size; x++) same = a.getModule(x, y) === b.getModule(x, y);
  ok(same, "deterministic matrix");
}

// 3. finder patterns at three corners: 7x7 with dark center 3x3, light ring, dark border
function finderOk(ox: number, oy: number): boolean {
  for (let dy = 0; dy < 7; dy++) for (let dx = 0; dx < 7; dx++) {
    const dist = Math.max(Math.abs(dx - 3), Math.abs(dy - 3));
    if (qr.getModule(ox + dx, oy + dy) !== (dist !== 2)) return false;
  }
  return true;
}
ok(finderOk(0, 0), "finder top-left");
ok(finderOk(qr.size - 7, 0), "finder top-right");
ok(finderOk(0, qr.size - 7), "finder bottom-left");

// 4. timing patterns: row 6 and column 6 alternate dark/light between the finders
{
  let t = true;
  for (let i = 8; i < qr.size - 8; i++) {
    if (qr.getModule(i, 6) !== (i % 2 === 0)) t = false;
    if (qr.getModule(6, i) !== (i % 2 === 0)) t = false;
  }
  ok(t, "timing patterns alternate");
}

// 5. format info: recompute the 15 format bits from (ECC=M, mask) with the spec's BCH(15,5)
//    generator 0x537 and XOR mask 0x5412, then compare against the matrix's first copy.
{
  const M_FORMAT_BITS = 0; // ISO 18004: L=1, M=0, Q=3, H=2
  const data = (M_FORMAT_BITS << 3) | qr.mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const bits = ((data << 10) | rem) ^ 0x5412;
  const getBit = (x: number, i: number) => ((x >>> i) & 1) !== 0;
  let match = true;
  for (let i = 0; i <= 5; i++) if (qr.getModule(8, i) !== getBit(bits, i)) match = false;   // (8,0..5)
  if (qr.getModule(8, 7) !== getBit(bits, 6)) match = false;
  if (qr.getModule(8, 8) !== getBit(bits, 7)) match = false;
  if (qr.getModule(7, 8) !== getBit(bits, 8)) match = false;
  for (let i = 9; i < 15; i++) if (qr.getModule(14 - i, 8) !== getBit(bits, i)) match = false; // (5..0, 8)
  ok(match, `format info encodes ECC=M mask=${qr.mask} with valid BCH`);
}

// 6. pinned snapshot for the canonical address shape (regression guard; generated 2026-07-03)
{
  const WANT_V = 3, WANT_MASK = 2;
  const WANT_HEX = "fe0213fc104d506eaac0bb75ebd5dba9212ec148d507faaaafe0136000be4debe5e0d09441ac6b75b9b60108b5ded77c5909479ae6b741a96012e37ded7d6b10946eb26b7178d60128605eff00610c47f8c6eb50546113baa9effdd560a8eea1e8b504463b2fef5e0e0";
  let bits = "";
  for (let y = 0; y < qr.size; y++) for (let x = 0; x < qr.size; x++) bits += qr.getModule(x, y) ? "1" : "0";
  let hex = ""; for (let i = 0; i < bits.length; i += 4) hex += parseInt(bits.slice(i, i + 4).padEnd(4, "0"), 2).toString(16);
  ok(qr.version === WANT_V && qr.mask === WANT_MASK && hex === WANT_HEX, "42-char address snapshot (v3, mask 2)");
}

// 7. robustness: various payload lengths encode; absurd input throws rather than truncates
{
  let allOk = true;
  for (const s of ["a", "0x" + "f".repeat(40), "csd:" + "9".repeat(80), "x".repeat(500)]) {
    const q = enc(s);
    if (!(q.size >= 21 && q.size <= 177)) allOk = false;
  }
  ok(allOk, "payloads 1..500 chars encode");
  let threw = false;
  try { enc("x".repeat(5000)); } catch { threw = true; }
  ok(threw, "over-capacity input throws (never truncates)");
}

console.log(`qr: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
