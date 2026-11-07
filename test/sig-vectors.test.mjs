// The wallet's signature checks accept what the node accepts. The node reads a scriptSig's 64 signature bytes as
// compact r || s only, then requires low S (compute-substrate src/crypto/mod.rs verify_sig). Every wallet path that
// verifies a signature goes through src/core/spvbind.ts: recoverSigner (fillspv's own-fill check) and bindSigner, the
// csd-crypto authorOf bind namespv and fillspv call per record. The csd-vectors SIG_VECTORS
// (test/vectors/sig-vectors.json) hold two compact signatures whose bytes are also DER-shaped, which the node
// accepts, and one 64-byte DER signature, which it refuses. Each is run through both primitives and through a name
// replay; the last block pins that src/ has no other signature check.
// Run: npx tsx test/sig-vectors.test.mjs   (offline)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { checker } from "./helpers/check.mjs";
import { verifyDigest, sighash as bundleSighash, addrFromPub } from "../src/vendor/cairnx-spv.js";
import { sighash as twinSighash } from "../src/core/csdtx.js";
import { recoverSigner, bindSigner } from "../src/core/spvbind.js";
import { verifyNameUnion } from "../src/core/namespv.js";
import { world, source, mkFetch } from "./_spvrig.ts";

const { check, done } = checker("signature vectors (csd-vectors SIG_VECTORS) through the wallet's signature checks:");
const ROOT = join(import.meta.dirname, "..");
const { vectors } = JSON.parse(readFileSync(join(ROOT, "test/vectors/sig-vectors.json"), "utf8"));

check("the vectors hold signatures the node accepts and one it refuses", vectors.some((v) => v.nodeAccepts) && vectors.some((v) => !v.nodeAccepts));

// The node's /block JSON shape for a vector tx (what the SPV source serves and bindBlockBody parses).
const rpcJson = (t) => ({
  version: t.version, locktime: t.locktime,
  inputs: t.inputs.map((i) => ({ prev_txid: i.prevTxid, vout: i.vout, script_sig: i.scriptSig })),
  outputs: t.outputs.map((o) => ({ value: o.value, script_pubkey: o.scriptPubkey })),
  app: { type: "Propose", domain: t.app.domain, payload_hash: t.app.payloadHash, uri: t.app.uri, expires_epoch: t.app.expiresEpoch },
});

const SRC = [{ label: "primary", base: "https://primary.example/trade/api" }];
const H = 50_000, TIP = 50_100;
for (const v of vectors) {
  const owner = v.owner.toLowerCase();
  const verdict = v.nodeAccepts ? "accepts" : "refuses";
  check(`${v.name}: the vector's sighash re-derives in the bundle and in the wallet's codec twin, and its owner from its key`,
    bundleSighash(v.tx) === v.expectedSighash && twinSighash(v.tx) === v.expectedSighash && addrFromPub(v.pub33) === owner);
  check(`${v.name}: verifyDigest ${verdict} as the node does`, verifyDigest(v.sig64, v.pub33, v.expectedSighash) === v.nodeAccepts);
  check(`${v.name}: recoverSigner names ${v.nodeAccepts ? "the signer" : "no signer"}`, recoverSigner(v.tx) === (v.nodeAccepts ? owner : null));
  const bound = await bindSigner(v.tx, { async prevoutScriptPubkey() { return owner; } });
  check(`${v.name}: bindSigner ${v.nodeAccepts ? "binds the coin owner" : "refuses the record as unsigned"} (${JSON.stringify(bound)})`,
    v.nodeAccepts ? bound.ok === true && bound.signer === owner : bound.ok === false && bound.kind === "unsigned");

  // A name replay over a hint naming the vector tx: an accepted signature proves the record (its uri is no name
  // record, so the replay then finds no owner); a refused one stops the replay at the record's authentication.
  const { blocks, hints } = world([{ height: H, tx: rpcJson(v.tx) }]);
  const spv = { ...source(blocks, TIP), async prevoutScriptPubkey(prevTxid) { return String(prevTxid).toLowerCase() === v.tx.inputs[0].prevTxid ? owner : null; } };
  const r = await verifyNameUnion("zzsig", SRC, spv, mkFetch({ [SRC[0].base]: { ok: true, resolve: { addr: owner, owner }, events: hints } }));
  check(`${v.name}: a name replay ${v.nodeAccepts ? "authenticates the record" : "refuses the record's signature"} (${r.reason})`,
    r.verified === false && (v.nodeAccepts ? /don't establish ownership/.test(r.reason) : /couldn't be authenticated/.test(r.reason)));
}

// Every signature check in src/ is one of the two spvbind primitives: no other module calls the bundle's verify,
// recover or author functions or noble's verify, so the vectors above cover every path.
const files = [];
const walk = (d) => { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) { if (n !== "vendor") walk(p); } else if (p.endsWith(".ts")) files.push(p); } };
walk(join(ROOT, "src"));
const bundleImports = (src) => [...src.matchAll(/import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*"[^"]*vendor\/cairnx-spv\.js"/g)].map((m) => m[1]).join(",");
const offenders = files.filter((f) => !f.endsWith(join("core", "spvbind.ts"))).filter((f) => {
  const src = readFileSync(f, "utf8");
  return /\b(verifyDigest|recoverSigner|authorOf)\b/.test(bundleImports(src)) || /secp256k1\.verify\(/.test(src.replace(/\/\/.*$/gm, ""));
});
check(`no module but spvbind.ts imports a signature check from the bundle or calls noble's verify (${offenders.map((f) => f.slice(ROOT.length + 1)).join(", ") || "none"})`, offenders.length === 0);
const spvbind = readFileSync(join(ROOT, "src/core/spvbind.ts"), "utf8");
check("spvbind.ts takes recoverSigner and authorOf from the bundle", /import \{[^}]*recoverSigner as recoverSignerFromScriptSig[^}]*authorOf[^}]*\} from "\.\.\/vendor\/cairnx-spv\.js"/.test(spvbind));

done("sig-vectors");
