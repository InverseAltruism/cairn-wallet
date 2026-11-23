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
  the same `ingest`, so a record stored in the profile is checked like a served one, except on a worker restart
  inside a browser session that already verified it (the section "Session pin" below).
- Above the newest anchor the guarantee is checkpoint-bound, consensus-checked headers: each header must pass the
  consensus checks against its parent. A reseed (after a sync that no longer links to the stored tip) replaces the
  held chain only when the fresh client's cumulative work exceeds the held one's (`reseedAdopts`, the vendored
  `tryReorg` max-work rule; both clients are seeded from the same anchor records, so the totals are comparable);
  otherwise the refusal is "the block headers from <headers source> above height N carry less proof of work than
  the chain this wallet already verified to height M; the wallet keeps its verified chain. Try again later." and
  the held chain and its stored suffix stay. A fresh install has no chain to compare with, and a chain that extends
  the stored tip is not compared with anything: what a header source can still do there, and what a work floor
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

Per proof (`prepare`, `blockAt`, `hashAt`, `merkleAt`): `prepare(h)` waits until the verified tip reaches the lower
of the node tip and h + 12; when the node tip cannot be read it syncs nothing and returns `tipKnown: false` (the
fclaim fill lane refuses on that, since it needs burial to the tip). A height above the newest anchor reads
the light client. A height at or below it acquires that one height's chunk under the sync serializer: the LRU of 8
verified chunks, else the store with a walk, else its aligned pages from `/api/headers` with a walk, then stored and cached. A chunk
that fails its walk on load is deleted and refetched; a fetched chunk that fails is refused with the checkpoint
copy naming the chunk. Store writes are detached from the proof path and merged; a write failure is warned.

## The sync and its runner

One runner per source syncs the light client (`liveSpvSource`, `syncPages`). It holds a target height for the run:
a `prepare` raises it to its own height and waits until the verified tip gets there, and `background()` raises it to
the node tip. A run that stops short leaves no target behind: the next run's target is what is asked then (runner
4b). Code: the runner, `lookupReseed`, `boundedReseed` and `adopt` in `liveSpvSource`; tests:
`test/namespv-sync-runner.test.mjs`, `test/namespv-reseed-bounded.test.mjs`, `test/namespv-dropped-source.test.mjs`,
`test/fill-dropped-source.test.mjs`.

- Requests: a window of up to five 512-aligned pages is requested at once, each request ending on a page top or at
  the window's aim, as a sequential sync would make them. The width adapts to the link: a source asks two pages at
  first, one more after each page that answered within a quarter of its 15 s timeout, and one after a timeout
  (`IN_FLIGHT` 5, `WIDEN_WITHIN_MS`; runner 1 and 1b). Five leaves one of Chrome's six HTTP/1.1 connections to the host
  free for the balance and a send, which go to the same host. While a lookup waits, each window aims at the lookup's
  height (runner 2b). Pages may arrive in any order; the rows are ingested strictly by height, one page per serialized
  op, so a lookup's or a fill's reads (a chunk acquisition, a sealed read) run between pages. A page's ingest and the
  rebase's re-ingest of the held headers (once the client holds 65,536) yield to the worker's other tasks every 128
  headers (`ingestSliced`), through a MessageChannel task (a nested `setTimeout(0)` waits 4 ms in Chrome; in Node, the
  tests' runtime, through `setImmediate`), so a balance or a send is answered between slices (netgate 1 and 2). Each request keeps its own ladder (15 s, Retry-After on 429, the 502 and
  503 retries); a page that fails fails the sync once the pages below it are ingested, and the other pages of its
  window are cancelled. A request's signal follows the source's, its window's and its own timeout through one helper
  (`following`), not `AbortSignal.any`, which not every engine the manifest admits has; the listeners it adds go when
  the request settles (test/namespv-no-signal-any.test.mjs). After each window the verified tail is persisted (a detached write), so a worker stopped
  mid-sync resumes from the last window whose write had committed, and asks again only what it had not stored
  (runner 3).
- The foreground first (`netgate.ts`): the requests a user waits on are counted while in flight: the balance, a
  send's coins, their source transactions and the submit, the node tip, the name service, a lookup's or a fill's
  block and transaction reads (all through `foregroundFetch`), and a lookup's own header pages and chunk reads. A
  background page starts only once none has been in flight for 250 ms (`QUIET_MS`), and a background page in flight
  when one starts is cancelled and asked again later; once a lookup waits, the run's pages at or below its height are
  its pages and wait for nothing, and those above it (a window planned for the background aim before it arrived) stay
  background, so they do not share the link with the lookup's (netgate 5c), and the page that holds its height is
  asked only up to it, as a sync to that height asks it; a page answered short ends its window (netgate 5d). The background run's own node tip read is not counted. A counted request stops counting after 30 s
  (`HOLD_MAX_MS`), above the longest timeout one wallet request carries (a submit's 20 s), so one that does not settle
  does not hold the background sync. A compound foreground read can run longer (a chunk acquisition's 8 pages, one
  after another; a lookup's page with its retry ladder): it too stops counting at 30 s, and the background may then
  start a page while it is still in flight. The USD line is read in the worker (`market.ts`) and is not counted (it
  is display only); the popup's and the approval window's own reads (the domain list, a name record) run in their own
  contexts and are not counted either (netgate 3 to 6). A listener or a waker of the gate that throws is logged and
  the request's own answer or error is what its caller gets (netgate 7).
- The background run: the popup sends `prewarmSpv` once the balance has answered or failed (`popup-render.ts`), and
  the wallet's `syncSpv` builds the source and starts the run to the node tip, unlocked only (locked, and from the
  install hook, `prewarmSpv` builds the source and syncs nothing). So no header request goes before the balance
  request at unlock. No run starts within 60 s of the previous one (`BACKGROUND_GAP_MS`), with `navigator.onLine`
  false or with Save-Data on; a lookup then syncs on demand.
- A transient failure (a timeout, a 429 or 50x after the ladder, a non-dense page) persists the verified tail,
  refuses the lookups that were waiting above the reached tip when it was caught, with today's error, and stops the
  run; a lookup that arrives while the tail is persisted waits for a run of its own (test/name-source-dropped.test.mjs
  4, test/fill-dropped-source.test.mjs 5), and the next lookup or background run resumes from the tip. A clock fault
  refuses with the clock named.
- A structural break (a page that does not link to the held tip or fails a check) gets one reseed per run. One
  function seeds a fresh client at a seed: the newest sealable top this source verified (from the seal list, its own
  chain or a rebase), with the 46 records ending there from memory or from that sealed chunk, or the table's newest
  entry from the anchor chunk in memory. One decision adopts it: the fresh chain verified above the held tip and
  carries more work counted from the same base (`adopts`, `reseedAdopts`), so the held tip never falls
  (reseed-bounded 4, 5 and 5b, the last a more-work chain stopped below the held tip). With a lookup
  waiting, the reseed runs from the newest seal and, when the served chain does not link there, from the table, to
  the lookup's height and on to the node tip when the work is undecided there, as before; a refused chain gives
  today's refusals. With no lookup waiting it is the bounded reseed: from the newest seal, or from the table while
  the held tip is at most 8,191 above it (`RESEED_BOUND`), to at most 17 pages (`BOUNDED_PAGES`); anything else, and
  any failure of it, stops the run without a refusal and waits for a lookup, so the background never runs the
  unbounded table reseed (reseed-bounded 2). It yields to a lookup that arrives while it runs: its pages stop, the
  chain it reached goes to the adoption site, which refuses it below the held tip whatever its work (5b), and the
  lookup's own reseed runs next, so the lookup's wait is its own work (6b). What one background run can cost a
  hostile header host's target: the window that broke (at most `IN_FLIGHT` pages), the reseed (at most
  `BOUNDED_PAGES`) and, after an adoption, the rest of the way to the node tip; 22 requests and about 3.6 MB before an
  adoption (166 kB a page: 36,982,177 bytes over 223 pages measured), at most one run a minute while the popup is open.
  After a background reseed that was refused or failed (not on a transient failure, a drop or a yield to a lookup),
  the source starts no background run for 2 minutes (`RESEED_BACKOFF_MS`), doubled after each further one up to 32
  minutes (`RESEED_BACKOFF_MAX_MS`); an adoption ends it, and so does a run that reaches its target on the held chain
  with no reseed, such as a lookup's once the hostile host is gone (reseed-bounded 8d); a lookup's run and reseed do
  not wait for it. Against a
  host whose chain the reseed refuses, an hour of an open popup then starts 5 runs (minutes 0, 2, 6, 14 and 30) with
  107 page requests (reseed-bounded 8); without it each of the 60 prewarms runs, with 1,317 page requests (the same test with the back-off removed). A transient failure in a run
  or in its reseed backs nothing off (8b, 8c). The back-off lives with the source, so a new worker starts without it.
  It reads the wall clock (`Date.now()`): after a backward jump the wait left is capped at the back-off itself, so no
  background run waits more than about 33 minutes with the 60 s gap, and nothing of it is stored.
- One adoption site, serialized: it waits for the acquirer's pending writes, takes the fresh client, deletes the LRU
  entries above the seed chunk, keeps the remembered tops at and below the seed (none for a table seed) and rewrites
  the store from the chunk above the seed. A seal seed's tops are the adopted chain's own, since it links to the
  seed's top.
- A dropped source (the wallet aborts its `signal` on an endpoint change, a vault change or a reset) requests no
  further page and writes nothing: no chunk, list, head, session pin, lapse floor or migration step. Each request and
  each write checks the source at the moment it would go out (after the seal key's await, in the detached writer and
  the acquirer's queue, in the catch-up and the migration); its requests in flight end with its signal and their
  retries stop; a page that answers after the drop is not ingested (test/namespv-dropped-source.test.mjs, one case per
  site and 50 drops at random points). Its waits above its tip are refused at once, as 0.3.5 answered `prepare` only at
  a height it reached, and the fill's burial scan also refuses verified headers that stop below the node tip it read
  (`servedTip`; test/fill-dropped-source.test.mjs, on the real `Wallet.fillOffer`, 4 with the drop during the buy's
  own node tip read). A dropped source reports it (`dropped()`), and a union replay that failed on it runs no
  per-server recovery there: it answers only at heights it verified, where a lagging name server's records can replay
  to an earlier holding while the union's records above its tip go unread. A name lookup whose source was dropped
  under it asks the current source once more (`names.ts` `verifyName`, one retry), as 0.3.5's old source went on to
  verify; an answer given while the generation moved is kept only when it is a clean union success (all records
  verified, none recovered). A second drop during that retry leaves the address unverified with the caution, where
  0.3.5 verified it (test/name-source-dropped.test.mjs 1 to 2b, test/spv-endpoint-race.test.mjs 5 to 5c). A buy
  keeps the refusal. A restore or catch-up parked on the
  unlock signal ends without work. The headers of one run and its reseed therefore come from the one host the source
  was built on; a host change builds a new source (there is one header host per configured API: the second host of
  the default RPC serves node reads, not `/api/headers`).

The width was decided on a modelled link, measured on 2026-11-23 (all hosts sharing one rate, six connections per
origin, 40 ms each way, the wallet's own timeouts; the 2026-11-21 recording of `/api/headers`; raw data outside the
repository). With six pages fixed, a balance refresh during the sync waited for a connection the header pages held
(3,985 ms at 250 kB/s, a timeout at 50 kB/s, against 51 and 61 ms on 0.3.5). The table is the final rule, the
adaptive width with the foreground first: five alternating pairs per cell, each operation in its own run, started
0.5, 1, 3 or 10 s after the unlock's balance answered (the background sync starts then; 0.3.5 runs none), from a
store holding the release table's chunk only (a new install, 3,470 headers to the tip) or a day behind (720). Each
figure is the median in ms, 0.3.5 first.

| Link | Store | Operation | 0.5 s | 1 s | 3 s | 10 s |
|---|---|---|---|---|---|---|
| 50 kB/s | new install | Balance refresh | 61; 61 | 61; 62 | 61; 61 | 61; 61 |
| 50 kB/s | new install | Send to an address | 171; 172 | 174; 172 | 172; 173 | 173; 176 |
| 50 kB/s | new install | A name's Review | 23,952; 23,833 | 23,992; 23,823 | 23,938; 23,853 | 23,996; 16,989 |
| 50 kB/s | a day behind | Balance refresh | 61; 61 | 61; 62 | 61; 62 | 61; 62 |
| 50 kB/s | a day behind | Send to an address | 174; 172 | 171; 173 | 172; 173 | 174; 174 |
| 50 kB/s | a day behind | A name's Review | 6,792; 6,747 | 6,788; 6,724 | 6,791; 6,741 | 6,782; 2,444 |
| 250 kB/s | new install | Balance refresh | 51; 51 | 51; 52 | 51; 51 | 51; 51 |
| 250 kB/s | new install | Send to an address | 160; 162 | 162; 164 | 164; 167 | 161; 161 |
| 250 kB/s | new install | A name's Review | 6,137; 5,944 | 6,114; 5,964 | 6,088; 4,461 | 6,065; 1,407 |
| 250 kB/s | a day behind | Balance refresh | 51; 52 | 51; 52 | 51; 52 | 51; 52 |
| 250 kB/s | a day behind | Send to an address | 161; 161 | 162; 161 | 161; 162 | 161; 161 |
| 250 kB/s | a day behind | A name's Review | 2,373; 2,331 | 2,379; 2,319 | 2,380; 1,411 | 2,391; 1,423 |
| no cap | new install | Balance refresh | 81; 82 | 81; 81 | 81; 81 | 81; 81 |
| no cap | new install | Send to an address | 251; 256 | 253; 253 | 252; 253 | 252; 253 |
| no cap | new install | A name's Review | 2,730; 2,065 | 2,713; 1,981 | 2,711; 1,987 | 2,660; 1,955 |
| no cap | a day behind | Balance refresh | 81; 82 | 81; 83 | 81; 83 | 81; 83 |
| no cap | a day behind | Send to an address | 252; 252 | 252; 254 | 252; 253 | 252; 254 |
| no cap | a day behind | A name's Review | 2,188; 1,980 | 2,160; 1,972 | 2,176; 1,966 | 2,177; 1,969 |

A name's Review is level or faster in every cell: its pages come first and the background's give way. A balance
refresh and a send are within 5 ms of 0.3.5 in every cell. 0.3.5's own 20 runs of one operation on one link and
store spread over 0 to 8 ms (all at 61 ms for a balance a day behind at 50 kB/s; 160 to 168 ms for a send a day
behind at 250 kB/s). Over the 240 paired balance and send runs the background build is higher in 128, equal in 62
and lower in 50, by +0.68 ms on average (balance +0.59, send +0.78), at most +10; its median is above 0.3.5's in 29
of the 48 cells, by 1 to 5 ms. The difference is there 10 s into a day's catch-up too, when the background has
nothing left to sync (13 of 15 balance pairs higher), so the ingest's slices are not its cause; the cause is not
traced. No header page timed out. A send during the cold background run of 114,062 headers (unthrottled, 80 ms a
request, five alternating pairs per start, against 0.3.5 idle at the same moment), whose ingest shares the worker
for the 8.4 to 9.1 s the run lasts, takes 259 ms against 250 started 0.5 s into it (paired median +9 ms), and 252
against 249 and 254 against 250 at 3 s and 6 s (+4 each); higher in 13 of the 15 pairs, by at most 21 ms (the
2026-11-23 rig `sendbg-idle.sh`, outside the repository). The longest stall of the worker's
event loop during a cold background run of 114,062 headers (unthrottled, 80 ms a request, 7 pairs) is 27 to 36 ms,
against 52 to 58 ms on 0.3.5 (it was 177 to 261 ms before the rebase's re-ingest was sliced, 726a29b: the rebase
rebuilt its client through the vendored `fromRecords`, whose yields let no timer run in Node). What the gate and the
slices cost (5 runs each against 726a29b): unthrottled, that cold run takes 8,351 ms against 9,160 with the same 223
requests; at 50 kB/s a balance 1 s into a new install's sync cancels its 2 pages in flight, which are asked again, so
the headers reach the tip 24,666 ms after the unlock's balance against 23,391, with 9 requests against 7, and the
balance takes 62 ms against 72.

A structural sync failure (an ordinary reorg in the suffix) reseeds (the section above: from the newest seal, else
the anchor chunk in memory) and syncs again; the stored suffix is replaced only after the new one verifies to the
sync target and carries more cumulative work than the held chain (`reseedAdopts`; when it does not at the sync
target, the fresh client syncs on to the node tip and the comparison is made there, since a name's target can sit
far below the tip). If the served headers still fail above the anchor, the refusal is "the
wallet could not verify the block headers from <headers source> above height N: they do not pass the chain's checks.
Try again later."; the light client's own reason is logged. A clock more than 2 hours behind a header stops with a
reason that names the clock, and the store is kept. A table reseed costs the suffix's pages again (one request per
512 headers above the anchor) and the fresh client's verification of them, and nothing below the anchor; a seal
reseed costs the headers above the seal, at most 17 pages for the background's and up to the lookup's height (then
the node tip, when the work is undecided there) for a lookup's; the held chain keeps serving proofs while either runs. The honest cases it covers (test/namespv-store-pins.test.mjs, case 2): a page
that breaks once, a stored suffix the served chain has outgrown (the served chain has more work and is adopted), a
corrupt or short stored suffix (the restore stops below the bad record and the ordinary sync continues from there;
no reseed is needed). A deep reorg below the stored suffix is the same path with the honest chain carrying more
work; a lower-work replacement is refused (test/namespv-reseed-work.test.mjs states what that test can and cannot
show offline).

## Session pin

Restoring the stored suffix with every check costs about 24 to 39 us per header in Node and 2.1 s for 64,359
headers in an unthrottled extension page (`fromRecords`), and Chrome stops an idle service worker after about
30 s, so a stale table was paid on every popup open after idle. After a restore or a sync, `liveSpvSource` writes
the pin `{ v: 1, newest, tip, hash, work }` through `opts.pin` (the wallet passes `chrome.storage.session` key
`spvPin`; `src/core/spvpin.ts`): the newest anchor the chain is seeded from, the verified tip that the store holds
(or is being written to hold), its hash and its chainwork counted from the anchor seed. The next restore in the
same browser session, when the pin's `newest` is this table's, the pin is at least 46 above the anchor and at or
below the stored tip, and no table entry lies between the anchor and the pin:

1. walks the stored records from the anchor to the pin (`walkToPin`: vendored `verifyLinkedRecords`, one run of
   4,096 records per task): the first record's prev is the table hash at `newest`, each record's sha256d is the next
   one's prev, and the record at the pin hashes to the pin's hash; it also finds the walked record with the latest
   timestamp;
2. re-runs the time rules on that record against today's clock (`latestTimeHolds`: the vendored light client seeds
   the 46 records below it and ingests it with every check); a failure runs the full restore;
3. seeds the light client with the 46 records ending at the pin, the pin hash given as the checkpoint at its height
   (`fromRecords`, which runs `seedTrusted` on them: hash, prev link, PoW, every table entry, the last hash equal to
   the pin), and ingests any record stored above the pin with every check;
4. answers heights between the anchor and the seed from the walked records, adds the pin's work to the client's
   so a reseed compares totals from the same anchor seed, and persists across both.

Any other outcome (no pin, a malformed one, a failed walk, a pin from another table) runs the full restore.

Why the trust is the same, from the vendored source (`src/vendor/cairnx-spv.js`): `verifyLinkedRecords` (1001-1017)
recomputes sha256d of every record and compares it byte for byte with the next record's prev field and, for the last,
with the pin, so the walked bytes are the ones whose hash chain ends at the pin; finding other bytes with that chain
needs a sha256d second preimage. The pin is written only from the light client's own chain, whose headers passed
`ingest` (`verifyOne`, 1097-1114: prev link, `checkTimeRules` at 1130, LWMA bits, PoW, `pinCheckpoint` at 1063) or
`seedTrusted` (1147-1166, reached through `fromRecords` at 1399) in this browser session, so the walked records
passed every consensus check earlier in the session. The checks that depend only on the headers (prev link, time
rules against earlier headers, LWMA bits, PoW, pins) give the same verdict now; the one that depends on today's
clock, the future-drift bound (`checkTimeRules` 1137-1138: time at most `MAX_FUTURE_DRIFT_SECS` ahead of now), is
re-run on the walked record with the latest timestamp by the vendored `ingest`. The bound falls only with the
timestamp, so that record passes it exactly when every walked record does, which keeps restore parity after a
backward clock correction within the session (test/namespv-session-pin.test.mjs 1b: with the clock moved back, the
pin restart falls back and accepts exactly the heights the full restore accepts). Table entries are not checked by
the walk, so the pin is refused when one lies in the walked range (with the release table the newest entry is the
anchor, so none lies above it; the prefix tables of tests and the acceptance harness can hit it); the pin itself is
added to the map only for the pin-seeded client, and the reseed seeds from the anchor with the release map alone, so
a reorg below the pin is handled as before.

Who can do what. Content scripts have no access to `chrome.storage.session` (`TRUSTED_CONTEXTS`, set at start,
`test/storage-access-level.test.mjs`); code that has it runs as the extension itself, with the vault and, while
unlocked, the key in reach. The session area is memory only: an attacker who writes the profile on disk can poison
IndexedDB but finds no pin on disk to set, and a changed record fails the walk. The front door and clarvis serve
nothing the walk reads; the pin can only name a tip the light client already accepted from them, which a full restore
would accept again (the residuals in "Work above the newest anchor" are unchanged). A pin written ahead of a detached
store write that never lands fails the walk, and the full restore runs. A new release cannot meet an old pin: Chrome documents
that `storage.session` is cleared when the extension is reloaded, updated or disabled and when the browser restarts
(not tested here), and the walk also refuses a pin whose `newest` is not this release's table. Measured on 2026-10-19 (64,359 stored
headers, the table minus 16; raw data outside the repository): in an extension page at 4x CPU throttle, open to
verified 8,690 to 11,631 ms over 10 runs without the pin and 2,335 to 2,725 ms over 5 runs with it; in the real
service worker unthrottled after a worker stop, 2,544 to 4,333 ms (tag build, 3 runs) against 947 to 1,129 ms (3
runs, a quieter host). Test: `test/namespv-session-pin.test.mjs`, and the Chrome case in `test/namespv-store-chrome.test.mjs`.

The `anchors` job (`release.yml`) walks the chain from the floor's page to the newest entry on every tag: one
`/api/headers` page per 512 heights plus one RPC check per entry, paced at 550 ms, under a 15-minute job timeout.
At tip 121,667 that is 197 requests (2.8 minutes at the 0.85 s per request measured on 2026-10-13); the count
grows by one page per 512 blocks, so the timeout is reached near tip 513,000 at that rate (about 544 days after
2026-10-17 at 720 blocks a day) and near tip 776,000 on pacing alone. Before then either the timeout is raised (a
public repository's minutes are free) or the check walks from the previous release's newest entry, which the
previous release's run already derived from the floor.

## Sealed chunks

A browser start finds no session pin, so without more the restore runs every check on every stored header above the
newest anchor, and its cost grows with the release's age (3.1 s and 71 MB at 114,062 headers, measured 2026-11-21).
Seals make it flat. `src/core/spvseal.ts` holds the key, the message and the list check; `src/core/spvseed.ts` the
seeding; the restore, the sealed reads and the writes are in `liveSpvSource`. Design and review: cairn
`docs/Plans/91-evidence/wallet-wl2-design-2026-11-22.md`.

- The key is HMAC-SHA256 of the raw vault key under the label `cairn-wallet/spv-seal-key/v1`, derived from the
  current vault key at each use and held across no `await` (`sealKeyGetter`; the wallet passes it as
  `opts.sealKey`). Locked, there is none. A new vault has a new key, under which old seals fail and are ignored; a
  reset drops the header source, its name hints and the session pin, and a source seals only under the vault it was
  built for, so a new vault in the same worker starts from a new source, and a source still running from before the
  reset writes no list under the new vault's key (test/namespv-seal-restore.test.mjs 7 and 7b). Its session pin is bound
  the same way: such a source writes no pin after the reset, so the next vault's first restore cannot walk to a pin the
  old vault's seal vouched for (test/namespv-pin-after-reset.test.mjs).
- A seal is a MAC over 145 bytes: a tag, the chunk index, the previous chunk's top hash (the table hash for the first
  chunk above the anchor), the chunk's top hash, its chainwork as u128 and the table's newest entry and hash. The
  record is `meta` key `seals`, `{ v: 1, newest, list: [{ k, top, work, mac }] }`, contiguous from the chunk above the
  anchor and rewritten whole by every suffix write while the key is there. A chunk is sealed once its top is at
  least 4,096 below the tip. The work counts from the light client's seed below the table's newest entry, as the pin's
  does; one helper (`seededClient`) seeds every client (the table, a seal, the pin, a rebase) and carries that base.
- Restore: with a list stored and no key, the restore waits for unlock before any request (the install hook and the
  popup's prewarm both build the source); after the unlock it resumes once the balance has answered or a lookup asks
  for it, so its requests follow the balance request. With the key, `checkSeals` proves the list (any failed MAC ignores all of
  it), and `sealSeed` picks, top-down, the highest sealed chunk whose stored bytes walk from the top below it to its
  own seal. The client is seeded with that chunk's last 46 records and the stored chunks above it are ingested with
  every check, or walked to the session pin when the pin lies among them. When no sealed chunk walks, the restore
  seeds at the table as before. A sealed restore reads the seal record, the head, the anchor chunk, the seed chunk and
  the one or two chunks above it, and its client holds at most 8,237 headers.
- A height between the anchor and the client's base reads its chunk through the acquirer and the LRU, walked against
  the remembered tops; a stored chunk that fails is deleted and refetched, and a refetch that fails its seal answers
  "could not verify" for that one call and starts a background run, whose sync meets the break and hands it to the
  bounded reseed (test/namespv-reseed-bounded.test.mjs 7). The spec a read walks against is the one in force when the read runs, and an
  LRU entry answers only the spec it was verified against, so a read across an adoption never serves or caches the
  replaced chain; an adoption queues its rewrite after the acquirer's pending writes (test/headerstore-adoption.test.mjs).
  A read that waited behind an adoption is decided again once under the tops the adoption kept, and the adopted client
  holds every height above them (test/namespv-seal-restore.test.mjs 13). A read no adoption crosses takes the same path
  and makes the same requests as before.
- An adoption keeps only the remembered tops at and below its seed: none for a table seed, whose client holds every
  height above the table; a seal seed's own list, which the adopted chain shares, since it links to that top. A
  restore walks only the seed chunk and takes every entry below it on the MAC, so a kept top of the replaced chain
  would be sealed into the next list below the adopted chain's own and a restart seeded above it would answer that
  chain or nothing (test/namespv-seal-two-chains.test.mjs: a fork inside the first sealed chunk, red with the table
  seed's reset removed). Every kept top is at or below the last height the two chains share: a fork above a kept seal
  keeps it, its chunks answer with no request and the next list and a restart follow the adopted chain
  (test/namespv-reseed-bounded.test.mjs 3: a fork inside chunk 34 keeping 32 and 33; a fork inside chunk 33 does not
  link at seal 33, so it takes the table seed and keeps nothing).
- A seal never refuses. An entry whose chunk is missing or holds other bytes is absent: a list a 0.3.4 install left
  behind after it rewrote chunks, a write made while locked over sealed chunks, a write that was dropped. A stored
  value that is no list at all (any structured-cloneable junk) proves nothing and is rewritten. Only the
  restore judges this; the writer does not cut a stored list it does not replace, because 0.3.4 does not read or
  write the list (its store code touches only `head` in `meta`) and the restore must judge its writes anyway. Once
  per source, when the key is there, the catch-up writes the list for every sealable chunk in the store when it
  differs from what the stored record proves, and rebases a client seeded below the highest sealed top onto it (the
  records above are re-ingested with every check, 4,096 to 8,191 of them; a client seeded at the session pin above
  it stays as it is, and with the list current no pass runs over the walked run). The base never moves above the
  persisted tip. A client longer than 16 chunks is rebased after a persist, which bounds a long first sync's memory.
- Rollback: the database stays at version 1 (a bump makes 0.3.4 delete and recreate it), the seals live in `meta`,
  which 0.3.4 reads only at `head`, and the vault is untouched. 0.3.4 walks chunks to the table and ingests the suffix
  with every check, so it trusts no header that only a seal vouched for.
- Who can do what: a writer of the profile without the unlocked vault cannot make a seal; a holder of the unlocked
  vault can seal a chain of their choice that a later restore trusts, and can already spend.

## Work above the newest anchor

Above the newest anchor the light client checks each header against its parent (prev link, time rules, LWMA bits,
PoW) and, on a reseed, compares the fresh chain's work with the held chain's (at the node tip when the sync target
leaves that undecided). It compares a chain with nothing else. Two cases follow: a fresh install, a wiped store and
a store that cannot open are one case (the chain is seeded from the newest anchor and synced forward), and a chain
that extends the held tip is accepted header by header, at any tip age.

What a header source can do with that. The vendored difficulty rule (`expectedBitsFromWindow` in
`src/vendor/cairnx-spv.js`: the next target is the 45-header window's mean target times its weighted mean
solvetime, each solvetime counted as at least 1 s and at most 1,440 s, over the 120 s block time) lets timestamps
lower the difficulty. A source that dates every header 1,440 s after its parent raises the target to 1.5, 2.0, 3.1
and 7.3 times the honest one after 1, 2, 3 and 5 headers, 44 times after 10, 374 times after 20, and reaches the
minimum difficulty (17.8 million times the target at tip 121,667) after 77 headers; the first 20 headers carry 4.48
of the 4.58 honest blocks' worth the whole decay costs, and every header after it costs about nothing. The time
rules (`checkTimeRules`: at least 60 s after the parent, above the median time past, at most 2 h ahead of the
wallet's clock) bound the room: (Simulated on 2026-10-17 from the rule as vendored, with the bits at tip 121,667;
Plan 86, D-86-9. The review's independent simulation of the extension case gave 7.7, 21.8, 116, 160 and 947 for
the five lengths below; this one gives 7.7, 21.9, 116.7, 160.9 and 950.9.)

- From the newest anchor (a fresh install, a wiped store, a store that cannot open): the anchor is at least 1,000
  blocks (33 h) old at tag time and ages for the life of the release, so the whole decay fits, and a forged chain
  above the anchor costs about 4.6 blocks' worth of honest work. Its cheap length is bounded by the time rules: the
  decay takes 30.8 h of the (anchor age plus 2 h) of room, and the remaining room holds one header per 60 s, so
  about 77 plus (anchor age plus 2 h minus 30.8 h) / 60 s headers: about 329 above a 33-hour-old anchor, about
  8,430 above a 7-day-old one. (The spacing alone would fit 2,100 and 10,200 headers, but every header before the
  decay completes costs real work.)
- Extending the held tip of an installed wallet, at any tip age: the 2 h of drift alone allow 5 headers at 1,440 s,
  after which 120 s spacing is neutral for the rule and the lowered difficulty holds. Forged extensions of 30, 120,
  720, 1,000 and 6,000 headers cost 7.7, 21.9, 116.7, 160.9 and 950.9 honest blocks' worth: a steady discount of
  about 6.35, about 16 percent of honest work per header. Above a held tip t old at most (t plus 2 h) / 60 s
  headers fit the time rules: 120 above a tip synced now, 2,100 above one 33 h old. (An earlier version of this note put the exposure
  at tips older than about 29 h; that figure marks when the minimum difficulty is reachable, which is not the
  binding point.)

What it reaches, and the price:

- Names: the forged chain need only reach the hinted record height plus 12, so the price is the decay's 4.6
  blocks' worth from the anchor, or 7.7 for a 30-header extension. The reach is withholding only: a later transfer
  hidden. The forged blocks cannot carry an owner's signature the source does not have (`replayName` authenticates
  every record's signer and binds it to the coin it spends), and the second name source's records then fail against
  the forged blocks, so the result is flagged rather than green.
- Reservation fills: the forged chain needs to start only just below the hidden event. The source serves honest
  headers up to the block before the competing hold (they verify and cost nothing), then forged headers that omit
  the hold, carry the buyer's fclaim and bury it to the fill's claim depth, and a node tip that ends there. For a
  hold placed 3 blocks before the buyer's fclaim and a depth-3 fill (every fill up to 5,000 CSD at the 50 CSD
  reward, the vendored `requiredClaimDepth`) that is 6 forged headers, about 3.2 blocks' worth of honest work by
  the extension model above (4 headers 2.6, 12 headers 4.6; simulated 2026-10-17, Plan 86 D-86-10). Once the front door
  is controlled it succeeds on every attempt for a few honest blocks, while the claim-depth rule prices a race on
  the real chain (a miner with a fifth of the hashrate reverses a depth-3 claim 1.563 percent of the time per
  attempt). The cheap case needs the wallet's stored chain to end below the fork point: a stored chain that reaches
  past it is kept unless the forged chain carries more work (the reseed rule), so the forger would then have to
  out-work the honest headers the wallet holds above the fork. Headers are synced by name verification and fills;
  the buyer's reservation itself syncs none. The reach: the buyer's fclaim, denied on the real chain, looks granted
  to the scan, and the payment burns. A competing hold with an expiry epoch below the buyer's passes the offer check
  (`OFFER_SOURCE_CONFLICT` refuses only a holder still held at the buyer's last held block); the reservation verdict
  below sees it.
- Who: whoever answers the wallet's `/api/headers` and `/api/rpc` (the front door's operator, or whoever compromises
  the front door); the node tip the wallet syncs to comes from the same source.

A minimum-work floor was considered (Plan 86 D-86-9 part 2) and is not built:

- The candidate of the plan, the table carrying the cumulative work at each anchor and a served chain refused when
  its work above the newest anchor is implausibly low for its height span, is bypassed by a short chain: the source
  also serves the node tip, so the forged chain can be 78 headers long (77 to decay, one dated now) with 4.6 blocks
  of work over a 78-block span, which no floor tolerating an honest 17-fold difficulty fall refuses. The table
  change buys nothing.
- A floor against elapsed time instead (the work since the anchor, against the anchor-era work per block times the
  seconds since the anchor's timestamp, both read from the verified anchor chunk, so no table change) is not
  bypassed by a short chain: the forged chain's work stays near 4.6 blocks while the anchor ages, so over an anchor
  age of 33 h it looks like an honest chain whose hashrate fell 215-fold, 1,096-fold at 7 days, 4,696-fold at 30
  days. A floor tolerating an F-fold fall refuses the forged chain once the anchor is older than 552 x F seconds
  (F = 100: 15 h; F = 1000: 6.4 days) and refuses every honest chain whose hashrate, averaged since the anchor, fell
  more than F-fold. The simulated honest collapse by a factor f shows exactly an f-fold work shortfall at every age
  (f = 10, 100 and 1,000 at 33 h, 7 days and 30 days), so no F separates a forged chain from an honest collapse of
  the same factor: a floor that catches a header source with hashrate H/F also refuses an honest chain running at
  H/F. Against an extension it would have to run per sync segment, where the same arithmetic holds over shorter
  windows.
- On this chain one coinbase address mined all 300 blocks from 121,368 to 121,667 (read from the node on
  2026-10-17). If that miner stops, the remaining hashrate, and with it the honest fall factor, is unknown and can
  exceed any F; the floor would then refuse every fresh install's name verification and reservation fill until a
  release re-anchors, for an event the wallet should survive. That is a new refusal on an honest path, so the floor
  is not built. Built, it would have been about 20 lines in `prepare` plus a test, no table change and no request.

### Built: the second resolver's verdict on the buyer's reservation (D-86-10)

Beside the clarvis offer read, the fclaim-lane preflight asks clarvis for its record of the buyer's fclaim,
`GET /trade/api/cairnx/record/{fclaimTxid}` (`src/core/offerxcheck.ts` `reservationRecordVerdict`,
`test/fill-reservation-verdict.test.mjs`). clarvis replays the chain from its own node and indexer, so headers forged
by the front door do not change its answer. The read starts with the scan, on the same terms as the offer read (the
same base and timeout), and counts only if it answered before the scan finished, so an honest fill waits for nothing.

- A 200 for this fclaim with `applied: false`: refuse with `RESERVATION_DENIED`; clarvis's reason, when it gives a
  short printable one, goes to the wallet's console, not on screen. The chain clarvis follows denies the reservation, which is where the payment would burn.
- A 404 whose `tipHeight` is at least the buyer's proven fclaim height plus 12: clarvis has scanned past the
  reservation and does not know it. The wallet signs nothing yet and returns `RESERVATION_UNCONFIRMED` with both
  heights to the approval window, which keeps the request queued and shows it again with a warning and two buttons,
  "Sign anyway" and "Cancel" (`test/fill-reservation-confirm.test.mjs` through the worker channel,
  `test/approve-unconfirmed-dom.test.mjs` for the window). "Sign anyway" re-sends the approval with an
  acknowledgement bound to the request id and the fclaim txid; the worker re-runs the whole preflight (the scan and
  both clarvis reads), so a reservation clarvis now reports denied still refuses, and an "unknown" with a matching
  acknowledgement, a granted one or no evidence signs once. The acknowledgement is taken only as a `resolve` argument on the
  extension-page channel (`background.ts` accepts popup-kind messages from any page of the extension; the approval
  window is the only one that sends it, and the toolbar popup only rejects); one in the request's params, or for another request or
  fclaim, is ignored. "Cancel" rejects the request; closing the window settles it `APPROVAL_CLOSED`.
- Anything else (applied, a 404 below that height, a wrong kind or txid, a malformed body, an error, a timeout, no
  answer before the scan ends): no evidence, the fill proceeds. When the read had not answered yet, or failed (an
  error, a timeout, a status other than 200 or 404, or a body that is not a JSON object; `secondSourceUnanswered`),
  the signed fill's outcome in the approval window adds "Second source not consulted" and the window stays open
  until it is closed; the page's result does not carry it (`test/fill-second-source-notice.test.mjs`,
  `test/fill-reservation-confirm.test.mjs` section 11, `test/approve-second-source-dom.test.mjs`). It adds no
  refusal and no wait.

The margin of 12 is conservative. The cairnx service publishes `tipHeight` and its events from one scan with no
depth lag (clarvis's deployed build constructs its scanner with inclusion checking off, the default; with it on, a
too-shallow record aborts the scan rather than lagging the events), so an honest resolver's 404 at a height means it
has no record there. The 12 blocks cover a shallow reorg that re-mines the fclaim a few blocks higher and the race
between the resolver's indexer and the node it reads from.

Rule A, the confirm step: clarvis's 404 and `tipHeight` now decide whether a fill needs a second click
(`offerxcheck.ts` `reservationRecordVerdict`, `fillpreflight.ts` `fclaimLanePreflight`); whether it signs after that click is
decided by the user's acknowledgement, bound to the request and the fclaim by the worker (`background.ts`
`reservationAckFor`), and every other check runs again unchanged. Rule B, the confirm step: the warning can be
triggered by a hostile or broken clarvis (a false 404 with a high `tipHeight`), against any buyer on the fclaim lane;
at most it makes that buyer click twice or cancel. It cannot sign, refuse a fill outright, or change what is signed.
A page cannot trigger it or answer it.

Rule B: an honest lagging clarvis can neither refuse nor warn: it answers 404 below the fclaim's height plus 12 and
the fill proceeds; an honest synced one answers `applied: true`. A compromised clarvis can choose which buyer gets a
refusal or a warning: denial of service only, the same class as the existing offer check, and both hosts are the
operator's. An honest clarvis on a stale fork can keep a denial that the current chain no longer supports; the buyer
is refused and retries once clarvis follows the current chain. That is accepted, and pinned in
`test/fill-reservation-verdict.test.mjs` (a denial for a fclaim the current chain grants still refuses). An honest clarvis replays the same vendored rules over its own chain, so when the wallet's
replay grants a reservation and clarvis's denies it, the difference is an event on clarvis's chain that the wallet's
scan was not shown, such as the hidden hold; the node accepts no attest to an unknown proposal, so a third party
cannot manufacture that difference without putting a real event on chain.

The header-hash comparison first proposed for D-86-10 is not built. After every extending sync it would have
compared the wallet's header with clarvis's at the synced height minus a finality depth (12). The forged chain needs
to start only just below the hidden event, and fills bury their fclaim at depth 3 to 6 (depth 6 covers fills up to
1,000,000 CSD), so the fork sits within a few blocks of the served tip and both hosts agree at the compared height:
it misses every fill at depth 3 to 6. Comparing nearer the tip would refuse honest users during a tip race or while
clarvis lags.

Residual:

- clarvis down or slower than the scan during the attack;
- a front door that withholds or delays the buyer's fclaim, while clarvis has not yet replayed it. The front door
  relays the buyer's submits through `/api/rpc`, so it can hold the fclaim back, get a competing hold mined first,
  and release the now-denied fclaim just before the fill. clarvis answers 404 because it has not seen the fclaim yet,
  and the fclaim's "proven" height is proven only against the headers the front door serves, so the attacker chooses
  it: within 12 of clarvis's tip gives no evidence and the fill proceeds, further gives the warning. Against a
  header-source attacker the "unknown" warning is therefore advisory;
- both hosts compromised. Both hosts are run by the operator under one registrable domain.

A possible later closure for the withholding case, not built: a second broadcast path for the fclaim through the
second host, if its relay accepts submits, so the front door alone cannot hold the reservation back.

## Name verification on top of the store

Moved from AGENTS.md on 2026-10-22; `SECURITY.md`, "Sending to a `.csd` name", has the user-facing account.

- After the header checks: a full-block merkle bind, signer auth and the prevout-ownership bind, then the two-source
  union (`verifyNameUnion`: primary and clarvis, union by txid, every event SPV-proven, the audited resolver replayed
  over the proven union minus every record about another name, `nameScopedEvents`). Another name's records reach this
  name's replay only through the resolver's per-address limits (a reveal is refused while its proposer holds
  MAX_PENDING_REG other reservations), and an honest source serves none of them (0 dropped over the 606 hints cairnx
  959fa25's selector serves for the 172 names of the 130,077 capture); when they decide a name, the honest source's
  `scopedReplaySufficient: false` refuses it, on the union replay and before the per-source recovery alike, and a
  source whose own replay is `viaFill` refuses the recovery as a `viaFill` union replay does, so a source that pads
  the union past `MAX_HINTS` cannot have the recovery drop an honest source whose own records replay and verify alone
  (test/namespv-union-scope.test.mjs cases 3 and 4). The recovery skips a source whose own replay fails for any
  reason, so when the honest source's records cannot be replayed a lone source still decides, with `soleSource` and
  `disagree` set (the residual in `docs/DESIGN-viafill.md`). The confirm-time skip also refuses on a fresh
  `scopedReplaySufficient: false` (case 5).
- `MAX_HINTS` (256) bounds one replay: a union over it is refused before any block read, but the per-source recovery
  then replays each source's own list, each within the cap, so one verification can prove up to the cap per source
  besides the union replay.
- A green badge needs a successful replay. A disagreeing source is a warning, not a refusal: the send goes to the
  proven winner with `disagree` or `soleSource` set. When nothing can be proven, `resolveName` returns the served
  address with `verified: false` and the popup lets the user send after a caution.
- A lapse refuses only when both hold: the lease is over at a height the wallet verified (its PoW-verified header tip
  or the persisted tip floor), so a served tip cannot make it; and 0.3.4's corroboration, two usable sources or the
  floor, since one source can withhold a renewal. Together that is 0.3.4's predicate without the served tip: the floor
  alone, or the verified tip with two sources. With the floor past the old lease end, one source withholding a renewal
  still makes the refusal (test/name-lapse-tip.test.mjs [W2]). Expired only at the served tip, seen in one source's records only,
  or reported lapsed by a resolver while the chain cannot show the lease current, it is
  `lapseUnconfirmed` (`verified: false`): the popup's caution with "Send anyway", on the last holding's proven
  address (`lastAddr`) when the replay gave one, else the served one under the popup's not-verified line
  (`addrProven` false; a source flagging `scopedReplaySufficient: false` leaves no `lastAddr`) (`src/core/names.ts`;
  test/name-lapse-tip.test.mjs, test/resolve-lapse-corroborate.test.mjs). Headers synced only to a name's last
  record plus 12 trail the tip, so an honest lapse of an old name is a caution until the headers reach past its
  lease end. A name the replay shows decided by an offer fill or a
  re-claim after a lapse (`viaFill`) is not shown green; the stale-seller residual above is the case the replay
  cannot see.
- A long sync persists its verified progress after every window of pages, so an interrupted sync
  resumes (`syncPages`, the runner). The persisted tip floor advances only in `prepare`, once its height is reached
  (`floorAdvance`); test/namespv-partial-persist.test.mjs pins both, test/namespv-sync-runner.test.mjs 3 the resume.
- The one-time migration of the `spvHeaderChain` snapshot ("What runs when") runs when an install or update fires
  `onInstalled` (`src/background.ts`), or at the popup's prewarm if that comes first.

## Callers and their tests

| Caller | Test |
|---|---|
| `replayName` (`blockAt` per hinted height) | `test/namespv-store-restore.test.mjs` (a real name in chunk 7, write volume), `test/namespv-hints-floor.test.mjs` (hint floor, case 19) |
| the fclaim lane's offer block (`fillspv.ts` `bindBlockOrThrow`) | `test/fillspv-store.test.mjs` |
| the V29 other offer (`provenClosed`) | `test/fill-holds-v29.test.mjs` (the real offer at 30,332 below the anchor) |
| `provenOfferPayto` | `test/fillspv-store.test.mjs` |
| the confirm-time skip (`hashAt`) | `test/namespv-hints-floor.test.mjs` |
| restore, pins, reorg, clock, corrupt chunks, concurrency, migration | `test/namespv-store-pins.test.mjs`, `test/namespv-store-migrate*.test.mjs`, `test/headerstore*.test.mjs` |
| the reseed's work rule (`reseedAdopts`) | `test/namespv-reseed-work.test.mjs` (the rule on bigint work and on two light clients over real headers; through `liveSpvSource`, a held branch with more work at the sync target compared at the node tip; the use-site), `test/namespv-reseed-recover.test.mjs` (the reseed order) |
| an unreadable node tip (SPV-5) | `test/spv-unknown-tip.test.mjs` |
| the runner (the adaptive width, order, reads between pages, a waiting lookup first, resume, transient stop, the per-run target, the 60 s gap, the popup's prewarm, a dropped source) | `test/namespv-sync-runner.test.mjs`, `test/popup-prewarm-order-dom.test.mjs`, `test/namespv-partial-persist.test.mjs`, `test/spv-serializer.test.mjs`, `test/namespv-dropped-source.test.mjs`, `test/fill-dropped-source.test.mjs` |
| the reseed's seeds, the bounded background reseed, the adoption site | `test/namespv-reseed-bounded.test.mjs` (generated chains on the cut table), `test/namespv-reseed-recover.test.mjs` |
| the session pin (`walkToPin`, the pin-seeded restore) | `test/namespv-session-pin.test.mjs`, `test/namespv-store-chrome.test.mjs` |
| sealed chunks (`checkSeals`, `sealSeed`, sealed reads, seal writes, catch-up, rebase, the locked wait) | `test/namespv-seal-heal.test.mjs` (a seal mismatch never refuses and heals, as a property), `test/namespv-seal-restore.test.mjs`, `test/spvseal.test.mjs`, `test/headerstore-kill-chrome.test.mjs` (a write killed in Chrome) |

## Invariants

- No stored header is used without its walk to the table, its forward verification in the same session, its walk
  to the session pin of headers verified earlier in the same browser session, or its walk to a seal the unlocked
  vault's key proves. This is the storage-poisoning defence: the profile is writable by whoever can write it, and a
  poisoned store can at most cost a refetch.
- A seal never refuses: an entry that does not match its chunk is absent; at the restore the headers above the highest
  entry that still walks are verified with every check, a lower chunk that fails is refetched when it is read, and
  the list is written again (test/namespv-seal-heal.test.mjs).
- The floor (29,960) does not move: a name event at height h needs the verified header at exactly h.
- Store and network failures degrade to "no cache this session" or a refetch, not to a refusal of a send that
  would otherwise verify. The exception is an unreadable node tip (SPV-5): nothing is synced, so a name record above
  the verified tip shows as not verified for that call, and a reservation fill refuses as retryable.
- Consensus math stays vendored (csd-sdk through the PROVENANCE-pinned bundle).
- The cost of a start follows the suffix above the newest anchor, so the table must be refreshed per release
  (`store/PUBLISH-RUNBOOK.md` step 2), and the `anchors` job refuses a tag whose table is stale.
