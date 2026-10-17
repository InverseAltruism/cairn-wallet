# Design note: the SPV header store and the release anchor table

Status: built (0.2.99 line), 2026-10-17. The plan with the measurements, the review history and the owner
decisions is cairn `docs/Plans/86-wallet-0299-2026-10.md` (sections 3 and 6). This note says what the code does
and which invariant it keeps. It replaces the 2026-07-20 snapshot-scaling roadmap, which is in git history.

## What it is for

A `.csd` name proof and the fill lanes need the verified block header at the exact height of each record they
prove, from the names floor (29,960) up. Headers live in the extension's IndexedDB (`cairn-wallet-spv`, version
1), as 84-byte records (`serializeHeader`), in chunks of 4,096 heights: chunk k covers 4,096k to 4,096k + 4,095,
and chunk 7 starts at 29,960. A `meta` row `head` (`{ v: 2, tip, tipHash }`) is a hint; the chunk keys present are
the truth. Code: `src/core/headerstore.ts` (store, LRU, acquisition), `src/core/namespv.ts` (`liveSpvSource`:
restore, routing, sync, migration), `src/core/spvanchors.ts` (the table, generated).

## The anchor rule

`src/core/spvanchors.ts` carries `SPV_FLOOR` (29,960 and its hash) and `SPV_ANCHORS`: entry i is the hash at height
4,096 x (7 + i) + 4,095. It is generated per release by `scripts/update-spv-anchors.mjs` from an anchor that
cairn's `bump-swapguard-cp.mjs --emit-json` corroborated on the node, the miner and clarvis, by walking the
served headers up from the floor pin through the vendored light client; the `anchors` job in
`.github/workflows/release.yml` re-walks the whole table from clarvis's public `/api/headers` and checks every
entry on the front door's RPC. The release runbook (`store/PUBLISH-RUNBOOK.md` step 2) regenerates the table for
every tag; the job gates the tag and also runs on PRs that touch the table, its generator or the bundle. It fails
when the newest entry is more than 6,000 below the public tip or less than 1,000 below it.

The rule the code keeps:

- A header at or below the newest anchor is used only from a chunk whose records hash-link, in this session, to
  its two table hashes: the previous chunk's entry (or, for chunk 7, the floor pin as the first record's hash) and
  its own entry as the hash of its last record (`verifyLinkedRecords` in csd-light, called by `verifyChunk`).
  Nothing is adopted on the store's or the head's say-so.
- Above the newest anchor, headers come only from the light client, seeded with the last 46 records of the anchor
  chunk (`LightClient.fromRecords`: hash, prev link, PoW, pins) and synced forward with every consensus check
  (prev link, time rules including the 2-hour future drift, LWMA bits, PoW). The stored suffix is restored through
  the same `ingest`, so a record stored in the profile is checked like a served one.
- Above the newest anchor the guarantee is checkpoint-bound, consensus-checked headers: each header must pass the
  consensus checks against its parent. A reseed (after a sync that no longer links to the stored tip) replaces the
  held chain only when the fresh client's cumulative work exceeds the held one's (`reseedAdopts`, the vendored
  `tryReorg` max-work rule; both clients are seeded from the same anchor records, so the totals are comparable);
  otherwise the refusal is "the block headers from <headers source> above height N carry less proof of work than
  the chain this wallet already verified to height M; the wallet keeps its verified chain. Try again later." and
  the held chain and its stored suffix stay. A fresh install has no chain to compare with, and a chain that extends
  the stored tip is never compared with anything: what a header source can still do there, and what a work floor
  would and would not change, is the section "Work above the newest anchor" below.
- The light client gets every table entry, floor included, as a checkpoint (`SPV_CHECKPOINTS`), for the life of
  the release. No code path removes, skips or overrides an entry. The `anchors` option of `liveSpvSource` takes only
  a prefix of the release table (tests and the acceptance harness); the light client still gets the full map
  (`test/namespv-anchor-prefix.test.mjs`).
- A served chain that contradicts an entry fails closed: the store is kept, and the reason is "the wallet could not
  match the chain to its built-in checkpoints (height N); update the wallet or try again later". There is no
  fallback to an older entry, which would let whoever serves `/api/headers` choose the pins.
- Nothing below 29,960 is stored or fetched. A name-history hint below it is dropped and the verdict flagged
  `disagree` (`fetchNameUnion`) rather than failing the replay. A source whose hints all sit below the floor is
  left with none, so when no source has a hint above it the verify has nothing to prove and fails.

## What runs when

At start (`liveSpvSource`): open the store (any failure runs the session in memory), list the chunk keys, read the
head. If the store has no head and the pre-store `spvHeaderChain` snapshot exists in `chrome.storage.local`, migrate
it: each anchored chunk it covers is walked and written, the suffix above the newest anchor goes through
`fromRecords`, the head is written and read back, then the snapshot is deleted. A snapshot over 200 MB is deleted
unread; after three failed migrations it is deleted and the session runs from memory. Then acquire the newest
anchor's chunk (store, or one `/api/headers` request per 512-aligned page: 8, or 6 for chunk 7), seed from it, and restore the stored chunks above it.

Per proof (`prepare`, `blockAt`, `hashAt`, `merkleAt`): `prepare(h)` syncs to the lower of the node tip and h + 12,
one 512-aligned page at a time; when the node tip cannot be read it syncs nothing and returns `tipKnown: false`
(the fclaim fill lane refuses on that, since it needs burial to the tip). A height above the newest anchor reads
the light client. A height at or below it acquires that one height's chunk under the sync serializer: the LRU of 8
verified chunks, else the store with a walk, else its aligned pages from `/api/headers` with a walk, then stored and cached. A chunk
that fails its walk on load is deleted and refetched; a fetched chunk that fails is refused with the checkpoint
copy naming the chunk. Store writes are detached from the proof path and merged; a write failure is warned.

A structural sync failure (an ordinary reorg in the suffix) reseeds from the anchor chunk in memory and syncs
again; the stored suffix is replaced only after the new one verifies to the sync target and carries more cumulative
work than the held chain (`reseedAdopts`). If the served headers still fail above the anchor, the refusal is "the
wallet could not verify the block headers from <headers source> above height N: they do not pass the chain's checks.
Try again later."; the light client's own reason is logged. A clock more than 2 hours behind a header stops with a
reason that names the clock, and the store is kept. The reseed costs the suffix's pages again (one request per 512
headers above the anchor) and the fresh client's verification of them, and nothing below the anchor; the held chain
keeps serving proofs while it runs. The honest cases it covers (test/namespv-store-pins.test.mjs, case 2): a page
that breaks once, a stored suffix the served chain has outgrown (the served chain has more work and is adopted), a
corrupt or short stored suffix (the restore stops below the bad record and the ordinary sync continues from there;
no reseed is needed). A deep reorg below the stored suffix is the same path with the honest chain carrying more
work; a lower-work replacement is refused (test/namespv-reseed-work.test.mjs states what that test can and cannot
show offline).

The `anchors` job (`release.yml`) walks the chain from the floor's page to the newest entry on every tag: one
`/api/headers` page per 512 heights plus one RPC check per entry, paced at 550 ms, under a 15-minute job timeout.
At tip 121,667 that is 197 requests (2.8 minutes at the 0.85 s per request measured on 2026-10-13); the count
grows by one page per 512 blocks, so the timeout is reached near tip 513,000 at that rate (about 544 days after
2026-10-17 at 720 blocks a day) and near tip 776,000 on pacing alone. Before then either the timeout is raised (a
public repository's minutes are free) or the check walks from the previous release's newest entry, which the
previous release's run already derived from the floor.

## Work above the newest anchor

Above the newest anchor the light client checks each header against its parent (prev link, time rules, LWMA bits,
PoW) and, on a reseed, compares the fresh chain's work with the held chain's. It compares a chain with nothing else:
a fresh install has no held chain, and a chain that extends the stored tip is accepted header by header.

What a header source can do with that. The vendored difficulty rule (`expectedBitsFromWindow` in
`src/vendor/cairnx-spv.js`: the next target is the 45-header window's mean target times its weighted mean
solvetime, each solvetime counted as at least 1 s and at most 1,440 s, over the 120 s block time) lets timestamps
lower the difficulty. A source that dates every header 1,440 s after its parent raises the target to 1.5, 2.0, 3.1
and 7.3 times the honest one after 1, 2, 3 and 5 headers, 44 times after 10, 374 times after 20, and reaches the
minimum difficulty (17.8 million times the target at tip 121,667) after 77 headers; those 77 headers carry 4.58
blocks' worth of work at the honest difficulty, and every header after them carries about none. The 77 headers
need 30.8 h of timestamp room; the time rules (`checkTimeRules`: 60 s minimum spacing, median time past, at most
2 h ahead of the wallet's clock) bound that room by the clock, so such a fork can start from any verified header
that is at least 28.8 h old. (Simulated on 2026-10-17 from the rule as vendored, with the bits at tip 121,667;
Plan 86, D-86-9.)

The two cases the reseed rule does not reach:

- A fresh install, a wiped store, or a wallet restored from its seed on another machine: the chain is seeded from
  the newest anchor, which is at least 1,000 blocks (33 h) old at tag time and ages for the life of the release.
  A fork from the anchor can be decayed and extended to any height the source names, for about 5 blocks of honest
  work; the wallet syncs to the lower of the served node tip and the proof's height plus 12, both from that source.
- An installed wallet whose verified tip is older than about 29 h: a fork grafted onto that tip decays the same
  way, links to the stored chain, and is synced forward like an honest advance. No reseed runs. A wallet synced
  within the last day leaves 2 to 26 h of room, so a fork from its tip must mine most of its headers at or near
  the honest difficulty, which takes hashrate, not a header source.

Who can do it: whoever answers the wallet's `/api/headers` and `/api/rpc` (the front door's operator, or whoever
compromises the front door); the node tip comes from the same source. What it reaches: for names, withholding
only, since the forged blocks cannot carry an owner's signature the source does not have, and the second name
source's records then fail against them, so the result is flagged rather than green; for reservation fills, a
competing hold or cancel hidden inside the fclaim scan window, which the second-resolver offer check covers only
when clarvis answers in time (`OFFER_SOURCE_CONFLICT`).

A minimum-work floor was considered for the fresh-install case (Plan 86 D-86-9 part 2) and is not built:

- The candidate of the plan, the table carrying the cumulative work at each anchor and a served chain refused when
  its work above the newest anchor is implausibly low for its height span, is bypassed by a short chain: the source
  also serves the node tip, so the forged chain can be 78 headers long (77 to decay, one dated now) with 4.6 blocks
  of work over a 78-block span, which no floor tolerating an honest 17-fold difficulty fall refuses. The table
  change buys nothing.
- A floor against elapsed time instead (the work since the anchor, against the anchor-era work per block times the
  seconds since the anchor's timestamp, both read from the verified anchor chunk, so no table change) cannot be
  shortened away: the forged chain's work stays near 4.6 blocks while the anchor ages, so over an anchor age of
  33 h it looks like an honest chain whose hashrate fell 215-fold, 1,096-fold at 7 days, 4,696-fold at 30 days. A
  floor tolerating an F-fold fall refuses the forged chain once the anchor is older than 552 x F seconds (F = 100:
  15 h; F = 1000: 6.4 days) and refuses every honest chain whose hashrate, averaged since the anchor, fell more than
  F-fold. The simulated honest collapse by a factor f shows exactly an f-fold work shortfall at every age (f = 10,
  100 and 1,000 at 33 h, 7 days and 30 days), so no F separates a forged chain from an honest collapse of the same
  factor: a floor that catches a header source with hashrate H/F also refuses an honest chain running at H/F.
- On this chain one coinbase address mined all 300 blocks from 121,368 to 121,667 (read from the node on
  2026-10-17). If that miner stops, the remaining hashrate, and with it the honest fall factor, is unknown and can
  exceed any F; the floor would then refuse every fresh install's name verification and reservation fill until a
  release re-anchors, for an event the wallet should survive. That is a new refusal on an honest path, so the floor
  is not built. Built, it would have been about 20 lines in `prepare` plus a test, no table change and no request.

What would close both cases: a second header source on another host for a fresh install's first sync and for an
extension past a stale tip (one request for the hash at the synced height from clarvis's public `/api/headers`,
refuse on a disagreement, proceed with the result flagged when it does not answer). That is the two-source pattern
the name path uses, fail-soft, and not independent of the operator (one registrable domain). Not built in 0.2.99;
recorded for the owner with D-86-9.

## Callers and their tests

| Caller | Test |
|---|---|
| `replayName` (`blockAt` per hinted height) | `test/namespv-store-restore.test.mjs` (a real name in chunk 7, write volume), `test/namespv-hints-floor.test.mjs` (hint floor, case 19) |
| the fclaim lane's offer block (`fillspv.ts` `bindBlock`) | `test/fillspv-store.test.mjs` |
| the V29 other offer (`provenClosed`) | `test/fill-holds-v29.test.mjs` (the real offer at 30,332 below the anchor) |
| `provenOfferPayto` | `test/fillspv-store.test.mjs` |
| the confirm-time skip (`hashAt`) | `test/namespv-hints-floor.test.mjs` |
| restore, pins, reorg, clock, corrupt chunks, concurrency, migration | `test/namespv-store-pins.test.mjs`, `test/namespv-store-migrate*.test.mjs`, `test/headerstore*.test.mjs` |
| the reseed's work rule (`reseedAdopts`) | `test/namespv-reseed-work.test.mjs` (the rule on bigint work and on two light clients over real headers; the use-site), `test/namespv-reseed-recover.test.mjs` (the reseed order) |
| an unreadable node tip (SPV-5) | `test/spv-unknown-tip.test.mjs` |

## Invariants

- No stored header is used without its walk to the table or its forward verification in the same session. This is
  the storage-poisoning defence: the profile is writable by whoever can write it, and a poisoned store can at most
  cost a refetch.
- The floor (29,960) does not move: a name event at height h needs the verified header at exactly h.
- Store and network failures degrade to "no cache this session" or a refetch, not to a refusal of a send that
  would otherwise verify. The exception is an unreadable node tip (SPV-5): nothing is synced, so a name record above
  the verified tip shows as not verified for that call, and a reservation fill refuses as retryable.
- Consensus math stays vendored (csd-sdk through the PROVENANCE-pinned bundle).
- The cost of a start follows the suffix above the newest anchor, so the table must be refreshed per release
  (`store/PUBLISH-RUNBOOK.md` step 2), and the `anchors` job refuses a tag whose table is stale.
