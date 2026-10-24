// The System, Light, Dark control in Settings. The choice is stored by cairn-ui's theme.js in this extension's own
// localStorage, which the popup and the approval window share; theme-init.js applies it before either page paints.
import type { CairnThemeApi, ThemeChoice } from "../vendor/cairn-ui/theme.js";

/** Wires every `[data-theme-choice]` button under `root`; a page without theme.js keeps the system theme. */
export function mountThemeControl(root: ParentNode, theme: CairnThemeApi | undefined): void {
  if (!theme) return;
  theme.startSync();
  const buttons = Array.from(root.querySelectorAll<HTMLElement>("[data-theme-choice]"));
  const paint = () => {
    const choice = theme.current().choice;
    for (const b of buttons) b.setAttribute("aria-checked", String(b.dataset.themeChoice === choice));
  };
  for (const b of buttons) {
    b.addEventListener("click", () => {
      const choice: ThemeChoice = theme.parseChoice(b.dataset.themeChoice);
      const r = b.getBoundingClientRect();
      void theme.set(choice, { x: r.left + r.width / 2, y: r.top + r.height / 2 }).then(paint);
    });
  }
  theme.onChange(paint);
  paint();
}
