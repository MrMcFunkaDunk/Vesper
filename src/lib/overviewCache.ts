import type { CharacterOverview } from "./eve";

const STORAGE_KEY = "vesper-last-known-overviews";

/** Matches ESI's transient "server is unreachable" failure modes - gateway
 * timeouts and the specific "Timeout contacting tranquility" body ESI
 * returns during daily downtime. These are expected, self-resolving, and
 * not something the user can act on, so they shouldn't pop an error modal
 * the way a real bug or an auth failure should. */
export function isTransientServerError(message: string): boolean {
  return /\b50[234]\b|gateway timeout|timeout contacting tranquility/i.test(message);
}

function readCache(): Record<number, CharacterOverview> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Record<number, CharacterOverview>) : {};
  } catch {
    return {};
  }
}

function writeCache(cache: Record<number, CharacterOverview>) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cache));
  } catch {
    // Quota or serialization issues here just mean no offline fallback next
    // launch - not worth surfacing to the user.
  }
}

/** Last-known-good overview for every character, read once at Dashboard mount
 * so a launch during downtime shows stale-but-real numbers instead of every
 * card stuck on "Loading..." forever. */
export function getAllCachedOverviews(): Record<number, CharacterOverview> {
  return readCache();
}

export function getCachedOverview(characterId: number): CharacterOverview | null {
  return readCache()[characterId] ?? null;
}

export function setCachedOverview(characterId: number, overview: CharacterOverview) {
  const cache = readCache();
  cache[characterId] = overview;
  writeCache(cache);
}
