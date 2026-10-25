# Chrome Web Store submission package

Everything needed to list and update Cairn Wallet on the Chrome Web Store. For a release, start with **PUBLISH-RUNBOOK.md**; for listing copy, **STORE-LISTING.md**. The first-listing checklist and console answers are archived in `../docs/archive/store/`.

| File | What it is |
|---|---|
| `PUBLISH-RUNBOOK.md` | The dual-control, reproduce-then-publish procedure for each release (security-critical). |
| `STORE-LISTING.md` | Paste-ready copy for every dashboard field (name, description, single purpose, permission justifications, data disclosures, remote-code=No, trader status, reviewer notes). |
| `PRIVACY-POLICY.md` | The privacy policy text; the same text is served at https://cairn-substrate.com/wallet-privacy.html, the URL the store listing uses. Change both together. |
| `assets/screenshot-1..5.png` | 1280×800 store screenshots (self-custody, the send review, the approval window, .csd names, the light theme). |
| `assets/promo-440x280.png` | Small promo tile (required). |
| `assets/marquee-1400x560.png` | Marquee tile (optional, for featuring). |
| `assets/1..5-*.png` | The popup and approval-window captures the screenshots frame (2x, from the real pages of this checkout). |
| `gen-assets.mjs` | Renders every image above in headless Chromium from the built pages and a fixed demo wallet (offline); needs `PLAYWRIGHT_CORE` and `PLAYWRIGHT_CHROMIUM`. |

The store **icon** is the existing `../public/icons/icon-128.png`.

Upload artifact: `npm run package` (reproducible zip), but the Web Store needs
`manifest.json` at the zip root, so for the store, zip the **contents** of `dist/`
(flat), not the `cairn-wallet/`-nested release zip.
