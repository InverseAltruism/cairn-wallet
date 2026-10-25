// Types for theme.js, for TypeScript consumers that load it as a classic script.
export type ThemeMode = "light" | "dark";
export type ThemeChoice = ThemeMode | "system";

export interface ThemeState {
  readonly mode: ThemeMode;
  readonly choice: ThemeChoice;
}

export interface CairnThemeApi {
  readonly KEY: string;
  readonly EVENT: string;
  readonly REVEAL_MS: number;
  readonly FADE_MS: number;
  readonly EASE: string;
  current(): ThemeState;
  set(choice: ThemeChoice, from?: { x: number; y: number }): Promise<void>;
  toggle(el?: Element | null): Promise<void>;
  startSync(): void;
  onChange(listener: (state: ThemeState) => void): () => void;
  toggleLabel(mode?: ThemeMode): string;
  iconSvg(id: string): string;
  parseChoice(v: unknown): ThemeChoice;
  resolveMode(choice: ThemeChoice, systemDark: boolean): ThemeMode;
  revealRadius(xPct: number, yPct: number, width: number, height: number): number;
}

declare global {
  interface Window {
    CairnTheme: CairnThemeApi;
  }
}
