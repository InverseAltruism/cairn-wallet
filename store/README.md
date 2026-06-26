# Chrome Web Store submission package

Everything needed to list Cairn Wallet. Start with **SUBMISSION-CHECKLIST.md**.

| File | What it is |
|---|---|
| `SUBMISSION-CHECKLIST.md` | Ordered checklist; **(you)** items are operator account/legal/host steps. |
| `STORE-LISTING.md` | Paste-ready copy for every dashboard field (name, description, single purpose, permission justifications, data disclosures, remote-code=No, trader status, reviewer notes). |
| `PRIVACY-POLICY.md` | The privacy policy to host at a public URL (fill in the contact-email placeholders first). |
| `assets/screenshot-1..4.png` | 1280×800 store screenshots (self-custody, HD backup, on-chain actions, safe send). |
| `assets/promo-440x280.png` | Small promo tile (required). |
| `assets/marquee-1400x560.png` | Marquee tile (optional, for featuring). |
| `assets/1..4-*.png` | The raw popup captures the framed screenshots were built from. |
| `gen-assets.mjs` | Regenerates the framed assets from the popup captures (render the HTML it emits at the listed pixel sizes and screenshot). |

The store **icon** is the existing `../public/icons/icon-128.png`.

Upload artifact: `npm run package` (reproducible zip), but the Web Store needs
`manifest.json` at the zip root, so for the store, zip the **contents** of `dist/`
(flat), not the `cairn-wallet/`-nested release zip.
