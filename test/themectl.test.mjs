// The Settings theme control (src/popup/themectl.ts) over cairn-ui's window.CairnTheme. It must show the choice that
// is in force, also when the approval window or the system changes it (theme.js reports those through onChange), and
// a press must go through CairnTheme.set, which stores the choice for both pages, with the reveal starting at the
// button. A page where theme.js did not load keeps working.
// Run: npx tsx test/themectl.test.mjs   (offline)
import { mountThemeControl } from "../src/popup/themectl.ts";
import { checker } from "./helpers/check.mjs";

const { check, done } = checker("theme control");

function fakeButton(choice, left) {
  const attrs = {};
  const listeners = {};
  return {
    dataset: { themeChoice: choice },
    setAttribute: (k, v) => { attrs[k] = v; },
    getAttribute: (k) => attrs[k],
    addEventListener: (t, fn) => { listeners[t] = fn; },
    getBoundingClientRect: () => ({ left, top: 100, width: 80, height: 32 }),
    click: () => listeners.click?.(),
  };
}
function fakeTheme(initial) {
  let choice = initial;
  const subs = [];
  const sets = [];
  let syncs = 0;
  return {
    sets,
    get syncs() { return syncs; },
    fromElsewhere(c) { choice = c; for (const s of subs) s({ mode: c === "dark" ? "dark" : "light", choice: c }); },
    api: {
      startSync: () => { syncs++; },
      current: () => ({ mode: choice === "dark" ? "dark" : "light", choice }),
      parseChoice: (v) => (v === "light" || v === "dark" ? v : "system"),
      set: (c, from) => { sets.push({ c, from }); choice = c; for (const s of subs) s({ mode: "light", choice: c }); return Promise.resolve(); },
      onChange: (fn) => { subs.push(fn); return () => undefined; },
    },
  };
}
const checked = (bs) => bs.filter((b) => b.getAttribute("aria-checked") === "true").map((b) => b.dataset.themeChoice).join(",");

const buttons = [fakeButton("system", 0), fakeButton("light", 100), fakeButton("dark", 200)];
const root = { querySelectorAll: () => buttons };
const t = fakeTheme("light");
mountThemeControl(root, t.api);
check(`on open it shows the stored choice (checked: ${checked(buttons)})`, checked(buttons) === "light");
check("it follows the system and other windows (startSync called once)", t.syncs === 1);

buttons[2].click();
await Promise.resolve();
check(`a press sets that choice through CairnTheme.set (${JSON.stringify(t.sets)})`, t.sets.length === 1 && t.sets[0].c === "dark");
check("the reveal starts at the centre of the pressed button", t.sets[0].from.x === 240 && t.sets[0].from.y === 116);
check(`and the control shows it (checked: ${checked(buttons)})`, checked(buttons) === "dark");

t.fromElsewhere("system");
check(`a choice made in the approval window shows here too (checked: ${checked(buttons)})`, checked(buttons) === "system");

let threw = false;
try { mountThemeControl(root, undefined); } catch { threw = true; }
check("without theme.js the control is inert and nothing throws", !threw);

done("themectl");
