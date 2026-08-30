import { useEffect, useRef, useState } from "react";
import { useLocationTracking } from "../hooks/useLocationTracking";
import { useSoundEnabled } from "../hooks/useSoundEnabled";
import { useSoundVolume } from "../hooks/useSoundVolume";
import { playProximityAlert } from "../lib/sound";

const PULSE_DURATION_MS = 1800;

/**
 * A full-viewport red flash mounted at the app root, so it's visible no
 * matter which page is open - Maps, Wallet, Intel, wherever - the instant a
 * kill lands within the tracked proximity radius. Remounted (via `key`) on
 * every pulseToken change so back-to-back alerts each get their own full
 * animation instead of getting cut off mid-pulse.
 *
 * pulseToken lives in a root-level provider and never resets to 0, so a
 * plain `if (pulseToken === 0) return` guard isn't enough - a fresh mount
 * of THIS component (which can happen for reasons unrelated to a real
 * alert) would see whatever nonzero value already exists and flash for no
 * reason. lastSeenRef captures whatever pulseToken is AT MOUNT TIME as the
 * baseline, so only a genuine increase observed while mounted triggers the
 * flash - remounting alone never does.
 */
function ProximityFlashOverlay() {
  const { pulseToken, soundToken } = useLocationTracking();
  const [soundEnabled] = useSoundEnabled();
  const [soundVolume] = useSoundVolume();
  const [activeToken, setActiveToken] = useState<number | null>(null);
  const lastSeenRef = useRef(pulseToken);
  // Same remount-safety concern as pulseToken above: soundToken never resets
  // to 0, so a fresh mount must baseline against whatever value already
  // exists rather than treating any nonzero token as a brand-new alert.
  const lastSoundSeenRef = useRef(soundToken);

  useEffect(() => {
    if (pulseToken === lastSeenRef.current) return;
    lastSeenRef.current = pulseToken;
    setActiveToken(pulseToken);
    const timeout = setTimeout(() => setActiveToken(null), PULSE_DURATION_MS);
    return () => clearTimeout(timeout);
  }, [pulseToken]);

  useEffect(() => {
    if (soundToken === lastSoundSeenRef.current) return;
    lastSoundSeenRef.current = soundToken;
    if (soundEnabled) playProximityAlert(soundVolume);
  }, [soundToken, soundEnabled, soundVolume]);

  if (activeToken === null) return null;

  return <div key={activeToken} className="proximity-flash-overlay" aria-hidden="true" />;
}

export default ProximityFlashOverlay;
