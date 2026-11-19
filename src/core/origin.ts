// A requesting origin the wallet cannot tell apart from others: "null" (a sandboxed, data: or some file: page) and
// "unknown" (no sender origin) are shared strings, not sites, so nothing is remembered or compared under them.
export const opaqueOrigin = (origin: unknown): boolean => !origin || origin === "unknown" || origin === "null";
