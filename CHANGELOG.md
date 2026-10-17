# Changelog

## Unreleased

- Reservation fills: beside the offer read, the wallet asks the second source (clarvis) for its verdict on the
  buyer's own reservation (`/cairnx/record/{fclaimTxid}`), started with the SPV scan and never waited for past it.
  When clarvis reports that it replayed the reservation and did not apply it, the fill refuses with the new code
  `RESERVATION_DENIED` and clarvis's reason. This covers a header source that hides a competing reservation placed
  just before the buyer's, whose hold ends before the buyer's and so passes the offer check. An applied
  reservation, a 404, a timeout, an error or an unusable answer proceed as before, with no added wait.
- SECURITY.md and the header-store design note correct the cost of the forged-header attack on reservation fills:
  the forged chain needs to start only just below the hidden reservation, so for a small fill it is a few honest
  blocks' worth of work and succeeds on every attempt once the front door is controlled (the earlier text said it
  had to run to the chain's real height, about 160 blocks' worth). They describe the reservation verdict above, its
  residual (clarvis down or slow during the attack, or both hosts compromised), and why the header-hash comparison
  first proposed was not built (it misses every fill at claim depth 3 to 6).
- The two `RATE_LIMITED` messages for a full approval queue use a semicolon instead of a dash: "too many pending
  requests from this site; approve or reject the queued ones first" and "too many pending wallet requests; approve
  or reject the queued ones first". The code is unchanged.
- Name verification keeps block headers in a compact store in the browser (IndexedDB), anchored by block hashes
  built into each release, instead of a JSON snapshot that was read and re-verified whole at every start. A start
  reads the newest built-in chunk and the headers above it; an older name costs one chunk the first time it is
  needed. The old snapshot is moved into the store once after the update and then deleted.
- Name verification and fills on the header store: an offer or name record below the newest built-in block hash is
  proven from its 4,096-block chunk, fetched once and kept. A name-history entry below the names floor (block
  29,960) is ignored and the result is marked as a source disagreement, instead of failing the check. When the
  node does not answer its chain tip, the wallet no longer asks for headers past the chain; a reservation fill
  then refuses as retryable. If the node RPC serves a block that does not match the wallet's verified header (for
  example a local node on another chain), a reservation fill refuses with the new code `RPC_BLOCK_MISMATCH` and a
  message naming the block and the RPC, instead of "try again in a moment"; an offer-id fill still refuses as
  `VERIFY_UNAVAILABLE`, and a name shows as not chain-verified. Headers from the Cairn API that keep
  failing the chain's checks are reported in plain words instead of the light client's internal message.
- When the served headers stop linking to the wallet's verified chain and the wallet re-syncs from its newest
  built-in block hash, the replacement chain is adopted only if it carries more proof of work than the chain the
  wallet already verified; otherwise the wallet keeps its chain and says so ("the block headers from <source> above
  height N carry less proof of work than the chain this wallet already verified to height M; the wallet keeps its
  verified chain. Try again later."). An honest chain that outgrew the stored one has more work and is adopted.
- Reservation fills: a served payment recipient or seller that differs from the offer's on-chain record is refused
  by the payment check against the proven offer ("payment does not match the proven fill progress"); the separate
  recipient check that used to give the reason "the seller payment recipient does not match the offer's on-chain
  author" was a second copy of the same check and is removed. One case changes: an offer with a minimum partial
  fill has no maker-rebate leg, so a served seller that differs from the on-chain one used to refuse and now
  signs, with the honest outputs (the payment to the on-chain recipient and the treasury fee); no payment can be
  redirected by that difference. Every other case that was refused before is refused now.
- Activity markers come from chain state, not a clock: a send that may not have reached the chain reads "sent, not
  yet included" until it is seen in a block; after 10 blocks it reads "still not included after 10 blocks; check
  the explorer before sending again", and a send whose coins another mined transaction spent reads "not included:
  its coins were spent by another transaction; check the explorer before sending again". The wallet does not
  resend on its own. A merge reads "merge sent (txid); confirming" instead of claiming it completed, and a merge
  still pending after 10 blocks says so.
- Approval window: after an idle auto-lock and unlock, a token quote or balance read started before the lock no
  longer lands on the repainted screen. Approve now waits for the repaint's own quote, and the balance line and
  the "does not cover" check come from the repaint's own read, so the amount you approve is the one shown.
- Approval window: the finalize check on a .csd registration stays current while the request is open. Approve
  goes down when the finalize window closes and comes back when a request opened too early becomes valid,
  without a reopen. A click on a check older than 35 seconds re-reads the chain tip first, and a result that
  arrived while the wallet was locked is shown after unlock.

## 0.2.74 (2026-10-13)

- Amounts on the signing screens are exact decimals from one formatter (1 base unit reads 0.00000001 CSD, not
  1e-8 CSD); token amounts use the pinned decimals, never the ones a server reports.
- Copy buttons say "copied" only after the clipboard write succeeded; a failed copy says so.
- Content registration after a post gives up after 20 seconds instead of waiting on a hung request.
- A fill with a malformed offer id is refused before anything is signed (`BAD_REQUEST`).
- The fill cost line no longer says the fee and rebate are paid to the seller.
- RPC: the wallet talks to the Cairn proxy or to a node on this computer (`http://127.0.0.1:<port>` or
  `http://localhost:<port>`). A saved remote RPC is moved to the Cairn proxy once, with a notice; the manifest
  never allowed the wallet to reach a remote node, so that setting could not work.
- Five popup-channel methods that nothing called are removed (`verifyName`, `signin`, `propose`, `attest`,
  `flushPending`); the dApp paths for sign-in, propose and attest are unchanged.
- Create, restore and import change nothing unless the new vault is sealed and stored. A password under 8
  characters (or a failed storage write) used to leave the wallet unlocked on an address whose key was stored
  nowhere.
- Approval window: it stays open until the outcome of an approved request arrives, and after a failure it keeps
  the reason and its code on screen (for example `failed: ... (OFFER_SOURCE_CONFLICT)`) until you close it or the
  next request appears. A success or a rejection still closes it.
- Connected sites: a site's connect and your Disconnect of another site are applied one after the other, so the
  disconnected site can no longer be restored by the race.
- A lock (including the idle auto-lock) between a send's broadcast and its history write no longer drops the
  history row: it is held in memory and written to storage at the next unlock. It does not survive the
  service worker stopping before then. A reset still drops it.
- Sealed claims: the reveal preimage is encrypted before the commit is broadcast, so a lock between the
  broadcast and the seal write no longer loses it (the paid commit stayed unrevealable). Like the history row it
  is held in memory while locked and written at the next unlock; a reset drops it.
- Sign in with CSD: a `statement` longer than 256 characters is refused, like `requestId`.
- Epoch math uses the vendored consensus `EPOCH_LEN` instead of a local copy of the number (no value changes).
- `window.cairn`: the per-page reply nonce between the content script and the page provider is removed. Replies
  are posted on `window`, so any script on the page could read it from the first reply; it protected nothing.
  Signing and connecting still require approval in the wallet window, bound to the requesting site's origin.
- Failure messages say what happened. "May already be in flight" now appears only when a transaction may have
  reached the node (`SUBMIT_MAYBE_INFLIGHT`, or the popup lost its connection to the wallet mid-call). Any other
  error from a send, token send, merge, renewal, set-primary, post or seal says "Nothing was sent". Renewal,
  set-primary, post and seal results are read the same way as a send (they used to show "... failed" for an
  ambiguous or already-pending submit).
- A node answer without a coin list (`/utxos`) is refused before signing as `VERIFY_UNAVAILABLE`; a submit
  answered with a 2xx body that is not a JSON object is `SUBMIT_MAYBE_INFLIGHT` (it used to throw after the
  submit).
- When coin selection uses its three rounds on coins the node could not prove yet (typically while a restarted
  node rebuilds its index), the refusal is the retryable `VERIFY_UNAVAILABLE`. It used to read as "the remaining
  coins couldn't cover this spend".
- New code `SEAL_NOT_MINED`: Reveal waits until the seal's commit is mined.
- A locked wallet answers `WALLET_LOCKED` (not `INTERNAL`) when a popup action or an approval runs into the lock.
- An open-offer fill refused for a reason the chain tip does not decide (for example the claim cap) keeps
  `FILL_UNSAFE` even when the tip was floor-clamped; only tip-decided reasons read "wait a moment and try again".
- Settlement wording no longer promises "next block" or "a block or two": items settle once they are mined.
- Approval window: a CSD-paid fill shows the asset the listing gives (as listed by the offer service) and, on a
  reserved offer, the listing behind the reservation; Approve stays disabled while the spendable balance does not
  cover the request; the first-time recipient warning for a name record says what the address receives instead
  of "Payments are irreversible".
- Sending to the wallet's own other account no longer shows the first-time recipient warning.
- Popup send review: Confirm stays disabled, with the same note as the approval window, while the spendable
  balance does not cover the amount plus fee.
- SECURITY.md and README describe `.csd` name verification as the code does it: a disagreeing name source is
  a warning, not a refusal; an unprovable name shows the served address as not chain-verified; the two default
  name sources share one operator and one registrable domain. Also corrected: storage is closed to content
  scripts, page messages are not authenticated, there is no reset screen.
- Release workflow: no default token permissions (each job gets its own), checkouts do not keep credentials, a
  typecheck step, and deleting an existing release for a re-pushed tag fails the job instead of being ignored.
  The CI workflow gets the same permissions and checkout settings. All vendor gates are unchanged.
- The vendor-freshness gate labels its csd-sdk commit check as advisory; the rebuild byte-diff is the check that
  fails it. Pass and fail are unchanged.
- Publish runbook: one maintainer (no dual control), the four files a release carries, the local-vs-release
  sha256 comparison, and the commands for the post-publish CRX comparison.

## 0.2.73 (2026-10-10)

- Open-offer fills (fclaim lane): the wallet reads the offer by id from the second source (clarvis) in parallel
  with its SPV scan and refuses with `OFFER_SOURCE_CONFLICT` only on positive evidence (offer cancelled, filled
  or expired, more paid or delivered than the primary served, or a later claim holder). This closes the
  pre-window withholding gap when clarvis is reachable and honest. 404, timeout or garbage proceed, and the fill
  never waits for clarvis.
- Approval screen: CAIRN amounts use pinned decimals (8); other tokens show an "(unverified token)" mark next to
  the human figure. Base units are always shown; what is signed is unchanged.

## 0.2.72 (2026-10-10)

- Token amounts at approval show both scales, e.g. "4638.5287329 CAIRN = 463852873290 base units" (CX-35).
- The second-resolver fclaim comparison keyed by the claim txid is retired (`SOURCE_DIVERGENCE`); it could not
  catch withholding.
- Vendor bundle rebuilt from csd-sdk `fb37dbb` with a layout-independent build; signed nprofile values are shown
  in full; the release workflow's provenance step must succeed; the version lives only in `package.json` and the
  build checks that it was stamped.

Earlier releases are described in their tag messages.

## Earlier release notes (moved from AGENTS.md on 2026-10-11)

These were dated status snapshots in AGENTS.md. They are kept as written; they describe their own date, not the current tree.

### As of 2026-10-09 (Plan 83 batch 1)

**Version 0.2.72 on `lts/83-wallet-0.2.72` (draft PR), not tagged, not uploaded.** Chrome Web Store field version: 0.2.71. What it carries: the vendored bundle rebuilt from csd-sdk `fb37dbb` (cairnx-core 0.1.42, the expiry-index resolver change; replay byte-identical); the vendor build runs esbuild from the csd-sdk root and the freshness gate re-runs the build script instead of keeping its own copy of the entry, so the bundle bytes no longer depend on checkout layout (from a worktree the gate used to report STALE on identical code); nprofile values are shown in full in the approval window (they were cut at 120 chars with no marker, so the tail of a signed value was hidden); the SLSA attestation step in release.yml is required (the repo is public and the step has succeeded on every release since); the version is written once, in package.json, and stamped into the manifest and the provider at build time.


### As of 2026-09-23 (Plan 80 Phase D)

**Version 0.2.71 on `wallet/0.2.71` (PR #4), to be tagged `v0.2.71` after the packaged QA.** Chrome Web Store field version before it: 0.2.70. What it carries: token-debiting fills are signed only against the complete exchange the approval window showed (`REVIEW_REQUIRED` when the reviewed quote is missing or lacks fee and total; fee and total bound to the merkle-proven terms, CX-15); approval review state is kept per request id, so the 1.2 s re-poll cannot drop the reviewed quote (CX-23); two-stage arming (Reject at once, Approve only after the token quote paints); human units on the token card; look-alike ticker warning keyed on the CAIRN deploy id, which warns when the record did not load (CX-16.3); per-ticker token reads for the preview; a duplicate approval window closes itself. Gate: 64/64 test files, typecheck, build tripwires; the vendored bundle is byte-identical to 0.2.70 (release.yml re-verifies it from the pinned csd-sdk commit `06c3780`). Packaged QA on the extracted store zip (sha256 `eaeac36f…`): token-for-token fill with a human-unit card and broadcast; a fill whose quote cannot load never arms Approve. Known and not in this release: the **bid** card still shows base units (0.2.72); after Approve the wallet verifies and broadcasts about 9 s later, and a fresh install's first fill first syncs its light client from 29,960 (73 s in QA). Upload to the Chrome Web Store stays the operator's manual step.


### As of 2026-08-02 (Plan 75-B batch C2)

**Version 0.2.66, MERGED to master `a036261`, TAGGED `v0.2.66`, GitHub release built by `release.yml`
with all four assets (2026-08-03). The Chrome Web Store upload is the ONE remaining action.** Store-zip
sha256 `5446a71bedab8072dc6742c61c2c81d017c119d0bc1fdfd41e1df92b44db0870`, matching the released
`.sha256` asset byte for byte; the manifest inside the zip reads 0.2.66.
★**The packaged-artifact QA PASSED** (see cairn/docs/Plans/75-TRACKER.md section L): 5 of 7 scenarios
executed in real headed Chrome against the PACKAGED zip on the live chain, 43 assertions, 0 FAIL, and the
three lock-dependent ones (W1, poisoning, W8) driven by the REAL 15-minute idle auto-lock timer rather
than a scripted `lock()`. W2 was proven by forcing the race with a 6 s CDP request pause, because at real
network speed the window does not exist and the test would be vacuous. S4 (token fill) is N-A, no live
subject exists; S5 (Renew) is N-A, register-then-renew costs 6.00 CSD against the 2.00 CSD test ceiling,
so **W5's Renew happy path is untested on the packaged artifact** and is covered instead by
`test/fee-tier-clamp.test.mjs`, which pins that a fractional tip returns null and is NOT normalized to 0.
★**ROLLBACK, corrected by the operator 2026-08-03:** the Chrome Web Store IS rollback-capable, and nobody
installs from the GitHub release. Any doc saying "no rollback, only a forward 0.2.67" is wrong. The Chrome Web Store
field version is **0.2.64** (the listing has read 0.2.64 since 2026-07-23); the repo and the GitHub release
are at 0.2.65, which was minted by Plan 75 and never reached the store, so this ships as 0.2.66 and the
store jumps 0.2.64 to 0.2.66. Rollback on this vehicle is FORWARD ONLY, as 0.2.67.

What 0.2.66 carries (Plan 75-B C2, items W1 to W8, seven code edits):
W1 (AW-4) the approval window resets four of its five once-per-request latches at the `$("req").innerHTML`
rebuild, so an approval left open across an idle auto-lock repaints its address-poisoning and
first-time-recipient warnings and its token debit quote instead of showing empty boxes; the 1.2s poll adds
zero fetches (pinned by `test/approve-repaint-dom.test.mjs`). The FIFTH latch is the approve-gate latch and
is deliberately not reset; it is W8 below.
W2 (AW-3) the async DOM fillers (`fillBalance`, `fillSendWarning`, `fillTokenSim`) carry the
`renderedId !== r.id` guard after their await, so a superseded request's late balance fetch can no longer
repaint the money row of the request now on screen.
W3 (N-05) `fillOffer`'s score guard uses `!= null`, so an explicit `score: null` is treated as absent
again (it never shipped; the store still serves 0.2.64, and this release must not be the one that
introduces the refusal). A present-and-not-100 score is still refused.
W4 (AW-SEAL-LOCK-1) `lock()` no longer wipes `pendingHist`/`pendingSeals`. An idle auto-lock destroyed a
PAID commit's only reveal nonce and the parked history rows behind the double-pay backstop. `doReset()`
still clears both, so reset discipline is unchanged, and `test/storage-durability.test.mjs` case I is
revised (with its reasoning) from M9's old pin. HONESTY: both arrays are RAM on the MV3 service worker and
still die at SW idle kill; this buys survival across a lock and unlock inside ONE service-worker lifetime,
not durability.
W5 (Q-02) `feePricingTip` normalizes with `Number.isSafeInteger` and returns `number | null`. A served tip
of `65100.5` or `1e16` is finite but is not a height: it used to reach the vendored `buildFeeHeight`, throw
RangeError, and be swallowed by clearsign's bare catch, silently disarming the CLEARSIGN-FEE-1
underpayment warning. Normalizing to 0 would have been WORSE (it prices the cheapest tier, so the wallet's
own Renew would build an underpaid record and BURN the fee), so both build sites refuse on null. That
refusal IS UX-6's refusal and is recorded as such; the paired happy-path (fresh install, live tip, floor 0)
prices and signs unchanged.
W6 (ND-1) a fifth input verdict, `unrepresentable`, with code `VERIFY_UNREPRESENTABLE`. There is no upper
bound on `expires_epoch` in consensus, so a stranger could anchor one tx with
`expires_epoch = 9007199254740993` and 1 sat to a victim: `JSON.parse` rounds it, the recomputed txid
differs, the coin classified `tamper`, and tamper is decisive for the whole spend. `consolidate()` selects
smallest-first, so that dust coin bricked the documented remedy for the large-send class, permanently. The
new verdict is classified on the RAW body before `nodeTxToTx`, mirrors `horizon` (per-coin skippable, own
array, own reporting rung after horizon and before notfound), adds NO rung to the decisive fold, and is
never aliased to `notfound` (that copy would call a real coin missing). A well-formed body with a wrong
txid is still `tamper`.
W7 the four version literals (`package.json`, `public/manifest.json`, `src/inpage.ts` x2) at 0.2.66, and
this snapshot. No new version tripwire was built: `build.mjs:32-38` already matches EVERY `version:`
string in `inpage.ts` and was re-verified live by mutating the manifest and the second inpage literal
(both aborted the build).
W8 (AW-4, the fifth latch) the nfinalize/nrenew/nset approve-gate note survives the unlock repaint. Its
latch (`nfinForId`) was outside W1's reset line while its output is written with `insertAdjacentHTML` into
the very element the rebuild destroys, so a FEE-BURN warning (for example that the name is a pending
reservation rather than a finalized registration, so the renewal would be ignored on-chain and the fee
burned) was still silently lost across an idle auto-lock, inside W1's own stated rule. The fix RE-ATTACHES the already-settled verdict and
nothing else. Adding `nfinForId` to W1's reset line instead would have AUTHORED A NEW DEFECT: it re-runs
the bounded 6s name fetch on every repaint AND resets `nfinBlocked` to false with a fresh in-flight
verdict, so `armButtons`' 700ms timer re-enables Approve on a request the gate had already BLOCKED until
the new verdict lands. Both shapes are pinned in `test/approve-repaint-dom.test.mjs` (cases 5 to 7): the
naive reset is what turns the blocked-button assertion red. Not handled and stated plainly rather than
left implied: a verdict that settles WHILE the wallet is locked is still dropped by the `renderedId` guard,
so it has no note to re-attach and `nfinBlocked` stays false; `resolve()` still awaits `nfinGate` and
refuses a blocking verdict at the click, which is the fund-safety belt in that corner.

Gate as run 2026-08-02 on this branch: `npm run typecheck` clean, `npm test` **57/57 files** (up from 54;
three new files: `approve-repaint-dom`, `seal-lock-park`, `unrepresentable-coin`), `npm run build` green
with all three tripwires, `npm run verify:vendor` PASSES byte-identically against csd-sdk 0.1.41 dists.
Vendored bundle: `csdSdkVersion 0.1.41`, `csdSdkCommit 82175f98`, `bundleSha256 f34994f2c58c`. The gate
prints a standing commit-mismatch warning because csd-sdk HEAD has advanced past that pin; the byte-diff
is authoritative and passes. **OWED before tagging:** re-run `node scripts/check-vendor-fresh.mjs --write`
after Plan 75-B batch C0 lands on csd-sdk master, so the PROVENANCE pin names csd-sdk HEAD, and commit the
bundle and PROVENANCE together. **OWED before uploading:** the packaged-zip human click-through,
`docs/archive/QA-0.2.66-packaged-clickthrough.md`, which is the only control on a vehicle with no rollback.
Also known and deliberately NOT shipped here: the namespv checkpoint at `src/core/namespv.ts:40` stays
29,960 (a checkpoint is a trust decision, not a perf knob, and the diff on this vehicle is kept minimal);
`package-lock.json` still records 0.2.60 and is not one of the four lockstep literals.


Version 0.2.64 on master, RELEASED: tag v0.2.64 (6ff9615), PROVENANCE byte-verified at csd-sdk 0.1.40/722b427, CI GitHub release built, and the CWS upload is DONE (0.2.64 live in the Chrome Web Store as of 2026-07-23; field adoption feeds the ~tip-80,000 V29 checkpoint). Master is one merge ahead of the tag: rebind/bp6-wallet (BP6 wallet half, the OBS-3 legacy-claim tombstone) was rebased onto 0.2.64 and merged 2026-07-23 once the tip passed 60,134 (below that the tombstone would have shipped a burn window); it rides the NEXT wallet vehicle, suite 48/48 at merge. What shipped IN 0.2.64 (the S-06 mega-vehicle): B4a (single-source), the B5 WALLET-HARDEN chain B5a..B5f + B5g/h/i, BP8b (namespv partial-progress snapshot persistence, see the namespv bullet: partial persists write the header-chain key only, the lapse floor never advances on one), BP8-design (docs/DESIGN-namespv-scaling.md, the N14 scaling roadmap), BN0w (the node SCAN_HORIZON 503 consumed as a fourth per-coin-skippable "horizon" verify verdict; inert until node v0.1.6 emits it), B8w (the runner-guards N24 guard-of-the-guard + lazy dist walk + the N18 pin), the re-vendor to cairnx-core 0.1.40 (PROVENANCE re-pinned at release per R3), and B7e + B7e-FIX (BOTH fill lanes bind; the token lane now merkle-proves the offer record and binds give/want content, see the trust-model bullet; CONF_TOKEN_FILL de-duped across its 5 sites). 0.2.64 carried ~15 batches in one CWS upload (the named mega-vehicle risk, accepted in writing; upload completed 2026-07-23). M3 residual, accepted in writing: the tokenFillQuote clear-sign DISPLAY number stays resolver-served and explicitly unverified (bounded: the fill itself is content-bound, so the worst case is a warning-ignoring user overpaying up to the genuine on-chain price, not theft; loud verify-on-explorer warning; recorded cheap tightening = echo the preflight's proven wantAmount into the clear-sign). History below this line is prior-release narrative, not the current tree.

0.2.63 (2026-07-20, REBIND S-03: BP4 fclaim scan transport - the ~224-block by-height fclaim scan parallelized into bounded-concurrency waves (pool 12, ascending) with a per-height bindBlock memo and a shared light client behind a single-flight LC.sync serializer so two concurrent consumers cannot interleave ingests; plus a source-pinned guard that the serializer is applied at its use-site, and the B0c glob test runner. Zero verification-logic change. Git-level released + tagged v0.2.63 + CI GitHub release rebuilt; the CWS upload is the operator's manual step). 0.2.62 (2026-07-18: the legacy dApp fill lane now MERKLE-PROVE-binds want-TYPE - refuse to sign a CSD payment on an offer whose proven on-chain terms carry no `want.value`, closing a lying-resolver token-priced-as-CSD pay-without-delivery burn; mirrors the fclaim lane's isTokenWant rejection. Git-level released + tagged; the CWS upload is the operator's manual step). 0.2.61 was Plan 70 R1/R1.1/R2 fund-boundary binds: F2/F2-legacy payto+seller+fee+min on both fill lanes, L5 seal-preimage encrypt-at-rest; vendored cairnx-core 0.1.38 @ csd-sdk commit 84f22d7. The dated batch narratives BELOW (0.2.55-0.2.58) are historical context, not the current tree. // 0.2.58 batch: persistVault serialized behind a promise chain + cleartext mirror captured from the same pre-await snapshot as the sealed doc, so concurrent account-management can no longer drop a just-added imported (non-recoverable) key (pinned by persistvault-race.test.mjs); nfinalize gate comment corrected to honest resolver-trust scope (the finalize window is best-effort against an honest-but-stale resolver, not a Byzantine one); F-CLIP btn-backup-done clears a copied first-backup secret on dismiss; expectSigner throw consolidated to one helper.

The 0.2.57 batch (Plans/68 Tracks A + B1/B2 + C2): signing-context capture closes the fillOffer account-switch race (captureSigner/signerUnchanged + the expectSigner backstop threaded from the approval window AND the popup review snapshots; ACCOUNT_CHANGED now fires at the sign tick, not only pre-dispatch); imported-key removal is password-gated with an irreversibility warning (HD removal stays one-click; sentinel REMOVE_IMPORTED_REAUTH); the fillOffer preflight fails CLOSED on a clean 404 or status-less 200 (new code OFFER_UNKNOWN - filling a proposal the resolver will not settle burned the whole payment); the nfinalize approve gate gains the freeze-window half via the completed vendored finalizeWinnerCheck (cairnx-core 0.1.36) and the gate now also covers nrenew/nset (nameActApproveGate: block only definitive no-ops, warn on transport failure); flushPending keeps paid bodies on a refused registration and survives concurrent queueing; getPermissions requires unlocked; single-source/low-depth name badges read honestly weaker; maybe-entries get a post-expiry tombstone and maybe-path seals are flagged; CI actions SHA-pinned (attest v2). Vendored core: cairnx-core 0.1.36 + csd-light 0.1.17 (snapshot anchor containment + restore-time timestamp rules) at the csd-sdk commit pinned in src/vendor/PROVENANCE.json. The 0.2.55 batch (unreleased, riding in 0.2.56): honest structured send errors (SUBMIT_MAYBE_INFLIGHT / SUBMIT_DUPLICATE with locally computed txids), coin consolidation + preview + the pending-merge indicator and merge-aware refusal copy, bounded verify concurrency, timeout-inversion fixes, unlimitedStorage, clarvis resolve fallback, 7-day pending-content retention. The 0.2.56 batch: maybe-inflight outcomes recorded in history for EVERY value flow at the maybeRecord chokepoint (maybe:true entries with the local txid; cleared in place on a definitive ok/duplicate or when the txid shows up in the utxo set; time-bounded "may be in flight" marker in the history UI), history filed under the account that SIGNED (pre-await histKey capture), maybe-inflight cairnPost content + sealClaim preimages persisted (a landed ambiguous tx no longer loses its body/reveal), ~4x faster SPV snapshot restore (vendored csd-light 0.1.16 LWMA memo, byte-identical), Terms of Use + Privacy links in Settings, spendableCoins/clarvis-fallback/2xx-unparseable test pins, store-listing unlimitedStorage justification, em-dash-free user-facing docs, portable ux-shots (no machine paths in the public repo). Vendored core: cairnx-core 0.1.35 + csd-light 0.1.16 at the csd-sdk commit pinned in src/vendor/PROVENANCE.json.

