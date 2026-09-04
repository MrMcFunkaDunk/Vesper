import { usePersistentState } from "./usePersistentState";

const STORAGE_KEY = "vesper.premium.soundEnabled";

/** Gates the premium decks' hardware sound cues (relay clicks, mechanical
 * throws) - see lib/sound.ts's playPremiumRelayClick/playPremiumThrow.
 * Separate from useSoundEnabled, which only ever meant the proximity
 * alert. Defaults to on so a premium theme is fully "switched on" out of
 * the box, matching how every other sound in the app already defaults. */
export function usePremiumSoundEnabled() {
  return usePersistentState<boolean>(STORAGE_KEY, true);
}
