# Cairn Wallet — Chrome Web Store Submission Checklist

Work top to bottom. Items marked **(you)** require the operator (account/legal/host
actions the build can't do); everything else is already prepared in this repo.

## 1. Developer account  (you)
- [ ] Register at https://chrome.google.com/webstore/devconsole and pay the **one-time
      $5 USD** registration fee.
- [ ] **Enable 2-Step Verification** on the publishing Google account — submission is
      blocked without it.
- [ ] Set a monitored developer contact email (Google sends review/policy notices here).
- [ ] Declare **Trader** status and provide the legal name + contact Google requires
      (shown to EU users). Required for EU distribution.

## 2. Host the privacy policy  (you)
- [ ] Publish `store/PRIVACY-POLICY.md` at a public URL (e.g.
      `https://cairn-substrate.com/wallet-privacy.html`). Fill in the `inversealtruism@gmail.com`
      placeholders first.
- [ ] Put that URL in the dashboard **Privacy practices → Privacy policy** field.

## 3. Build the upload artifact
- [x] `npm ci && npm test` — full gate passes (22 suites, 1000+ checks).
- [x] `npm run build` — MV3 bundle, no remote code, strict CSP.
- [ ] Produce the upload zip: `npm run package`. This emits TWO reproducible artifacts:
      **`cairn-wallet-store.zip`** (manifest.json at the ROOT — upload THIS one to the
      Web Store) and `cairn-wallet.zip` (nested under `cairn-wallet/`, for `Load unpacked`).
      Each gets a `.sha256` sidecar; the zips are byte-identical across machines for the
      same source, so the published hash is reproducible.
      Note: the store rejects a zip without a root-level `manifest.json` — that is exactly
      why `cairn-wallet-store.zip` exists. Do not upload the nested `cairn-wallet.zip`.

## 4. Manifest / policy compliance  (already done in repo)
- [x] `manifest_version: 3`.
- [x] `description` = 124 chars (≤ 132).
- [x] Minimal permissions: `storage`, `unlimitedStorage`, `alarms`.
- [x] Host permissions narrow; custom hosts via `optional_host_permissions` requested at
      user action.
- [x] Strict CSP; no WASM ⇒ no `'wasm-unsafe-eval'` needed.
- [x] No remotely-hosted code (all deps bundled); not obfuscated.

## 5. Listing assets  (in store/assets/)
- [x] Store icon 128×128 — `public/icons/icon-128.png`.
- [x] Screenshots 1280×800 (3–5) — `store/assets/screenshot-1..4.png`.
- [x] Small promo tile 440×280 — `store/assets/promo-440x280.png`.
- [x] Marquee 1400×560 (optional) — `store/assets/marquee-1400x560.png`.

## 6. Dashboard fields  (copy from STORE-LISTING.md)
- [ ] Name, summary, detailed description, category (Productivity), language.
- [ ] Single-purpose statement.
- [ ] Per-permission + per-host justifications.
- [ ] Data categories: leave **ALL UNCHECKED** (NONE collected/transmitted — keys + state stay on-device; see STORE-LISTING.md / CHROME-SUBMISSION.md) + the 3 certifications checked.
- [ ] Remote code = **No**.
- [ ] Upload screenshots + promo tile.

## 7. Submit  (you)
- [ ] Click **Submit for review**. Expect a few days up to ~3 weeks (a new developer +
      a wallet + a localhost host permission can trigger extended/manual review; the
      "notes for review" text in STORE-LISTING.md pre-empts the common questions).

## Likely-rejection guardrails (already handled)
- Over-broad permissions → we use only `storage`/`unlimitedStorage`/`alarms` + narrow hosts. ✓
- Missing/weak privacy policy or Limited Use → policy written; certifications true. ✓
- Suspected remote code → none; all bundled, reproducible. ✓
- Obfuscation → none (readable/minified only). ✓
- Single-purpose violation → one purpose (a CSD wallet). ✓
