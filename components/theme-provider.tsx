"use client";
import * as React from "react";
import { usePathname } from "next/navigation";
import {
  DEFAULT_CHOICE_ID,
  getChoiceId,
  resolveChoice,
  type ThemeDef,
  type ThemeMode,
} from "@/lib/themes";

/**
 * Per-project theme (bead-me-up-scotty-81k). The chosen theme is stored per-device
 * in localStorage, keyed by the active project so different projects look different
 * and don't get confused. Project identity comes from the /p/<projectId> URL; the
 * launcher (no project) uses a shared key.
 */
const LEGACY_KEY = "bmus-theme";
const THEME_EVENT = "bmus:theme";
const DARK_QUERY = "(prefers-color-scheme: dark)";

function subscribe(callback: () => void) {
  window.addEventListener(THEME_EVENT, callback);
  window.addEventListener("storage", callback);
  return () => {
    window.removeEventListener(THEME_EVENT, callback);
    window.removeEventListener("storage", callback);
  };
}

function serverSnapshot(): string {
  return "light";
}

// The OS appearance is its own external store: only the "system" choice reads it,
// but subscribing unconditionally keeps the hook order fixed and the cost is nil.
function subscribeDark(callback: () => void) {
  const mq = window.matchMedia(DARK_QUERY);
  mq.addEventListener("change", callback);
  return () => mq.removeEventListener("change", callback);
}

function prefersDark(): boolean {
  return typeof window !== "undefined" && window.matchMedia(DARK_QUERY).matches;
}

function serverPrefersDark(): boolean {
  return false;
}

function storageKey(projectId: string | null): string {
  return projectId ? `bmus.theme.${projectId}` : "bmus.theme";
}

/**
 * localStorage when in a browser, else undefined. Reached via `globalThis` on
 * purpose: a `typeof window === "undefined"` guard gets constant-folded to `true`
 * in the server bundle, which dead-code-eliminates the project-keyed read and
 * leaves the minifier emitting a temp before its declaration (TDZ during SSR).
 *
 * Node >= 22 exposes a `globalThis.localStorage` stub during SSR that lacks the
 * Storage methods unless the process was started with `--localstorage-file`
 * (calling `getItem` on it throws "is not a function"), so the object is only
 * usable if it actually implements Storage. Both methods are checked, not just
 * `getItem`: the read path and the two `setItem` writers share this one guard,
 * so a partial stub would still throw on save.
 */
function getStore(): Storage | undefined {
  const store = (globalThis as { localStorage?: Storage }).localStorage;
  return typeof store?.getItem === "function" && typeof store.setItem === "function"
    ? store
    : undefined;
}

function projectIdFromPath(pathname: string | null): string | null {
  const m = pathname?.match(/^\/p\/([^/]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

/**
 * Reads the saved *choice* for a project (a palette id or "system"), falling back
 * to the legacy key, then the default. This is what the user picked, not what is
 * painted — resolve it with resolveChoice() when the OS preference matters.
 */
function readChoiceId(projectId: string | null): string {
  try {
    const store = getStore();
    const stored = store
      ? (store.getItem(storageKey(projectId)) ?? store.getItem(LEGACY_KEY))
      : null;
    return getChoiceId(stored);
  } catch {
    return DEFAULT_CHOICE_ID;
  }
}

interface ThemeContextValue {
  /** The palette actually painted (System already resolved to Light/Dark). */
  theme: ThemeDef;
  /** What the user picked: a palette id, or "system". Drives the picker's selection. */
  choice: string;
  mode: ThemeMode;
  setTheme: (id: string) => void;
  toggle: () => void;
}

// Plain-literal default (no module-load-time function call — keeps the bundler's
// scope-hoisting from tripping a TDZ during SSR). Only used if a consumer renders
// with no provider mounted, which doesn't happen in practice.
const ThemeContext = React.createContext<ThemeContextValue>({
  theme: { id: "light", name: "Light", mode: "light", swatch: ["#f6f6f8", "#ffffff", "#6d5ef0"] },
  choice: "light",
  mode: "light",
  setTheme: () => {},
  toggle: () => {},
});

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const projectId = projectIdFromPath(pathname);

  // Hydration must match the server's light snapshot before reading browser
  // preferences. React then applies the saved project theme and subscribes to changes.
  const choice = React.useSyncExternalStore(
    subscribe,
    () => readChoiceId(projectId),
    serverSnapshot,
  );
  const osDark = React.useSyncExternalStore(subscribeDark, prefersDark, serverPrefersDark);
  const theme = resolveChoice(choice, osDark);

  // Apply to <html>: data-theme drives the palette; .dark drives Tailwind/shadcn.
  React.useEffect(() => {
    document.documentElement.dataset.theme = theme.id;
    document.documentElement.classList.toggle("dark", theme.mode === "dark");
  }, [theme.id, theme.mode]);

  // Plain handlers (no manual memoization — React Compiler handles it, and the
  // provider updates from the external store). Notify this tab after saving;
  // the native storage event handles other tabs.
  function setTheme(id: string) {
    getStore()?.setItem(storageKey(projectId), getChoiceId(id));
    window.dispatchEvent(new Event(THEME_EVENT));
  }
  // Quick flip to the opposite of what is on screen (sidebar button, T shortcut,
  // launcher). From "system" it saves an explicit Light/Dark, so the user can opt
  // out of following the OS; pick System again in Settings to re-follow it.
  function toggle() {
    const showing = resolveChoice(readChoiceId(projectId), prefersDark());
    const next = showing.mode === "dark" ? "light" : "dark";
    getStore()?.setItem(storageKey(projectId), next);
    window.dispatchEvent(new Event(THEME_EVENT));
  }

  return (
    <ThemeContext.Provider value={{ theme, choice, mode: theme.mode, setTheme, toggle }}>
      {children}
    </ThemeContext.Provider>
  );
}

export const useTheme = () => React.useContext(ThemeContext);
