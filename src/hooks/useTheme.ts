import { useEffect } from "react";
import { usePersistentState } from "./usePersistentState";

export type ThemeId = "dark" | "light" | "anime" | "cyberpunk" | "sunset" | "retro-ova" | "crt-green";

export const THEMES: { id: ThemeId; label: string; description: string }[] = [
  { id: "dark", label: "Dark (default)", description: "VESPER's original dark navy/cyan look." },
  { id: "light", label: "Light", description: "A bright counterpart to the default theme." },
  { id: "anime", label: "Analog Signal", description: "Warm cream, indigo panels, and dusty rose - old cel-animation film tones." },
  { id: "cyberpunk", label: "Night Static", description: "Deep navy and violet, oxidised cyan, sodium-gold streetlights." },
  { id: "sunset", label: "Dusk Horizon", description: "A softer, warmer palette - slate blue fading into coral and cream." },
  { id: "retro-ova", label: "YC Retro", description: "EVE reimagined as a 1994 sci-fi anime OVA - tactical cyan and aged amber on deep navy." },
  { id: "crt-green", label: "Phosphor Deck", description: "Old spacecraft terminal - CRT phosphor green for data/telemetry, aged amber for navigation and industry." },
];

const STORAGE_KEY = "vesper.settings.theme";

/** The active color theme, applied via a data-theme attribute on <html> so
 * App.css's [data-theme="x"] blocks (each redefining the same semantic
 * color variables the rest of the app already renders with - --bg, --accent,
 * --text, etc.) take over with no per-component changes needed. "dark" is
 * the absence of an override - it just leaves the base :root values in
 * place, matching how the app already looked before theming existed. */
export function useTheme() {
  const [theme, setTheme] = usePersistentState<ThemeId>(STORAGE_KEY, "dark");

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  return [theme, setTheme] as const;
}
