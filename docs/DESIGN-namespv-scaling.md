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
