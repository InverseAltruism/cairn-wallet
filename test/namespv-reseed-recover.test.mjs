// M8 (B5e): the wallet's header SPV chain must self-heal on a STRUCTURAL sync break (a reorg orphaned the
//   tip), never wedge permanently, while a TRANSIENT transport failure keeps the cache and fails closed.
// M12 (B5e): a poisoning 2nd source must not DoS-downgrade a name the honest source independently proves;
//   per-source recovery routes to the honest proof, flags the poisoner, never trusts a served claim.
//
// M12 is exercised end-to-end in name2-union-poc.mjs [B]/[B2]. This file adds the transport-level M8
// transient-vs-structural split, which name2 does not cover. The reseed seeds from the newest seal or from the newest
// anchor's chunk held in memory (no request); the stored suffix is replaced only after the fresh client has synced.
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

// (2) the runner's sync is wrapped so a throw is classified, not blindly propagated.
const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1");
const run = code.slice(code.indexOf("const run = async (): Promise<void> => {"), code.indexOf("const raise = "));
check("the runner wraps the shared client's page sync in a try/catch (M8 self-heal)",
  /try \{\s*await syncPages\(\(\) => LC, \(\) => lookupWant\(\) \|\| target, runPage\(\(from\) => from > lookupWant\(\), \(\) => lookupWant\(\) \|\| Infinity\),[^;]*;\s*\} catch \(e\) \{/.test(run));

// (3) The verified progress is persisted first; a clock fault and a TRANSIENT failure stop the run with their own error
// (the store is kept, DOS-HDR-3); only a STRUCTURAL break reseeds. The classifier is the ONE exported
// isTransientSyncError (imported above), called at the throw site.
const catchIdx = run.indexOf("} catch (e) {");
const persistIdx = run.indexOf("await serializeSync(persist);", catchIdx);
const clockIdx = run.indexOf("if (CLOCK_FAULT.test(msg)) { failAbove(clockRefusal(msg)); break; }", catchIdx);
const transientIdx = run.indexOf("if (isTransientSyncError(msg)) { failAbove(e); break; }", catchIdx);
const reseedIdx = Math.min(...["await lookupReseed(want)", "await boundedReseed()"].map((x) => run.indexOf(x, catchIdx)));
check("the verified progress is persisted before the failure is classified", persistIdx > catchIdx && persistIdx < clockIdx);
check("a transient class stops the run with its own error (KEEP the store, DOS-HDR-3)", transientIdx > catchIdx);
check("a clock fault is refused with the clock named, before any reseed (the store is kept)", clockIdx > catchIdx && clockIdx < reseedIdx);
check("the reseed runs only after the transient stop: structural breaks only", reseedIdx > transientIdx && transientIdx > clockIdx);

// FIX-1b (G8 review): the stored suffix is NOT dropped before the reseed. A write issued before the fresh client has
// synced would replace an honest suffix with nothing if the reseed then failed. The reseed functions write nothing;
// the adoption site sets persistedTip only after it took the fresh client, then persists the new suffix.
const body = (fn) => code.slice(code.indexOf(fn), code.indexOf("\n  };", code.indexOf(fn)));
const line = (fn) => code.slice(code.indexOf(fn), code.indexOf("\n", code.indexOf(fn)));
const reseeds = [...["const lookupReseed = ", "const boundedReseed = ", "const sealSeedNow = "].map(body), ...["const seedClient = ", "const syncFresh = "].map(line)].join("\n");
check("the reseed does not write the store between seeding and adoption (no clear-before-reseed nuke)",
  reseeds.length > 400 && !/persist\(|detachStoreWrite|store\.|deleteAbove|persistedTip =/.test(reseeds));
check("the table seed is the anchor chunk held in memory: no request, every pin enforced by seedTrusted",
  /const tableSeed = \(\): Seed => \(\{ top: newest, hash: table\.newestHash, work: null, tail: tableBase\.tail, tops: \[\] \}\);/.test(code)
  && /const tableBase = \{ height: newest, hash: table\.newestHash, work: null as bigint \| null, tail: anchor\.subarray\(anchor\.length - SEED \* HB\) \};/.test(code)
  && /const seedClient = \(s: Seed\) => seededClient\(s\.tail, s\.top, s\.hash, s\.work, lcOpts\);/.test(code));
const adoptSite = body("const adopt = ");
const takeIdx = adoptSite.indexOf("LC = fresh.client;"), resetIdx = adoptSite.indexOf("persistedTip = seed.top;"), persistAt = adoptSite.indexOf("await persist();");
check("the adoption site resets persistedTip only AFTER taking the fresh client, then persists the new suffix", takeIdx > 0 && resetIdx > takeIdx && persistAt > resetIdx);
check("a lookup's reseed syncs the fresh client to `want` BEFORE asking the adoption site (a lying-high header still throws)",
  body("const lookupReseed = ").indexOf("await syncFresh(fresh, want, lookupPage)") > 0 && body("const lookupReseed = ").indexOf("await syncFresh(fresh, want, lookupPage)") < body("const lookupReseed = ").indexOf("await adopt(fresh, seed)"));
// The reseed's transient-before-pin order and the checkpoint copy are pinned by behaviour in namespv-store-pins.
check("a clock fault during the reseeded sync is refused with the clock named, never pinRefusal",
  /const freshFailure = [^\n]*\n\s*const m = messageOf\(e\);\s*if \(CLOCK_FAULT\.test\(m\)\) return clockRefusal\(m\);/.test(code)
  && /if \(CLOCK_FAULT\.test\(m\)\) throw clockRefusal\(m\);/.test(body("const lookupReseed = ")));

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
check("M12: a viaFill solo replay refuses the recovery as the success path does, never drops its source (behaviour: namespv-union-scope case 4)", /if \(solo\.viaFill\) return \{ \.\.\.fail\(viaFillReason\(name\)\)/.test(union));

t.done("namespv-reseed-recover");
