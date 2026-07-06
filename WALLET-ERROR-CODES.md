# Wallet error codes (dApp contract)

Since 0.2.46 (Plan 57 B9) every `{ok:false}` envelope a dApp can see carries a stable
machine `code` next to the human `error` string. The strings are UX copy and may change;
the codes are the contract. All codes are emitted from `src/background.ts`.

## The two layers

The provider resolves an envelope `{ok, result|error, code?}`. Tx methods (`send`,
`propose`, `attest`, `fillOffer`, ...) nest their own `SubmitResult`
`{ok, txid|error, sighashMatch}` inside `result`. As of 0.2.53 only the OUTER envelope
carries a `code`: a builder failure returned as a nested `{ok:false}` result (for example
the coin-verify refusals from `src/core/node.ts`) is code-less and consumers still match
its string. Adding codes to nested results is additive (0.2.54 candidate).

## Codes

| Code | Meaning | Retryable | Since |
|---|---|---|---|
| `USER_REJECTED` | The user declined the request in the approval window ("rejected by user"). | No (only with fresh user intent). | 0.2.46 |
| `APPROVAL_CLOSED` | The approval window closed before a decision; treated as a decline. | No (same handling as `USER_REJECTED`). | 0.2.46 |
| `WALLET_LOCKED` | The wallet was locked (or had no account) when the action ran. | Yes, after the user unlocks. | 0.2.46 |
| `ACCOUNT_CHANGED` | The active account changed between review and approve; the wallet refuses rather than sign with an unreviewed account. | Yes: reopen the request and re-review. | 0.2.46 |
| `FIRST_PARTY_ONLY` | `signIn()` from a third-party origin. | No: use the audience-bound `signInWithCsd()`. | 0.2.46 |
| `UNSUPPORTED_METHOD` | Method not in the dApp allowlist (or wallet predates it). | No. | 0.2.46 |
| `RATE_LIMITED` | Too many pending approval requests (global or per-origin queue cap). | Yes, after the queued requests are approved or rejected. | 0.2.46 |
| `FORBIDDEN` | Privileged internal message from a non-extension page. | No. | 0.2.46 |
| `UNKNOWN_KIND` | Unknown message kind on the internal channel. | No. | 0.2.46 |
| `INTERNAL` | Catch-all wrapper for anything thrown while executing an approved action; `error` carries the thrown message. | Unknown from the code alone; consumers may inspect the string (the coin-verify "could not verify selected inputs" / "couldn't fetch source transactions" prose is retryable). | 0.2.46 |

## Code-less strings consumers must still know

* `WALLET_RELOADED: ...` (string PREFIX on `error`, `src/content.ts`, since 0.2.50): the
  extension was updated or reloaded under a live page; the page must refresh to reconnect.
* The 0.2.53 per-coin ghost-skip refusal (`src/core/node.ts` `selectVerified`):
  `"N coin(s) totalling X CSD could not be verified on the chain and were skipped; the
  remaining verifiable coins couldn't cover this Y CSD spend (amount plus fee)"`.
  NOT retryable: the skipped coins stay excluded until the node can prove them, so an
  immediate retry changes nothing. Nested code-less result today; a dedicated code is the
  0.2.54 candidate. Distinct from the retryable coin-verify class above.

## Consumption pattern (code first, string fallback)

Check the machine `code` FIRST; fall back to matching the human string only for
pre-0.2.46 wallets (and for the code-less classes above). Never string-match a class
that has a code: the strings are UX copy and may be reworded.

Reference implementations:

* `cairn-sdk` `src/errors.ts` `mapProviderError`: maps native codes to typed errors,
  string regexes only as the legacy fallback.
* `cairn` `public/trade/actions.js`: `unwrap` re-attaches the envelope `code` to the
  thrown `Error`; `walletErrText` classifies on the code first, then the fallback
  regexes (`WALLET_DECLINED_RE`, `WALLET_SOFT_RE`, `WALLET_GHOST_RE`).

## Shipping rule

Every NEW user-facing `{ok:false}` path must carry a `code`. Codes are additive: never
reuse or repurpose one, and never rely on an error string as the machine contract.
