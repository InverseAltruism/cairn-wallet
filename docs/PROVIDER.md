# The `window.cairn` provider: contract for applications

For developers of a site that asks Cairn Wallet to connect or sign. Every statement here describes the code in this
repository; the files that hold each number are listed at the end. Where this file and the code disagree, the code is
what runs and this file has a bug. Error codes are specified in [`WALLET-ERROR-CODES.md`](../WALLET-ERROR-CODES.md),
which this file does not repeat.

## Who gets the provider

- The content script runs on pages whose URL matches `https://*/*`, `http://localhost/*` or `http://127.0.0.1/*`
  (`public/manifest.json`), at `document_start`. The manifest sets no `all_frames`, so it runs in the top frame only:
  an iframe gets no provider. Plain http on any other host gets none.
- It injects `inpage.js`, which defines `window.cairn`. A call travels as a `window.postMessage` to the page's own
  origin, then to the wallet. The wallet identifies the site by the origin the browser reports for the sender, not by
  anything the page sends.
- Messages on the page side are not authenticated: any script running on the page can call the provider and read its
  replies. The boundary is the wallet's approval window, which shows the requesting origin.

## Finding the provider

- `window.cairn` is frozen, not writable and not configurable. It carries `isCairn: true` and `version` (the wallet's
  release version).
- `cairn#initialized`: a plain `Event` dispatched on `window` once, after `window.cairn` is set. A script that runs
  before injection can wait for it.
- `csd:announceProvider`: a `CustomEvent` on `window`, dispatched once at injection and again each time the page
  dispatches `csd:requestProvider` on `window`. Its `detail` is frozen:
  `{ info: { uuid, name: "Cairn Wallet", icon, rdns: "com.cairn-substrate.wallet" }, provider }`. `icon` is an SVG
  data URI, `provider` is `window.cairn`, and `uuid` is a random UUID made once per page load: every announcement of
  one load carries the same one, and the next load has a new one. Key a wallet by `rdns`, not by `uuid`.
- The pattern follows EIP-6963 under the `csd:` names. The provider is not an EIP-1193 provider: there is no
  `request()` method and no `eip6963:` event.

```js
const wallets = new Map();
window.addEventListener("csd:announceProvider", (e) => wallets.set(e.detail.info.rdns, e.detail.provider));
window.dispatchEvent(new Event("csd:requestProvider"));
const cairn = wallets.get("com.cairn-substrate.wallet") ?? window.cairn;
```

## Calls and the envelope

Every method below except `getCapabilities`, `on` and `removeListener` returns a promise that resolves to an envelope:
`{ ok: true, result }` or `{ ok: false, error, code }`. `code` is the contract and `error` is text for people.

The transaction methods (`propose`, `attest`, `send`, `fillOffer`, `sealClaim`) put a `SubmitResult`
`{ ok, txid?, error?, sighashMatch, code? }` in `result`. `{ ok: true, result: { ok: false, code } }` means the user
approved and then the wallet refused before signing or the submit did not succeed. Check both levels.
`SUBMIT_MAYBE_INFLIGHT` and `SUBMIT_DUPLICATE` carry the `txid` of a transaction that may be on the network.

Amounts and fees are integer base units of CSD (100,000,000 to one CSD); `fee` is a number. Every id, txid, hash and
address is a string; a `score` or `confidence` is a number (a digit string reads the same) and never an object or a
list. A request with an object or a list in one of those fields is answered `BAD_REQUEST` before any window opens. The
wallet picks the inputs from coins it verified against the chain and returns change to its own address; a site can
name outputs, never inputs or a change address.

## Methods

| Method | Parameters | `result` | Asks the user |
|---|---|---|---|
| `connect()`, `getAddress()` | none | `{ addr }` | yes, unless the site is connected, the wallet is unlocked and the connected account is the active one |
| `requestPermissions()` | none | `[{ invoker, accounts: [addr], grantedAt }]` | always |
| `getPermissions()` | none | that array for this site; `[]` when not connected and while locked | no |
| `revokePermissions()` | none | `{ revoked }` (boolean): ends this site's connection | no |
| `signInWithCsd(p)` | below | `{ account, pub33, sig64, message, chainId }` | always |
| `signIn()` | none | the legacy session; first-party only | always |
| `propose(p)` | `{ domain, payloadHash, uri, expiresEpoch, fee?, outputs? }` | SubmitResult | always |
| `attest(p)` | `{ proposalId, score, confidence, fee? }` | SubmitResult | always |
| `send(p)` | `{ to, amount, fee? }` or `{ outputs, fee? }` | SubmitResult | always |
| `fillOffer(p)` | `{ proposalId, outputs, score?, confidence?, fee? }` | SubmitResult | always |
| `sealClaim(p)` | `{ claim, domain?, fee? }` | SubmitResult | always |
| `revealClaim(txid)` | the seal's txid | the Cairn API's answer to the content post | always |

- `propose`: `domain` is a string of at most 128 UTF-8 bytes and `uri` a string of at most 512 (the network's caps),
  neither with an unpaired surrogate; the wallet does not check what a domain means. `payloadHash` is `0x` and 64 hex
  digits, `expiresEpoch` a non-negative safe integer. `fee` is an integer number from 25,000,000 (0.25 CSD, the
  network's proposal minimum and the default) to 100 CSD. `outputs` is `[{ to, value }]`, at most 8, each `to` `0x`
  and 40 hex digits and not the zero address, each `value` a positive integer or a string of decimal digits. A
  proposal with any other parameter is answered `BAD_REQUEST` before any window opens, by the check the signer
  applies (a call that reaches the signer gets it with the nested code: `BAD_REQUEST`, `BAD_OUTPUTS`, `BAD_FEE`,
  `FEE_TOO_LOW`, `FEE_CAP` or `ZERO_ADDR_REFUSED`). Two rules stay after approval: the fee cap of 10% of the coins
  the wallet selects needs those coins (nested `FEE_CAP`), and the node refuses at submit an empty domain or uri and
  an all-zero payload hash (nested `SUBMIT_REJECTED`, nothing spent), rules csd-sdk does not carry and the wallet
  does not repeat.
- `attest`: `proposalId` is `0x` and 64 hex digits; `score` and `confidence` are signed as u32 (`>>> 0`); `fee`
  defaults to 5,000,000 (0.05 CSD) and is an integer number above zero and at most 100 CSD. An attest with any other
  proposalId or fee is answered `BAD_REQUEST` before any window opens, by the checks the signer applies (nested at the
  signer: `BAD_REQUEST`, `BAD_FEE`, `FEE_TOO_LOW` or `FEE_CAP`). An attest never carries outputs. At confidence
  1,000,000 it is signed as a token-priced fill and runs the fill checks below.
- `send`: `to` is `0x` and 40 hex digits and not the zero address, and `amount` a positive safe integer (a number);
  or `outputs`, 1 to 500 objects `{ to, value }` with `to` and `value` as on a proposal. `fee` defaults to 1,000,000
  (0.01 CSD) and is an integer number above zero and at most 100 CSD. A send with any other parameter (a decimal
  string `amount` included) is answered `BAD_REQUEST` before any window opens, by the checks the signer applies (a
  call that reaches the signer gets the nested `BAD_OUTPUTS`, `BAD_FEE`, `FEE_TOO_LOW`, `FEE_CAP` or
  `ZERO_ADDR_REFUSED`). The 10% fee cap and the balance need the coins the wallet selects and are checked after
  approval.
- `fillOffer`: `proposalId` is the offer id or the reservation (fclaim) txid; `outputs` 0 to 100 objects, each `to`
  as on a proposal and each `value` a positive integer number; `fee` as on a send. A fill with any other target,
  outputs or fee is answered `BAD_REQUEST` before any window opens, by the checks the signer applies that read
  nothing; everything else the wallet checks about a fill needs the offer and the chain and runs after approval.
  `score` may be absent, `null` or 100; any other score is refused before signing.
  `confidence` defaults to 100; 1,000,000 marks a token-priced fill, which may carry no CSD output. `fee` defaults to
  5,000,000. The wallet checks the fill against the offer's proven record before signing
  (`docs/DESIGN-fill-lanes.md`); a CairnX that refuses the fill keeps the payment. While one fill request for a target
  is open, another for it is refused `FILL_IN_PROGRESS`. After a CSD-paid fill of a target was sent, another fill of
  it is refused after approval with the nested `FILL_ALREADY_SENT` while the first was sent less than 30 minutes ago
  (counted from its last send, so a lost submit's retry restarts the 30 minutes), not marked gone, and not yet seen
  applied (listed by the offer service on the offer-id lane, mined on the reservation lane). It is not for a program
  to retry: look the earlier fill up, and let the user ask again once it confirms. The exception is a retry after a
  submit whose answer was lost (`SUBMIT_MAYBE_INFLIGHT`): when it builds the same transaction (same coins, same txid) it is signed and
  sent again, and the answer is the submit's (a node that already holds it answers `SUBMIT_DUPLICATE`). On the reservation lane the outputs must pay exactly
  what the offer needs, per address; on the offer-id lane outputs beyond the need are signed (section 12 of
  `test/sign-display-parity.test.mjs`).
- `sealClaim`: `claim` is a non-empty string, `domain` a string of at most 128 UTF-8 bytes once trimmed, with no
  unpaired surrogate (default `csd:sealed`), `fee` as on a proposal (default 25,000,000). The wallet makes the salt and
  keeps it; the commit expires 720 epochs after the current one. Any other claim, domain or fee is answered
  `BAD_REQUEST` before any window opens.
- `revealClaim`: the txid of a seal this account made in this wallet, a string (an object or a list is answered
  `BAD_REQUEST` before any window opens). No transaction; refused `SEAL_NOT_MINED` until the commit is mined. A txid the active account holds no seal for opens the window like any reveal, from every
  site, and approving it answers `SEAL_UNKNOWN` (nested); nothing a site gets before the window depends on which seals
  the wallet holds.
- `signInWithCsd`: `nonce` (required, 8 or more ASCII letters and digits), `statement` (one line, at most 256
  characters), `uri` (default: the site's root; must be on the site), `domain` (must equal the site's),
  `expirationSecs` (default 600, held to 60 to 3,600), `notBeforeSecs` (positive), `requestId` (one line, at most 256
  characters), `resources` (at most 10 entries of one line and at most 256 characters each). A request the wallet
  would refuse is answered `BAD_REQUEST` before any window opens. The wallet builds the message from the origin the
  browser reports, signs it, and mints no session; the site's own server verifies it.
- `signIn()`: legacy, not advertised. It works only from the wallet's configured Cairn API origin (default
  `https://cairn-substrate.com`), or from a localhost page when that API is on localhost; elsewhere `FIRST_PARTY_ONLY`.
- `getCapabilities()` resolves directly, with no envelope: `{ version, siwc: "1", discovery: "csd", events:
  ["accountsChanged", "disconnect"], methods }`, where `methods` lists every method of the table except `signIn`.
- `on(event, handler)` adds a handler and `removeListener(event, handler)` removes the same one; both return nothing.

## Limits

- Outputs: at most 8 on a proposal, 500 on a send and 100 on a fill; more is answered `BAD_REQUEST` before the window
  (nested `BAD_OUTPUTS` at the signer). An output to the zero address is refused (`ZERO_ADDR_REFUSED`; from a page,
  `BAD_REQUEST` before the window). A transaction spends at most 512 inputs (`TOO_MANY_INPUTS`).
- Fees: above zero (`FEE_TOO_LOW`), at least 0.25 CSD on a proposal or a seal (`FEE_TOO_LOW`), at most 100 CSD, and
  at most the larger of 1 CSD and 10% of the verified inputs the wallet selects for that transaction (`FEE_CAP`). On a
  proposal, a seal, a send, a fill or an attest every fee rule but the last is answered `BAD_REQUEST` before the
  window. A cap
  refuses the request; the wallet does not lower the fee and retry. The approval window marks a fee above 5 CSD as
  unusually large.
- Queue: at most 5 pending requests per site and 32 in all; a request past either is refused `RATE_LIMITED` before it
  is queued. There is no limit over time.
- One approval window shows the requests in arrival order, the first one first ("Request 1 of N"). Approve and Reject
  take no click for 700 ms after a request is shown. Closing the window answers every queued request
  `APPROVAL_CLOSED`. A request that arrives while the wallet is locked waits behind an unlock form. A request the window
  fails to draw is shown as one the wallet could not show, with Approve off and Reject live after the same 700 ms, so
  it does not hold the requests behind it.

## Events

- `accountsChanged`: the payload is always `[]`; the wallet does not push an address. After it, call `connect()` again.
- `disconnect`: `{ reason }`, one of `"locked"` (the user locked the wallet), `"idle-lock"` (the auto-lock after 15
  minutes without activity in the wallet), `"disconnected"` (the user removed the site in Settings) and `"revoked"`
  (the site called `revokePermissions()`).
- Locking, the auto-lock and an account switch send `accountsChanged([])` to every connected site; the two locks also
  send `disconnect`, an account switch does not. Removing a site in Settings and `revokePermissions()` send both to
  that site only. A site that is not connected receives no lock or account-switch events.

## Consent

- Approving `connect`, `getAddress` or `requestPermissions` records the site's origin with the address shown. That lets
  the site read the address again without a prompt while that account is active and the wallet is unlocked; it grants
  nothing else. An opaque origin (`"null"`) is not recorded. The user sees and removes connected sites in Settings.
- The signing methods (`signInWithCsd`, `signIn`, `propose`, `attest`, `send`, `fillOffer`, `sealClaim`,
  `revealClaim`) open the approval window every time, whether or not the site is connected, and approving one records
  no connection; a request answered before the window (`BAD_REQUEST`, `FIRST_PARTY_ONLY`, `UNSUPPORTED_METHOD`,
  `FILL_IN_PROGRESS`, `RATE_LIMITED`) signs nothing. The window does not say
  whether the site is connected. A signature still shows the site the signing address: `signInWithCsd` returns it as
  `account`, and a transaction spends that account's coins on chain.
- The wallet records each origin the user approves a request from, with when, so the window can say when a site the
  user has approved nothing from asks (below); a connected site counts as approved. The list stays on the device,
  keeps the 500 origins approved last (an older one reads as new again) and never holds an opaque origin. It grants
  nothing, and removing the extension deletes it (as does the wallet's internal reset).
- There is no permission per method or per site and no allowance. The only origin rule is the legacy `signIn()`.
  Any site may propose any `cairnx:v1` record (a token transfer, an offer, a name transfer, a profile write) and gets
  the same approval window the wallet's own site gets (`test/sign-display-parity.test.mjs` sections 8 and 9).

## What the approval window shows

The header shows the requesting origin in full, an initial tile drawn from it, what the request asks for and the
account that signs. When the user has approved no request from the origin with this wallet and has not connected it,
the ask line reads "New site, which asks ..." (its tooltip: "You have not approved a request from this site with this
wallet before."). A rejected request or a closed window leaves it; once one request is approved, the next request from
the origin reads as before, so two requests queued from a new site both carry it until one is approved. A request
from an opaque origin never carries it. The line changes no button and adds no wait. A request that moves funds shows the network fee, the total and the balance after; recipients are
shown in full, and one the wallet has not paid before, or one that resembles an address it has seen, is flagged.

- Connect: "Connect", with what approving grants.
- Sign in: "Sign in to" the site's host, with the audience, nonce, expiry, URI, resources and request id; the statement
  is labelled as the site's text.
- Send: "Send CSD", the amount and every recipient with its amount. Approve stays off when the balance after is short.
- Fill: "Fill offer", the total, every recipient, what the listing gives as the offer service lists it, the offer's
  expiry, the offer id and that a refused fill keeps the payment. A token-priced fill shows a warning and the offer
  service's token quote, and Approve waits for the quote. Both kinds mark a listed token that is a well-known or
  Cairn-like ticker Cairn has not verified (or a CAIRN that is not Cairn's deploy) with a warning, and an amount of
  another unpinned token "(unverified token)", from the token record the window already reads.
- Attest: "Support / review" with the target, score and confidence; "Cancel your offer" or "Cancel your bid" for score
  0 when the node reports the signer as the target's proposer; "Reserve an open offer" for score 50, confidence 0.
- Seal and reveal: "Seal a claim" with the domain and claim; "Reveal a sealed claim" with the seal txid and the domain
  and claim from the wallet's own records. A seal keeps the origin that asked for it (the wallet's own for a seal made
  in its popup; none for an opaque origin): the reveal shows it as "Sealed by", and when another site asks for the
  reveal a caution names both sites instead. A seal made before the wallet kept the origin, or asked by an opaque
  origin, reads "Sealed by: not recorded". Nothing is refused.
- A `cairnx:v1` proposal that the vendored parser accepts is decoded. Each card also shows any outputs as funds leaving
  the wallet, the expiry, the payload hash and "Anchored as: a cairnx:v1 proposal". By record type:
  - `transfer`: "CairnX token transfer": token, amount, recipient (flagged as above), memo.
  - `deploy`: "CairnX token deploy": ticker and name, supply (also at the record's decimals), decimals, minting.
  - `mint`: "CairnX token mint": token, and the amount or "default lot".
  - `offer`: "CairnX offer": give, want, the partial-fill minimum, the only taker, the accepted bid, the paid-to
    address (flagged as above), memo. The only taker gets the look-alike flag and never the first-time one (an
    answer to a bid always names an address new to the wallet). An offer whose want is zero says that it asks
    nothing in return and that whoever fills it gets what the user gives for nothing.
  - `bid`: "CairnX bid": what is bid and for what, memo.
  - `ocancel`: "CairnX cancel offers": the open offers it cancels (one ticker's, one name's, or all).
  - `ncommit`: ".csd registration, step 1 of 3 (commit)": the commitment.
  - `name`: ".csd registration, step 2 of 3 (reserve, free)", or ".csd name claim" without a salt: the name.
  - `nfinalize`: ".csd registration, step 3 of 3 (finalize and pay)": the name. The window reads the reservation from
    the configured CairnX API and keeps Approve off when its answer shows the finalize would pay the fee for nothing.
  - `nxfer`: ".csd name transfer": the name and the new owner (flagged as above), and a caution that the transfer is
    final, that the new owner controls the name from then on and that it clears the name's address record and its
    profile. The window reads the name's record from the configured CairnX API after the paint; when it gives the
    name to another address, shows it not yet finalized, lapsed or locked by an open offer, or has no record of it,
    a caution says so and that the fee is spent if that still holds when the record is mined, and Approve reads
    "Sign anyway" and Reject "Cancel". The read holds nothing back: Approve arms at its 700 ms floor, a click does not
    wait for it, and the caution does not turn Approve off.
  - `nset`: ".csd name → address record": the name and the address (flagged as above); the zero address reads
    ".csd un-point (clear address record)". Approve stays off when the CairnX API answers that the name is not
    registered or has another owner.
  - `nrenew`: ".csd name renewal": the name. Approve stays off when the name is not registered, or is in its grace
    period under another owner; the renewal of another owner's live lease gets a caution, and Approve reads "Sign
    anyway". A renewal or finalize that pays less than the current fee gets a warning.
  - `nprofile`: ".csd identity profile": every key and value, the notice that the record replaces the whole profile
    and removes any key not listed, a "Keys removed" row with the current keys it drops (read from the configured
    CairnX API, display only), and a warning when a key or value looks like an address. When the new map sets
    `contenthash`, `csd.rpc` or `csd.p2p`, a caution says what each does for other applications (the site they open
    for the name; the node address they may read the chain through for the name; a peer they may dial), and a
    removed one in "Keys removed" carries the same words. The sentence that the keys do not change where funds go
    (and that other applications may read some of them) covers the other keys only. An empty profile reads "Clears".
    The record read for "Keys removed" also gives the caution and "Sign anyway" a transfer gets, except for a lock: a
    profile write on a name an open offer locks takes effect.
  - `tmeta`: "CairnX token metadata (issuer only)": the token and the content hash.
  - `fclaim`: "Reserve an open offer": the offer id, and that it moves no money.
- Every name check above (finalize, set-address, renewal, transfer, profile write) is for the account the window
  shows as signing. When the window paints the same request for another account (an unlock after the active account
  changed), the check is redone for that account from the record already read, and nothing judged for the other
  account stays on screen. A switch of account while the window is unlocked does not repaint it: the window keeps the
  account it shows, and Approve is then refused `ACCOUNT_CHANGED` with nothing signed. A click on Approve that waits for
  a finalize, set-address or renewal check belongs to the paint it was made on: if the window repaints the request
  before the check answers, that click signs nothing, the request stays queued, and the window says to review it and
  approve again.
- A proposal in another domain is shown raw as "Post a proposal": the fee, any outputs, the expiry, and the domain,
  payload hash and URI as sent, with a line that the wallet does not interpret records of that domain, that they
  cannot change CairnX names, tokens or offers, and that this one costs the network fee and any outputs shown. The
  wallet does not fetch the URI.
- A `cairnx:v1` proposal the parser refuses (a payload hash that is not the record's, an unknown type, a uri that is
  not canonical JSON) is shown raw the same way, with a caution that the wallet does not recognise the record, that it
  may be a record type newer than this wallet, that the network may give it no effect and that the fee (and any
  outputs) is spent either way. It is not refused.

## Not offered

- No message signing other than Sign in with CSD: no `signMessage`, no `personal_sign`, no typed data.
- No key derivation, encryption or decryption for a site.
- No spending cap or allowance per site, and no second confirmation for a large amount.
- No cooldown after a rejection: each new request raises the window again, within the queue limits.

## Stability

The error codes are a contract (`WALLET-ERROR-CODES.md`: codes are added, never reused). From this document on, so are
the method names, the parameter names, the envelope and `SubmitResult` shapes, the event names and payload shapes, the
discovery event names, the `rdns` value and the fields of the announce detail. Additions (a method, an optional
parameter, a result field, a code, an event reason) can come in any release. A removal or rename of any of these is
announced in `CHANGELOG.md` before the release that makes it. Error text, the approval window's wording and layout,
the defaults and the limits are not part of the contract; a change to a default or a limit is listed in
`CHANGELOG.md`.

## Where each number lives

- The page match patterns and the top frame: `public/manifest.json` (`content_scripts`).
- `rdns`, `name`, the per-load `uuid`, the event list and `getCapabilities().methods`: `src/inpage.ts`.
- Output caps 8, 500, 100, the fee caps (`MAX_FEE` 100 CSD, `proportionalFeeCap`) and the address and hash shapes:
  `src/core/node.ts`; the checks made before the window, `proposeRefusal` and `sendRefusal` there and
  `src/core/fillpreflight.ts` `fillRefusal` for a fill. The 128 and 512 byte caps on
  a proposal's domain and uri: the vendored `MAX_DOMAIN_BYTES` and `MAX_URI_BYTES`. 100,000,000 base units to one
  CSD: `src/core/cairnx.ts` `CSD_DECIMALS`.
- Fee defaults: `src/core/cairnx.ts` `defaultFeeFor`; 0.25 and 0.05 CSD are the vendored `MIN_FEE_PROPOSE` and
  `MIN_FEE_ATTEST` (`src/vendor/cairnx-spv.js`).
- Score 100, confidence 1,000,000: the vendored `SCORE_FILL` and `CONF_TOKEN_FILL`, used by `src/core/signfields.ts`.
- 512 inputs: the vendored `MAX_TX_INPUTS`.
- 5 per site, 32 in all: `src/background.ts` `MAX_PENDING_PER_ORIGIN`, `MAX_PENDING_GLOBAL`. The 500 origins the
  wallet remembers approving: `APPROVED_CAP` there.
- The 5 CSD fee mark: `src/popup/clearsign.ts` `FEE_WARN`. The 700 ms floor: `src/popup/approve.ts` `armButtons`.
- The 15-minute auto-lock and the 720-epoch seal expiry: `src/core/wallet.ts` `AUTO_LOCK_MS`, `PROPOSE_EXPIRY_EPOCHS`.
- The sign-in limits: `src/core/siwcparams.ts`.
