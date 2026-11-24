# Architecture: modules, runtime footprint and deviations

Status: as built, 2026-11-17. Moved out of `AGENTS.md`, which keeps the invariants and a short map; this file holds the
per-module detail behind them. The fill lanes, the inclusion reconcile and the SPV header store have their own design
notes (`docs/DESIGN-*.md`); tests and CI are in `docs/TESTING.md`; the user-facing account is `SECURITY.md`.

Everything ships bundled by esbuild from `src/` into `dist/` (gitignored), with zero runtime npm imports (all four
dependencies are inlined).

## Build (`build.mjs`)

The build, plus the tripwires that abort it:

- a forbidden external message surface: `externally_connectable`, `onMessageExternal` or `onConnectExternal` anywhere
  in `src/` or `public/`;
- source-host coverage: every hardcoded https fetch host must be in the manifest's CSP `connect-src` and in
  `host_permissions`;
- popup isolation: the `Wallet` class must sit in a split chunk, not in `dist/popup.js` or `dist/approve.js`.
  `approve.js` is built without code splitting, so `approve.ts` must not import `popup-bridge.ts` (or `devshim.ts`),
  whose dev path would inline the Wallet;
- the vendored cairn-ui files must match `src/vendor/cairn-ui/PROVENANCE.json` (`scripts/check-ui-vendor.mjs`).

The release version lives only in `package.json`; the build stamps it into `dist/manifest.json` and the inpage provider
(esbuild define `__WALLET_VERSION__`).

## Background (`src/background.ts`)

The MV3 service worker. It owns the unlocked key, the dApp approval queue, per-origin consent, the `DAPP_METHODS`
allowlist (enforced twice: before a request is queued and in `resolvePending`;
test/resolve-allowlist-second-line.test.mjs drives the second line), the popup sender-origin gate, provider events and
alarm-driven auto-lock, which a read on the popup channel does not extend (`READ_ONLY_METHODS`;
test/readonly-no-touch.test.mjs).

- Queue caps: `MAX_PENDING_GLOBAL` = 32, `MAX_PENDING_PER_ORIGIN` = 5. A request returned to its reservation confirm
  step is re-queued without re-checking them, so a site can sit one above its cap per such request.
- One fill request per fill target (`fillTargetOf` in `fillpreflight.ts`: a `fillOffer`, or an `attest` at the
  token-fill confidence, `fillOf` in `signfields.ts`) across sites and reloads: another is refused `FILL_IN_PROGRESS`
  before it is queued, until the first request's answer goes to its page (test/fill-one-request-per-offer.test.mjs;
  `docs/DESIGN-fill-lanes.md`, "One request per fill target").
- An open approval window is brought forward only by `focusApprovalWindow` (the one `chrome.windows.update` in
  `src/`), which first asks the window to re-arm (`approve.ts` `armButtons`, the 700 ms floor) and raises it on the
  answer, at once when no window listens, or after 250 ms when none comes (test/approve-raise-rearm.test.mjs,
  test/approve-raise-chrome.test.mjs).
- A `FILL_IN_PROGRESS` refusal raises the window at most once per `REFUSED_RAISE_GAP_MS` (5 s) across all origins; a
  refusal inside the gap re-arms nothing, so repeated refusals cannot hold the painted request's buttons off
  (test/approve-raise-refused-bound.test.mjs). Newly queued requests still raise each time; the queue caps bound them.
- At start it sets both `chrome.storage.local` and `chrome.storage.session` to `TRUSTED_CONTEXTS` (content scripts
  cannot read or write the vault or the header snapshot; test/storage-access-level.test.mjs).
- A keyed method that throws "locked" maps to `WALLET_LOCKED`, anything else to `INTERNAL` (`thrownCode`).
- A `signinWithCsd` request is checked before it is queued by `siwcParamsRefusal` (`src/core/siwcparams.ts`, the
  wallet's sign-in parameter rules; `signInWithCsd` signs through the same `siwcMessageFor`): one the wallet would
  refuse is answered `BAD_REQUEST` with no window (test/siwc-prequeue.test.mjs). A `propose` is checked by
  `node.ts` `proposeRefusal`, the function `node.propose` refuses with (payload hash, expiry, the domain and uri
  types, their consensus byte caps and surrogates, the fee checks that need no coins and the proposal minimum, the
  outputs and the zero address), and a `sealClaim` by `signfields.ts` `sealFields`, which `wallet.sealClaim` signs
  from, and `proposeFeeRefusal`; one the signer would refuse is answered `BAD_REQUEST` with no window and no queue
  slot (test/propose-prequeue.test.mjs). The fee and zero-address helpers are the ones `assembleValueTx` and
  `buildSignSubmit` run; the 10% fee cap needs the selected coins and runs only there. A `send` is checked by
  `node.ts` `sendRefusal` and a `fillOffer` by `fillpreflight.ts` `fillRefusal`, which run the checks `node.send`,
  `node.sendMany` and `node.fillOffer` run before they select a coin (the outputs and their caps of 500 and 100, an
  element that is not an object, the amount, the fee checks that need no coins, the zero address) and, for a fill,
  the preflight's checks that read nothing (the target's shape, output values that are integer numbers); one the
  signer would refuse is answered `BAD_REQUEST` the same way (test/send-fill-prequeue.test.mjs). An `attest` is
  checked by `fillpreflight.ts` `attestRequestRefusal` (as a fill at the token-fill confidence, else `node.ts`
  `attestRefusal`, which `node.attest` runs), and a `revealClaim` by `signfields.ts` `revealFields`. The engine reads
  an id or address only from a string, and the readers in `signfields.ts` name a score, confidence or seal txid that
  is a JSON object or list in `shape`, which the pre-queue check and the signer both refuse
  (test/request-shape-prequeue.test.mjs). The chain lives in `src/core/prequeue.ts` `prequeueRefusal`, which
  `queueDappRequest` calls; every method on the allowlist is in it or takes no parameters, and a seeded fuzz finds no
  request that passes it and makes the approval window's paint throw (test/request-shape-fuzz.test.mjs). Every
  pre-queue check is a function of the request's parameters (and, for a sign-in, the origin): it reads nothing and
  waits for nothing, so its answer carries no wallet state.
- `spentTxids` and `inputs` on a submit result are internal: `resolvePending` strips both before a page receives the
  result.
- `approvedOrigins` (storage key): `{ vault, origins: { [origin]: ms } }`, the origins the user has approved a request
  from and when they last did, at most `APPROVED_CAP` = 500, the newest by that time (the oldest is dropped and reads as
  new again). A list belongs to one vault: `vault` is `Wallet.vaultId()`, the vault's PBKDF2 salt (16 random bytes made
  with the vault, kept by every re-seal, erased with it), and a list under another vault, with no vault or in the old
  plain shape reads as empty and is replaced by the next write. It is
  display metadata, kept apart from everything essential. Each queued request carries its flag (`first`), set from
  memory when it is queued (`isNewOrigin`: in neither `approvedNow` nor `connectedNow`) and refreshed (`refreshNew`)
  when either loads (`loadKnown`, in the background, one read of each at a time, tried again when a request is queued)
  or changes (an approval, a consent write, a reset). `pending` reads only the flags and touches no storage; until a
  list has loaded, or when it cannot be read, an origin reads as new. `resolvePending` updates `approvedNow` once the
  page has its answer and queues the storage write on the list's own queue (`recordApproved`, `inApprovedChain`, never
  awaited; a failed write is logged). An approval records its origin under the vault current when the user approved,
  and only if that vault is still current when the approval finishes: in memory at once, and in storage by a queued
  write that carries that vault, so one that runs after a reset lands as a list bound to the erased vault, which every
  reader takes as empty. So an approval, a write or a load from before a reset never lands in the next wallet's
  list (sections 7 to 9 of
  test/approve-first-request.test.mjs). The reset clears the consent map, then calls `wallet.reset()`, which drops the
  vault id before its first await, and only then empties the list: nothing that finishes during the consent write can
  refill it, and a consent write that throws leaves the wallet and its list as they were. The stored copy's deletion is
  queued as hygiene, awaited by nothing and relied on by nothing. Opaque origins (`src/core/origin.ts`
  `opaqueOrigin`) are never written (test/approve-first-request.test.mjs).
- A `revealClaim` for a seal the active account does not hold is queued like any reveal, from every site, and
  `revealClaim` answers it `SEAL_UNKNOWN` after approval. A seal records the asking origin on its record (`origin`; the
  extension's own for a popup seal, none for an opaque origin), which `clearsign.ts` `revealPreviewHtml` shows.

## Provider (`src/content.ts`, `src/inpage.ts`)

They inject the frozen `window.cairn` provider and relay it over same-origin `window` messages (source, target and
origin checked; replies are not authenticated, a script on the page can read and forge them), with
`csd:announceProvider` discovery. The two replies `content.ts` writes itself carry codes: `WALLET_RELOADED` (an
orphaned content script after an update) and `WALLET_UNAVAILABLE` (a closed channel). `getCapabilities().methods`
lists every `DAPP_METHODS` entry but the legacy `signIn`, which against the Cairn API can succeed from no origin
(test/extension-boundary.ts CQ-4, test/inpage-relay.test.mjs). The contract this surface offers applications
(discovery, methods, limits, events, consent, the approval cards, stability) is `docs/PROVIDER.md`;
test/provider-discovery.test.mjs pins the discovery part.

## Core (`src/core/`)

- `keystore.ts`: the AES-256-GCM vault; PBKDF2-SHA256 at 600k iterations; `MIN_ITERS` = 100k is the downgrade floor
  and `MAX_ITERS` = 30M the DoS ceiling on a stored iteration count.
- `account.ts`: BIP-39/32/44, coin type 7779.
- `csdtx.ts`: the deliberate browser twin of the server tx codec (bincode, txid = sha256d, sighash `CSD_SIG_V1`,
  low-S; `loginDigest` structurally disjoint from a tx sighash). Do not dedupe it into an import.
- `wallet.ts`: the `Wallet` class: vault lifecycle, multi-account, `chrome.storage.session` key rehydrate
  (fail-closed), the brute-force auth guard (5 failures, then exponential lockout), endpoint settings, signer capture,
  the sign flows (send, sendMany, consolidate, propose, attest, fillOffer, posts, token transfer, name renew and
  set-primary, sealClaim, SIWC), SPV wiring and its test seams. The modules below hold the rest; each reads the wallet
  through a small IO object or host the class builds from closures, called when the code runs. Every flow captures its
  histKey before its first await so entries file under the account that signed.
- `endpoints.ts`: the default endpoints (including clarvis, the second source) and the URL rules. RPC rule:
  `rpcAllowed` accepts only the Cairn proxy or a loopback node (`http://127.0.0.1:<port>`, `http://localhost:<port>`);
  a saved remote RPC is moved to the proxy once with a notice. The Cairn and CairnX API settings take https or loopback
  (`validRpcUrl`), and the manifest CSP limits what is reachable.
- `signfields.ts`: the fields the wallet signs for each dApp request type, from its params (fee defaults, the u32
  clamps, the token-fill confidence that turns an attest into a fill at score 100, a fill's score refusal, the trimmed
  seal domain): `attestFields`, `fillFields`, `proposeFields`, `sendFields`, `sealFields`, `revealFields`, `fillOf`
  (the fill a fillOffer or a token-fill attest signs) and `isTokenFill`. The sign path (`wallet.ts`, `background.ts`,
  `fillpreflight.ts` `fillTargetOf`) builds from them, and the approval window reads every request field it shows or
  uses from them (`clearsign.ts` `describe`, `debitOf`, `costBlock`, `signedFee`, `signedOutputs`,
  `requestRecipients`; `approve.ts`'s reads before and after the paint; `approve-density.ts`); the sign-in's are
  `siwcparams.ts` `siwcFieldsFor`. test/sign-display-parity.test.mjs sends every request type the window paints
  through the real worker to the real approval window, approves it there, and compares the painted fields and the
  window's reads with the signed transaction's.
- `fillpreflight.ts`: what is checked before an offer fill is signed: the offer read, the output sums, then one of
  three lanes (`fclaimLanePreflight`, `csdLanePreflight`, `tokenLanePreflight`); returns a refusal or null, signs
  nothing. The design is `docs/DESIGN-fill-lanes.md`.
- `names.ts`: name resolution and verification for sends to a `.csd` name (`resolveName`, `verifyName`,
  `confirmName`, the hint-set cache read and write).
- `market.ts`: the CSD/USD rate behind the balance's USD line, read from the Cairn API's `/api/market/csd` (absent on
  its 503, a failure or a body without a positive price from a named venue); display only: no signing flow reads the
  rate. `wallet.ts` imports it for the `csdMarket` read and `popup-balance.ts` for the line, and
  test/usd-line.test.mjs scans every file under `src/` for other importers and for any other use in `wallet.ts`.
- `cairnxview.ts`: display-only CairnX reads for the popup and the approval cards (balances, token list, token-fill
  quote, fill view, token decimals, and `attestTargetView`, the node's `/proposal` read that tells the approval window
  whether a score-0 attest names the signer's own offer or bid, so it can title it "Cancel your offer" or "Cancel your
  bid"); never bound to a signature.
- `history.ts`: `TxHistory`, the per-account history. `maybeRecord` is the single history chokepoint: ok records,
  `SUBMIT_MAYBE_INFLIGHT` records `maybe: true` under the local txid, `SUBMIT_DUPLICATE` clears an earlier maybe in
  place (never inserts). It also holds the write chain, the rows parked in RAM when a write fails or the wallet is
  locked, and the inclusion reconcile (`pendingMerge`, `docs/DESIGN-inclusion-reconcile.md`). A popup send or token
  send to a `.csd` name keeps the name on its row (`wallet.ts` `namedRow`), which the next review of that name
  compares with where it resolves now (`clearsign.ts` `lastPaidTo`, the `[A19]` caution).
- `claims.ts`: `SealedClaims`, the per-account sealed claims: reveal preimages encrypted under the vault key, the
  write chain and parked records, `revealClaim` (refuses with `SEAL_NOT_MINED` until the node shows the commit mined)
  and the list. `sealClaim`, which signs the commit, is a `Wallet` method. An unrevealed record is never deleted except
  by `reset()`: the cap evicts revealed records only, and `removeAccount` keeps the account's unrevealed records
  (`keepUnrevealedOf`; the remove step counts them through the popup-only `unrevealedSeals`), so they list and reveal
  again when the same address is back in the wallet (test/seal-remove-keep.test.mjs).
- `cairnx.ts`: CairnX record builders over the vendored core; consensus rules imported, never re-typed; a pre-spend
  `parseRecord` round-trip so build success implies resolver acceptance. No on-device registration flow: the /names
  site drives registration through dApp propose, always clear-signed.

### Hosts (`hosts.ts`)

`hostsFor(rpc)` is the default RPC and `BACKUP_RPC` for the default RPC, else the RPC alone. `firstAnswer(rpc, read)`
asks the preferred host, the other after `HEDGE_MS` or on the preferred host's failure, and returns the first answer
with its host. The reads in `node.ts` take the wallet's RPC and go through it; a step that must stay on one host
passes the host it got: a spend's source reads (`selectVerified`, `consolidate`) and a reconcile pass
(`history.ts` `inclusionReads`). `balance()` adds `via: "backup"` when the second host answered. `submitEach(rpc,
send)` sends to every host at once and resolves with the outcome as soon as `decideSubmit` decides it.

### The send engine (`node.ts`)

`assembleValueTx` is the single chokepoint for every value tx, in this order:

1. fee > 0, flat `MAX_FEE` = 100 CSD, zero-address refusal;
2. `selectVerified`, then csd-tx's `selectInputs` from the vendored bundle (greedy largest-first, `MAX_TX_INPUTS` =
   512 from csd-codec; one coin served in two txid spellings is one coin);
3. `verifyInputValues`: fetch each source tx and recompute its txid with the consensus codec, in a bounded pool
   (`VERIFY_CONCURRENCY` = 8) with a decisive short-circuit. Verdicts: number, notfound, transient, tamper, horizon,
   unrepresentable. "horizon" is classified only on the node's exact 503 plus body code `SCAN_HORIZON`, so a
   cold-index window skips coins instead of refusing the spend (test/ghostcoin.test.mjs). "unrepresentable" is
   classified on the raw body before the txid recompute when a serialized number cannot survive `JSON.parse` exactly
   (test/unrepresentable-coin.test.mjs). Both are skipped per coin like notfound and add no rung to the decisive
   tamper/transient fold; all three skip classes are remembered for the session (`ghostSeen`, `horizonSeen`,
   `unrepSeen`, 120 s, 2,048 each), keyed by host and outpoint, so a retry on the same host starts without the coins
   an attempt already skipped and another host checks them again;
4. the ghost re-select loop, then the proportional fee cap max(1 CSD, 10% of verified inputs), change to self only,
   and `signAndSubmit`: one signing, the bytes to every host of the RPC at once (`hosts.ts` `submitEach`), each answer
   read by `submitverdict.ts` `classifyAnswer` (accepted, duplicate, refused with a `reason`, unclear) and the outcome
   by `decideSubmit`: sent at the first acceptance, else once every host answered (after the main host's refusal the
   others get `MAIN_REFUSED_WAIT_MS`, 4 s, then the outcome is unclear carrying its reason), unclear before duplicate before
   refused (`SUBMIT_MAYBE_INFLIGHT`, `SUBMIT_DUPLICATE`, `SUBMIT_REJECTED`). The result's `hosts` logs each answer
   and is stripped before a page receives it. `mainHolds` (stripped too) says whether the main host answered accepted
   or already present: `history.ts` records a sent row maybe while it does not, clears a mark only on it (a duplicate
   result included), and on a later answer kept as one fact (`laterFact`): the main host's hold clears the mark, the
   other host's refusal after the cap removes the row that send made. `classifyAnswer` is total: text is
   read only from string fields, and anything it cannot read is unclear; a host's rejected send counts as unclear in
   `submitEach`. A 200 `ok:false` whose text is neither the duplicate text nor the panic text is refused with reason
   `UNKNOWN`, so a node that rewords one of those reads as a refusal: reading unknown text as unclear would leave a
   "sent, not yet included" row for a transaction no host took, and 0.3.4 and cairn-sdk read it the same way.

Beside it:

- `maxSendable()` is the send sheet's Max, two passes of `selectVerified`: the first with a target that each round is
  the reported total of the 512 largest coins still eligible, the second the send's own numeric call with that figure,
  from the session caches the first filled. Max answers only when the second succeeds, so the figure (minus the fee,
  under both fee caps) is one the send's selection accepted at that moment; after the caches expire a send can take
  one retry. Popup-only, signs nothing (test/maxsendable.test.mjs sends exactly it and one base unit more).
- `consolidate()` merges dust: up to 512 smallest coins into one self-output, verified like a send, both fee caps
  apply (popup-only, not in `DAPP_METHODS`; `consolidatePreview()` feeds the settings ▸ coins UI). From a `/utxos`
  list the node cut (`truncated`) its `remaining` counts only listed coins, so the popup shows it as a floor; under
  such a list a send the reported whole balance covers that the listed coins cannot fill within 512 inputs is
  `TOO_MANY_INPUTS`, not `INSUFFICIENT` (test/utxos-truncated.test.mjs 2b, 2c).
- `spendableCoins()` is the set of coins `selectInputs` accepts, each once: it asks `selectInputs` about each coin and
  dedupes on `opKey`, csd-tx's outpoint key in the node's `0x` form (test/selectinputs-parity.ts,
  test/selectinputs-spelling.test.mjs).
- `VERIFY_UNAVAILABLE` also covers a `/utxos` body without a `utxos` array and a selection that used its three rounds
  on coins the node could not prove yet (both refuse before signing).

### SPV (`namespv.ts`, `headerstore.ts`, `spvanchors.ts`, `spvnewest.ts`, `chainbound.ts`, `spvpin.ts`, `spvbind.ts`, `fillspv.ts`)

- `namespv.ts`: SPV name verification over the header store (`headerstore.ts`: IndexedDB, 84-byte records in
  4,096-height chunks) anchored by the release table `spvanchors.ts` (one block hash per chunk from the names floor
  29,960, each a light-client checkpoint).
  - At or below the newest anchor a header is used only from a chunk whose records hash-link to two table hashes in
    the same session; above it, from the PoW light client seeded from the anchor chunk and synced forward with every
    consensus check, or, after a worker restart in a session that already verified it, by a hash walk to the session
    pin (`src/core/spvpin.ts`, test/namespv-session-pin.test.mjs).
  - Then: full-block merkle bind, signer auth and prevout-ownership bind, and the two-source union (`verifyNameUnion`:
    primary and clarvis). A disagreeing source is a warning, not a refusal (the warn-over-block rule; `SECURITY.md`
    states it).
  - The replay also returns `completedAt`, the height of the event that completed the name's current holding
    (`completingHeight`: the lowest event height at which the vendored resolver over the events up to it already
    holds a record with the final `claimId` and `effectiveHeight`, not pending). The popup shows `[A18]` when it is
    above the release's newest table entry (`spvnewest.ts`), since such a holding rests on headers above the table
    that the answering servers also serve (test/name-completed-at.test.mjs, test/popup-checks-dom.test.mjs 9d).
  - The sync: one runner per source holds a target per run (a lookup's height, or the node tip for the background
    run the popup's `prewarmSpv` starts once the balance has answered), requests up to five 512-aligned pages at once
    (two at first, more after fast pages, one after a timeout), aims at a waiting lookup's height first, and
    ingests by height, one page per serialized op, persisting the tail after each window. A structural break gets one
    reseed per run: with a lookup waiting from the newest seal, then the table; with none, the bounded reseed (the
    newest seal, or the table within 8,191 of the held tip, 17 pages at most), which yields to a lookup that arrives.
    One adoption site: a chain verified above the held tip with more work. A source the wallet drops (endpoint, vault,
    reset) requests and writes nothing more and refuses its waits above its tip; a name lookup on it asks the current
    source once more (`names.ts`). Background pages give way to the foreground (`netgate.ts`: none starts while a
    request a user waits on is in flight or ended less than 250 ms before, and one in flight is cancelled and asked
    again); a page's ingest and the rebase's re-ingest yield every 128 headers (`ingestSliced`). After a refused
    background reseed the source's background runs wait 2 minutes, doubling up to 32; an adoption ends the wait.
  - Store, sync, migration and the union's lapse and badge rules: `docs/DESIGN-namespv-scaling.md`.
- `spvnewest.ts`: the anchor table's newest height alone, written by the generator beside `spvanchors.ts`.
  `chainbound.ts`: `heightOf` (a served tip or stored floor counts only as a positive safe integer) and
  `lowestChainHeight` (the stored floor or that height); a leaf, so the approval window uses it without the table
  (test/chainbound.test.mjs, test/height-integer.test.mjs).
- `spvbind.ts`: the SPV primitives `namespv.ts` and `fillspv.ts` share: the block bind (`bindBlock` over csd-light
  `bindBlockBody`: exact parse of the served `/block` text, a transaction not written as the node writes it refused
  as a body mismatch (its `txid` field absent or not the id the body hashes to, a hash, address or script not `0x`
  and lower-case hex, an app type other than `None`, `Propose` or `Attest`; test/spv-node-form.test.mjs), the
  repeated-txid refusal before the merkle compare, test/merkle-dup-txid.test.mjs), the author bind (`bindSigner` over csd-crypto `authorOf`: the owner of the coin
  input 0 spends, test/namespv-fillspv-parity.test.mjs), signer recovery, the coinbase test, `paidTo` and the event
  mapping. Both binds return their refusal; a body that does not decode throws. namespv turns a refusal into a reason
  and fillspv into a throw (`BodyMismatchError` for a body mismatch of either kind) or a null.

SPV header storage (the design as built is `docs/DESIGN-namespv-scaling.md`):

- The names floor 29,960 cannot move: verifying a name event at height h needs the verified header at exactly h. A
  name-history hint below it is dropped and flags `disagree`.
- A start reads only the newest anchor's chunk and the suffix above it, so restore cost follows the suffix, not the
  chain. The table is regenerated per release (`store/PUBLISH-RUNBOOK.md` step 2), and the `anchors` job fails a tag
  whose newest entry is more than 6,000 blocks below the public tip. Between releases, a table-only release is cut
  once the public tip is more than 14,400 blocks above the newest entry (the runbook's refresh cadence, with the
  measured cost per header). An older height costs one chunk the first time a proof needs it.
- Every table entry is a light-client checkpoint for the life of the release (an `anchors` prefix in tests narrows the
  newest anchor, never the checkpoint map); a served chain that contradicts one fails closed with no fallback to an
  older entry.
- When the node tip cannot be read, `prepare` syncs nothing and reports `tipKnown: false`, and the fclaim fill lane
  refuses.
- Do not adopt a stored header without its walk to the table, its forward verification, or its walk to the session
  pin (headers verified earlier in the same browser session): that check is the storage-poisoning defence.

## Popup and approval window (`src/popup/`)

- `popup.ts`: the popup's entry. It loads one `popup-*.ts` module per view or concern, such as `popup-send.ts`,
  `popup-sendflow.ts` for the review engine the CSD and token sends share, `popup-namecheck.ts` for a Review's wait for
  a name check (the status line, D12's choice; it reads the background's `nameCheck`, memory only, which holds the
  served answer of a name's latest lookup and is cleared on an endpoint change and on lock), `popup-panels.ts` for the sheets and their
  teardown, `popup-state.ts` for the state several views read. Source scans read the whole set through
  `scriptSource("popup.ts")` in `scripts/popup-ids.mjs`; `popup-outcome.ts` is one of them.
- `popup-outcome.ts`: the extension channel to the background, the one reading of a submit outcome and the one
  reading of a Reject's answer, which the popup takes through `popup-bridge.ts` and the approval window directly:
  `approve.js` is built without code splitting, so it must not import `popup-bridge.ts`, whose dev path would inline
  the Wallet; `build.mjs` aborts if it does.
- `sentences.ts`: the copy. Every line the wallet's results put on screen is an entry of one table keyed by the copy
  sheet's tag (`R1`, `S4`, ...): its text, its level (grey, amber, red) and its Details, the technical sentence one
  tap away under the line. A selector chooses the key from a result's code and refusal reason, not from a text, so
  a change of wording is a change of one entry; `test/sentences-copy.test.mjs` holds every entry to the copy rule (at
  most 160 characters and two sentences, no technical word, three levels). In a send (the popup's CSD and token
  sends, a page's send in the approval window) every refusal has a line, `R1` for a code without its own, with the
  engine's text under Details; any other flow keeps the engine's text for a code its lines do not cover yet. An
  offer fill (a `fillOffer`, or an `attest` the signer signs as a fill) keeps it for `VERIFY_UNAVAILABLE` too, which
  there also means the offer or its proofs could not be read yet (test/approve-outcome-dom.test.mjs 10). A
  server's free text reaches neither a line nor Details: a submit's `error` is the wallet's sentence (`node.ts`
  `submitResult`), and the other places a served string was shown map it onto a fixed list of words or leave it out
  (`src/core/servedtext.ts`; test/served-text-off-screen.test.mjs).
- `approve.ts`: the clear-signing window. For an `nprofile` or an `nxfer` it reads the name's record once from the
  configured CairnX API (`namegate.ts` `readNameRecord`, bounded at 6 s) after the paint: an `nprofile` fills the
  reserved "Keys removed" row with the current keys the record drops (`clearsign.ts` `profileDropValue`), and both
  get `namegate.ts` `nameRecordCaution` in the name action's note, with "Sign anyway" for a caution. Neither the arm
  nor the click awaits that read, unlike the finalize, renew and set-address gate, which a click awaits. Every name
  verdict is keyed by the request and the signer the paint shows (`armNfinalizeGate`); a repaint for another signer
  recomputes it from the record already read, chained on that one read, so a verdict for the signer shown before
  always lands first. A click (`resolve`) is bound to the paint generation and the signer it was made on and is
  abandoned, signing nothing, when either has changed after one of its awaits. A request whose paint throws, or whose
  reads before the paint throw (caught and rethrown inside the paint's `try`), is shown as one the wallet could not
  show: Approve stays off and Reject arms after the 700 ms floor, so it cannot hold the window or hide the requests
  behind it (test/approve-paint-throw-dom.test.mjs, test/approve-paint-throw-preread-dom.test.mjs). `unpaintableShown` names the request
  whose card that is: another request's paint clears it, so one that failed before and comes back to the head of the
  queue is disabled and shown so again, never under the other request's card and buttons
  (test/approve-paint-throw-requeue-dom.test.mjs).
- `clearsign.ts`: pure formatters, among them `groupedAddr`, the one address-in-groups-of-four display both pages
  use, lookalike detection and the nfinalize approve gate: it re-fetches the reservation and runs
  `finalizeWinnerCheck` before allowing a fee-burning finalize.
- `qr/`: the QR code (third-party `qrcodegen.ts` and the drawing).
- The identity avatar is cairn-ui's `avatar.js`, vendored with the theme files and the logos in
  `src/vendor/cairn-ui/` (`PROVENANCE.json`, checked by `scripts/check-ui-vendor.mjs`).
- The Cairn mark has one home, the vendored `mark.svg`: the pages draw `<use href="ui/mark.svg#mark">` in its viewBox,
  and the drawing `<svg>` sets the fill because the mark sets no paint (test/popup-logos-chrome.test.mjs checks every
  one on the popup and the approval window, both themes), the sprite `icons.svg` holds Lucide icons only, and
  `scripts/mark.mjs` reads it for the extension icons and the store images (test/mark-home.test.mjs).
- `tiles.ts` gives a token row its tile: the mark only for the CAIRN whose served deploy id is the pinned one
  (`isPinnedDeploy`), the neutral glyph for every other token; the CSD row draws the vendored `csd-logo.jpg`.

## Vendored consensus bundle (`src/vendor/cairnx-spv.js`)

A vendored esbuild bundle of the published csd-sdk packages (csd-light, csd-client, csd-codec, csd-crypto, csd-tx,
cairnx-core) at the exact versions `package.json` pins as dev dependencies; `cairnx-spv.d.ts` is generated with it
from the same export list, so the types are the packages' own. `src/vendor/PROVENANCE.json` pins both files' sha256,
each package's version and lockfile integrity, and the noble versions (read the file for the current values).
`scripts/check-vendor-fresh.mjs` (`npm run verify:vendor`, run by CI and the release build) checks those pins, that
the wallet's @noble pins equal the ones csd-crypto declares, and re-runs `scripts/build-spv-vendor.sh` into a temp
dir: both files must be byte-identical to the committed ones.

## Manifest, icons, store

- `public/manifest.json`: permissions only `storage`, `alarms` and `unlimitedStorage` (the SPV header store grows
  with the chain); CSP `connect-src` limited to cairn-substrate.com, clarvis and loopback; `web_accessible_resources`
  only `inpage.js`; no `externally_connectable`. test/pentest.ts section 10 pins the web-accessible resource, the
  absent `externally_connectable` and the scope of `host_permissions`; test/store-listing-hosts.test.mjs requires the
  store listing to justify each host permission.
- `public/icons/icon-{16,32,48,128}.png`: written by `scripts/gen-icons.mjs` from the vendored mark (the light
  theme's on-ink colour on an ink tile, pure JavaScript, the same bytes for the same input);
  test/extension-icons.test.mjs compares the committed pixels with the script's.
- `store/`: the Chrome Web Store listing kit, including `PUBLISH-RUNBOOK.md` (security-critical).
- `WALLET-ERROR-CODES.md`: the dApp error contract (codes are the contract, strings are UX copy).

## Runtime footprint

- Node RPC: the Cairn proxy https://cairn-substrate.com/api/rpc or a loopback node only. GET 12 s, POST 20 s. Every
  outer timeout sits above its server-side worst case; do not lower one without re-deriving the inner chain. The
  default RPC's second host, https://clarvis.cairn-substrate.com/api/rpc (`hosts.ts`): a read goes there 1.5 s
  (`HEDGE_MS`) after the main host if it has not answered, or at once when it failed; after a main failure or a read
  the second host answered first, the second host is asked first for 60 s (`BACKUP_FIRST_MS`). With both healthy it gets no reads. Every submit goes to both at
  once. A loopback RPC has no second host.
- Cairn API (user-configurable, https or loopback): auth, /api/content, /api/domains, /api/headers at 15 s with
  Retry-After-aware 429 and 502/503 backoff, at most five header pages in flight per sync of a source (`IN_FLIGHT`,
  adapting to the link), one background header run per 60 s (`BACKGROUND_GAP_MS`), none offline or with Save-Data,
  none for 2 to 32 minutes after a refused background reseed (`RESEED_BACKOFF_MS`, `RESEED_BACKOFF_MAX_MS`), and no
  background page while a foreground request is in flight or within 250 ms of one (`QUIET_MS`, `netgate.ts`).
- CairnX read API /trade/api (12 s); clarvis /trade/api (name-history union always, resolve fallback, 12 s).
- Rate limits: the front door rate-limits per IP; the wallet's fan-out is bounded (send-path input verify at 8
  concurrent, the fclaim fill-scan block fetch at 12), so legitimate flows stay under the per-IP budget.
- Block bodies (name proofs, fill scans) are read by the verified header's hash, `/block/<hash>` (`namespv.ts`
  `blockAt`): the front door marks a finalized one immutable for the edge and charges it no per-height budget, while
  `/block/height/<h>` is never cached. The merkle bind checks the body either way (test/block-by-hash.test.mjs).
- Storage: `unlimitedStorage` because the namespv header store (IndexedDB, 84 bytes per header, about 60 KB per
  chain-day) grows with the chain; `chrome.storage.local` holds the vault, history and settings, the connected sites
  and the 500 origins the user approved a request from last (`approvedOrigins`).
- Consensus caps: `MAX_TX_INPUTS` = 512, `MAX_TX_BYTES` = 100 KB; an all-coinbase holder tops out around 25,600 CSD
  per tx. `consolidate()` is the wallet-side answer. A proposal's domain and uri: `MAX_DOMAIN_BYTES` = 128 and
  `MAX_URI_BYTES` = 512 UTF-8 bytes, vendored from csd-codec.
- `pendingMerge()` (popup-only) settles open history rows (an unconfirmed merge, a `maybe: true` row) from chain
  state, not the clock, and submits nothing; the rules are in `docs/DESIGN-inclusion-reconcile.md`
  (`src/core/inclusion.ts`, test/inclusion-chain.test.mjs).
- Pending post bodies (`pendingContent`, 7 days): `flushPending` tries each on every 1-minute alarm for 15 attempts,
  then doubles the wait from 2 minutes to at most an hour (186 attempts in 7 days against a server that keeps
  failing), and drops a body the server refuses for good (`contentRefusedForGood`: HTTP 400, 413 or 422; a 401, 403
  or 404 comes from in front of Cairn's route or a fixable API setting and backs off), marking its post's history row
  `bodyRefused` so Activity reads "Not posted" (`TxHistory.annotate`). Cairn answers its own content refusals with
  HTTP 200 `{ok:false}` and no code, so those back off rather than stop (test/flushpending.test.mjs).

## Deviations from the cross-repo standard

Not exhaustive. Counts are left to the commands, so this list does not go stale with each release.

- Files over 800 lines: `src/core/wallet.ts`, `src/core/namespv.ts`, `src/core/node.ts`, `src/popup/clearsign.ts`,
  `src/popup/popup.css`, and the third-party `src/popup/qr/qrcodegen.ts`, which tsc does not check (`@ts-nocheck` in
  its local banner: `noUncheckedIndexedAccess` would need edits to upstream code). List them with
  `git ls-files src | grep -E '\.(ts|css|html)$' | grep -v '^src/vendor/' | xargs wc -l | awk '$1>800 && $2!="total"'`.
- Copies kept in step by hand where the standard prefers an import:
  - the fee cap in `src/core/node.ts` (`proportionalFeeCap`): the vendored bundle does not export csd-tx's `feeCap`,
    and test/feecap-parity.test.mjs compares the two against the pinned csd-tx over the totals it prints; adding
    `feeCap` to the export list of `scripts/build-spv-vendor.sh` at the next re-vendor retires it;
  - the field checks `src/core/siwc.ts` shares with csd-siwc (KEEP-IN-SYNC comment);
  - `src/core/csdtx.ts` calls itself the browser twin of the server codec and carries no marker; the golden vectors in
    `test/selftest.ts` pin it;
  - `toChainEvent` in `src/core/spvbind.ts` mirrors the event shapes of the cairnx scanner, which lives in another
    repo; test/namespv.test.mjs replays them through the vendored resolver.
- `npm run lint` (Biome, `biome.json`) reports empty blocks in `src/` and `test/` as warnings (`noEmptyBlockStatements`
  is `warn`; the run's last line gives the count), so that rule does not fail CI yet.
- Comment essays and audit IDs in `src/` are trimmed per module, not as drive-by edits.
