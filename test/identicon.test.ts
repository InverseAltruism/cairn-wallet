// The wallet draws account identities with cairn-ui's avatar (src/vendor/cairn-ui/avatar.js), the module the site's
// names pages use, so an account and its name's page show the same avatar. Driven through the real paintAvatar and
// renderAcctSelect against a stub document:
//  - a primary name paints a `ui-avatar` whose background is the vendored avatarBackground of that name, with no
//    letter in it, the same for that name under any address;
//  - a name-less account draws the avatar of its address in lower case, with no mark and no letter, and a later name
//    replaces it with the name's avatar;
//  - one account, one identity on every surface: the switcher draws the account the header shows with the header's
//    avatar, another account with its primary name's avatar once read, else its address's (lower case).
//    RED-FIRST: put back the cairn mark for a name-less account (paintAvatar and rowAvatarHtml at 0b4a582) and the
//    address checks fail; seed every row by its address (identitySeed(null, addr)) and the name row checks fail.
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
const { knownNames } = await import("../src/popup/popup-state.js");

const A = "0x7A3F9C21" + "7a3f9c21".repeat(4);
const B = "0x" + "c9d8e7f6".repeat(5);
const av = byId("avatar");

paintAvatar("alice", A);
check("a primary name: the element is a ui-avatar", av.classList.contains("ui-avatar"));
check(`a primary name: the background is the vendored avatar of the name (${av.style.background})`, av.style.background === avatarBackground("alice"));
check(`a primary name: no letter is drawn (text ${JSON.stringify(av.textContent)}, markup ${JSON.stringify(av.innerHTML)})`, av.textContent === "" && av.innerHTML === "");

paintAvatar(null, A);
check("no primary name: the avatar of the address, in lower case", av.style.background === avatarBackground(A.toLowerCase()));
check("no primary name: no mark and no letter in it, still a ui-avatar", !av.classList.contains("mark") && av.innerHTML === "" && av.textContent === "" && av.classList.contains("ui-avatar"));

paintAvatar("alice", B);
check("a name after the address: the name's avatar replaces it", av.style.background === avatarBackground("alice") && av.innerHTML === "");
check("the name seeds the avatar, not the address: alice under another account draws the same", av.style.background === avatarBackground("alice"));
check("and it differs from that account's address avatar", av.style.background !== avatarBackground(B));

// the header now shows alice for the active account A
const C = "0x" + "a1b2c3d4".repeat(5);
renderAcctSelect([{ addr: A, label: "Main" }, { addr: B, label: "Miner key" }, { addr: C, label: "Spare" }], 0);
let menu = byId("acct-menu").innerHTML;
check("the active row draws the header's avatar: alice's, not A's address avatar", menu.includes(avatarHtml("alice", "acct-dot")) && !menu.includes(avatarHtml(A.toLowerCase(), "acct-dot")));
check("an account whose name was not read draws its address's avatar, in lower case", menu.includes(avatarHtml(B, "acct-dot")) && menu.includes(avatarHtml(C, "acct-dot")));
check("three accounts, three avatars", (menu.match(/class="ui-avatar acct-dot"/g) || []).length === 3);
knownNames.set(B, "bob");
knownNames.set(C, null);
renderAcctSelect([{ addr: A, label: "Main" }, { addr: B, label: "Miner key" }, { addr: C, label: "Spare" }], 0);
menu = byId("acct-menu").innerHTML;
check("once B's primary name is read, B's row draws bob's avatar, as the header would", menu.includes(avatarHtml("bob", "acct-dot")) && !menu.includes(avatarHtml(B, "acct-dot")));
check("an account read to have no name draws its address's avatar, as the header would", menu.includes(avatarHtml(C, "acct-dot")));
paintAvatar(null, A);
renderAcctSelect([{ addr: A, label: "Main" }, { addr: B, label: "Miner key" }], 0);
menu = byId("acct-menu").innerHTML;
check("a name-less active account: its row draws the address avatar the header draws", menu.includes(avatarHtml(A.toLowerCase(), "acct-dot")) && !menu.includes(avatarHtml("alice", "acct-dot")) && av.style.background === avatarBackground(A.toLowerCase()));
check("no avatar anywhere carries the mark", !menu.includes("mark") && !av.classList.contains("mark"));

done("identicon");
