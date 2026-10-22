# Design note: names bought through the market (the viaFill trap)

Status: open, 2026-10-23. No option is chosen; this note is the input for that decision. Nothing in it changes
behaviour. Line numbers are as of the commit that adds this note. The name-verification design is
`docs/DESIGN-namespv-scaling.md`; the user-facing account is the "Sending to a `.csd` name" section of `SECURITY.md`.

## The trap

A `.csd` name delivered by an offer fill does not verify when the wallet sends to it, for as long as the name keeps
the record the fill created. The wallet then shows the address the name service served, with a caution to confirm
it out of band.

How it arises, in the vendored resolver (`src/vendor/cairnx-spv.js`, built from csd-sdk's cairnx-core):

- `deliverNameToBuyer` (lines 3973-3985) hands the name to the buyer and, for a fill at or above V13 (31,100), sets
  `viaFill = true` (line 3983). Both name-sale paths call it: the token-priced fill (line 4666) and the CSD-priced
  fill (line 4772).
- A lapsed-lease re-claim below V26 (46,480) also writes `viaFill: true` (line 4135), although no fill took place.
- Nothing that keeps the record clears the flag. `nxfer` (lines 4254-4275) changes the owner, `nset` (lines
  4276-4291) the address and `nrenew` (lines 4464-4489) the lease, each on the same record. The flag goes only when
  the record is replaced: a V26 recapture of a lapsed name (`putName` without the flag, line 4247). A finalized
  sealed registration does not get it (lines 4205-4216).
- The flag is resolver state, not a label: a name carrying it cannot be displaced by an earlier-anchored claim
  (lines 4145 and 4176, "name taken (purchased, not displaceable)"), and the state output carries it (line 4854).

How the wallet turns it into a permanent caution:

- `replayName` replays the audited resolver over the merkle-proven records and returns the winning record's
  `viaFill` (`src/core/namespv.ts:241`).
- `verifyNameUnion` refuses to call such a name verified (`src/core/namespv.ts:341-355`), and also refuses when any
  source served `scopedReplaySufficient: false` (line 348). The per-source recovery skips a viaFill result (line
  322), so no path reaches verified.
- `resolveName` then returns the served address, not the replayed one: `{ ...base, verified: false, ... viaFill }`
  (`src/core/names.ts:92`, where `base.addr` is the resolver's `addr`, line 74). The confirm-time hint-set skip
  does not cache the name (`src/core/names.ts:137-138`), so every send repeats the full verification.
- The popup shows "purchased name, can't be name-scope-proven, confirm the address" (`src/popup/popup.ts:587`) and
  the caution block in `nameCautionHtml` (`src/popup/clearsign.ts:583-588`). The send is not blocked.

Why the wallet fails closed: the cairnx name-history selector (cairnx `src/namehist.ts`, header comment and lines
150-188) serves the records that decide one name. For two fill classes that set is not enough to reproduce the
full chain's owner: an open-lane (claim or fclaim) fill, whose validity depends on the buyer's live claims across
all offers (the global `MAX_ACTIVE_CLAIMS` cap), and a name-for-token fill, which depends on the buyer's token
balance. A second source runs the same selector, so the two-source union cannot fill the gap. The taker-bound
CSD-priced sale is the class cairnx's fuzz shows is name-local, but the wallet's gate keys on the flag alone and
catches it too.

## What it costs today

- Every name that changed hands through the market, and every name re-claimed after a lapse below V26, reads as
  not chain-verified for every sender, for the life of the record. The set only grows with market use.
- For those names the wallet shows the served address. A hostile or broken name service can put any address
  there; the user sees the purchased-name caution, which is the same caution an honest traded name gets, so it
  does not tell them apart. This is the address substitution the name path exists to stop.
- The refusal text "(open-lane / token sale)" (`src/core/namespv.ts:353`) is wrong for a taker-bound sale and for
  a pre-V26 re-claim.

## Options

### 0. Show the replayed address with the caution (wallet only)

When the replay succeeded and only the viaFill gate failed, return the replayed `rep.addr` instead of the served
one, keep `verified: false` and the caution, and flag a source whose served address differs. For the unsound
classes the replayed owner can differ from the full chain's, but it is backed by signed, mined records, where the
served address is backed by nothing. Cost: a small change in `namespv.ts` and `names.ts`, a test on the production
call shape, and owner sign-off if the caution text changes. No resolver change, no height gate. It narrows the
substitution, it does not remove the caution.

### 1. Proof of transfer

Let the wallet prove the transfer that set the flag, so the name verifies without a caution. Per class:

- Taker-bound CSD-priced sale: the fill, the offer and the payment are already in the name's own records. The
  wallet needs a predicate that says "the record's flag came from a name-local fill" (find the fill by the
  record's `claimId`, its offer among the verified events, taker set, CSD want). It must come from cairnx-core and
  arrive in the vendored bundle, not be written here (one home for consensus rules). Cost: a csd-sdk change, a
  vendor rebuild, golden vectors for the predicate and a wallet test; no change to how any name resolves, so no
  height gate. Covers the class cairnx already calls sound.
- Open-lane fill: the cap is counted over a bounded window before the grant (`MAX_SCAN`, 134 blocks), the same
  window `liveFillSpvSource` scans at fill time (`src/core/fillspv.ts`, over `src/core/spvbind.ts`). A historical
  version anchored at the grant height instead of the tip could prove the count. Cost: about 135 block reads per
  verify of such a name (the window [grant - 134, grant]; the fill-time scan adds the 89-block hold span and reads
  224), at 12 in flight, on the send path, plus the same prevout binds as the fill lane. Each send to the name pays it unless the result is cached by fill txid.
- Name-for-token fill: the buyer's balance depends on the token's whole history; no bounded proof exists. Only a
  resolver change can help.

A resolver change that makes name fills name-local (for example, name offers outside the global claim cap, or
name-for-token sales refused) changes how names resolve, so it is a height-gated consensus change: made once in
csd-sdk's cairnx-core and recorded in its `CONSENSUS_CHANGES.md`, then shipped to every consumer at once (the
cairnx resolver's pinned package, this wallet's vendored bundle, the site's bundle), with replay byte-identical
below the gate. Clearing the flag on an existing
name is the same kind of change, since the flag also decides displacement. Names sold before the gate stay
trapped unless the old fill is proven another way.

### 2. One-time bind (wallet only)

Keep the caution for the first send. After the user confirms the address out of band, the wallet stores a local
bind of (name, owner, address, the record's `claimId`) for the active account. A later resolve whose replay gives
the same four values shows "address confirmed by you" instead of the caution; any change (an `nxfer`, an `nset`, a
recapture) drops the bind and the caution returns, and the confirm-time re-resolve still refuses a change between
review and confirm. Cost: a store and its migration in `chrome.storage.local` (unencrypted, like history), a
confirm step and its strings in the popup, tests for the bind and its invalidation. No resolver change, no height
gate. The bind is only as good as the user's out-of-band check, and it does nothing for the first send to each
name. It needs option 0 first: binding a served address would bind exactly what an attacker serves.

## Constraints on any choice

- Any change to how a name resolves or when `viaFill` is set or cleared is a height gate, mirrored in every
  resolver implementation, never a wallet-only change.
- The wallet keeps failing closed on a served `scopedReplaySufficient: false` and never trusts a served `true`.
- A disagreeing source stays a warning, not a refusal (the warn-over-block rule in `SECURITY.md`).
- W-5 is out of scope here; it stays deferred to the 0.3 redesign.
