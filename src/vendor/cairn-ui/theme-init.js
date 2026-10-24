// The theme before the first paint. Load it as a classic, blocking script in <head>, before the stylesheets, so a page
// never shows the wrong theme. A stored "light" or "dark" wins; anything else, or nothing, follows the system. Storage can
// throw (private windows, blocked site data): the system decides then. The key is theme.js's KEY (test/theme-init.test.mjs).
(() => {
  const KEY = "cairn-theme";
  let stored = null;
  try {
    stored = window.localStorage.getItem(KEY);
  } catch {
    stored = null;
  }
  const choice = stored === "light" || stored === "dark" ? stored : "system";
  const dark = choice === "dark" || (choice === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  const root = document.documentElement;
  root.setAttribute("data-theme", dark ? "dark" : "light");
  root.setAttribute("data-theme-choice", choice);
  root.style.colorScheme = dark ? "dark" : "light";
})();
