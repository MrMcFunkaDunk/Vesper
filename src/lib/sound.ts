import alertSoundUrl from "../assets/sounds/alert-sound.mp3";

/** Reused across plays rather than a fresh `new Audio()` each time - lets a
 * second alert restart the sound cleanly instead of two overlapping
 * instances if kills land in quick succession. */
let alertAudio: HTMLAudioElement | null = null;

function getAlertAudio(): HTMLAudioElement {
  if (!alertAudio) {
    alertAudio = new Audio(alertSoundUrl);
  }
  return alertAudio;
}

/** Plays the user-supplied alert sound - fired when a kill lands in the
 * character's current system or one jump away. */
export function playProximityAlert() {
  const audio = getAlertAudio();
  audio.currentTime = 0;
  audio.play().catch(() => {
    // Most likely the page hasn't seen a user gesture yet (autoplay policy) -
    // nothing to recover from here, the next alert after any click will play fine.
  });
}
