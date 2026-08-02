# Packaged-zip click-through, wallet 0.2.66 (Plan 75-B, batch C2)

Operator script. Follow it literally, in order, and record a PASS or FAIL per numbered step.

This is the only control on a vehicle with no rollback: the Chrome Web Store has no undo, only a forward
0.2.67. It is also the named interim control for the largest instrument blind spot in this repo, which is
that nothing verifies the clear-sign at the DOM level in a real browser. Two of the six 0.2.66 fixes (W1
and W2) are DOM-behavior defects, which is exactly the class a source-only pass misses, so steps 2 and 3
are not optional.

## Before you start

```bash
cd /opt/cairn_substrate/cairn-wallet
git rev-parse --abbrev-ref HEAD        # expect the 0.2.66 branch or master after merge
npm run package                        # builds dist/ and emits both zips + sha256
sha256sum -c cairn-wallet.zip.sha256 cairn-wallet-store.zip.sha256
```

Load the PACKAGED artifact, not `dist/` directly, so what is clicked is what is uploaded:

1. Unzip `cairn-wallet.zip` (the nested one, built for load-unpacked) into a scratch directory.
2. `chrome://extensions` with Developer mode on, Load unpacked, pick that directory.
3. Confirm the card reads version **0.2.66**. If it reads anything else, stop: the build tripwire should
   have caught it and something is wrong with the artifact you loaded.
4. Create a throwaway wallet, or import a low-value test account. Do not use a treasury or operator key.

Endpoints stay at their defaults (`https://cairn-substrate.com/api/rpc`, `/trade/api`, clarvis). Steps 5
and 6 spend real CSD, a few hundredths of a CSD in total; step 6 needs at least two spendable coins.

## The six scenarios

### 1. Two queued dApp requests, resolved in sequence (W2)

Trigger two signing requests from a page without resolving the first, for example two `send` calls in
quick succession from the console of an origin the wallet is connected to.

- The approval window shows `request 1 of 2`.
- Approve or reject the first while it is still painting its `balance:` line.
- **ASSERT**: when the second request paints, its cost row shows the SECOND request's amount and its own
  balance-after. The first request's numbers must never appear under the second request's details.
- **ASSERT**: the recipient address shown with the second request is the second request's recipient.

FAIL if the money row flickers to the previous request's figures at any point.

### 2. One approval left open across an idle auto-lock, then unlocked (W1)

- Raise a `send` approval to a recipient this account has never paid, and leave the window open.
- Wait for the idle auto-lock (do not touch the popup or the approval window; the approval window's own
  1.2s poll deliberately does not defer the lock).
- The approval window swaps to the locked view. Unlock it in place.
- **ASSERT**: the request repaints AND the first-time-recipient warning is present again ("First time
  sending to 0x…"). An empty gap where the warning was is the defect this release fixes.
- **ASSERT**: the `balance:` line is filled in again, not left as the bare cost line.
- Reject the request. Nothing should have been signed.

### 3. A send to a lookalike recipient (the poisoning warning must appear)

- Pick an address this account HAS paid before (or one of the wallet's own accounts), and construct a
  near-lookalike: same first four and last four characters, different in the middle.
- Raise a `send` approval to the lookalike.
- **ASSERT**: the red "Possible address-poisoning" warning appears and names both addresses.
- Repeat inside scenario 2's lock and unlock: lock, unlock, and **ASSERT** the poisoning warning is still
  there after the repaint.
- Reject.

### 4. A token-priced fill (the debit quote must appear)

- From `/trade` or `/names`, start a purchase of a TOKEN-priced offer so the wallet raises the
  `attest`/`fillOffer` token-lane approval.
- **ASSERT**: the "TOKEN-PRICED FILL" caution is shown AND the token debit quote box below it is filled
  in with an amount attributed to the offer service (not left as an empty box).
- Lock and unlock as in scenario 2. **ASSERT**: the quote box refills.
- Reject, or complete the purchase if you want the fill; either is fine for this step.

### 5. A Renew at the live tip (W5 happy-path)

- Settings, assets, pick a `.csd` name you own with a live lease, press Renew.
- **ASSERT**: the review card shows a real fee, not "priced at confirm", and the total is anchor plus fee.
- Confirm.
- **ASSERT**: it signs and broadcasts, and the fee it paid equals the fee that was reviewed.
- **ASSERT** on the explorer that the treasury output value matches the reviewed fee exactly.

This is the paired happy-path for W5's new null refusal. If Renew ever shows "priced at confirm" against a
healthy node, stop and report it: that is the refusal firing on an honest path, which is a defect.

### 6. A consolidate (W6 happy-path)

- Settings, coins. **ASSERT** the preview reports the coin count and the resulting single-coin value.
- Run the merge.
- **ASSERT**: it completes, the resulting history row appears, and the merged output lands at the wallet's
  own address.
- **ASSERT**: no refusal mentioning "could not be found on the chain" or "could not be verified" appears
  for coins this wallet visibly holds. If a coin IS skipped, the message must say the source transaction
  carries a number this wallet cannot represent exactly (`VERIFY_UNREPRESENTABLE`), never that the coin is
  missing and never that it is tampered.

## Record

Write the result of each numbered step, the wallet version from the extensions card, the chain tip at the
time, and the sha256 of `cairn-wallet-store.zip` as uploaded. A FAIL on any step blocks the upload.

## After the click-through

Only then: tag and push (which runs `release.yml`: vendor-fresh-full, test, package, attestation, GitHub
release), then upload `cairn-wallet-store.zip` to the Chrome Web Store manually per
`store/PUBLISH-RUNBOOK.md`. Rollback is forward-only, as 0.2.67.
