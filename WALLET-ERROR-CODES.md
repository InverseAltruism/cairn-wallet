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
| `WALLET_LOCKED` | The wallet was locked (or had no account) when the action ran. Since 0.2.74 also when a keyed wallet method throws "locked" mid-action, on the dApp approval path and on the popup channel (these read `INTERNAL` before). | Yes, after the user unlocks. | 0.2.46 |
| `ACCOUNT_CHANGED` | The active account changed between review and approve; the wallet refuses rather than sign with an unreviewed account. | Yes: reopen the request and re-review. | 0.2.46 |
| `FIRST_PARTY_ONLY` | `signIn()` from a third-party origin. | No: use the audience-bound `signInWithCsd()`. | 0.2.46 |
| `UNSUPPORTED_METHOD` | Method not in the dApp allowlist (or wallet predates it). | No. | 0.2.46 |
| `RATE_LIMITED` | Too many pending approval requests (global or per-origin queue cap). | Yes, after the queued requests are approved or rejected. | 0.2.46 |
| `FORBIDDEN` | Privileged internal message from a non-extension page. | No. | 0.2.46 |
| `UNKNOWN_KIND` | Unknown message kind on the internal channel. | No. | 0.2.46 |
| `INTERNAL` | Catch-all wrapper for anything thrown while executing an approved action, except the "locked" throw (`WALLET_LOCKED` since 0.2.74); `error` carries the thrown message. | Unknown from the code alone; consumers may inspect the string (the coin-verify "could not verify selected inputs" / "couldn't fetch source transactions" prose is retryable). | 0.2.46 |
| `WALLET_UNAVAILABLE` | The content-script ↔ service-worker channel is closed (SW dropped, bfcache, or `wallet.init` rejected). The inpage waiter is resolved with this coded refusal instead of hanging. | Yes, after a page refresh (or once the extension is reachable again). | 0.2.70 |

## Nested SubmitResult codes (0.2.54)

These ride on the inner `result` of a tx method (`send`, `propose`, `attest`, `fillOffer`).
The strings are unchanged from earlier releases; only the machine `code` is new.

| Code | Meaning | Retryable | Emitted from |
|---|---|---|---|
| `GHOST_INPUTS_SKIPPED` | Coins whose source tx the node couldn't prove were skipped and the rest couldn't cover the spend (the 0.2.53 per-coin ghost-skip). | **No**: the skipped coins stay excluded until the node can prove them; an immediate retry changes nothing. | `node.ts` `selectVerified` (`consolidate` until 0.2.73; its round-budget case is `VERIFY_UNAVAILABLE` since 0.2.74) |
| `VERIFY_UNAVAILABLE` | Couldn't fetch source txs / the chain tip / the resolver to verify before signing (node unreachable or erroring). Since 0.2.74 it also covers a `/utxos` answer without a `utxos` array (which used to throw out of the pre-sign path), and the round budget: the wallet used its three rounds of coin selection, each round hit coins the node could not prove yet (`SCAN_HORIZON`, not found, or unrepresentable), and untried coins remain, typically while a restarted node rebuilds its transaction index. A retry selects other coins: those the node reported missing or beyond its scan horizon are set aside for two minutes. Until 0.2.73 the round-budget case read as `VERIFY_HORIZON` / `GHOST_INPUTS_SKIPPED` "couldn't cover". | **Yes**: nothing was signed; try again shortly. | `node.ts` `selectVerified`, `consolidate`, `wallet.ts` fillOffer preflight |
| `VERIFY_TAMPER` | A served source-tx body failed txid recompute / output sanity (possible hostile RPC). | **No**: the whole spend is refused, no retry against a forging RPC. | `node.ts` `selectVerified`, `consolidate` |
| `VERIFY_HORIZON` | One or more selected coins sit beyond the node's transaction scan horizon: a node v0.1.6+ answered HTTP 503 with body code `SCAN_HORIZON` on `/tx/:id` (scan budget exhausted, absence NOT proved; the normative wire contract lives in the node README). The coins are REAL and belong to the wallet; this node just cannot look back far enough to prove them yet. They were skipped per coin (like ghosts, the 0.2.53 rule) and the remaining provable coins couldn't cover the spend. This code never means the coins are suspect; a plain 503, or a 503 with any other code (`SCAN_INCOMPLETE`/`SCAN_DECODE`), still classifies as the retryable `VERIFY_UNAVAILABLE` transient refusal. Severity: below `VERIFY_TAMPER` and `VERIFY_UNAVAILABLE`, above `GHOST_INPUTS_SKIPPED`. | **No as-is**: the coins become spendable once the node's txid index converges or the node is upgraded; a smaller spend covered by provable coins works now. | `node.ts` `selectVerified` (staged on `rebind/b4`, REBIND BN0w; inert until a node emitting `SCAN_HORIZON` ships) |
| `VERIFY_UNREPRESENTABLE` | One or more selected coins were skipped because their source transaction carries a number this wallet cannot represent exactly. Consensus puts no upper bound on a Propose's `expires_epoch`, so a stranger can anchor a tx whose numeric fields exceed the safe-integer range and pay the victim a dust output; `JSON.parse` rounds the value, the recomputed txid then differs, and the coin would otherwise read as `VERIFY_TAMPER`, which refuses the whole spend. Nothing is proved either way about such a coin: it is neither missing nor tampered, so it is skipped per coin (like ghosts and horizons, the 0.2.53 rule). Severity: below `VERIFY_TAMPER` and `VERIFY_UNAVAILABLE`, reported after `VERIFY_HORIZON` and before `GHOST_INPUTS_SKIPPED`. A body whose numbers ARE all exactly representable and whose recomputed txid differs is still `VERIFY_TAMPER`. | **No as-is**: the coin stays excluded; a spend covered by the remaining provable coins works now, and `consolidate` merges around it. | `node.ts` `selectVerified`, `consolidate` (since 0.2.66) |
| `INSUFFICIENT` | Insufficient confirmed balance for the spend; from `consolidate` it means the selected coins cannot cover the fee. | No (until funded). | `node.ts` `selectVerified`, `consolidate` |
| `TOO_MANY_INPUTS` | The balance covers the amount but not within the 512-input per-transaction cap (common for a holder of many small coins). | No as-is: send a smaller amount, or consolidate coins first. | `node.ts` `selectVerified` (since 0.2.55) |
| `FEE_TOO_LOW` | Fee is not positive (the node enforces a minimum). | No. | `node.ts` `assembleValueTx` |
| `FEE_CAP` | Fee exceeds the flat 100 CSD cap or the 10%-of-selected-inputs cap. | No. | `node.ts` `assembleValueTx`, `consolidate` (re-asserts both caps itself) |
| `BAD_FEE` | Fee (or amount+fee) is out of the safe-integer range; from `consolidate` it also covers a non-positive fee (the send path's `FEE_TOO_LOW` class; popup-only, and the popup hardcodes 0.01 CSD). | No. | `node.ts` send / sendMany / fillOffer / buildSignSubmit / `consolidate` |
| `ZERO_ADDR_REFUSED` | An output pays the zero address (irrecoverable burn). | No. | `node.ts` `assembleValueTx` |
| `BAD_OUTPUTS` | An output failed validation (count/cap, address shape, non-positive/unsafe value, sum overflow), incl. the fillOffer preflight's per-output integer check. | No. | `node.ts` `validateOutputs` / `send`, `wallet.ts` fillOffer preflight |
| `NO_OUTPUTS` | The tx would have no outputs (nothing, incl. change, would be paid). | No. | `node.ts` `assembleValueTx` |
| `BAD_REQUEST` | A propose/attest param failed its shape check (payloadHash / proposalId / expiresEpoch). | No. | `node.ts` `propose` / `attest` / `fillOffer`; `wallet.ts` fillOffer preflight (a malformed `proposalId`, refused before any read; since 0.2.74) |
| `FILL_UNSAFE` | The fillOffer fund-safety preflight refused (offer not open, undeliverable, or an underpaid seller/fee/rebate leg): the chain would take the payment and reject the fill. Since the V28 open lane (Plans/69) it also covers the fclaim-lane grant-replay boundary (`verifyFillSpv`): a resolver-DENIED / superseded fclaim, a not-mine or lapsed hold, a below-depth offer/fclaim, or a stranded past-deadline fill (a DENIED fclaim is an L0-valid but delivery-less target, so filling it would burn the payment). Since B7e-FIX it also covers the TOKEN-priced lane's give/want CONTENT bind: a resolver-served give (asset/amount/name) or want (type/ticker/amount) that does not match the offer's merkle-proven on-chain record (a bait-and-switch of what you receive or what you pay). | No (rebuild the fill as quoted, or wait for the offer/fclaim to bury). | `wallet.ts` fillOffer preflight |
| `REVIEW_REQUIRED` | A TOKEN-priced fill (it debits your tokens, not CSD) reached the signer without a complete reviewed quote: the approval window could not show the exact token amount, fee and total, or the call did not come through the approval window. Since 0.2.71 the wallet signs a token-debiting fill only against the amount, fee and total you saw, bound to the offer's merkle-proven terms (a mismatch is `FILL_UNSAFE`). | Yes: reopen the purchase and approve once the amount is shown. | `wallet.ts` fillOffer preflight |
| `OFFER_UNKNOWN` | The resolver answered but does NOT know this proposal as a CairnX offer (clean 404, or a 200 without a parseable offer status). Filling a proposal the resolver will not settle burns the whole payment, so the wallet refuses instead of proceeding (since 0.2.57). | **Yes**: a new offer appears once it is mined and the resolver has read that block; retry then. If it persists, the proposal is not an open CairnX offer. | `wallet.ts` fillOffer preflight |
| `FILL_WRONG_TARGET` | At/above V28, an offer-txid fill was attempted on an offer that has a LIVE fclaim reservation held by you: the resolver routes fills to the fclaim (reservation) target, so paying the offer id would mine on-chain with no delivery and burn (Correction 1). Fill the reservation's fclaim txid instead. | No as-is: re-target the fill to the fclaim txid (an updated site bundle does this automatically). | `wallet.ts` fillOffer preflight |
| `FILL_LEGACY_SUNSET` | Past the V28 sunset band (tip >= 60,045, computed from the wallet's floor-clamped tip, nothing resolver-served), an offer-id fill of an OPEN CSD offer is unconditionally rejected on-chain (the last legacy hold ended at 60,044), so paying it would burn. Refused by arithmetic regardless of any served claim fields (the W5 forgery class). Taker-bound and token-priced offers are exempt from this guard (neither routes through the open-lane claim machinery; the token lane's give/want CONTENT bind landed in B7e-FIX and refuses under `FILL_UNSAFE`, see that row). | No as-is: fill through the offer's fclaim (reservation) target instead (an updated site bundle does this automatically). | `wallet.ts` fillOffer preflight |
| `SOURCE_DIVERGENCE` | **Retired in 0.2.72; no longer emitted. The name stays reserved and is never reused.** It was the V28 fclaim-lane second-resolver (clarvis) value comparison, keyed by the fclaim txid. Every value field it compared is either bound to the merkle-proven offer before signing (a mismatch refuses as `FILL_UNSAFE`) or cannot change the signed outputs, and an honest second resolver 404s a denied fclaim, so it never detected withholding. The withholding check that replaced it is `OFFER_SOURCE_CONFLICT`. | n/a | none (was `wallet.ts` fillOffer preflight) |
| `OFFER_SOURCE_CONFLICT` | On the V28 fclaim lane, the independent second resolver (clarvis), asked for the OFFER by id while the wallet's SPV scan runs, positively reports that the offer is cancelled, filled or expired, that more of it has been paid or delivered than your resolver shows, or that another reservation (fclaim) holds it through the last block of yours (the message names the last block it holds). Your resolver may be withholding an event older than the wallet's scan window, and paying would likely be lost. Not emitted when clarvis answers 404, times out, errors, returns an unusable body, or has not answered by the time the scan finishes; those cases proceed. | Not as-is: reload the offer and check it on the explorer. If your resolver was only lagging, a retry after it catches up shows the same state as clarvis. | `wallet.ts` fillOffer preflight (`fclaimLanePreflight`) |
| `RESERVATION_DENIED` | On the V28 fclaim lane, the independent second resolver (clarvis), asked by txid for its verdict on your reservation (fclaim) while the wallet's SPV scan runs, reports that it replayed the reservation and did not apply it; its reason, when it gives one, is in `error`. The chain clarvis follows denies the reservation, so the fill would move your payment and deliver nothing. A header source that hides a competing reservation placed just before yours makes the wallet's own scan grant it. Not emitted when clarvis reports the reservation applied, does not know it (404), times out, errors, returns an unusable body, or has not answered by the time the scan finishes; those cases proceed. | Not as-is: check the offer and its reservations on the explorer. | `wallet.ts` fillOffer preflight (`fclaimLanePreflight`), since 0.2.99 |
| `RESERVATION_UNCONFIRMED` | Returned to the approval window only, never to a page. On the V28 fclaim lane, the second resolver (clarvis) answered 404 for your reservation (fclaim) with its `tipHeight` at least 12 blocks past the height the wallet proved it at: it has read past the reservation and does not know it. Nothing was signed; the request stays queued, and the result carries `unconfirmed: { fclaimTxid, fclaimHeight, tipHeight }` for the window's confirm step. "Sign anyway" re-sends the approval with an acknowledgement bound to the request id and that fclaim txid, and the wallet re-runs the whole preflight; "Cancel" rejects the request (`USER_REJECTED`). Closing the window settles it `APPROVAL_CLOSED`. The acknowledgement is accepted only as a `resolve` argument on the extension-page channel (the approval window sends it); one in the request's own params, from a web page or the content script, or for another request or fclaim, is ignored. | Yes, by confirming in the approval window after checking the offer on the explorer. | `wallet.ts` fillOffer preflight (`fclaimLanePreflight`), `background.ts` `resolvePending`, since 0.2.99 |
| `RPC_BLOCK_MISMATCH` | On the V28 fclaim lane, a block body served by the configured node RPC does not hash to the merkle root of the block header the wallet verified, so the offer or reservation cannot be proven. The `error` names the block height and the RPC. Typical cause: a local node (`http://127.0.0.1:<port>`) that follows another chain or a fork. Nothing was signed. A transient read failure on the same lane (no chain tip, a header chunk that could not be fetched, a timeout) stays `VERIFY_UNAVAILABLE`. | Not as-is when the RPC follows another chain: point the wallet at the Cairn proxy or fix the node. A mismatch from the Cairn proxy near the chain tip can clear on a retry. | `wallet.ts` fillOffer preflight (`fclaimLanePreflight`), since 0.2.99 |
| `SUBMIT_REJECTED` | The submit was DEFINITIVELY rejected: the node answered a 4xx rejection (feerate/etc.), or a pre-forward proxy 400/413 body cap or 429 rate limit. The tx is NOT in the mempool, so nothing was sent. | No (fix the cause, then resend); inspect `error`. | `node.ts` `signAndSubmit` (since 0.2.55: split from the ambiguous case below) |
| `SUBMIT_MAYBE_INFLIGHT` | The submit outcome is AMBIGUOUS: the request threw / timed out, or hit a 5xx gateway failure (the cairn proxy 502s the node after ~4s, which can outrace a slow-but-successful mempool ingest), or returned an unreadable body. The tx MAY be in the mempool. `txid` carries the locally computed consensus txid so consumers can check whether it landed. | **Do NOT auto-retry.** Check the balance / explorer first; only resend if the tx did not confirm. | `node.ts` `signAndSubmit` (since 0.2.55) |
| `SUBMIT_DUPLICATE` | The node's answer contains "already present": this exact tx is already pending (a resend is byte-identical under deterministic signing, so this is the normal resubmit outcome). Current nodes answer a conflict with a different pending tx with a separate string, which stays `SUBMIT_REJECTED`; an older node's combined "already present or mempool conflict" string can also mean that conflict. Either way a tx spending these coins IS in the mempool; "nothing was sent" would be false. `txid` carries the locally computed consensus txid. | **Do NOT retry.** Check the history once the pending tx is mined; it either settles or frees the coins. | `node.ts` `signAndSubmit` (since 0.2.55) |
| `SEAL_NOT_MINED` | `revealClaim` was asked to publish a sealed claim whose commit the node does not show as mined yet (still pending, never landed, or the node could not be reached). Nothing was published. | **Yes**: reveal once the commit is mined. | `wallet.ts` `revealClaim` (since 0.2.74) |
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
