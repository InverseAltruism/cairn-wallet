// Deterministic account-identity visuals: gradient identicon + monogram letter.
// The gradient hash is a byte-exact port of the CNS avatarGradient (cairn repo,
// public/names/profile.js) so the same seed renders the same identity gradient in the
// wallet and on the website. Output is numbers-only interpolation: injection-safe by
// construction, and it is only ever assigned to style.background, never to HTML.
export function avatarGradient(seed: string): string {
  let h = 0;
  const s = String(seed ?? "");
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  const a = h % 360, b = (a + 80 + ((h >> 8) % 140)) % 360;
  return `linear-gradient(135deg, hsl(${a} 65% 45%), hsl(${b} 70% 32%))`;
}

// First letter of the primary .csd name (matches the CNS profile monogram), else the
// first hex nibble of the address, else "?".
export function monogram(primaryName: string | null | undefined, addr: string | null | undefined): string {
  const n = (primaryName || "").trim();
  if (n) return n[0]!.toUpperCase();
  const a = (addr || "").replace(/^0x/i, "");
  return (a[0] || "?").toUpperCase();
}

// Identity seed: the bare primary name when set (same identicon as that name's CNS
// profile), else the lowercased address (stable per account before a name resolves).
export function identitySeed(primaryName: string | null | undefined, addr: string | null | undefined): string {
  const n = (primaryName || "").trim();
  return n ? n : String(addr || "").toLowerCase();
}
