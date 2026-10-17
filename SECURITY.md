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
* **In memory only while unlocked.** The decrypted key lives only in the background service worker and is cleared by a 15-minute idle auto-lock.
* **Storage closed to web pages.** At start the service worker restricts both `chrome.storage.local` (the vault ciphertext) and `chrome.storage.session` to the extension's own pages and worker (`TRUSTED_CONTEXTS`), so the content script that runs on web pages cannot read or write them.
* **Local signing.** The wallet builds each transaction, computes its `CSD_SIG_V1` sighash, and signs it on your device. Only the finished transaction is sent to the node. The wallet never signs a digest handed to it by a server, so a malicious or intercepted RPC cannot redirect funds or change what you approved. The "sign in with CSD" digest is structurally distinct from a transaction sighash, so a hostile site cannot turn a sign-in into a spend.
* **Deterministic, non-malleable signatures.** secp256k1 with RFC 6979 nonces and low-S enforcement.

The wallet also declares the `unlimitedStorage` permission. Its trustless `.csd` name
verification keeps block headers in the extension's own IndexedDB database (84 bytes per header,
in 4,096-header chunks), which grows with the chain; without the permission the header store
would eventually hit the quota and degrade verification. Everything stays local to the device and
nothing is transmitted; the vault is unaffected. A poisoned store cannot forge verification: a
stored chunk is used only if its headers hash-link to the block hashes built into the release,
and the headers above the newest built-in hash are re-verified on load (PoW, LWMA difficulty,
timestamps), so storage tampering can at worst force a re-fetch.

## What the wallet trusts the RPC for

Signing is local and the RPC can never alter what you sign, but the wallet does trust the
configured node/proxy for **state it displays and builds from**: balances, UTXO sets, history,
and CairnX token state. A malicious RPC cannot redirect funds or forge your approval, but it
could show a wrong balance, hide a transaction, or feed stale/false UTXOs (at worst causing a
rejected transaction or a misleading display, not a key or fund compromise). If that matters
for your threat model, point the wallet at your own node (`http://127.0.0.1:8789`) instead of
the public proxy. Block headers still come from the Cairn API (`/api/headers`) and block bodies
from the node, so a node that follows another chain fails the merkle check and nothing is signed
on its blocks: a reservation fill refuses with `RPC_BLOCK_MISMATCH`, naming the block and the RPC;
an offer-id fill refuses as `VERIFY_UNAVAILABLE`; a `.csd` name shows as not chain-verified.

The Activity markers for a transaction not yet seen as included come from that same RPC (its tip,
whether it reports the transaction mined, and its mined coin set), so a lying RPC can show a transaction
that was mined as "not included: its coins were spent by another transaction". The wallet signs and sends
nothing because of a marker, and the marker says to check the explorer before sending again.

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
  approval window, never from a page. Both reads are fail-soft and never waited for past the scan, so what remains is
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
  records, and **re-runs the audited CairnX resolver** over only the merkle-verified ones. The send target is
  the address that replay proves, not an address a service states. A service that claims an address it has
  no signed, mined records for does not change where the funds go.

The two default sources are run by **one operator under one registrable domain** (`cairn-substrate.com`).
They are not independent. The union covers one source being stale, lagging or broken; it does not cover
that operator hiding a later transfer or a competing claim from both. The wallet's own badge says the name
servers share one operator.

**What happens when the sources disagree.** There is no hard refusal on a disagreeing source. The wallet
warns and lets you decide:

* The replay succeeds but a source stated a different address, or reported the name unregistered: the
  wallet uses the proven address and shows a "sources disagree" warning.
* The combined replay fails: the wallet replays each source's records alone. If the sources that replay
  agree on one address, that address is used with the same warning, and when only one source could prove
  it the warning says it is not corroborated.
* Nothing can be proven, or the sources prove different addresses: the name is shown as **not
  chain-verified**, the address the name service served is the one shown, and the warning asks you to
  confirm it out-of-band. The send is not blocked.
* A name whose ownership was decided by an on-chain **offer fill** (an open-lane claim or a name-for-token
  sale) is never shown as verified, because that ownership depends on state outside the name's own
  history; it gets an explicit caution.

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
The provider is injected
on all sites (like MetaMask) so any dApp can request a connection, but injection scope is
**not** the security boundary: the content script only relays requests, exposes no keys, and
`host_permissions` (network access) stays scoped to the node/proxy, not broadened with it.
The provider exposes a fixed set of actions: connect, getAddress, sign in, propose, attest,
sealed claims, **send** (a plain CSD transfer), and **fillOffer** (an atomic CairnX
delivery-versus-payment fill, preflighted against the resolver before anything is signed).

**Per-origin consent (connected sites).** `connect`/`getAddress` grant *address visibility*:
the first time an origin connects the user approves it, and the origin is recorded as a
connected site (listed and revocable in Settings; removing the extension clears the list). After that, that origin
may read the address without a fresh prompt. This is the **only** silent path, and only when
the wallet is unlocked **and the currently-active address is the SAME one the user consented to
share** (F11): consent is recorded against a specific address, so if the user has since switched
accounts, the silent path falls through to a fresh approval prompt rather than disclose the new,
unconsented address. **Every signing / fund-moving action (signin, send, propose, attest,
sealClaim, revealClaim) ALWAYS opens the clear-signing approval window, every time,
regardless of connection state.** Being connected never pre-approves a signature (enforced by
the fast-path guard in `background.ts` + the positive whitelist in `resolvePending`; proven by
`test/extension-boundary.ts` and the source-scan tripwires in `test/pentest.ts` §15).

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

## Supply chain

The wallet has a small, pinned dependency set (`@noble/curves`, `@noble/hashes`,
`@scure/bip32`, `@scure/bip39`), installed with `npm ci --ignore-scripts` (no install-time
lifecycle scripts run). The trust-sensitive SPV code is a **vendored bundle** of csd-sdk's audited
dists (`src/vendor/cairnx-spv.js`); `PROVENANCE.json` pins its sha256, the exact `@noble` versions,
and the csd-sdk **version and source commit**. The gate is `scripts/check-vendor-fresh.mjs`:

* **Load-bearing:** the rebuild byte-diff. CI checks out csd-sdk at the pinned commit, rebuilds the bundle
  and requires it to be byte-identical to the committed one (the `vendor-fresh-full` job in `ci.yml`, and
  in `release.yml`, where the release job depends on it). csd-sdk is public, so CI checks it out without a
  token and the job runs on every push, pull request and tag; locally it needs a csd-sdk checkout.
* **Always on, cheap:** the committed bundle's sha256 equals `PROVENANCE.json` and the `@noble` pins agree,
  so a bundle edited without a matching `PROVENANCE.json` change fails even without csd-sdk present.
* **Advisory only:** the check that the csd-sdk checkout's HEAD equals `csdSdkCommit` prints a warning and
  does not fail the gate. In CI it compares the pinned commit with itself, since that is the commit checked out.

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
(step 7 of the runbook). The full procedure is in `store/PUBLISH-RUNBOOK.md`.

## Verification

The signing core is tested against external ground truth: the transaction codec matches the
CSD consensus golden vectors, a real on-chain signature verifies against an independently
recomputed sighash, and the core produces transactions the live node accepts.
