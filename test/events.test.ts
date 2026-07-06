// Provider-event port registry tests (doc 28 Phase 2): the security-critical property is that a page
// only ever receives events for ITS OWN origin (keyed on the unforgeable sender origin). Run: npx tsx test/events.test.ts
import { PortRegistry } from "../src/core/events.js";
import { checker } from "./_check.js";

const { check, done } = checker();
const mkPort = () => { const msgs: any[] = []; return { msgs, postMessage(m: any) { msgs.push(m); } }; };

const r = new PortRegistry();
const a1 = mkPort(), a2 = mkPort(), b1 = mkPort();
r.add("https://a.example", a1); r.add("https://a.example", a2); r.add("https://b.example", b1);
check("size counts all registered ports", r.size === 3);

r.emitToOrigin("https://a.example", "accountsChanged", []);
check("emitToOrigin reaches ALL ports of that origin", a1.msgs.length === 1 && a2.msgs.length === 1);
check("★ emitToOrigin does NOT reach another origin (cross-origin isolation)", b1.msgs.length === 0);
check("event message shape is {kind:'cairn-event',event,data}", a1.msgs[0].kind === "cairn-event" && a1.msgs[0].event === "accountsChanged" && Array.isArray(a1.msgs[0].data));

// PRIVACY INVARIANT (why emitAll was removed, 2026-07-06): a wallet-wide event (lock / account-switch)
// must reach ONLY the origins the user has CONSENTED to — never every connected page — or a random open
// site learns the wallet's lock/account-switch timing. Background emits per-consented-origin (emitConnected
// loops emitToOrigin over the consent map); model that here (a.* is "consented", b.* is not) and prove the
// connected-but-unconsented origin hears nothing. A broadcast emitAll() would have leaked to b.* too.
for (const consented of ["https://a.example"]) r.emitToOrigin(consented, "disconnect", null);
check("per-consented-origin emit reaches the consented origin's ports", a1.msgs.length === 2 && a2.msgs.length === 2);
check("★ a connected-but-UNconsented origin hears nothing (no lock-timing leak)", b1.msgs.length === 0);

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

done("events");
