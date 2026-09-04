import { useEffect, useState } from "react";

export type ThemeId =
  | "dark"
  | "light"
  | "anime"
  | "cyberpunk"
  | "sunset"
  | "retro-ova"
  | "crt-green"
  | "bulkhead"
  | "cold-ballast"
  | "command-deck";

export const THEMES: { id: ThemeId; label: string; description: string; tier?: "premium" }[] = [
  { id: "dark", label: "Dark (default)", description: "VESPER's original dark navy/cyan look." },
  { id: "light", label: "Light", description: "A bright counterpart to the default theme." },
  { id: "anime", label: "Analog Signal", description: "Warm cream, indigo panels, and dusty rose - old cel-animation film tones." },
  { id: "cyberpunk", label: "Night Static", description: "Deep navy and violet, oxidised cyan, sodium-gold streetlights." },
  { id: "sunset", label: "Dusk Horizon", description: "A softer, warmer palette - slate blue fading into coral and cream." },
  { id: "retro-ova", label: "YC Retro", description: "EVE reimagined as a 1994 sci-fi anime OVA - tactical cyan and aged amber on deep navy." },
  { id: "crt-green", label: "Phosphor Deck", description: "Old spacecraft terminal - CRT phosphor green for data/telemetry, aged amber for navigation and industry." },
  {
    id: "bulkhead",
    label: "Bulkhead",
    description: "Gritty industrial freighter - rust, hazard amber, and a reactor that's overdue for maintenance. Buttons press with real weight.",
    tier: "premium",
  },
  {
    id: "cold-ballast",
    label: "Cold Ballast",
    description: "A quiet ops deck lit by tank glass - deep abyss black and electric cyan, CRT scanlines on the shell.",
    tier: "premium",
  },
  {
    id: "command-deck",
    label: "Command Deck",
    description: "Bridge HUD glass paired against warm amber switch banks - void navy, royal blue, and Exo 2 display type.",
    tier: "premium",
  },
];

const STORAGE_KEY = "vesper.settings.theme";
// Exported so non-React code that can't call the useTheme() hook itself
// (MapView's canvas draw loop, in particular) can still listen for a live
// theme change directly, instead of guessing at this string a second time.
export const THEME_CHANGE_EVENT = "vesper:theme-change";

function readStoredTheme(): ThemeId {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as ThemeId) : "dark";
  } catch {
    return "dark";
  }
}

/** True whenever a premium deck is active - the one thing every premium-
 * only component (StatusLamp, the boot-flicker wrapper, anything else
 * gated on tier rather than a specific palette) needs to check, without
 * each of them re-deriving the premium id list themselves. */
export function isPremiumTheme(theme: ThemeId): boolean {
  return THEMES.find((t) => t.id === theme)?.tier === "premium";
}

/** The active color theme, applied via a data-theme attribute on <html> so
 * App.css's [data-theme="x"] blocks (each redefining the same semantic
 * color variables the rest of the app already renders with - --bg, --accent,
 * --text, etc.) take over with no per-component changes needed. "dark" is
 * the absence of an override - it just leaves the base :root values in
 * place, matching how the app already looked before theming existed.
 *
 * Deliberately NOT built on the generic usePersistentState - this app now
 * has more than one place that needs to REACT to a theme change live
 * (StatusChip swapping to the premium lamp markup, the boot-flicker
 * wrapper, future premium-only components), and usePersistentState's
 * plain useState only updates the ONE component instance that called
 * setTheme. Every other already-mounted useTheme() caller (the persistent
 * TopBar, in particular - it's never unmounted between tab switches)
 * would keep rendering the value it read at ITS OWN mount time until a
 * full reload. Broadcasting the change over a window CustomEvent (instead
 * of a React Context, to avoid re-plumbing every existing useTheme() call
 * site through a new provider) means every instance - however many are
 * mounted, however long they've been mounted - stays in sync the instant
 * ANY of them calls setTheme. */
export function useTheme() {
  const [theme, setThemeState] = useState<ThemeId>(() => readStoredTheme());

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    function handleExternalChange(e: Event) {
      setThemeState((e as CustomEvent<ThemeId>).detail);
    }
    window.addEventListener(THEME_CHANGE_EVENT, handleExternalChange);
    return () => window.removeEventListener(THEME_CHANGE_EVENT, handleExternalChange);
  }, []);

  function setTheme(next: ThemeId) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Not worth surfacing - worst case the choice doesn't persist across restarts.
    }
    setThemeState(next);
    window.dispatchEvent(new CustomEvent(THEME_CHANGE_EVENT, { detail: next }));
  }

  return [theme, setTheme] as const;
}
