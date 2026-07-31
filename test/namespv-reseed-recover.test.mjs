// M8 (B5e): the wallet's header SPV chain must self-heal on a STRUCTURAL sync break (a reorg orphaned the
//   tip), never wedge permanently, while a TRANSIENT transport failure keeps the cache and fails closed.
// M12 (B5e): a poisoning 2nd source must not DoS-downgrade a name the honest source independently proves;
//   per-source recovery routes to the honest proof, flags the poisoner, never trusts a served claim.
//
// M12 is exercised end-to-end in name2-union-poc.mjs [B]/[B2]. This file adds the transport-level M8
// transient-vs-structural split, which name2 does not cover.
//
// Run: node --import tsx test/namespv-reseed-recover.test.mjs   (offline)
import { liveSpvSource, isTransientSyncError } from "../src/core/namespv.ts";

let pass = 0, fail = 0;
const check = (n, c) => { c ? (pass++, console.log("  ✓ " + n)) : (fail++, console.error("  ✗ " + n)); };

// A stub LightClient wired through liveSpvSource is out of reach (it builds its OWN vendored LightClient).
// So drive M8's TRANSPORT split at the source-shape level: a source-scan pin that the split exists at the
// use-site (the same pentest.ts idiom the campaign uses when a live seam would be over-engineering on a
// fund path), plus a behavioral check of the regex classifier that decides transient-vs-structural.
import { readFileSync } from "node:fs";
const src = readFileSync(new URL("../src/core/namespv.ts", import.meta.url), "utf8");

console.log("M8 (B5e) - transient-vs-structural sync self-heal:");

// (1) the LC binding is mutable (a const cannot be reseeded in place).
check("liveSpvSource holds LC in a reassignable binding (reseed target)", /\blet LC = lc;/.test(src));

// (2) the sync is wrapped so a throw is classified, not blindly propagated.
const prepStart = src.indexOf("async prepare(maxEventHeight");
const prepEnd = src.indexOf("async blockAt(", prepStart);
const prep = src.slice(prepStart, prepEnd);
check("prepare() wraps LC.sync in a try/catch (M8 self-heal)", /try \{[\s\S]*await LC\.sync\(want\)[\s\S]*\} catch/.test(prep));

// (3) TRANSIENT failures rethrow (keep the cache); only a STRUCTURAL break reseeds. TSA-5: the classifier
// is now the ONE exported isTransientSyncError (this file imports it below), called at the throw site.
check("a transient class rethrows (KEEP the cache, DOS-HDR-3)", /isTransientSyncError\(msg\)\)\s*throw e;/.test(prep));
// FIX-1b (G8 review): the snapshot is NOT dropped before the reseed - a set(null)-before-reseed would nuke
// an honest snapshot if the reseed then failed. On reseed SUCCESS the post-catch toSnapshot write replaces
// it; on FAILURE the old snapshot is kept and heals next prepare(). So the catch must NOT call cache.set(null).
check("the reseed does NOT drop the snapshot before syncing (no set(null)-before-reseed nuke)", !/cache\.set\(null\)/.test(prep));
check("the reseed builds a fresh client from the baked checkpoint", /new LightClient\(\{ client, headersBatchProvider: headersBatch, checkpoints \}\)[\s\S]*syncFromCheckpoint\(CP\.height/.test(prep));
check("the reseed re-syncs to `want` (a lying-high header still throws -> fail-closed)", /await fresh\.sync\(want\);[\s\S]*LC = fresh;/.test(prep));
check("the reseed adopts the fresh client (LC = fresh)", prep.indexOf("LC = fresh;") > prep.indexOf("await fresh.sync(want)"));

// (4) the classifier behaves: transient markers match, a prev-link break does NOT. TSA-5: assertions run
// against the REAL exported isTransientSyncError (imported above), NOT a hand-duplicated copy, so dropping
// a marker from the source function reds these directly (source-drift can no longer hide behind a test copy).
check("classifier: '/api/headers 429' is TRANSIENT (keep cache)", isTransientSyncError("/api/headers 429"));
check("classifier: '502 gateway' is TRANSIENT", isTransientSyncError("HTTP 502 bad gateway"));
// G8 review (Opus-A): a 200 with a non-JSON body (a CF interstitial) throws a JSON parse error - a
// transport fault, NOT a chain fault. It must classify TRANSIENT so it keeps the cache instead of
// gratuitously reseeding.
check("classifier: 'Unexpected end of JSON input' is TRANSIENT (CF 200-HTML blip)", isTransientSyncError("Unexpected end of JSON input"));
check("classifier: 'Unexpected token < in JSON' is TRANSIENT", isTransientSyncError("Unexpected token < in JSON at position 0"));
check("classifier: a prev-link break is STRUCTURAL (reseed)", !isTransientSyncError("header 40123 prev-link mismatch (reorg)"));
check("classifier: 'invalid prev hash' is STRUCTURAL", !isTransientSyncError("invalid prev hash at 51000"));
check("classifier: 'bad bits at' is STRUCTURAL", !isTransientSyncError("bad bits at 51000"));

// M12 source-shape pin (behavioral coverage is name2-union-poc [B]/[B2]).
console.log("M12 (B5e) - union per-source recovery:");
const union = src.slice(src.indexOf("export async function verifyNameUnion"));
check("M12: per-source recovery only runs after the unioned replay failed (usable.length > 1 branch)", /if \(usable\.length > 1\) \{[\s\S]*replayName\(name, r\.hints, src\)/.test(union));
check("M12: recovery honors ONLY an agreed single winner (addrs.size === 1)", /addrs\.size === 1/.test(union));
check("M12: a recovery ALWAYS flags disagree (poisoner surfaced, never a silent green)", /disagree: recovered\.length < usable\.length \|\| agreed < usable\.length/.test(union));
check("M12: viaFill / scope-insufficient recoveries are excluded (keep their own fail-closed handling)", /!solo\.viaFill && r\.scopedReplaySufficient !== false/.test(union));

console.log(`\nnamespv-reseed-recover: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
