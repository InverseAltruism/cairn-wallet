# Security Policy

Cairn Wallet is non-custodial. Your keys are generated and stored only on your device,
encrypted with your password, and are never sent to any server.

## Reporting a vulnerability

If you find a security issue, please report it privately to **inversealtruism@gmail.com**
rather than opening a public issue. Include steps to reproduce and, if possible, a proof of
concept. We will acknowledge your report and keep you informed as we work on a fix, and we
are happy to credit you once it is resolved.

## How keys are protected

* **Encrypted at rest.** Keys and the recovery phrase are stored only as an AES-256-GCM vault, sealed with a key derived from your password using PBKDF2-SHA256 (600,000 iterations). A wrong password fails authenticated decryption and reveals nothing. The stored iteration count is validated on open, so a tampered vault cannot weaken the key derivation.
* **In memory only while unlocked.** The decrypted keys and recovery phrase are held in the background service worker's memory. The vault key that decrypts them is also kept in the browser's in-memory session storage (`chrome.storage.session`, closed to web pages as below), so the wallet stays unlocked when Chrome stops an idle service worker. Locking, including the 15-minute idle auto-lock, drops both from memory, and closing the browser empties the session storage. The popup receives the phrase and an account's private key only to show them: when the wallet is created, and when you reveal them with your password.
* **Storage closed to web pages.** At start the service worker restricts both `chrome.storage.local` (the vault ciphertext) and `chrome.storage.session` to the extension's own pages and worker (`TRUSTED_CONTEXTS`), so the content script that runs on web pages cannot read or write them.
* **Local signing.** The wallet builds each transaction, computes its `CSD_SIG_V1` sighash, and signs it on your device. Only the finished transaction is sent to the node. The wallet never signs a digest handed to it by a server, so a malicious or intercepted RPC cannot redirect funds or change what you approved. The "sign in with CSD" digest is structurally distinct from a transaction sighash, so a hostile site cannot turn a sign-in into a spend.
* **Deterministic, non-malleable signatures.** secp256k1 with RFC 6979 nonces and low-S enforcement.

The wallet also declares the `unlimitedStorage` permission. Its chain-checked `.csd` name
verification keeps block headers in the extension's own IndexedDB database (84 bytes per header,
in 4,096-header chunks), which grows with the chain; without the permission the header store
would eventually hit the quota and degrade verification. Everything stays local to the device and
nothing is transmitted; the vault is unaffected. A poisoned store cannot forge verification: a
stored chunk is used only if its headers hash-link to the block hashes built into the release,
and the headers above the newest built-in hash are re-verified on load (PoW, LWMA difficulty,
timestamps), so storage tampering can at worst force a re-fetch. The one shortcut: after it has
verified them, the wallet keeps the hash of the newest stored header in `chrome.storage.session`
(memory only, cleared when the browser closes), and a background-worker restart in the same
browser session restores the stored headers by checking that their hashes chain from the newest
built-in hash to that one and re-checking the latest-dated one against the clock, instead of
re-running every check. Changing any stored header breaks
the chain, and the full checks run; after a browser start there is no pin (Chrome empties
session storage when the browser closes), so the first restore runs them.

## What the wallet trusts the RPC for

Signing is local and the RPC can never alter what you sign, but the wallet does trust the
configured node/proxy for **state it displays and builds from**: balances, UTXO sets, history,
and CairnX token state. A malicious RPC cannot redirect funds or forge your approval, but it
could show a wrong balance, hide a transaction, or feed stale/false UTXOs (at worst causing a
rejected transaction or a misleading display, not a key or fund compromise). If that matters
for your threat model, point the wallet at your own node (`http://127.0.0.1:8789`) instead of
the public proxy. Block headers still come from the Cairn API (`/api/headers`) and block bodies
from the node, so a node that follows another chain fails the merkle check and nothing is signed
on its blocks: a reservation fill refuses with `RPC_BLOCK_MISMATCH`, naming the block, the RPC and
the header source (a header source that serves a false header with valid proof of work gives the
same mismatch, so the message does not blame the node); an offer-id fill refuses as
`VERIFY_UNAVAILABLE`; a `.csd` name shows as not chain-verified. A body whose transactions hash to
the verified root but are not written as the node writes them (a `txid` field absent or not the id
the body hashes to, a hash, address or script not `0x` and lower-case hex) is refused the same way:
the codec reads either spelling to the same bytes, so the merkle check alone would pass it while the
wallet compares the served text (test/spv-node-form.test.mjs).

The RPC's tip is served as well. The offer-id fill checks that depend on the chain's height (the V28 sunset
refusal `FILL_LEGACY_SUNSET` and the offer expiry check) compare the largest of that tip, the tip floor the wallet
stored after its last header sync, and the height of the release's newest built-in block hash, which the chain is
past whatever is served. A tip served too low therefore cannot get an offer-id fill of an open CSD offer signed, nor
one of an offer that expired below that height. The wallet's own name renewal is priced at the same height, and so
is the approval window's warning about an underpaid name fee, so a tip served too low cannot price a cheaper fee
tier; with no usable tip and no stored floor the renewal is still refused, and the window's warning prices at the
release's newest anchor, which the window holds without a read. On a fresh install the stored floor is 0 until the
first sync.

The approval window's title for a score-0 attestation (how a site cancels a CairnX offer or bid) also comes from that
RPC: it reads the target proposal, and says "Cancel your offer" or "Cancel your bid" only when the node reports the
account on screen as its proposer. When the read fails, the window keeps "Support / review" and says that score 0
cancels the target if it is your open offer or bid. The signed bytes are the same either way.

The USD figure under the balance is the CSD/USD price the configured Cairn API serves (`/api/market/csd`), multiplied
on the device. It is display only: no amount, fee, check or signature reads it, so a wrong price can mislead a reader
of that line and nothing else. Without a price from the API the line is not shown.

The Activity markers for a transaction not yet seen as included come from that same RPC (its tip,
whether it reports the transaction mined, and its mined coin set), so a lying RPC can show a transaction
that was mined as "not included: its coins were spent by another transaction". The wallet signs and sends
nothing because of a marker, and the marker says to check the explorer before sending again. That marker needs
the RPC to report the transaction definitely not mined and not pending: the Cairn proxy
(`/api/rpc/tx/:id/status`) reports that only when both of its node backends answered their mempool reads in
full, so with a backend down a row keeps the 10-block notice instead; a node on this computer reports it when its
own transaction scan was complete (it has no mempool view to add).

### Sending to a `.csd` name

When you send to a `.csd` name (e.g. `alice.csd`), the wallet treats the CairnX name services as
**untrusted** and checks their answers against the chain itself:

* it runs an **in-wallet SPV light client** anchored by block hashes built into each release (one
  per 4,096 blocks from the names floor, corroborated by three nodes on two hosts and re-derived from
  a second host in CI): a header up to the newest built-in hash is used only if its chunk hash-links
  to those hashes, and every header above it is verified forward (PoW + LWMA difficulty + prev-link).
  Every built-in hash stays a checkpoint for the life of the release: a served chain that contradicts one is
  refused, with no fallback to an older hash, and the wallet says to update or try again later. Above the newest
  built-in hash every header is consensus-checked (PoW, LWMA difficulty, timestamps, prev link). When the served
  chain stops linking to the wallet's stored chain and the wallet re-syncs from the built-in hash, the replacement
  is adopted only if it carries more proof of work than the chain the wallet already verified. Two cases are
  compared with nothing: the first sync of a fresh install (also a wiped store, or a store that cannot open), and
  any chain that extends the stored tip, at any tip age. There a header source (the front door's operator, or
  whoever compromises the front door) can serve a fork whose difficulty it lowered with spread timestamps: above
  the newest built-in hash for about 5 blocks' worth of honest work however long the fork; above a stored tip for
  about one sixth of the honest work per header (7.7 blocks' worth for 30 headers, 161 for 1,000)
  (`docs/DESIGN-namespv-scaling.md`, "Work above the newest anchor", has the derivation). What that reaches: a
  name shown without a later transfer, for the 5 blocks' worth (the forged blocks cannot carry signatures the
  source does not have, and the second name source's records then fail against them, so the result is flagged,
  not green); and a reservation fill with a competing hold hidden from the scan. That fork needs to start only
  just below the hidden hold, because honest headers fill everything below it: for a small fill (claim depth 3, a
  hold placed 3 blocks before the buyer's) it is 6 forged headers, about 3 blocks' worth of honest work, and once
  the front door is controlled it succeeds on every attempt, where the claim-depth rule prices a race on the real
  chain (a miner with a fifth of the hashrate reverses a depth-3 claim 1.563 percent of the time per attempt). It
  needs a wallet whose stored chain ends below the hidden hold; a stored chain that reaches past it is kept unless
  the fork carries more work. Against it, while the scan runs, the wallet asks the second resolver (clarvis, which
  follows its own node) for its verdict on the buyer's own reservation and refuses with `RESERVATION_DENIED` when
  clarvis replayed it and did not apply it; a cancel or fill older than the scan window is covered by its offer
  read (`OFFER_SOURCE_CONFLICT`). When clarvis has read at least 12 blocks past the reservation and does not know
  it, the approval window shows the request again with a warning and asks for "Sign anyway" or "Cancel" before
  anything is signed; the confirmation is bound to that request and reservation and is taken only from the
  extension's own pages (the channel the approval window uses), never from a web page or the content script. Both reads are fail-soft and never waited for past the scan; when the
  reservation read had not answered or failed, the approval window says "Second source not consulted" under the
  sent fill. What remains is
  clarvis down or slower than the scan during the attack; a front door that withholds or delays the buyer's
  fclaim, while clarvis has not yet replayed it (the front door also relays the buyer's submits through
  `/api/rpc`, so it can hold the reservation back, get a competing hold mined first and release the now-denied
  reservation just before the fill); or both hosts compromised. Both hosts are the operator's. Against a header-source
  attacker the "unknown" warning is advisory: the reservation's height is proven against the headers that attacker
  serves, so it chooses the height clarvis's tip is compared with. A second broadcast path for the reservation
  through the second host, if its relay accepts submits, would narrow the withholding case; it is not built. A header-hash comparison with clarvis was considered and not built: it compares at a buried height
  and misses every fill at claim depth 3 to 6 (the design note has both);
  it proves each name record's inclusion against the PoW-committed merkle root;
* it binds each record's signer to the **coin it spends** (the prevout's scriptPubkey must be that
  signer's address), so a hostile block-body provider cannot substitute a foreign-but-valid signature
  to re-attribute a name's owner;
* it fetches name history from **two sources**, the configured CairnX API (default
  `https://cairn-substrate.com/trade/api`) and `https://clarvis.cairn-substrate.com/trade/api`, unions the
  records, and **re-runs the audited CairnX resolver** over the merkle-verified records of that name alone. The
  send target is the address that replay proves, not an address a service states. A service that claims an
  address it has no signed, mined records for does not change where the funds go.

The two default sources are run by **one operator under one registrable domain** (`cairn-substrate.com`).
They are not independent. The union covers one source being stale, lagging, broken or hostile while the other
answers honestly and the wallet can replay that honest source's records: a source can add only real, signed, mined
records, and a record about another name is dropped before the replay. (Before wallet 0.3.2 it was replayed too, and a source that added the owner's reservations of
other names without their finalizes could make the owner's own registration fail the resolver's per-address
reservation limit, so a later rival registration was shown as the owner with a "sources disagree" warning.) When
records about other names do decide a name, the resolver says so (`scopedReplaySufficient: false`) and the wallet
shows the name as not chain-verified, whether the combined replay succeeds or the wallet falls back to replaying each
source alone, and the send's confirm step runs the full check again rather than reuse the review's answer. The union
does not cover that operator hiding a later transfer or a competing claim from both, nor the stale-seller case below.
The wallet's own badge says the name servers share one operator.

**What happens when the sources disagree.** There is no hard refusal on a disagreeing source. The wallet
warns and lets you decide:

* The replay succeeds but a source stated a different address, or reported the name unregistered: the
  wallet uses the proven address and shows a "sources disagree" warning.
* The combined replay fails: the wallet replays each source's records alone. If the sources that replay
  agree on one address, that address is used with the same warning, and when only one source could prove
  it the warning says it is not corroborated. When a source reports the name not provable from its own records,
  or a source's records alone replay and show the name was sold through an offer fill or re-claimed after its lease
  lapsed, there is no such fallback: the name is shown as not chain-verified. A source whose own replay fails for any
  reason (more than 256 records, a block the wallet's node does not serve, a record that does not bind) drops out of
  the fallback. That leaves a stale-seller residual: a hostile source that withholds a later sale and makes the
  combined replay fail, while the honest source's records cannot be replayed, has the seller proven from its records
  alone, shown with the "not corroborated" warning and not cached for the confirm step.
* Nothing can be proven, or the sources prove different addresses: the name is shown as **not
  chain-verified**, the address the name service served is the one shown, and the warning asks you to
  confirm it out-of-band. The send is not blocked.
* A name whose current ownership came through an on-chain **offer fill** or a re-claim after its lease lapsed is
  not shown as verified when the replay shows it (`viaFill`), because for an open-lane claim or a name-for-token sale
  that ownership depends on state outside the name's own history; it gets an explicit caution. The replay shows it
  only when the records it replays include the sale: the stale-seller residual above is the case where they do not.

Decided on 2026-11-18 for names bought on the market: the base of name verification will move from a replay of one
name's records to a full replay of the `cairnx:v1` domain, from a pinned record log plus the complete blocks above the
pin, and the per-name verifier will be retired with that change. The reason is a principle: some resolver rules read
state outside the name, and a replay of one name's records cannot evaluate them, so it can undercount and accept what the
chain refused. Until that change ships, the caution on such names stays as described above
(`docs/DESIGN-viafill.md`, "Decision").

Besides a name that does not resolve at all (unregistered, no address, or the zero address), two cases
refuse: a lease the chain shows has lapsed (or that a resolver reports lapsed and the chain cannot show
current), and a change between review and confirm. At confirm the wallet **re-resolves and
re-verifies** the name and refuses to sign if the address changed or the status dropped from verified to not
verified. The recipient you confirm is always the **full, untruncated address**.

The honest residual: "verified" means **chain-backed as shown** by records the two sources returned; for a
sizable transfer, confirm the `0x…` address out-of-band. (As with every send, the wallet selects its own
inputs and returns change only to your own address.) Not built yet: a name source run by someone else on a
different registrable domain, and per-source block bodies.

## dApp boundary

A web page interacts with the wallet only through the injected `window.cairn` provider,
relayed to the background service worker over same-origin messages. Those page-side messages are
not authenticated: any script running on the page can read and forge them. The boundary is the
wallet's own approval window, bound to the requesting site's origin, and the key never reaches the page.
The window takes no click on Approve or Reject for 700 ms after it shows a request, so a click already in motion or a
double click cannot approve a request the user has not seen. The same floor follows every raise the wallet makes (a
request queued while the window is open, a refused second fill of an offer, the toolbar popup's Review): the worker
asks the window to re-arm and raises it once the window has answered, so a site cannot have the user double-click on
its page, raise the window with the first click and land the second on Approve. A window that has not answered within
250 ms (a hung page) is raised anyway. A focus the user gives the window re-arms nothing, so their own click lands at
once (test/approve-raise-rearm.test.mjs, test/approve-raise-chrome.test.mjs). A refused second fill raises the window
at most once per 5 seconds, whichever site sends it, so a page that repeats one cannot keep Approve and Reject off or
keep pulling the window forward; what remains is one raise and its 700 ms floor per 5 seconds while it repeats
(test/approve-raise-refused-bound.test.mjs).
The provider is injected
on all sites (like MetaMask) so any dApp can request a connection, but injection scope is
**not** the security boundary: the content script only relays requests, exposes no keys, and
`host_permissions` (network access) stays scoped to the node/proxy, not broadened with it.
The provider exposes a fixed set of actions: connect, getAddress, sign in, propose, attest,
sealed claims, **send** (a plain CSD transfer), and **fillOffer** (a CairnX offer fill: one transaction pays
the recipients and records the fill, and CairnX then decides delivery; if it refuses the fill, the payment is not
returned. The wallet checks the fill against the offer's proven record before anything is signed, and holds one
fill request per offer target at a time: a second one, from any site, is refused `FILL_IN_PROGRESS` before it is
queued, until the first is answered. Once the first was sent, another CSD-paid fill of the same target is refused
after approval (`FILL_ALREADY_SENT`, "was sent and is not confirmed yet") while the first is in this
account's history, sent in the last 30 minutes (counted from its last send, so a lost submit's retry restarts them),
not marked gone, and not yet seen applied: listed by the offer service on the offer-id lane, proven by the block scan
on the reservation lane. A retry after a submit whose answer was lost builds the same transaction from the same
unspent coins and is signed and sent again, which cannot pay twice; a retry that would spend other coins is refused
for up to those 30 minutes; a token-priced fill has no such check; docs/DESIGN-fill-lanes.md). The 30 minutes count
from the wallet's last recorded send of that transaction, and two re-sends do not move them: one answered
`SUBMIT_DUPLICATE` while the wallet is locked, since the stored history row is not written while locked; and one whose
history row was parked (recorded while locked, or after a failed storage write) and lost before it was written, since
parked rows live in memory only and a service-worker teardown drops them. In both cases the stored row keeps its
earlier time, and the refusal can end while the re-sent transaction is still unconfirmed.

**Per-origin consent (connected sites).** `connect`/`getAddress` grant *address visibility*:
the first time an origin connects the user approves it, and the origin is recorded as a
connected site (listed and revocable in Settings; removing the extension clears the list). After that, that origin
may read the address without a fresh prompt. This is the **only** silent path, and only when
the wallet is unlocked **and the currently-active address is the SAME one the user consented to
share** (F11): consent is recorded against a specific address, so if the user has since switched
accounts, the silent path falls through to a fresh approval prompt rather than disclose the new,
unconsented address. **Every signing / fund-moving action (signin, signinWithCsd, send, fillOffer,
propose, attest, sealClaim, revealClaim) ALWAYS opens the clear-signing approval window, every time,
regardless of connection state.** Being connected never pre-approves a signature (enforced by
the fast-path guard in `background.ts` + the positive whitelist in `resolvePending`; proven by
`test/extension-boundary.ts` and the source-scan tripwires in `test/pentest.ts` §15). A sign-in request whose
parameters the wallet would refuse at signing (a nonce that is not 8 or more letters and digits, a domain or URI of
another site, an over-long or multi-line field) is answered `BAD_REQUEST` before it is queued, so no window asks the
user to approve something that cannot be signed (test/siwc-prequeue.test.mjs). A proposal or a seal is checked the
same way, by the function the signer refuses it with (`node.ts` `proposeRefusal`, `signfields.ts` `sealFields`): a
malformed payload hash or expiry, a domain or URI that is not a string, has an unpaired surrogate or is past the
network's byte cap, a fee that is not an integer from the network's 0.25 CSD proposal minimum to the 100 CSD cap,
outputs the signer refuses (the zero address included), a seal claim or domain of the wrong type. A send and a fill
are checked by the checks their signer runs before it selects a coin (`node.ts` `sendRefusal`, `fillpreflight.ts`
`fillRefusal`): an output that is not an object, more outputs than the signer takes (500 on a send, 100 on a fill), an
address or amount it refuses (a decimal-string `amount` included), the zero address, a fee that is not an integer
number above zero and at most 100 CSD, a fill target that is not a txid. An attest is checked by the same engine checks
(`node.ts` `attestRefusal`: a proposalId that is not a txid, a fee outside those bounds), or as a fill at the token-fill
confidence, and a reveal's txid must be a string. Across these methods an id or address must be a string and a score
or confidence must not be an object or a list (`signfields.ts`): JSON objects and lists made `String()` and
`Number()` throw or read a list as its one element, in the window and in the codec. Such a request is answered
`BAD_REQUEST` before it is queued and uses no queue slot; none of the site's golden requests and no shape
docs/PROVIDER.md documents is refused (test/propose-prequeue.test.mjs, test/send-fill-prequeue.test.mjs,
test/request-shape-prequeue.test.mjs, test/golden-requests-cards.test.mjs). Each of these checks is a function of the
request's parameters (`prequeue.ts`): it reads nothing and waits for nothing, so the answer is the same whatever the
wallet holds and whether it is locked. Before, a page could queue a request the approval window could not draw (a
send or fill whose outputs held `null`, an attest or reveal whose id was an object), which kept both buttons off and
hid every request behind it; a seeded fuzz now finds no request that passes these checks and fails to draw
(test/request-shape-fuzz.test.mjs). A request the window still fails to draw, in its paint or in the reads it makes
before it paints, is shown as one it could not show, with Approve off and Reject live after the 700 ms floor, also
when it comes back to the head of the queue after another request's paint (test/approve-paint-throw-dom.test.mjs,
test/approve-paint-throw-preread-dom.test.mjs, test/approve-paint-throw-requeue-dom.test.mjs). What stays after
approval, beside the lock and account-change refusals: on every request that spends, the 10% fee cap and the
balance, which need the coins the wallet selects; on a proposal, the node's own rules that csd-sdk does not carry (an empty domain
or URI, an all-zero payload hash), refused by the node at submit with nothing spent, because the wallet does not
re-declare consensus; on a fill, and on an attest at the token-fill confidence, which the wallet signs as a fill, the
fill preflight, which reads the offer, its proofs and this account's history (`fillpreflight.ts`), and a score other
than 100, which is decided on the parameters alone and still queued: the window shows it as refused, and approving
signs nothing (test/sign-display-parity.test.mjs). A `revealClaim` for a txid the active account holds no seal for
opens the window as any reveal does, from every site, and approving it answers `SEAL_UNKNOWN`: nothing a page gets
before the window depends on which seals the wallet holds, since such an answer would let a page test the public seal
commits against the wallet and learn which address the visitor holds. In the sign-in window, the site's
statement is labelled as text from that site, not from the wallet. The legacy `signIn()` is not listed in
`getCapabilities()`: against the Cairn API it succeeds from no origin (that API no longer serves the `/auth/nonce` it
uses; a self-hosted API that still serves it would work), and it
stays refused off the first-party site.

**What the wallet keeps about sites.** Two lists of origins, in `chrome.storage.local` on the user's device, written
and read only by the background worker, which sends neither in any request: the connected sites above (each with the address it was shown),
and the origins the user has approved a request from (`approvedOrigins`, stored with the identifier of the vault they
were recorded under, its PBKDF2 salt), each with when, so the window can say "New site"
when a site the user has approved nothing from asks. A connected site counts as approved. The second list is the
user's own record of which sites they approved something from; it grants nothing, changes no button and adds no wait.
It is display metadata kept apart from everything essential: each queued request carries its flag, decided from memory,
the list is written after the page has its answer on its own queue, and a reset erases the wallet without waiting on
it, so a slow or failing read, write or deletion delays and fails nothing (an unreadable list shows the line). A list
belongs to one vault and reads as empty under any other, so a list from before a reset, whether or not its deletion
succeeded, never marks a site as familiar in the next wallet, and an approval, a write or a load from before a reset
records nothing there, including one that runs while the reset is still clearing the consent map
(test/approve-first-request.test.mjs sections 7 to 9). It keeps the 500 origins approved last (an older one is dropped
and reads as new again) and never holds an opaque origin (`"null"`, `"unknown"`; section 4). Removing the extension
deletes both lists; no screen clears the second one (the wallet's internal reset does). A site cannot read either list
beyond its own connection: storage is restricted to the wallet's own pages and worker
(test/storage-access-level.test.mjs). Each sealed claim
also keeps the origin that asked for it (none for an opaque origin), so the reveal card can say which site sealed it
and caution when another site asks for the reveal.

`send` moves funds to a page-supplied recipient, so the approval window **clear-signs the
full (untruncated) recipient address(es), each amount, the total, the fee, and the
projected balance-after**, and warns on a first-time or look-alike (address-poisoning)
recipient. The wallet always selects its own inputs and returns change to its own address:
a page can pass `{to, amount, fee}` or `{outputs:[…], fee}` but can never choose which
UTXOs are spent, nor redirect the change. Key export, mnemonic/seed reveal, account
management, and RPC/API settings remain reachable **only** from the wallet's own interface;
those methods and `reset` (which no screen offers) are refused on the dApp channel even if a
user approves the dialog
(enforced by the positive method whitelist in `resolvePending`, proven by
`test/extension-boundary.ts`).

A `.csd` profile record (`nprofile`) replaces the name's whole profile, and any site can ask the wallet to sign one, so a
write from one site removes the keys another site wrote. The approval window says so with the request itself: the record
replaces the whole profile and any key not listed is removed. It also lists the keys of the current profile that the
record removes, read from the name record the configured CairnX API serves, never from the requesting site; when the read
fails, times out or the name is unknown, the row says the current profile could not be read. That list is the name
service's answer and display only: Approve arms at its 700 ms floor whether or not the read has answered, a click never
waits for it, and nothing that is signed reads it. A name service that lies can make the list wrong (list keys the name
does not have, or leave out keys it has), never change the record that is signed. The same card is shown for every
origin, the wallet's own site included (test/sign-display-parity.test.mjs section 8).

Some profile keys are read by other applications: `contenthash` (the site they open for the name), `csd.rpc` (the node
address they may read the chain through for the name) and `csd.p2p` (a peer they may dial). A write that sets one gets
a caution saying what it does, and a removed one is marked the same way in "Keys removed"; the sentence that profile
keys do not change where funds go covers the other keys only. The wallet does not check these values, and the
applications that read them are responsible for their own reader rules.

Any site may also ask for a name transfer, an offer or a proposal in any domain, so those cards say what the record
does, from the request alone and with no added read, wait or refusal (test/sign-display-parity.test.mjs section 13).
A name transfer says it is final and clears the name's address record and profile (what the vendored resolver's
`applyNxfer` does). An offer's only taker gets the look-alike check against the wallet's known addresses but no
first-time notice, and an offer that asks nothing in return says the asset goes for nothing. A `cairnx:v1` record the
wallet cannot read is shown raw with a caution that the network may give it no effect and the fee is spent either way;
it is not refused, since it may be a record type newer than the wallet. A proposal in another domain says the wallet
does not interpret it and that it cannot change CairnX names, tokens or offers (CairnX reads `cairnx:v1` proposals
only). The CSD-paid fill card carries the ticker look-alike warning and the unverified-token mark the token-priced card
shows for the same listing.

A name transfer or a profile write takes effect only from the name's owner, on a finalized name whose lease has not
lapsed, and a transfer only while no open offer locks the name. The approval window reads the name's record from the
configured CairnX API after the paint (a profile write shares the read "Keys removed" already makes) and, when the
record gives the name to another address, shows it not yet finalized, lapsed or (for a transfer) locked, or has no
record of it, shows a caution that the fee is spent if that still holds when the record is mined, with Approve
relabelled "Sign anyway". It never refuses and never waits: the served record can be a block behind, and two records
in one block apply in position order, so a transfer to this account followed by its profile write is valid while the
record still names the old owner. Approve arms at its 700 ms floor, a read that has not answered is no verdict, and
the caution does not turn Approve off (test/sign-display-parity.test.mjs section 14). A name service that lies can
add or hide the caution, never change what is signed. Every name check, these cautions and the finalize, renewal and
set-address gates alike, is for the account the window shows: a repaint of the same request for another account (an
unlock after the active account changed) redoes it for that account from the record already read, so a verdict for
one account never stands for another (section 15; before this, a set-address or finalize judged for the name's owner
left Approve live for an account that would pay the fee for nothing). A click is bound the same way: one that waits
for a finalize, set-address or renewal check is abandoned, with nothing signed and the request still queued, when the
window repaints the request before the check answers, so it never acts on a verdict another paint computed for another
account (section 16). With the caution, a long "Keys removed" list (the honest
maximum, 16 keys of 32 characters) can run past the buttons; the caution and everything before the list stay above
them and the line under the buttons says more is below.

## Supply chain

The wallet has a small, pinned dependency set (`@noble/curves`, `@noble/hashes`,
`@scure/bip32`, `@scure/bip39`), installed with `npm ci --ignore-scripts` (no install-time
lifecycle scripts run). The trust-sensitive SPV code is a **vendored bundle** built from the published
csd-sdk packages (`@inversealtruism/csd-light`, `csd-client`, `csd-codec`, `csd-crypto`, `cairnx-core`),
pinned to exact versions as dev dependencies, with each tarball's registry integrity in `package-lock.json`.
The bundle (`src/vendor/cairnx-spv.js`) and its types (`cairnx-spv.d.ts`, generated from the same export
list) are committed; `PROVENANCE.json` pins both files' sha256, each package's version and integrity, and the
exact `@noble` versions. The gate is `scripts/check-vendor-fresh.mjs` (`npm run verify:vendor`), run by the
`test` job in `ci.yml` and the `build` job in `release.yml`, which the release job depends on:

* **Rebuild byte-diff:** both files are rebuilt from the installed packages into a temporary directory and
  must be byte-identical to the committed ones. No csd-sdk checkout is involved, so it runs wherever
  `npm ci` ran.
* **Pins:** the committed files' sha256, the package versions and integrity, and the `@noble` versions must
  equal `PROVENANCE.json`, and the wallet's `@noble` pins must equal the versions csd-crypto declares, so the
  bundle's crypto and the signing path use the same `@noble`.

Releases are built in CI from tagged source with `npm ci` and a deterministic zip writer, so they are
**byte-for-byte reproducible**: rebuild from the same source and the SHA-256 matches the published
release. Every release carries a SLSA build-provenance attestation; the release job fails if it
cannot be produced. The jobs that run repository code (the install, the tests, the packager, the vendor
rebuild) can only read; the one job that holds the attestation and release permissions checks nothing out and
installs nothing: it downloads the zips the build job produced, checks them against their `.sha256` files,
attests and publishes them (`test/release-workflow-permissions.test.mjs` pins the split).

## Publishing & updates

The wallet's defenses (SPV name-verify, clear-signing, the dApp boundary) run **inside the
extension**, so a malicious auto-update would disable them all at once. That makes the Chrome Web Store
publish credential the highest-blast-radius asset (cf. the Trust Wallet Dec-2025 leaked-CWS-key drain).
The project has a **single maintainer**, so there is no two-person control on what is tagged or uploaded.
What exists instead: the CWS upload is a **manual step, deliberately off CI** (a CI-resident store key is
exactly what supply-chain worms scrape), behind hardware-2FA; the uploaded zip must have the same sha256 as
the zip CI built and attested from the tag; and after publication the CRX the store serves is downloaded
and compared with that attested zip. Anyone can run that comparison for the version the store serves
(step 8 of the runbook). The full procedure is in `store/PUBLISH-RUNBOOK.md`.

## Verification

The signing core is tested against external ground truth: the transaction codec matches the
CSD consensus golden vectors, a real on-chain signature verifies against an independently
recomputed sighash, and the core produces transactions the live node accepts.
