// M8 (B5e): the wallet's header SPV chain must self-heal on a STRUCTURAL sync break (a reorg orphaned the
//   tip), never wedge permanently, while a TRANSIENT transport failure keeps the cache and fails closed.
// M12 (B5e): a poisoning 2nd source must not DoS-downgrade a name the honest source independently proves;
//   per-source recovery routes to the honest proof, flags the poisoner, never trusts a served claim.
//
// M12 is exercised end-to-end in name2-union-poc.mjs [B]/[B2]. This file adds the transport-level M8
// transient-vs-structural split, which name2 does not cover. The reseed source is the newest anchor's chunk held
// in memory (no request); the stored suffix is replaced only after the fresh client has synced to `want`.
//
// Run: npx tsx test/namespv-reseed-recover.test.mjs   (offline)
import { readFileSync } from "node:fs";
import { isTransientSyncError } from "../src/core/namespv.ts";
import { checker } from "./helpers/check.mjs";

const t = checker();
const check = t.check;

// liveSpvSource builds its own vendored LightClient, so the reseed ordering is pinned at the use-site (the same
// pentest.ts source-scan idiom), plus a behavioral check of the classifier that decides transient-vs-structural.
const src = readFileSync(new URL("../src/core/namespv.ts", import.meta.url), "utf8");

console.log("M8 (B5e) - transient-vs-structural sync self-heal:");

// (1) the LC binding is mutable (a const cannot be reseeded in place).
check("liveSpvSource holds LC in a reassignable binding (reseed target)", /\blet LC = restored\.client;/.test(src));

// (2) the sync is wrapped so a throw is classified, not blindly propagated.
const prepStart = src.indexOf("async prepare(maxEventHeight");
const prepEnd = src.indexOf("async blockAt(", prepStart);
const prep = src.slice(prepStart, prepEnd);
check("prepare() wraps the LC syncs in a try/catch inside the serialized block (M8 self-heal)",
  /serializeSync\(async \(\) => \{[\s\S]*?try \{[\s\S]*?await syncAligned\(LC, want\)[\s\S]*?\} catch \(e\) \{/.test(prep));

// (3) A clock fault and a TRANSIENT failure rethrow (the store is kept, DOS-HDR-3); only a STRUCTURAL break
// reseeds. The classifier is the ONE exported isTransientSyncError (imported above), called at the throw site.
const catchIdx = prep.indexOf("} catch (e) {");
const clockIdx = prep.indexOf("CLOCK_FAULT.test(msg)) throw clockRefusal(msg);", catchIdx);
const transientIdx = prep.indexOf("isTransientSyncError(msg)) throw e;", catchIdx);
const reseedIdx = prep.indexOf("await seedFromAnchor()", catchIdx);
check("a transient class rethrows (KEEP the store, DOS-HDR-3)", transientIdx > catchIdx);
check("a clock fault is refused with the clock named, before any reseed (the store is kept)", clockIdx > catchIdx && clockIdx < reseedIdx);
check("the reseed runs only after the transient rethrow: structural breaks only", reseedIdx > transientIdx && transientIdx > clockIdx);

// FIX-1b (G8 review): the stored suffix is NOT dropped before the reseed. A write issued before the fresh
// client has synced to `want` would replace an honest suffix with nothing if the reseed then failed. On reseed
// success the persist after the block replaces it; on failure the old suffix stays and heals on the next prepare().
const freshSyncIdx = prep.indexOf("await syncAligned(fresh, want);", reseedIdx);
const adoptIdx = prep.indexOf("LC = fresh;", reseedIdx);
const resetIdx = prep.indexOf("persistedTip = newest;", reseedIdx);
const finalPersistIdx = prep.lastIndexOf("persist();");
check("the reseed does not write the store between seeding and adoption (no clear-before-reseed nuke)",
  reseedIdx > 0 && adoptIdx > reseedIdx && !/persist\(|detachStoreWrite|store\.|deleteAbove/.test(prep.slice(reseedIdx, adoptIdx)));
check("the reseed builds the fresh client from the anchor chunk held in memory: no request, every pin enforced by seedTrusted",
  /const seedFromAnchor = async \(\) => \(await LightClient\.fromRecords\(anchor\.subarray\(anchor\.length - SEED \* HB\), \{ firstHeight: newest - SEED \+ 1, anchorHeight: newest \}, lcOpts\)\)\.client;/.test(src));
const seedDef = src.slice(src.indexOf("const seedFromAnchor ="), src.indexOf("\n", src.indexOf("const seedFromAnchor =")));
check("seedFromAnchor makes no request (no fetch, header batch or chunk acquisition)", seedDef.length > 40 && !/fetch|Batch|acquire|client\./.test(seedDef));
check("the reseed re-syncs to `want` BEFORE adopting the client (a lying-high header still throws -> fail-closed)",
  freshSyncIdx > reseedIdx && adoptIdx > freshSyncIdx);
check("the reseed resets persistedTip only AFTER adopting the fresh client, then the block persists the new suffix",
  resetIdx > adoptIdx && finalPersistIdx > resetIdx);
check("a reseeded sync that fails at the anchor refuses with the checkpoint message (pinRefusal), not a bare sync error",
  /if \(tipOf\(fresh\) === newest && !isTransientSyncError\(m2\)\) throw pinRefusal\(anchorSpec, e2\);/.test(prep)
  && /const pinRefusal = \(spec: ChunkSpec, e: unknown\) =>\s*new Error\(`the wallet could not match the chain to its built-in checkpoints/.test(src));
check("a clock fault during the reseeded sync is refused with the clock named, never pinRefusal",
  /catch \(e2\) \{\s*const m2 = String\(\(e2 as Error\)\?\.message \|\| e2\);\s*if \(CLOCK_FAULT\.test\(m2\)\) throw clockRefusal\(m2\);/.test(prep));

// (4) the classifier behaves: transient markers match, a prev-link break does NOT. TSA-5: assertions run
// against the REAL exported isTransientSyncError, NOT a hand-duplicated copy, so dropping a marker from the
// source function reds these directly.
check("classifier: '/api/headers 429' is TRANSIENT (keep the store)", isTransientSyncError("/api/headers 429"));
check("classifier: '502 gateway' is TRANSIENT", isTransientSyncError("HTTP 502 bad gateway"));
check("classifier: any other '/api/headers' status is TRANSIENT", isTransientSyncError("/api/headers 404"));
check("classifier: a non-dense header range is TRANSIENT", isTransientSyncError("range is non-dense at 51000"));
// G8 review (Opus-A): a 200 with a non-JSON body (a CF interstitial) throws a JSON parse error - a
// transport fault, NOT a chain fault. It must classify TRANSIENT so it keeps the store instead of
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

t.done("namespv-reseed-recover");
