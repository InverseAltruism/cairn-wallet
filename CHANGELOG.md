# Changelog

## 0.3.1

- The CSD row shows the CSD coin's logo (the owner's file, vendored from cairn-ui 0.4 as `csd-logo.jpg`) in its
  circle with the avatar's hairline; it showed the Cairn mark. The CAIRN row shows the Cairn mark, only for the token
  the wallet pins by deploy id: the row passes the deploy id the token list serves for its ticker, and a CAIRN from
  another deploy, a CAIRN whose token record did not load and every other token keep the neutral glyph. No tile shows
  part of a ticker.
- The extension icon is the Cairn mark on an ink tile (16, 32, 48 and 128 px; the 128 px icon keeps Chrome's 16 px
  margin), drawn from the vendored mark by `scripts/gen-icons.mjs`, which gives the same bytes for the same input. The
  green tile with three bars and its unshipped masters (`icon.png`, `logo-white.png`) are gone. The store listing's
  icon is `public/icons/icon-128.png` and is uploaded with this release.
- The Cairn mark has one home, cairn-ui's `mark.svg` (vendored at 786c5fb, the merge of cairn-ui #4): the setup, lock
  and approval pages draw it from `ui/mark.svg`, and `scripts/build-icons.mjs` no longer keeps a traced copy in the
  sprite.
- Under the balance, its value in USD at the CSD/USD price the Cairn API serves (`/api/market/csd`), with the venue
  named: "≈ $79.14 · USD via SafeTrade", plus "stale, N min ago" or "sources differ" when the API says so. Display
  only; no send, fee or check reads it. Without a price (the route answers 503 while the site's market data is off, a
  failed read, a body with no positive price from a named venue) and while the amount shown is an earlier read after a
  failed refresh, the line is not shown.
- The send sheet has Max at the end of the amount field. It fills in the most one send accepts now after the 0.01 CSD
  fee: the send engine's own coin selection and chain verification run with a target of the 512 largest coins still
  eligible, so ghost, horizon and unrepresentable coins are left out as a send leaves them out, and both fee caps
  apply. When the 512-coin limit or unprovable coins hold it below the balance, a line under the estimate says so. The
  review and the confirm then run as for a typed amount; if coins change before Confirm, the send refuses as before.
  Max computes nothing for a token send (the design has none there).
- Coin selection is csd-tx's `selectInputs` from the vendored bundle; the wallet's own copy in `src/core/node.ts` is
  removed. A coin the node lists twice, once with a `0x` txid and once without (or with `0X`), is now one coin: a
  send no longer takes it twice and refuses with `VERIFY_TAMPER`, a send that an honest coin can cover goes through,
  consolidate and its preview count it once, and a coin skipped as unprovable stays skipped when the node changes
  its spelling. `spendableCoins` asks `selectInputs` about each coin, so the two apply one rule. The node serves
  `0x` lower-case txids, so a normal send's selection is unchanged.
- The csd-sdk bundle moves to npm window 5 (cairnx-core 0.2.3, csd-client 0.1.20, csd-light 0.1.26) and adds csd-tx
  0.1.23. With cairnx-core 0.2.3 an offer fill refuses, before signing, an offer anchored below block 29,860 and a
  name offer anchored below 29,960; the resolver ignores both, so a fill would pay and deliver nothing.

## 0.3.0

- The popup and the approval window are redesigned: the popup is 360 by 600, set in Geist, light and dark with a
  choice in Settings › Appearance (System, Light, Dark; the approval window follows the same choice, also when it
  changes while the window is open), and forms open as sheets that Escape closes. The node RPC and block explorer
  pickers moved to Settings › Network (they were top right, also before unlocking). Accounts, post, seal, recovery
  phrase and reveal key are under More. The approval and review buttons changed sides: Reject, Cancel and Back on
  the left, Approve and Confirm on the right, equal width.
- An account shows the shared cairn-ui avatar (a soft blue to peach conic gradient) of its primary name, the one its
  names page draws, and of its address while the name is not read or when it has none, without a letter; the account
  switcher shows each account's avatar at 16 px (was a 10 px dot); the old dark two-colour gradient, often olive green,
  is gone. One account draws one identity on every surface: the switcher draws the account the header shows with the
  header's avatar, and another account with its primary name's avatar once the popup has read it, else its address's.
  A name-less account no longer shows the cairn mark in the header; the mark stays the product's logo (setup, the
  lock screen, the approval window's tile).
- The approval window shows each request as a title and label and value rows, with every check as a row whose tint
  and icon give its weight (red where the text was red, amber where it was neutral). The cost rows and the balance
  after sit above the buttons on every request type, the requesting site is named in full at the top, and the
  700 ms pause before the buttons arm is shown as a bar that fills. Its copy has no em dashes, is in sentence case
  and marks emphasis in bold instead of capitals; every warning and refusal keeps its meaning.
- In the approval window a website's renewal or name record verdict sits right under the cost rows and the
  warnings. A look-alike of an address used before (address poisoning) is a red row and a first send to an address an
  amber row, in the popup's send review and in the approval window alike (0.2.99 showed the first send red too). Up
  to two flagged recipients are named, each on its own line; past two, the red row says how many recipients are
  look-alikes and the amber row how many are new. Whenever a request has more than one recipient row, each flagged
  row is marked with its tier's tint and a bar at its start (and the words "Look-alike" or "New" for assistive
  technology), which add no height, so the warnings stay a few lines above the buttons however many recipients a
  request carries and a flagged row is found by its whole address, not only by the head and tail the box names.
- The approval window lists every recipient of a request, each whole and in groups of four with its amount, and keeps
  the count and the total in the amount line. It showed the first 12 and summarised the rest in a red line. A CSD
  fill shows what it buys before its recipients. test/approve-layout-chrome.test.mjs pins the fold at 13, 20 and 500
  recipients (500 outputs is the most the wallet signs on a send) and for a 100-output fill.
- The approval window opens at 460 by 716 (was 380 by 620), and everything that decides a signature sits above Reject
  and Approve without scrolling, for every request type and for the long cases test/approve-layout-chrome.test.mjs
  builds (an unconfirmed reservation's confirm step, an underpaid name fee with its verdict, a token fill with a
  ticker warning, three recipients with a look-alike, a large fee and a short balance, a queue): the site and the
  signer, the amount, the cost rows, every warning and refusal, every recipient with its amount, what a fill's
  listing gives and its expiry, the token debit, a reveal's secret and a name action's verdict. Each request shows
  that first and the explanations, ids, hashes and raw fields after it; a recipient and a short amount share one
  line; rows, check rows and boxes are denser. Before, a CSD fill's recipients, a send's third first-time warning and
  a finalize's verdict sat below the buttons. The window is wider rather than only taller because width is what small
  screens can spare. A site can still make a request longer than the window (more recipients, a very long origin);
  the cost, the recipient warnings and a name action's verdict then stay on top, and the rest scrolls.
- A line under the buttons says what the window is doing: "Arming: both buttons wait 700 ms" while the latch holds
  both buttons, then "2 more recipients below: scroll to see them" (or "1 more recipient below: scroll to see it")
  while a recipient row is not fully shown and "More below: scroll to read the whole request" while anything else is,
  and otherwise "Ready." ("Ready. Read the warning above before you sign." on a
  reservation's confirm step), "Approve waits for the token amount." while a token quote loads, or "Approve is off: see
  the warning above." when a refusal holds Approve down. Its line is always reserved, so it never moves the buttons,
  never covers the request and never holds back Approve. A request painted into the open window enters as in the
  approved design: it rises 8 px and fades in over 320 ms, and fades in only with reduced motion.
- The approval window has two densities. A request that fits the window whole in the approved design's sizes (a 36 px
  amount, 40 px rows of 13.5 px text, check rows with 10 and 12 px padding) paints in them; a request that does not
  keeps the dense sizes above, which hold the fold for every request shape. The window measures the request before
  its first frame, with every part that fills in later (the recipient warnings, the balance note, a name action's
  verdict, a fill's listing, the token quote, a reveal's secret) counted at its tallest, and keeps that density for
  the request, so nothing jumps on open or moves after the buttons arm. The header and the buttons keep one geometry
  in both densities.
- Each request in the approval window opens at its top, also when the queue moves on from a request the user had
  scrolled to its end, and on a reservation's confirm step: before, the next request could open scrolled down with
  its amount, fee and warnings above the view (test/approve-layout-chrome.test.mjs, "queue advance").
- A fill no longer reads "Pay and attest in one atomic transaction.": a CSD-paid fill says "One transaction pays the
  recipients above and records the fill. CairnX then delivers what you buy; if it refuses the fill, the payment is
  not returned.", and a token-priced fill says "One transaction records the fill." The store listing's two mentions
  of "trustless" name verification lose the word. test/wallet-claims.test.mjs keeps "atomic", "trustless",
  "guaranteed" and "risk-free" out of everything the wallet shows.
- In the approval window the check rows drop their leading ⚠, as in the popup (the row's icon and tint carry it),
  and so do the balance note in the popup's send review and the second-source note after a sent fill; the inline
  "⚠ unusually large fee" and "⚠ unusually long claim window" marks inside a value stay. Two texts follow the new
  order: a finalize "pays the fee shown above" (was "below"), and on a reserved listing "The offer id below is your
  reservation of this listing." (was "above"). Nothing else in the wording changed.
- The wallet's own Renew and Set as primary read the name again from the name service right before they sign, and
  refuse when it is not registered, when it is owned by another address (set primary), when it is a pending
  reservation, or when it has lapsed. A review left open while the name changed could otherwise pay a fee the
  resolver ignores. When the name service does not answer, they still sign, as before. A website's set primary
  (nset) is now warned about on a pending or lapsed name as a renewal already was, since the resolver ignores both.
  The lapsed text gives the resolver's reason: "This name has lapsed: its lease and grace period are over, and a
  lapsed name is claimed again, not renewed, so the renewal fee would be burned." (it said a renewal is honored
  within its grace period, but the name service marks a name lapsed only after it). A refusal for a name the
  service does not know adds "If it was registered in the last few minutes, the name service may still be catching
  up: try again later."
- Addresses a person compares show in groups of four: the account address under More, the accounts list, the send
  and token reviews and Receive in the popup, and the signer and the recipient, name record, taker and paid-to rows
  in the approval window. Copy address, and selecting the address, still take the bare 42 characters. A value that
  is not a whole address is shown as it is.
- The popup's messages and labels are in sentence case and end with a period; the message after a name changed
  between review and Confirm reads "changed where it points. Nothing was sent: review it again." (it had an em
  dash); the review warnings, the name check and its badges drop the ⚠, ✓ and △ marks, which the row's icon and
  tint now carry; the sealed claims list says Sealed and Revealed instead of two emoji. No amount, recipient,
  warning or refusal changed its meaning.
- The send sheet shows the network fee and the balance after it while the amount is typed (from the fee and the
  balance already read; nothing is read for it), and the amount field carries its unit, CSD. Its review step is
  titled "Review send" (the token send's too), its button says "Confirm send" (was "Confirm & send"), the fee row is
  "Network fee" (was "Fee"), and the "Amount" caption over the amount is gone.
- After a confirmed send the sheet closes, the sent toast shows at the bottom of the popup ("Sent 1.5 CSD", and under
  it "Transaction 0x1234abcd56… is waiting for inclusion in a block."; a token send adds "The token balance updates
  once it is mined."), and the balance counts down in the view once the sheet has cleared it. A refused or ambiguous send keeps the sheet, the draft and its copy as before. The send handlers read
  only the call's own outcome: a failure in the success path's display can no longer be reported as a submit
  outcome.
- Fixed (present in 0.2.99): a popup Confirm signs the frozen review, once, and only while that review stands. A token
  Confirm read the token and its decimals from the open sheet after the confirm-time name re-check, so closing the
  review during that re-check and opening another token's send could sign the other token at the reviewed base-unit
  amount; both sends kept Confirm armed while the submit was in flight, so two clicks sent twice; and Back during the
  re-check still sent. Now the review carries every field the call signs (the token and its decimals too), Confirm is
  disarmed on the first click before anything is awaited, and a review dropped or replaced while Confirm waited sends
  nothing and says "The review was closed before it was signed. Nothing was sent." A name that re-points between
  review and Confirm now also takes the review down (the draft stays), as every other failure does. The name action
  already consumed its review on the first click. Also present in 0.2.99 and fixed: a token Review left while it
  waited on the name lookup (another token's send opened) could bring up a review card for the other token, parsed
  with the first token's decimals, whose Confirm signed it; and Back, Review and Confirm while a send was in flight
  started a second send. A Review now primes nothing once the person has left it, and while a send is in flight no
  review arms Confirm. Only the latest Confirm writes an outcome, so a Confirm overtaken during its re-check cannot
  cover a later send's "Sent" or "Sending…", or a Post's, a Seal's or a name action's outcome. Post and Seal sign and pay
  a fee, and two clicks on them signed twice; each is now held until its outcome lands, and so is a sealed claim's
  Reveal (an off-chain publication of the sealed text, no fee). test/popup-confirm-snapshot-dom.test.mjs pins every
  case.
- An account label is stored as at most 40 characters (new, renamed and imported accounts; the popup's label fields
  take 40), and the approval window's "Signing as" line shows the label on one line with an ellipsis and the whole
  label as its title, so a long label stored before the cap cannot push the window into scrolling.
- A failed balance read no longer writes "unavailable" in the 40 px amount: with no earlier read, "Balance
  unavailable. Refresh to try again." takes the amount's place at the caption size; over an earlier read, that amount
  stays, dimmed, with "Last balance read; the refresh failed." under it. The refresh button is
  the retry; the CSD row reads "Unavailable" or the dimmed amount.
- Links to the explorer and the site end in the external-link icon instead of an arrow character ("View address",
  each Activity row's transaction, a revealed claim's transaction, Terms of Use, Privacy). Times in Activity and in
  the sealed claims read one way on every machine, in the block explorer's 24-hour UTC format without the seconds:
  "24 Oct 2026, 15:30 UTC" (was the browser's locale, such as "Oct 24, 05:30 PM").
- The Accounts sheet no longer repeats Rename and Remove on every row: a row opens to its own actions, as a name row
  opens its detail. The active account carries an "Active" mark (was a leading dot); the remove step asks "Remove
  this account?" with Yes and No (was "Remove?" with Yes and no), and an imported key's password step has Remove and
  Cancel (was Remove and no). The imported key's warning, its password and the refusal without it are unchanged.
- Internal: the popup script is split into one module per view or concern (`src/popup/popup-*.ts`, the largest
  183 lines, from one file of 1,532); its code is line for line the same apart from five lines that now write
  another module's state through a setter, and the popup shows the same pixels before and after the split in every
  view of the screenshot run.
- The Chrome Web Store images are rendered from the real pages in the new design (`store/gen-assets.mjs`).

- Internal: the token-priced fill's check that the served want ticker and amount equal the offer's on-chain record
  is the vendored `bindOfferTerms` want leg (cairnx-core 0.2.2), and the wallet's own copy is deleted; the reviewed
  quote is bound to the proven terms' want. The two refusals merge into one text: "refusing to sign: what you would
  receive or what you would pay does not match the offer's on-chain record (a lying resolver may be misrepresenting
  the trade)" (was "the offer's asset (give) or want-type does not match its on-chain record (a lying resolver may
  be misrepresenting what you receive)" and "the token or amount you would pay does not match the offer's on-chain
  record (a lying resolver may be understating your cost)").

- A fill now refuses an offer whose on-chain record is not one the marketplace accepts: an offer Propose in a
  settlement domain other than `cairnx:v1`, an offer that pays the protocol treasury, or a record that breaks a rule
  the resolver applies when it creates an offer (cairnx-core's `provenOfferRefusal`, run on the merkle-proven offer
  in every fill lane). The resolver ignores a fill of such an offer, so the payment would be lost; before this, an
  offer-id fill of one signed whenever the resolver served it as open. The refusal is `FILL_UNSAFE`: "refusing to
  sign: this offer's on-chain record is not an offer the marketplace accepts (<reason>), so the chain would take
  your payment and deliver nothing".

- A reservation (fclaim) fill no longer counts the buyer's reservations mined after the one being filled against
  the three-reservation cap. The wallet counted every other live reservation of the buyer, so a fourth reservation
  made each earlier granted one unfillable for the rest of its hold (the fill refused with "you held the max active
  claims when this fclaim was granted"), although the chain counts holds at the grant and would have accepted the
  fill. The count is now cairnx-core's `countOtherHoldsAtGrant`: reservations before the one being filled, in block
  and position order, one per offer. An earlier reservation the chain denied still counts, which can still refuse a
  fill the chain would accept. Grants below block 60,044 are refused rather than counted (no such reservation is
  fillable at today's height).

- Internal: the block bind and the author bind come from the vendored csd-sdk packages. `bindBlock` in
  `src/core/spvbind.ts` calls csd-light's `bindBlockBody` on the `/block` response text (the SPV source now reads
  the body as text with the same client, timeout and size cap), and `bindSigner` calls csd-crypto's `authorOf`.
  Verdicts are unchanged for every input class; the refusal texts that now come from csd-light are "block N
  repeats a txid (a malleated body)" (was "block N has a duplicate txid (malleated read path, CVE-2012-2459)"),
  "block N: tx P does not decode (...)", "block N: the body is not JSON (...)" and "block N: the node returned no
  block" (each after "couldn't verify on-chain (fail-closed): " on a name check).

- Internal: the wallet's own JSON reviver for node bodies (`spvJsonReviver` in `src/core/node.ts`) is deleted; the
  SPV client now uses csd-client's default `parseJsonExact` (the same rule: an integer literal outside the safe JS
  range becomes an exact bigint, a float literal stays a number). A block body or prevout source tx carrying a
  Propose expiry above 2^53 still proves (test/spv-poison-e2e.test.mjs drives the prevout read).

- Internal: the vendored SPV bundle is built from the published csd-sdk packages, pinned exactly as dev dependencies
  (cairnx-core 0.2.2, csd-light 0.1.25, csd-client 0.1.19, csd-crypto 0.1.20, csd-codec 0.1.18, npm window 4 of
  2026-10-23), instead of a local csd-sdk checkout, and `src/vendor/cairnx-spv.d.ts` is generated from the same
  export list instead of kept by hand. `npm run verify:vendor` rebuilds both files from the installed packages and
  requires byte identity on every run, so the separate CI job that checked out csd-sdk is gone. What the new
  versions change for a fill: a token-priced offer's served want ticker and amount are bound to its on-chain
  record by the shared term check, and the reservation-fill verifier refuses when an event it enumerated cannot be
  proven.

- A fill of an offer by its offer id (a taker-bound CSD offer or a token-priced offer) now refuses when the offer, by
  its own on-chain record, expires too soon for the fill to be mined (its last live block is less than 4 blocks
  past the chain tip, the margin the reservation lane already uses): "refusing to sign: this offer expires at block
  N and the chain is at M, so the fill cannot be mined in time; it would sit unconfirmed and be dropped. Ask the
  seller to relist." (`FILL_UNSAFE`). The node refuses a fill after its offer's expiry, so no payment moves; before
  this the wallet signed such a fill and it sat as a pending row until dropped. With no readable chain tip the
  check is skipped and the fill proceeds, since the worst outcome is a strand.
  The fill approval card (CSD and token) now shows when the listed offer expires, counted from the chain tip: "offer
  expires at block N, K blocks after the current tip (~X)"; "(too close to be mined in time: the wallet will refuse
  this fill)" when the wallet will refuse it; "offer expires at block N, the next block (the wallet will refuse this
  fill)" one block before; "offer expired at block N (the wallet will refuse this fill)" once the tip has reached
  it. The time is in minutes under an hour (2 minutes a block).

- A name whose record was set by a market sale or by a re-claim after its lease lapsed now gives the reason
  "NAME.csd changed hands through a market sale, or was re-claimed after its lease lapsed, and the wallet can't
  confirm the new owner from the name's own records: confirm the address out-of-band before sending". The old
  text named only open-lane and token sales, which was wrong for a sale bound to one buyer and for a re-claim.

- Internal: the SPV checks that name verification (`namespv.ts`) and the reservation-fill boundary (`fillspv.ts`)
  each carried a copy of (the full-block merkle bind with the duplicate-txid refusal, signer recovery, the coinbase
  test and the event mapping) now live once in `src/core/spvbind.ts`. Every refusal keeps its text, and the
  signatures the test suite produces are byte-identical before and after.
- Exporting the private key from a damaged vault, one whose account list has no account at its active slot, now
  refuses with "corrupt vault (no account at its active slot)" instead of an internal error about reading `priv`.
- Internal: the wallet engine `src/core/wallet.ts` is split by responsibility: the fill checks before signing
  (`fillpreflight.ts`, now one function per lane), name verification (`names.ts`), display-only CairnX reads
  (`cairnxview.ts`), transaction history (`history.ts`), sealed claims (`claims.ts`) and the endpoint defaults
  (`endpoints.ts`). TypeScript now checks every index read (`noUncheckedIndexedAccess`) and `src/core` has no
  `as any`. Nothing the wallet signs changed: with seeded randomness, the 786 signatures the test suite produces
  are byte-identical before and after every commit of the split.
- A background-worker restart (Chrome stops an idle worker after about 30 seconds) no longer re-runs every consensus
  check on the stored block headers when the same browser session already checked them: the wallet keeps the hash of
  the newest checked header in session storage (memory only, cleared when the browser closes) and confirms that the
  stored headers hash-chain from the release's newest built-in hash to it, and that none is dated more than 2 hours
  ahead of the computer's clock. With a release table about 90 days old (64,359 stored headers), the first name
  verification after a restart took 2.3 to 2.7 s instead of 8.7 to 11.6 s at a 4x CPU slowdown. The first start
  after the browser opens still runs every check, and a stored header that was changed fails the hash chain and gets
  the full checks.
- A reservation fill signed while the second source (clarvis) had not yet answered, or could not answer, the
  wallet's question about your reservation now says so under "sent" in the approval window: "Second source not
  consulted: the second source (clarvis) had not answered yet when this fill was signed, so its check of your
  reservation did not run. Check on the explorer that the fill delivered." (or "did not give a usable answer"),
  and the window stays open until you close it. Nothing is refused and nothing waits longer; when clarvis answers
  in time, nothing changes.
- Changing the node RPC or the Cairn API in settings now moves name verification and reservation-fill checks
  started after the change to the new endpoint. Before, they kept reading block bodies and headers from the old
  one until the extension's background worker restarted, and a block-mismatch refusal named the old RPC (since
  0.2.74). A check already running when the setting changes finishes on the endpoints it started with, and its
  name result is not kept for the quick re-check at confirm time; the change also empties that cache.
- `OFFER_SOURCE_CONFLICT` and `RESERVATION_DENIED` call clarvis "the second source (clarvis)" instead of "the
  independent second resolver": clarvis has the same operator as the default resolver, as SECURITY.md says. The
  codes are unchanged.
- The privacy policy no longer calls clarvis "an independent second copy" of the chain data: it is a second copy
  on its own server, run by the same operator as cairn-substrate.com. Code comments that called the two default
  name sources independent say the same.
- `RPC_BLOCK_MISMATCH` names the RPC and the header source and no longer points only at your own node: a header
  source that serves a false header with valid proof of work gives the same mismatch. The message reads "refusing
  to sign: block N from <RPC> does not match the block header the wallet verified from <API>. One of them is
  wrong: the RPC may follow another chain, or the header source may have served a false header. If that RPC is
  your own node and it follows the main chain, the header source may be at fault; otherwise try again in a
  moment." The code is unchanged.
- Tests: the approval window sends the "Sign anyway" acknowledgement only from the warning screen, also when the
  "unknown" result arrives while an older screen of the same request is still shown; the header store migration
  keeps the old snapshot when the stored head does not read back as written.

## 0.2.99 (2026-10-18)

- The bundled csd-sdk code is rebuilt from csd-sdk `e25c020` (cairnx-core 0.2.0, csd-codec 0.1.18, csd-light
  0.1.23, csd-client 0.1.18, csd-crypto 0.1.18). Name verification and fill checks give the same results on
  honest data (signing does not use this code): the wallet already passed both offer-content checks (give and
  want type) explicitly, which cairnx-core 0.2.0 turns on by default, and the other changes refuse malformed input
  only (a transaction served with an unpaired surrogate in a record's text, a merkle proof node that is not 32
  bytes, record data that is not plain JSON).
- The extension is built with esbuild 0.28.2 (was 0.25.12). The built code differs only in field declarations
  for constructor parameters, which behave the same; the bundled csd-sdk code is byte-identical.
- Reservation fills: beside the offer read, the wallet asks the second source (clarvis) for its verdict on the
  buyer's own reservation (`/cairnx/record/{fclaimTxid}`), started with the SPV scan and never waited for past it.
  When clarvis reports that it replayed the reservation and did not apply it, the fill refuses with the new code
  `RESERVATION_DENIED` and clarvis's reason. This covers a header source that hides a competing reservation placed
  just before the buyer's, whose hold ends before the buyer's and so passes the offer check. An applied
  reservation, a 404 below the reservation's height plus 12, a timeout, an error or an unusable answer proceed as before,
  with no added wait.
- When clarvis has read the chain at least 12 blocks past the buyer's proven reservation and has no record of it,
  the wallet signs nothing yet: the approval window shows the request again with a warning ("The second source has
  no record of your reservation. ...") and two buttons, "Sign anyway" and "Cancel", with Cancel as the filled
  (primary) button. "Sign anyway" re-runs every
  check and signs once; a reservation clarvis now reports denied still refuses. "Cancel" rejects the request. The
  page is not told until the user chooses. A granted reservation signs on the first approval as before. New code
  `RESERVATION_UNCONFIRMED`, seen only by the approval window.
- SECURITY.md and the header-store design note correct the cost of the forged-header attack on reservation fills:
  the forged chain needs to start only just below the hidden reservation, so for a small fill it is a few honest
  blocks' worth of work and succeeds on every attempt once the front door is controlled (the earlier text said it
  had to run to the chain's real height, about 160 blocks' worth). They describe the reservation verdict above, its
  residual (clarvis down or slow during the attack, or both hosts compromised), and why the header-hash comparison
  first proposed was not built (it misses every fill at claim depth 3 to 6). Correction made on 2026-10-19, after the
  v0.2.99 tag (the release is unchanged): SECURITY.md and the design note as released list one more residual, a
  front door that withholds or delays the buyer's reservation (it relays the buyer's submits) while clarvis has not
  yet replayed it, and say that against a header-source attacker the "no record of your reservation" warning is
  advisory, because that attacker serves the headers that prove the reservation's height.
- The two `RATE_LIMITED` messages for a full approval queue use a semicolon instead of a dash: "too many pending
  requests from this site; approve or reject the queued ones first" and "too many pending wallet requests; approve
  or reject the queued ones first". The code is unchanged.
- `OFFER_SOURCE_CONFLICT` for a reservation held by someone else now reads "another reservation holds this offer
  through block N" (the last block it holds) instead of "a later reservation now holds this offer": the check also refuses a holder with the
  same expiry epoch as yours, which came first, not later.
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
  resend on its own. Correction made on 2026-10-19, after the v0.2.99 tag (the release is unchanged): the "spent by
  another transaction" marker is not always available. It needs the RPC to report the transaction definitely not
  mined and not pending; the Cairn proxy (`/api/rpc/tx/:id/status`) reports that only when both of its node
  backends answered their mempool reads in full, so with a backend down the row keeps the 10-block notice instead. A merge reads "merge sent (txid); confirming" instead of claiming it completed, and a merge
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

## Notes moved from AGENTS.md (2026-10-22)

These describe their own dates or versions, not the current tree.

- State on 2026-10-11 (the "State snapshot" section): `package.json` read 0.2.73, tagged `v0.2.73` at 6275446;
  0.2.73 was uploaded to the Chrome Web Store that day with the store review pending; the vendored bundle pinned
  csd-sdk 0.1.42.
- Input verification history: 0.2.53 introduced the per-coin fail-closed classification (a ghost coin is skipped,
  `GHOST_INPUTS_SKIPPED`, with an honest balance warning) after the ghost-UTXO incident (h47114), where a node
  reorg-undo bug left phantom coins and the old any-null-kills-all fold let one ghost block every spend. The
  "horizon" verdict consumes the node's 503 with body code `SCAN_HORIZON` (introduced in node v0.1.6). 0.2.66 added
  the "unrepresentable" verdict, so one dust coin from a stranger can no longer block `consolidate()`.
- Fill lanes: 0.2.60 and 0.2.61 made the fclaim lane and the offer-id lane merkle-prove the offer and bind the
  payment, rebate, fee and `min` legs to the on-chain author. 0.2.71 added a clarvis comparison of the fill's value
  fields keyed by the fclaim txid; 0.2.72 removed it, because every field it compared is merkle-bound and it could
  not see withholding.
- The on-device name registration builders (commit, reveal, finalize) were removed on 2026-07-06; the /names site
  drives registration through dApp propose.
- 0.2.55 fixed a timeout-inversion class: every outer timeout now sits above its server-side worst case.
- Large-send incident (2026-07): a 10,540 CSD send (about 211 coinbase inputs) failed with the misleading "may
  already be in flight" copy, and nothing was broadcast. The first diagnosis (the verify fan-out tripping the front
  door's rate limit) was wrong. The cause was the front-door proxy's global 64 KB JSON body limit, which answered 400
  to /tx/submit at about 127 inputs or more (about 530 bytes per input) before the tx reached the node. 0.2.55
  shipped the wallet-side fixes: structured errors through `sendRefused` with the "may be in flight" copy kept for
  genuine `SUBMIT_MAYBE_INFLIGHT` and catch paths, `SUBMIT_MAYBE_INFLIGHT` distinguished from `SUBMIT_REJECTED`,
  bounded verify concurrency, the timeouts, `TOO_MANY_INPUTS` distinguished from `INSUFFICIENT`, a CSD fee pre-check
  for token sends, and consolidate with its preview. The front door got a larger body cap on that route and a raised
  rate limit. The fee guard was a red herring (the send fee is a fixed 0.01 CSD).
- MV3 service-worker idle kills looked like premature locking; the cure was keeping the key in
  `chrome.storage.session`. The approval window runs in a tab, so the sender gate keys on the extension-origin
  `sender.url`, not on a missing tab (a regression in v0.2.17).
- Version drift shipped once (v0.2.21); since then the version is written only in `package.json` and stamped at
  build time. A stale vendored bundle shipped once; since then the PROVENANCE and byte-diff gates run. clarvis was
  unreachable on arrival once because its host was missing from the CSP; since then the source-host tripwire runs.
- The /api/headers 429 spiral (2026-06-22) blocked buys; the cure was bounded backoff. The rule that fail-closed
  without an availability valve is a UX regression comes from it.
- `fillOffer` once trusted a caller-supplied verified flag and could underpay a maker on a partial fill; the exact
  `bigint` need-map preflight and the fail-closed registered-versus-unregistered handling in the union path closed it.
- Google Safe Browsing once flagged the sites for serving the zip themselves; wallet distribution is the Chrome Web
  Store and GitHub releases only.

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

