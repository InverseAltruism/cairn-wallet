> Onboarding briefing for coding agents and outside contributors. `AGENTS.md` is canonical and this file imports it; make edits in `AGENTS.md` only.
> Production and operations specifics (hosting, deployment, keys) are intentionally out of scope here and maintained privately by the maintainers.

# CLAUDE.md (cairn-wallet)

The full technical briefing for this repo lives in `AGENTS.md` (the MV3 signer: architecture, key/send/name/fill flows, fund-safety invariants, dev/test/release, incident history, cross-repo map). It is the single source of truth; read it first and keep both files in sync by editing `AGENTS.md`.

@AGENTS.md

## Operating notes

- **This is the fund-custody endpoint: real keys, real CSD.** The single most important standing rule: security fixes must NEVER regress UX. No added latency, no declines on legitimate sends/buys, no over-engineering. Prefer warn over hard-block, honesty over machinery. Several "hardening" ideas (EIP-55-style checksums, forced argon2id migration, hard-blocking unverified sends) were explicitly DECLINED as over-engineering.
- Other red lines: local signing only, no unattended transaction broadcast ever, the Chrome Web Store upload stays manual and off CI, the deliberate code forks (csdtx.ts, node.ts selectInputs) are KEEP-IN-SYNC not dedupe, the build tripwires are load-bearing. All detailed in `AGENTS.md`.
- Maintainers handle versioning, tagging, releasing, and deploys; do not assume deploy access or bump versions in a PR.
- No em dashes / AI-slop in READMEs or user-facing docs.
