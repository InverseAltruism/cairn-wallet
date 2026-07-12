#!/usr/bin/env bash
# Build the wallet's SPV verification bundle — the audited light client + consensus codec/crypto
# + the CairnX resolver, as ONE pinned, reviewable browser ESM (mirrors cairn/scripts/build-trade-vendor.sh).
#
# WHY a vendored bundle (not an npm dep): the wallet is a fund-custody extension with a deliberately
# minimal, everything-inlined dependency surface. Shipping one reviewable artifact built from the
# in-repo AUDITED dists — rather than resolving a live npm dep tree at install time — keeps that posture.
# The output (src/vendor/cairnx-spv.js) is committed; esbuild (build.mjs) inlines it into dist/.
#
# It exports exactly what core/namespv.ts (the XREPO-1 name verifier) needs:
#   • LightClient + CsdClient  — PoW-verified header chain + node-RPC reads (block/tx)
#   • rpcTxToTx                 — decode a node-JSON tx into the consensus codec Tx
#   • txid / sighash / merkleRoot — recompute txids, bind a block's tx-set to the verified header root,
#                                  and re-derive the signing digest to authenticate a tx's signer
#   • addrFromPub / verifyDigest — recover + authenticate the proposer/attester (merkle root does NOT
#                                  commit the scriptSig, so the signature MUST be checked)
#   • resolve                   — THE audited CairnX resolver, reused (never re-typed) to replay the
#                                  merkle-verified name events and recompute ownership
#
# Rebuild with: bash scripts/build-spv-vendor.sh   (rerun + recommit whenever the SDK verify surface changes)
set -euo pipefail
cd "$(dirname "$0")/.."                                   # -> cairn-wallet/
ROOT="$(cd .. && pwd)"
LIGHT="$ROOT/csd-sdk/packages/light/dist/index.js"
CLIENT="$ROOT/csd-sdk/packages/client/dist/index.js"
CODEC="$ROOT/csd-sdk/packages/codec/dist/index.js"
CRYPTO="$ROOT/csd-sdk/packages/crypto/dist/index.js"
CAIRNX="$ROOT/csd-sdk/packages/cairnx/dist/index.js"
OUT="src/vendor/cairnx-spv.js"

for d in "$LIGHT" "$CLIENT" "$CODEC" "$CRYPTO" "$CAIRNX"; do
  [ -f "$d" ] || { echo "missing $d — run (cd $ROOT/csd-sdk && pnpm -r build) first"; exit 1; }
done

mkdir -p src/vendor
TMP_ENTRY="$(mktemp --suffix=.mjs)"
trap 'rm -f "$TMP_ENTRY"' EXIT
{
  printf 'export { LightClient, CsdClient } from "%s";\n' "$LIGHT"
  printf 'export { rpcTxToTx } from "%s";\n' "$CLIENT"
  printf 'export { txid, sighash, merkleRoot, verifyMerkleProof } from "%s";\n' "$CODEC"
  printf 'export { addrFromPub, verifyDigest, recoverSigner } from "%s";\n' "$CRYPTO"
  # cairnx-core: the WHOLE convention (constants, fee/name math, canonicalJson, parseRecord, the record
  # builders, *_KEYS, the §4 regexes) — so core/cairnx.ts IMPORTS them instead of hand-typing a second copy
  # (shared-core de-dup, cairn docs/Plans/46). esbuild already inlines all of cairnx-core to serve `resolve`
  # (namespv.ts), so this only WIDENS the export surface of the SAME reviewed bytes — no new dep tree, no
  # size change of note, MV3 posture unchanged (one inlined artifact).
  printf 'export * from "%s";\n' "$CAIRNX"
} > "$TMP_ENTRY"

node_modules/.bin/esbuild "$TMP_ENTRY" \
  --bundle --format=esm --platform=browser --target=es2022 \
  --legal-comments=none --outfile="$OUT"

echo "built $OUT ($(du -h "$OUT" | cut -f1))"
node --input-type=module -e "import('./$OUT').then(m=>{const k=Object.keys(m);const need=['LightClient','CsdClient','rpcTxToTx','txid','sighash','merkleRoot','addrFromPub','verifyDigest','recoverSigner','resolve','canonicalState','parseRecord','canonicalJson','payloadHash','tradeFee','makerRebate','nameRegFee','previewFill','fillIsSafe','finalizeWinnerCheck','isOpenClaimLane','hasLiveClaim','verifyFillSpv','replayLiveHold','fclaimHoldEnd','FILL_TIP_MARGIN','MAX_ACTIVE_CLAIMS','GAP_NEEDED','MAX_SCAN','V28_HEIGHT','NAME_RE','PKEY','RESERVED_NAMES','OFFER_KEYS','BID_KEYS','NAME_KEYS','FEE_BPS','FEE_BPS_V16','REBATE_BPS','REBATE_FLAT','V16_HEIGHT','V18_HEIGHT','MAX_AMOUNT','MAX_RECORD_BYTES','PROFILE_MAX_KEYS','PROFILE_MAX_VALUE_BYTES','TREASURY_ADDR','TICKER_RE','ADDR_RE','AMOUNT_RE','HASH_RE'];const miss=need.filter(x=>!k.includes(x));if(miss.length)throw new Error('missing exports: '+miss.join(','));console.log('exports ok ('+k.length+' symbols)')})"
