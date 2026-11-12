/**
 * Theme registry — metadata only. The actual colors live in app/globals.css as
 * `html[data-theme="<id>"]` blocks; this module is what the provider and pickers
 * use to enumerate themes, validate ids, and render swatches. `mode` decides
 * whether the `.dark` class is applied (so Tailwind `dark:` + shadcn tokens work).
 */
export type ThemeMode = "light" | "dark";

export interface ThemeDef {
  /** Stable id — also the html[data-theme] value and the localStorage value. */
  id: string;
  /** Human label for the picker. */
  name: string;
  /** Drives the `.dark` class. All custom themes here are dark; only Light is light. */
  mode: ThemeMode;
  /** Three representative hexes [bg, surface, accent] for the picker preview. */
  swatch: [string, string, string];
}

export const THEMES: ThemeDef[] = [
  { id: "light", name: "Light", mode: "light", swatch: ["#f6f6f8", "#ffffff", "#6d5ef0"] },
  { id: "dark", name: "Dark", mode: "dark", swatch: ["#0c0c0f", "#1d1d22", "#8b7cf8"] },
  { id: "dracula", name: "Dracula", mode: "dark", swatch: ["#282a36", "#44475a", "#bd93f9"] },
  { id: "nord", name: "Nord", mode: "dark", swatch: ["#2e3440", "#3b4252", "#88c0d0"] },
  { id: "solarized-dark", name: "Solarized Dark", mode: "dark", swatch: ["#002b36", "#073642", "#268bd2"] },
  { id: "gruvbox-dark", name: "Gruvbox Dark", mode: "dark", swatch: ["#282828", "#3c3836", "#fabd2f"] },
  { id: "tokyo-night", name: "Tokyo Night", mode: "dark", swatch: ["#1a1b26", "#24283b", "#7aa2f7"] },
  { id: "catppuccin-mocha", name: "Catppuccin Mocha", mode: "dark", swatch: ["#1e1e2e", "#313244", "#cba6f7"] },
  { id: "rose-pine", name: "Rosé Pine", mode: "dark", swatch: ["#191724", "#26233a", "#c4a7e7"] },
];

export const DEFAULT_THEME_ID = "light";

const BY_ID = new Map(THEMES.map((t) => [t.id, t]));

export function isThemeId(id: string): boolean {
  return BY_ID.has(id);
}

/** Returns the theme for `id`, or the default theme for unknown/empty ids. */
export function getTheme(id: string | null | undefined): ThemeDef {
  return (id ? BY_ID.get(id) : undefined) ?? BY_ID.get(DEFAULT_THEME_ID)!;
}

/**
 * "System" is a *choice*, not a palette: it has no `html[data-theme]` block of
 * its own and resolves to Light or Dark from the OS `prefers-color-scheme`.
 * It lives outside THEMES so palette enumerations stay palettes-only; the
 * picker prepends it explicitly.
 */
export const SYSTEM_CHOICE_ID = "system";

export const SYSTEM_CHOICE: ThemeDef = {
  id: SYSTEM_CHOICE_ID,
  name: "System",
  mode: "light",
  // Left half light, right half dark so the swatch reads as "follows the OS".
  swatch: ["#f6f6f8", "#1d1d22", "#6d5ef0"],
};

/** What a project uses until the user picks something. */
export const DEFAULT_CHOICE_ID = SYSTEM_CHOICE_ID;

/** Normalizes a stored value to a valid choice id (palette id or "system"). */
export function getChoiceId(stored: string | null | undefined): string {
  if (stored === SYSTEM_CHOICE_ID) return SYSTEM_CHOICE_ID;
  return stored && BY_ID.has(stored) ? stored : DEFAULT_CHOICE_ID;
}

/** Resolves a choice to a concrete palette, given the OS preference. */
export function resolveChoice(choice: string, prefersDark: boolean): ThemeDef {
  return choice === SYSTEM_CHOICE_ID
    ? BY_ID.get(prefersDark ? "dark" : "light")!
    : getTheme(choice);
}
