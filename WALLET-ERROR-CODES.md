# Wallet error codes (dApp contract)

Since 0.2.46 (Plan 57 B9) every `{ok:false}` envelope a dApp can see carries a stable
machine `code` next to the human `error` string. The strings are UX copy and may change;
the codes are the contract. All codes are emitted from `src/background.ts`.

## The two layers

The provider resolves an envelope `{ok, result|error, code?}`. Tx methods (`send`,
`propose`, `attest`, `fillOffer`, ...) nest their own `SubmitResult`
`{ok, txid|error, sighashMatch, code?}` inside `result`. Through 0.2.53 only the OUTER
envelope carried a `code`. **As of 0.2.54 the nested `SubmitResult` also carries a `code`**
on every `{ok:false}` (the builder refusals from `src/core/node.ts` and the `fillOffer`
preflight in `src/core/wallet.ts`). The addition is purely additive: the human `error`
strings are byte-unchanged, and a consumer that still matches the string keeps working.
See "Nested SubmitResult codes" below.

(`sighashMatch` on a `SubmitResult` is deprecated/vestigial (constant-equal to `ok`, no
known reader) but is still emitted on every result, including preflight errors, since
dropping it would be a dApp-visible shape change.)

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

## Nested SubmitResult codes (0.2.54)

These ride on the inner `result` of a tx method (`send`, `propose`, `attest`, `fillOffer`).
The strings are unchanged from earlier releases; only the machine `code` is new.

| Code | Meaning | Retryable | Emitted from |
|---|---|---|---|
| `GHOST_INPUTS_SKIPPED` | Coins whose source tx the node couldn't prove were skipped and the rest couldn't cover the spend (the 0.2.53 per-coin ghost-skip). | **No**: the skipped coins stay excluded until the node can prove them; an immediate retry changes nothing. | `node.ts` `selectVerified`, `consolidate` |
| `VERIFY_UNAVAILABLE` | Couldn't fetch source txs / the chain tip / the resolver to verify before signing (node unreachable or erroring). | **Yes**: nothing was signed; try again shortly. | `node.ts` `selectVerified`, `consolidate`, `wallet.ts` fillOffer preflight |
| `VERIFY_TAMPER` | A served source-tx body failed txid recompute / output sanity (possible hostile RPC). | **No**: the whole spend is refused, no retry against a forging RPC. | `node.ts` `selectVerified`, `consolidate` |
| `INSUFFICIENT` | Insufficient confirmed balance for the spend; from `consolidate` it means the selected coins cannot cover the fee. | No (until funded). | `node.ts` `selectVerified`, `consolidate` |
| `TOO_MANY_INPUTS` | The balance covers the amount but not within the 512-input per-transaction cap (common for a holder of many small coins). | No as-is: send a smaller amount, or consolidate coins first. | `node.ts` `selectVerified` (since 0.2.55) |
| `FEE_TOO_LOW` | Fee is not positive (the node enforces a minimum). | No. | `node.ts` `assembleValueTx` |
| `FEE_CAP` | Fee exceeds the flat 100 CSD cap or the 10%-of-selected-inputs cap. | No. | `node.ts` `assembleValueTx`, `consolidate` (re-asserts both caps itself) |
| `BAD_FEE` | Fee (or amount+fee) is out of the safe-integer range; from `consolidate` it also covers a non-positive fee (the send path's `FEE_TOO_LOW` class; popup-only, and the popup hardcodes 0.01 CSD). | No. | `node.ts` send / sendMany / fillOffer / buildSignSubmit / `consolidate` |
| `ZERO_ADDR_REFUSED` | An output pays the zero address (irrecoverable burn). | No. | `node.ts` `assembleValueTx` |
| `BAD_OUTPUTS` | An output failed validation (count/cap, address shape, non-positive/unsafe value, sum overflow), incl. the fillOffer preflight's per-output integer check. | No. | `node.ts` `validateOutputs` / `send`, `wallet.ts` fillOffer preflight |
| `NO_OUTPUTS` | The tx would have no outputs (nothing, incl. change, would be paid). | No. | `node.ts` `assembleValueTx` |
| `BAD_REQUEST` | A propose/attest param failed its shape check (payloadHash / proposalId / expiresEpoch). | No. | `node.ts` `propose` / `attest` / `fillOffer` |
| `FILL_UNSAFE` | The fillOffer fund-safety preflight refused (offer not open, undeliverable, or an underpaid seller/fee/rebate leg): the chain would take the payment and reject the fill. Since the V28 open lane (Plans/69) it also covers the fclaim-lane grant-replay boundary (`verifyFillSpv`): a resolver-DENIED / superseded fclaim, a not-mine or lapsed hold, a below-depth offer/fclaim, or a stranded past-deadline fill (a DENIED fclaim is an L0-valid but delivery-less target, so filling it would burn the payment). | No (rebuild the fill as quoted, or wait for the offer/fclaim to bury). | `wallet.ts` fillOffer preflight |
| `OFFER_UNKNOWN` | The resolver answered but does NOT know this proposal as a CairnX offer (clean 404, or a 200 without a parseable offer status). Filling a proposal the resolver will not settle burns the whole payment, so the wallet refuses instead of proceeding (since 0.2.57). | **Yes**: a brand-new offer appears after the resolver's next scan (~15s); retry shortly. If it persists, the proposal is not an open CairnX offer. | `wallet.ts` fillOffer preflight |
| `FILL_WRONG_TARGET` | At/above V28, an offer-txid fill was attempted on an offer that has a LIVE fclaim reservation held by you: the resolver routes fills to the fclaim (reservation) target, so paying the offer id would mine on-chain with no delivery and burn (Correction 1). Fill the reservation's fclaim txid instead. | No as-is: re-target the fill to the fclaim txid (an updated site bundle does this automatically). | `wallet.ts` fillOffer preflight |
| `FILL_LEGACY_SUNSET` | Past the V28 sunset band (tip >= 60,045, computed from the wallet's floor-clamped tip, nothing resolver-served), an offer-id fill of an OPEN CSD offer is unconditionally rejected on-chain (the last legacy hold ended at 60,044), so paying it would burn. Refused by arithmetic regardless of any served claim fields (the W5 forgery class). Taker-bound and token-priced offers are exempt (bound on their own lanes). | No as-is: fill through the offer's fclaim (reservation) target instead (an updated site bundle does this automatically). | `wallet.ts` fillOffer preflight |
| `SOURCE_DIVERGENCE` | Two independent resolvers (the primary + clarvis) disagree on a VALUE field of the offer being filled (payto / value / ticker / amount / give / feeBps / min / status). Emitted only on the V28 fclaim lane (Plans/69 B6); a clarvis 404 / timeout / unreachable is fail-soft PROCEED (availability, not a value conflict), so only a genuine value disagreement refuses. | **Maybe**: confirm the offer out-of-band; if the sources reconcile, retry. A persistent divergence means one source is hostile/stale. | `wallet.ts` fillOffer preflight |
| `SUBMIT_REJECTED` | The submit was DEFINITIVELY rejected: the node answered a 4xx rejection (feerate/etc.), or a pre-forward proxy 400/413 body cap or 429 rate limit. The tx is NOT in the mempool, so nothing was sent. | No (fix the cause, then resend); inspect `error`. | `node.ts` `signAndSubmit` (since 0.2.55: split from the ambiguous case below) |
| `SUBMIT_MAYBE_INFLIGHT` | The submit outcome is AMBIGUOUS: the request threw / timed out, or hit a 5xx gateway failure (the cairn proxy 502s the node after ~4s, which can outrace a slow-but-successful mempool ingest), or returned an unreadable body. The tx MAY be in the mempool. `txid` carries the locally computed consensus txid so consumers can check whether it landed. | **Do NOT auto-retry.** Check the balance / explorer first; only resend if the tx did not confirm. | `node.ts` `signAndSubmit` (since 0.2.55) |
| `SUBMIT_DUPLICATE` | The node answered "already present or mempool conflict": either this exact tx is already pending (a resend is byte-identical under deterministic signing, so this is the normal resubmit outcome) or a different pending tx spends the same coins. Either way a tx spending these coins IS in the mempool; "nothing was sent" would be false. `txid` carries the locally computed consensus txid. | **Do NOT retry.** Wait a block or two; the pending tx settles or frees the coins. | `node.ts` `signAndSubmit` (since 0.2.55) |
| `NOTHING_TO_CONSOLIDATE` | `consolidate()` found fewer than two spendable coins to merge. Popup-only (not a dApp method). | No. | `node.ts` `consolidate` (since 0.2.55) |

## Code-less strings consumers must still know

* `WALLET_RELOADED: ...` (string PREFIX on `error`, `src/content.ts`, since 0.2.50): the
  extension was updated or reloaded under a live page; the page must refresh to reconnect.

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
