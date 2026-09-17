// Structured {ok:false} SubmitResult helper. Codes are the dApp contract
// (WALLET-ERROR-CODES.md); the error string is UX copy. sighashMatch stays
// false on every refusal (vestigial but dApp-visible — never drop it).
export function refuse(code: string, error: string): { ok: false; error: string; code?: string; sighashMatch: false } {
  return { ok: false, error, code, sighashMatch: false };
}
