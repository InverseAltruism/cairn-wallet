# Design note: what an offer fill proves before it signs

Status: built, 2026-10-22. Moved out of AGENTS.md; the code is `src/core/fillpreflight.ts`, `src/core/fillspv.ts` and
`src/core/offerxcheck.ts`. The header store and the second resolver's reservation verdict are in
`docs/DESIGN-namespv-scaling.md`; the user-facing account is in `SECURITY.md`.

## Routing

`fillOfferPreflight` reads the offer from the configured CairnX API and refuses before any lane when it is not a
parseable open offer (`OFFER_UNKNOWN` on a 404 or a status-less body, `VERIFY_UNAVAILABLE` when the read failed).
Then it routes on the request alone, never on a served field:

- `proposalId` differs from the offer id: the fill attests a reservation (fclaim), so it takes the fclaim lane. A
  resolver that withholds or alters `fclaimId` cannot steer it elsewhere.
- Otherwise it is an offer-id fill: `csdLanePreflight` for a CSD-priced want, `tokenLanePreflight` for a token want.
  An open CSD offer filled by offer id during a live hold refuses with `FILL_WRONG_TARGET`, and past the V28 sunset
  height (60,045, clamped up with the PoW-backed tip floor) with `FILL_LEGACY_SUNSET` (test/fill-legacy-sunset.test.mjs).

Every lane returns a refusal or null and signs nothing. An unprovable or transient read refuses as retryable
(`VERIFY_UNAVAILABLE`); a proven mismatch refuses as `FILL_UNSAFE`.

## The fclaim lane

- `verifyFillSpv` replays the offer's lane events, each merkle-proven against the verified header chain and bound
  to its author by the prevout-ownership check, over a window from below the fclaim's proven height to the tip.
- The planned per-address CSD sums (payment, treasury fee, maker rebate) must equal the need-map computed over the
  replayed offer, so the chain's own `paid` and `delivered` size a partial fill, not the served ones
  (test/fill-fclaim-preflight.test.mjs).
- The served fee, rebate, value, taker, bid and `min` fields are bound to the proven offer terms through the vendored
  `bindOfferTerms`; binding `min` closes the whole-fill-to-partial rebate-drop burn.
- The count of the buyer's other live holds is computed by the SPV source and over-counts; when it cannot be
  computed the fill refuses.
- A block body that contradicts its verified header refuses as `RPC_BLOCK_MISMATCH`, naming the block, the RPC and
  the header source without blaming either.

Pre-window withholding (a cancel or consuming fill older than the scan window) is covered by a second-source read:
beside the scan the preflight reads the offer by id from clarvis and refuses with `OFFER_SOURCE_CONFLICT` when clarvis
reports it cancelled, filled or expired, further paid or delivered, or held by another reservation through the buyer's
hold (`secondSourceOfferConflict`, test/fill-offer-crosscheck.test.mjs). The second read, clarvis's record of the
buyer's own fclaim (`RESERVATION_DENIED`, `RESERVATION_UNCONFIRMED` with "Sign anyway", the "Second source not
consulted" notice), is described with its residuals in `docs/DESIGN-namespv-scaling.md`, "Built: the second
resolver's verdict on the buyer's reservation".

Neither read is awaited past the scan, so these gaps close only when clarvis is reachable, answers before the scan
finishes, and is honest. They stay open when clarvis is down, slow or withholding the same event, and when the front
door withholds or delays the buyer's fclaim (it relays the submit through `/api/rpc`) while clarvis has not yet
replayed it. Against a header-source attacker the "unknown" warning is advisory, because that attacker serves the
headers that prove the height it is compared with (the `liveFillSpvSource` comment in `fillspv.ts`).

Value fields are checked against the primary resolver plus SPV only; there is no second-source value comparison,
because every value field is merkle-bound and such a comparison cannot see withholding.

## The offer-id CSD lane

An offer-id fill of a CSD-priced offer: a taker-bound offer, or an open one below the sunset height.

- `provenOfferPayto` merkle-proves the offer record; the served `want.payto` and seller must equal the proven author
  fields, and the proven offer must carry `want.value` (a token offer served as CSD-priced refuses).
- The fee, rebate, value, taker, bid and `min` fields are bound with the same `bindOfferTerms` call as the fclaim lane.
- Every leg of the vendored `requiredFillOutputs` need-map must be paid by the outputs, compared in `bigint`.
- Offer expiry (both offer-id lanes), strand avoidance: the node refuses an attest after its proposal's expiry
  epoch, in mempool admission and in block apply, so a fill that is not mined by the offer's last live block (the
  vendored `offerExpiryHeightOf` minus one) sits unconfirmed and is dropped; no payment moves. For offers anchored at
  or above V22 resolve() expires them at the same boundary. The resolver serves an offer open until its own tip
  reaches the last live block. The wallet takes the expiry epoch and anchor height from the merkle-proven record and
  refuses with `FILL_UNSAFE` when the last live block is below the tip plus the vendored `FILL_TIP_MARGIN` (4, the
  fclaim lane's margin for the same strand), with the tip clamped up by the PoW-backed floor; with no readable tip
  and no floor it refuses as `VERIFY_UNAVAILABLE` (test/fill-failclosed.test.mjs, test/fill-token-content.test.mjs). The fill cards show the listed offer's expiry
  block and the blocks left after the floor-clamped tip, from the offer service's listing (display only), and name a
  refusal only when `offerFillTooLate` says the preflight will make it (test/approve-card-honesty.test.mjs).

## The token lane

The fill is an Attest with no CSD outputs (`attest` with `CONF_TOKEN_FILL` reroutes to `fillOffer` with
`outputs: []`).

- Any CSD output refuses (test/fill-token-content.test.mjs).
- The offer record is merkle-proven and its give legs and want type are bound through `bindOfferTerms`; the token
  `want.ticker` and `want.amount` the buyer pays are bound separately, since `bindOfferTerms` carries no token-want
  leg. This mirrors the site's swapguard `verifyOfferContent`.
- The approval window's quote (`tokenFillQuote`) is a resolver read when shown. The fill signs only when the reviewed
  ticker, amount, fee and total equal the proven terms, with the fee computed from the proven amount and height; a
  quote that shows a give must show the proven give. No complete reviewed quote refuses with `REVIEW_REQUIRED`.

## What stays resolver-trusted

- The offer's give-backing (a token's deploy and mint, a name's ownership) is synthesized from the proven offer record
  and never affects the grant, denial, holder or cancel verdict.
- On the offer-id lanes the running state of a partial offer (`paid`, `delivered`) is served by the resolver: the
  creation-block proof cannot bind it. A full fill-replay proof on those lanes is not built.
- Name sends do not use these lanes; they stay on the SPV name verification in `src/core/namespv.ts`.
