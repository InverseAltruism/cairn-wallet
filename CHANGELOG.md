# Changelog

## 0.2.73 (2026-10-10)

- Open-offer fills (fclaim lane): the wallet reads the offer by id from the second source (clarvis) in parallel
  with its SPV scan and refuses with `OFFER_SOURCE_CONFLICT` only on positive evidence (offer cancelled, filled
  or expired, more paid or delivered than the primary served, or a later claim holder). This closes the
  pre-window withholding gap when clarvis is reachable and honest. 404, timeout or garbage proceed, and the fill
  never waits for clarvis.
- Approval screen: CAIRN amounts use pinned decimals (8); other tokens show an "(unverified token)" mark next to
  the human figure. Base units are always shown; what is signed is unchanged.

## 0.2.72 (2026-10-10)

- Token amounts at approval show both scales, e.g. "4638.5287329 CAIRN = 463852873290 base units" (CX-35).
- The second-resolver fclaim comparison keyed by the claim txid is retired (`SOURCE_DIVERGENCE`); it could not
  catch withholding.
- Vendor bundle rebuilt from csd-sdk `fb37dbb` with a layout-independent build; signed nprofile values are shown
  in full; the release workflow's provenance step must succeed; the version lives only in `package.json` and the
  build checks that it was stamped.

Earlier releases are described in their tag messages.
