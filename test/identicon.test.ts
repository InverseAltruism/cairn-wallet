// The wallet draws account identities with cairn-ui's avatar (src/vendor/cairn-ui/avatar.js), the module the site's
// names pages use, so an account and its name's page show the same avatar. Driven through the real paintAvatar and
// renderAcctSelect against a stub document:
//  - a primary name paints a `ui-avatar` whose background is the vendored avatarBackground of that name, with no
//    letter in it, the same for that name under any address;
//  - a name-less account shows the cairn mark, and a later name clears the mark;
//  - each account switcher row carries the vendored avatar seeded by its address in lower case.
// Run: npx tsx test/identicon.test.ts   (offline)
import { avatarBackground, avatarHtml } from "../src/vendor/cairn-ui/avatar.js";
import { checker } from "./helpers/check.mjs";

const { check, done } = checker("identity avatar (vendored cairn-ui module, real popup code):");

// Only what paintAvatar and renderAcctSelect touch. Assigning innerHTML sets the text to the markup without its tags.
class Stub {
  html = "";
  textContent = "";
  hidden = false;
  className = "";
  onclick: (() => void) | null = null;
  readonly style: Record<string, string> = {};
  readonly dataset: Record<string, string> = {};
  readonly classes = new Set<string>();
  readonly classList = {
    add: (...c: string[]) => { for (const x of c) this.classes.add(x); },
    remove: (...c: string[]) => { for (const x of c) this.classes.delete(x); },
    contains: (c: string) => this.classes.has(c),
    toggle: (c: string, on?: boolean) => ((on ?? !this.classes.has(c)) ? this.classes.add(c) : this.classes.delete(c)),
  };
  get innerHTML() { return this.html; }
  set innerHTML(v: string) { this.html = String(v); this.textContent = this.html.replace(/<[^>]*>/g, ""); }
  querySelectorAll() { return []; }
  querySelector() { return null; }
  addEventListener() { /* no events are dispatched here */ }
  setAttribute() { /* attributes are not read back here */ }
}
const els = new Map<string, Stub>();
const byId = (id: string) => { let e = els.get(id); if (!e) { e = new Stub(); els.set(id, e); } return e; };
const g = globalThis as unknown as Record<string, unknown>;
g.document = { getElementById: byId, querySelector: () => null, querySelectorAll: () => [], addEventListener: () => { /* no events are dispatched here */ } };
g.matchMedia = () => ({ matches: true });

// after the stub: the popup modules read the document when they run
const { paintAvatar } = await import("../src/popup/popup-balance.js");
const { renderAcctSelect } = await import("../src/popup/popup-accounts.js");

const A = "0x7A3F9C21" + "7a3f9c21".repeat(4);
const B = "0x" + "c9d8e7f6".repeat(5);
const av = byId("avatar");

paintAvatar("alice", A);
check("a primary name: the element is a ui-avatar", av.classList.contains("ui-avatar"));
check("a primary name: not in the mark state", !av.classList.contains("mark"));
check(`a primary name: the background is the vendored avatar of the name (${av.style.background})`, av.style.background === avatarBackground("alice"));
check(`a primary name: no letter is drawn (text ${JSON.stringify(av.textContent)}, markup ${JSON.stringify(av.innerHTML)})`, av.textContent === "" && av.innerHTML === "");

paintAvatar(null, A);
check("no primary name: the cairn mark", av.classList.contains("mark") && av.innerHTML.startsWith("<svg") && av.style.background === "");
check("no primary name: still drawn as a ui-avatar (its circle and hairline)", av.classList.contains("ui-avatar"));

paintAvatar("alice", B);
check("a name after the mark: the mark is gone", !av.classList.contains("mark") && av.innerHTML === "" && av.textContent === "");
check("the name seeds the avatar, not the address: alice under another account draws the same", av.style.background === avatarBackground("alice"));
check("and it differs from that account's address avatar", av.style.background !== avatarBackground(B));

renderAcctSelect([{ addr: A, label: "Main" }, { addr: B, label: "Miner key" }], 0);
const menu = byId("acct-menu").innerHTML;
check("each switcher row carries the vendored avatar of its address, in lower case", menu.includes(avatarHtml(A.toLowerCase(), "acct-dot")) && menu.includes(avatarHtml(B, "acct-dot")));
check("two accounts, two avatars", (menu.match(/class="ui-avatar acct-dot"/g) || []).length === 2);

done("identicon");
