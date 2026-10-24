// The theme switch for every Cairn surface, as window.CairnTheme. Load it as a classic script after theme-init.js; it
// needs theme.css. A switch reveals the new theme as a circle growing from the control (a view transition), crossfades
// under prefers-reduced-motion, and swaps at once where view transitions are missing. Pages redraw canvases and charts
// on EVENT, which fires inside the switch, before the new view is shown.
// Ported from @keshi/brand's theme.ts (InverseAltruism). The reveal takes three details from Magic UI's
// AnimatedThemeToggler (MIT, https://magicui.design/docs/components/animated-theme-toggler): the centre as percentages of
// the viewport, the new view's start pinned in CSS before the animation runs (theme.css), and one switch at a time.
(() => {
  if (window.CairnTheme) return;

  const KEY = "cairn-theme";
  const EVENT = "cairn:theme";
  const SWITCHING = "ui-theme-switching";
  const REVEAL = "ui-theme-reveal";
  const FADE = "ui-theme-fade";
  // --ui-dur-4 and --ui-ease; test/theme.test.mjs pins both to src/palette.mjs.
  const REVEAL_MS = 460;
  const EASE = "cubic-bezier(0.16, 1, 0.3, 1)";
  const FADE_MS = 180;

  const parseChoice = (v) => (v === "light" || v === "dark" ? v : "system");
  const resolveMode = (choice, systemDark) => (choice === "system" ? (systemDark ? "dark" : "light") : choice);
  const otherMode = (mode) => (mode === "dark" ? "light" : "dark");
  const root = () => document.documentElement;
  const systemDark = () => window.matchMedia("(prefers-color-scheme: dark)").matches;

  /** The theme on the page now: what theme-init.js set before the first paint, or the system's without it. */
  function current() {
    const r = root();
    const attr = r.getAttribute("data-theme");
    const choice = parseChoice(r.getAttribute("data-theme-choice"));
    return Object.freeze({ mode: attr === "dark" || attr === "light" ? attr : resolveMode(choice, systemDark()), choice });
  }

  function store(choice) {
    try {
      if (choice === "system") window.localStorage.removeItem(KEY);
      else window.localStorage.setItem(KEY, choice);
    } catch {
      // storage blocked: the choice lasts for this page only
    }
  }

  /** Writes the theme onto <html>, then tells the page. */
  function apply(choice) {
    const state = Object.freeze({ mode: resolveMode(choice, systemDark()), choice });
    const r = root();
    r.setAttribute("data-theme", state.mode);
    r.setAttribute("data-theme-choice", choice);
    r.style.colorScheme = state.mode;
    document.dispatchEvent(new CustomEvent(EVENT, { detail: state }));
    return state;
  }

  /** The radius that covers the viewport from a point given in percentages of it. */
  function revealRadius(xPct, yPct, width, height) {
    return Math.hypot((Math.max(xPct, 100 - xPct) / 100) * width, (Math.max(yPct, 100 - yPct) / 100) * height);
  }

  let inFlight = null;

  /**
   * Switches to a choice ("light", "dark" or "system") and stores it. `from` is the point the reveal grows from, in
   * viewport pixels; the viewport's centre without it. A call while a switch runs returns that switch (the page is
   * frozen during the reveal; a second click is a double click). Resolves when the new theme is on screen.
   */
  function set(choiceIn, from) {
    if (inFlight) return inFlight;
    const choice = parseChoice(choiceIn);
    store(choice);
    const r = root();
    if (resolveMode(choice, systemDark()) === current().mode) {
      apply(choice); // only the choice changed (say, to "system" while the system matches): nothing to animate
      return Promise.resolve();
    }
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    r.classList.add(SWITCHING);
    if (typeof document.startViewTransition !== "function") {
      // tracked like a transition, so a second call in this frame is dropped as during a reveal
      apply(choice);
      inFlight = new Promise((done) =>
        window.requestAnimationFrame(() => {
          r.classList.remove(SWITCHING);
          inFlight = null;
          done();
        }),
      );
      return inFlight;
    }
    const x = from ? (from.x / window.innerWidth) * 100 : 50;
    const y = from ? (from.y / window.innerHeight) * 100 : 50;
    r.style.setProperty("--ui-reveal-x", `${x}%`);
    r.style.setProperty("--ui-reveal-y", `${y}%`);
    r.classList.add(reduced ? FADE : REVEAL);
    let transition;
    try {
      transition = document.startViewTransition(() => {
        apply(choice);
      });
    } catch {
      // the browser refused to start one (it can throw in some states): switch without the animation
      apply(choice);
      r.classList.remove(SWITCHING, REVEAL, FADE);
      return Promise.resolve();
    }
    const run = async () => {
      try {
        await transition.ready;
        const pseudoElement = "::view-transition-new(root)";
        if (reduced) {
          r.animate({ opacity: [0, 1] }, { duration: FADE_MS, easing: "linear", fill: "forwards", pseudoElement });
        } else {
          const radius = revealRadius(x, y, window.innerWidth, window.innerHeight);
          r.animate(
            { clipPath: [`circle(0px at ${x}% ${y}%)`, `circle(${radius}px at ${x}% ${y}%)`] },
            { duration: REVEAL_MS, easing: EASE, fill: "forwards", pseudoElement },
          );
        }
        await transition.finished;
      } catch {
        // the browser skipped the transition (a hidden tab, another transition): the theme is applied all the same
        await transition.updateCallbackDone.catch(() => undefined);
      } finally {
        r.classList.remove(SWITCHING, REVEAL, FADE);
        inFlight = null;
      }
    };
    inFlight = run();
    return inFlight;
  }

  /** Switches to the other mode, revealed from the centre of `el` (the button pressed) when given. */
  function toggle(el) {
    let from;
    if (el && typeof el.getBoundingClientRect === "function") {
      const b = el.getBoundingClientRect();
      from = { x: b.left + b.width / 2, y: b.top + b.height / 2 };
    }
    return set(otherMode(current().mode), from);
  }

  let syncing = false;

  /**
   * Keeps the page in step without a click: the system setting changing while the choice is "system", and a choice made
   * in another tab of the same site. Installs its listeners once however often it is called.
   */
  function startSync() {
    if (syncing) return;
    syncing = true;
    const follow = () => {
      if (current().choice === "system") apply("system");
    };
    const mql = window.matchMedia("(prefers-color-scheme: dark)");
    if (typeof mql.addEventListener === "function") mql.addEventListener("change", follow);
    else if (typeof mql.addListener === "function") mql.addListener(follow); // Safari before 14
    window.addEventListener("storage", (e) => {
      if (e.key === KEY || e.key === null) apply(parseChoice(e.newValue));
    });
  }

  /** Calls `listener` with { mode, choice } on every applied theme; returns the unsubscribe. */
  function onChange(listener) {
    const handler = (e) => listener(e.detail);
    document.addEventListener(EVENT, handler);
    return () => document.removeEventListener(EVENT, handler);
  }

  /** The toggle's accessible name: what pressing it does. */
  const toggleLabel = (mode) =>
    mode === "dark" ? "Switch to light theme" : mode === "light" ? "Switch to dark theme" : "Switch theme";

  const RAYS = [0, 45, 90, 135, 180, 225, 270, 315]
    .map((deg) => {
      const a = (deg * Math.PI) / 180;
      const p = (rad) => [12 + rad * Math.sin(a), 12 - rad * Math.cos(a)].map((v) => Math.round(v * 100) / 100);
      const [x1, y1] = p(8);
      const [x2, y2] = p(10.5);
      return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`;
    })
    .join("");

  /**
   * The toggle's icon: a sun whose disc a second circle eclipses into a moon in dark mode (theme.css moves it). `id`
   * names the mask: a constant unique on the page (it is written into markup unescaped).
   */
  function iconSvg(id) {
    return (
      `<svg class="ui-theme-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">` +
      `<mask id="${id}"><rect x="-4" y="-4" width="32" height="32" fill="#fff"/>` +
      `<circle class="ui-theme-icon-bite" cx="15" cy="9" r="5" fill="#000"/></mask>` +
      `<circle class="ui-theme-icon-sun" cx="12" cy="12" r="5" fill="currentColor" mask="url(#${id})"/>` +
      `<g class="ui-theme-icon-rays" stroke="currentColor" stroke-width="1.75" stroke-linecap="round">${RAYS}</g>` +
      `</svg>`
    );
  }

  window.CairnTheme = Object.freeze({
    KEY,
    EVENT,
    REVEAL_MS,
    FADE_MS,
    EASE,
    current,
    set,
    toggle,
    startSync,
    onChange,
    toggleLabel,
    iconSvg,
    parseChoice,
    resolveMode,
    revealRadius,
  });
})();
