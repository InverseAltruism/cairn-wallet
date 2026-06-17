// Provider-event port registry tests (doc 28 Phase 2): the security-critical property is that a page
// only ever receives events for ITS OWN origin (keyed on the unforgeable sender origin). Run: npx tsx test/events.test.ts
import { PortRegistry } from "../src/core/events.js";

declare const process: { exit(code: number): void };
let pass = 0, fail = 0;
const check = (n: string, c: boolean) => { c ? (pass++, console.log("  ✅ " + n)) : (fail++, console.log("  ❌ " + n)); };
const mkPort = () => { const msgs: any[] = []; return { msgs, postMessage(m: any) { msgs.push(m); } }; };

const r = new PortRegistry();
const a1 = mkPort(), a2 = mkPort(), b1 = mkPort();
r.add("https://a.example", a1); r.add("https://a.example", a2); r.add("https://b.example", b1);
check("size counts all registered ports", r.size === 3);

r.emitToOrigin("https://a.example", "accountsChanged", []);
check("emitToOrigin reaches ALL ports of that origin", a1.msgs.length === 1 && a2.msgs.length === 1);
check("★ emitToOrigin does NOT reach another origin (cross-origin isolation)", b1.msgs.length === 0);
check("event message shape is {kind:'cairn-event',event,data}", a1.msgs[0].kind === "cairn-event" && a1.msgs[0].event === "accountsChanged" && Array.isArray(a1.msgs[0].data));

r.emitAll("disconnect", null);
check("emitAll reaches every origin's ports", a1.msgs.length === 2 && a2.msgs.length === 2 && b1.msgs.length === 1);

r.remove("https://a.example", a1);
r.emitToOrigin("https://a.example", "x", 1);
check("a removed port no longer receives", a1.msgs.length === 2 && a2.msgs.length === 3);

r.remove("https://b.example", b1);
check("an origin with no ports left is pruned (size)", r.size === 1);

const bad = { postMessage() { throw new Error("port closing"); } };
const survivor = mkPort();
r.add("https://c.example", bad); r.add("https://c.example", survivor);
r.emitToOrigin("https://c.example", "y", 2);
check("a throwing port can't break delivery to its siblings", survivor.msgs.length === 1);

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
