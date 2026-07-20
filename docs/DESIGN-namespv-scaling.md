# Design note: namespv snapshot scaling (N14 structural roadmap)

Status: DESIGN ONLY, committed under Plan 71 REBIND batch BP8-design (2026-07-20).
Implementation is a post-CERTIFY campaign; nothing here changes runtime behavior.
Companion shipped work: BP8b (partial-progress snapshot persistence, this branch),
BP4 (shared light client + single-flight sync serializer), 0.2.56 (vendored LWMA
memo, ~4x faster restore). The server-side cap cure is BP8a in the cairn repo.

## The problem, measured (2026-07-19 audit, finding N14)

The wallet's trustless name path keeps a PoW-verified header chain from the baked
checkpoint (height 29,960, the V11 names floor) to the vicinity of the chain tip.

- Restore is O(chain) on EVERY MV3 service-worker cold start: the whole JSON
  snapshot is parsed and every header re-verified. About 1 to 1.3 s today,
  growing about 35 ms per chain-day.
- The snapshot is about 10.2 MB of JSON (about 370 bytes per header on disk),
  growing about 272 KB per day, and it is whole-blob rewritten on advance.
- A fresh-install cold sync is about 5 to 7 s today; it would hit the N10
  /api/headers budget wall around 2026-08-30 (owned by BP8a server-side and
  BP8b wallet-side, not by this note), and restore alone reaches about 1 minute
  around tip 320k if nothing structural changes.

The checkpoint CANNOT be bumped to shrink any of this: verifying a name event at
height h needs the PoW-verified header at exactly h, so the chain must span the
names floor to tip for as long as historical name events must be provable.
"Bump the checkpoint" is a documented wrong answer (AGENTS.md, SPV snapshot
growth). Growth is structural; only the roadmap below changes the curve.

## Bite dates and the alarm

Audit arithmetic (about 720 blocks/day from tip about 57.6k on 2026-07-19):

| Milestone | Tip | Approximate date | What degrades |
|---|---|---|---|
| Slow-hardware bite | ~74k | ~2026-08-11 | cold-start restore becomes user-visible jank on weak machines |
| N10 cap wall (separate finding) | 87,304 | ~2026-08-30 | fresh-install cold sync exceeds the whole headers budget (cured by BP8a; BP8b makes it resume, not restart) |
| Fast-hardware bite | ~163k | ~2026-12-12 | restore is disruptive on all hardware |
| Unmitigated horizon | ~320k | 2027+ | ~1 minute restore per service-worker cold start |

An alarm exists and is armed: the N10 default-path cold-span alarm plus the
tip-84,000 watchdog tripwire (cairn BP3, promoted live via OP-16). The window
between the first bite (~08-11) and the hard wall (~08-30) is why item 1 below
must start in the first post-CERTIFY slot.

## Roadmap, sequenced safest-first (per AGENTS.md)

The ordering rule: pure scheduling first, format second, trust-surface last.
Each step is independently shippable and independently revertable.

### 1. Async/chunked snapshot restore

Split the restore parse+re-verify loop across event-loop turns (bounded chunks,
e.g. 2 to 4k headers per turn) so the service worker stays responsive during a
cold start and user actions are not blocked behind the full O(chain) pass.
Pure scheduling: byte-identical verification, no format change, no new trust.
The restore still completes fully before any verify answers (fail-closed
unchanged); only the blocking shape changes.

Owner: post-CERTIFY campaign, first implementation slot.
Bite date covered: the ~74k / ~2026-08-11 slow-hardware bite.

### 2. Binary snapshot v2

Replace the JSON blob with a versioned binary record format (fixed-width header
records, about 80 bytes per header vs about 370 as JSON), appended
incrementally instead of whole-blob rewritten per advance. One-shot migration
from v1 on first load; v1 fallback read kept for one release. Restore
re-verification is UNCHANGED (same hashes, prev links, PoW, LWMA re-derivation,
checkpoint anchoring); only the serialization format changes.

Owner: post-CERTIFY campaign, second slot (after 1 is observed live).
Bite dates covered: the storage-growth curve (10.2 MB +272 KB/day, quota
pressure shared with the vault) and the parse half of the ~163k bite.

### 3. Verified-event proof cache

The ONLY path that beats the unbumpable checkpoint floor. Cache, per name
event, the minimal verified proof bundle (the PoW-verified header at the event
height, the merkle inclusion path, the signer/prevout bind result), keyed by
header hash. Once an event's proof is cached and re-verifiable locally, the
full header span between proven heights no longer needs to be retained or
re-synced, so the chain window can finally be pruned without breaking
historical name verification.

This is a LARGE money-path change (it alters what the name-verify trust chain
is rebuilt from) and is deliberately NOT built inside REBIND: the campaign's D3
proportionality rule forbids it there, and this note exists precisely so the
decision and its date are on the record for CERTIFY-A's scalability-headroom
criterion. It requires its own design review and red-team gate before code.

Owner: post-CERTIFY campaign, third slot, own gated design + adversarial
review.
Bite date covered: the ~163k / ~2026-12-12 fast-hardware bite and the 2027+
horizon.

## Invariants that hold through every step

- NEVER skip restore re-verification. Re-verify-on-load (fromSnapshot
  recomputing hashes, prev links, PoW, LWMA bits, checkpoint anchoring) IS the
  storage-poisoning defense: chrome.storage.local is not a trusted input. Steps
  1 and 2 change scheduling and format, never what a restore trusts. Step 3
  must re-verify cached proofs against the pinned checkpoint chain on load with
  the same posture. This is pinned behaviorally by
  test/namespv-partial-persist.test.mjs (a poisoned snapshot is never adopted).
- The checkpoint floor (29,960) stays until step 3 ships and is proven; no
  intermediate step may bump it.
- Fail-soft on the availability axis: a missing/corrupt snapshot or cache
  degrades to a re-sync, never to a refusal of a legitimate send (the standing
  no-UX-regression rule).
- Consensus math stays vendored (csd-sdk via the PROVENANCE-pinned bundle);
  none of these steps re-declares a consensus rule in this repo.
