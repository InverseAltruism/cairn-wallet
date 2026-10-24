// The System, Light, Dark control in Settings. The choice is stored by cairn-ui's theme.js in this extension's own
// localStorage, which the popup and the approval window share; theme-init.js applies it before either page paints.
import type { CairnThemeApi, ThemeChoice } from "../vendor/cairn-ui/theme.js";

const STEP: Record<string, number> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };

/** Wires every `[data-theme-choice]` button under `root` as one radio group; a page without theme.js keeps the
 *  system theme. */
export function mountThemeControl(root: ParentNode, theme: CairnThemeApi | undefined): void {
  if (!theme) return;
  theme.startSync();
  const buttons = Array.from(root.querySelectorAll<HTMLElement>("[data-theme-choice]"));
  // One tab stop for the group, on the checked option (the ARIA radio group pattern).
  const paint = () => {
    const choice = theme.current().choice;
    for (const b of buttons) {
      const on = b.dataset.themeChoice === choice;
      b.setAttribute("aria-checked", String(on));
      b.setAttribute("tabindex", on ? "0" : "-1");
    }
  };
  const choose = (b: HTMLElement) => {
    const choice: ThemeChoice = theme.parseChoice(b.dataset.themeChoice);
    const r = b.getBoundingClientRect();
    void theme.set(choice, { x: r.left + r.width / 2, y: r.top + r.height / 2 }).then(paint);
  };
  buttons.forEach((b, i) => {
    b.addEventListener("click", () => choose(b));
    b.addEventListener("keydown", (e: KeyboardEvent) => {
      const step = STEP[e.key];
      if (!step) return;
      e.preventDefault();
      const next = buttons[(i + step + buttons.length) % buttons.length];
      if (!next) return;
      next.focus();
      choose(next);
    });
  });
  theme.onChange(paint);
  paint();
}
