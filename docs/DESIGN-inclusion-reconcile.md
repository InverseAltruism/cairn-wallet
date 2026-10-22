# Design note: the inclusion reconcile for sent transactions

Status: built, 2026-10-22. Moved out of AGENTS.md; the code is `src/core/inclusion.ts` (the verdicts and constants)
and `TxHistory.pendingMerge` in `src/core/history.ts`; the test is `test/inclusion-chain.test.mjs`. The user-facing
account of the markers is in `SECURITY.md`, "What the wallet trusts the RPC for".

## What it settles

Every open history row is settled from chain state, not the clock. An open row is a merge not yet confirmed or a
`maybe: true` row (a submit whose outcome was ambiguous). The reconcile submits nothing and writes only its own
bookkeeping fields on the row.

- Included: the txid is in the caller's utxo set, the node reports it mined, or it is in the mined utxo set. The row
  drops `maybe`, `stuck` and `gone`; a merge also latches `confirmed`, because the next step spends its output.
- `gone`: one of the row's kept inputs (up to `INCLUSION_INPUTS_KEPT`, 8) is missing from the mined utxo set
  (`/utxos-all`) while the tx is not mined, at two different tips. Any later reading that disagrees clears it. It
  also needs the RPC's status read to be `definite` (behind the Cairn proxy: both node backends' mempool reads
  complete); without it the row keeps the `stuck` notice. A `gone` row is read again once per
  `INCLUSION_GONE_READ_INTERVAL` (100) blocks, so a later "mined" still undoes it.
- `stuck`: the standing notice, set `INCLUSION_NOTICE_BLOCKS` (10) blocks past `subTip`. `subTip` is the tip at the
  row's first reconcile, not at submit: a popup send is first reconciled at the popup's balance refresh after the
  send, a dApp send when the popup next opens.

## Cost per refresh

One tip read, at most `INCLUSION_READS_MAX` (8) status reads (newest rows first, one per row per block, tracked in
`chkTip`), and the mined utxo set once when a status came back unknown. No tip means no chain-derived step that pass.
The reads run outside the history write chain, so a hung RPC cannot park a send's own history write; the chained step
re-reads the rows before writing.

## Callers

`pendingMerge` is popup-only: it is not in `DAPP_METHODS` (`src/background.ts`). The popup calls it from its balance
refresh (`src/popup/popup.ts`).
