import alertSoundUrl from "../assets/sounds/alert-sound.mp3";
import notificationPingUrl from "../assets/sounds/notification-ping.mp3";

/** Reused across plays rather than a fresh `new Audio()` each time - lets a
 * second alert restart the sound cleanly instead of two overlapping
 * instances if kills land in quick succession. */
let alertAudio: HTMLAudioElement | null = null;
let notificationAudio: HTMLAudioElement | null = null;

function getAlertAudio(): HTMLAudioElement {
  if (!alertAudio) {
    alertAudio = new Audio(alertSoundUrl);
  }
  return alertAudio;
}

/** A plain <audio>.volume can never exceed 1.0 - that's the file's own
 * mixed level, hard-capped by spec. The ping clip isn't mixed loud enough
 * to reliably cut through over EVE itself or a headset at that native
 * level, so 100% on the slider needs to mean louder than the file actually
 * is, not just "as loud as it happens to be" - routing it through a Web
 * Audio GainNode instead is the only way to amplify past that ceiling.
 * createMediaElementSource can only be called once per <audio> element
 * (a second call throws), so the whole graph is built once and reused,
 * same lazy-singleton shape as getAlertAudio above. */
let notificationGainNode: GainNode | null = null;
let notificationAudioCtx: AudioContext | null = null;

/** Gain applied at a full 100% slider - 2 means the loudest setting plays
 * at double the clip's native amplitude ("200% louder", as asked). */
const NOTIFICATION_MAX_GAIN = 2;

function getNotificationAudioGraph(): { audio: HTMLAudioElement; gainNode: GainNode; ctx: AudioContext } {
  if (!notificationAudio || !notificationGainNode || !notificationAudioCtx) {
    notificationAudio = new Audio(notificationPingUrl);
    notificationAudioCtx = new AudioContext();
    const source = notificationAudioCtx.createMediaElementSource(notificationAudio);
    notificationGainNode = notificationAudioCtx.createGain();
    source.connect(notificationGainNode);
    notificationGainNode.connect(notificationAudioCtx.destination);
  }
  return { audio: notificationAudio, gainNode: notificationGainNode, ctx: notificationAudioCtx };
}

/** Plays the user-supplied alert sound - fired when a kill lands in the
 * character's current system or one jump away. volume is 0-1, from
 * useSoundVolume - the clip itself is mixed loud, so this defaults well
 * below full to avoid startling whoever's got a headset on. */
export function playProximityAlert(volume = 0.5) {
  const audio = getAlertAudio();
  audio.currentTime = 0;
  audio.volume = Math.min(1, Math.max(0, volume));
  audio.play().catch(() => {
    // Most likely the page hasn't seen a user gesture yet (autoplay policy) -
    // nothing to recover from here, the next alert after any click will play fine.
  });
}

/** Plays whenever anything lands in the notification bell
 * (useNotificationCenter's addNotification is the single choke point every
 * feature already pushes through, so hooking the sound in there instead of
 * at each call site covers all of them, including future ones, for free).
 * volume is 0-1, from useNotificationSoundVolume, mapped onto gain 0-
 * NOTIFICATION_MAX_GAIN rather than plain <audio>.volume - see
 * getNotificationAudioGraph above for why this one specifically needs to
 * go louder than a normal audio element ever can. */
export function playNotificationPing(volume = 0.5) {
  const { audio, gainNode, ctx } = getNotificationAudioGraph();
  gainNode.gain.value = Math.min(1, Math.max(0, volume)) * NOTIFICATION_MAX_GAIN;
  audio.currentTime = 0;
  if (ctx.state === "suspended") {
    ctx.resume().catch(() => {});
  }
  audio.play().catch(() => {
    // Same autoplay-policy caveat as playProximityAlert above.
  });
}
