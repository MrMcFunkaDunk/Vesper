import { useEffect, useRef } from "react";
import { usePersistentState } from "./usePersistentState";
import { getMultiboxClients, isMultiboxOverlayOpen, openMultiboxOverlay } from "../lib/multibox";
import { useErrorReporter } from "./useErrorReporter";

const STORAGE_KEY = "vesper.settings.multiboxAutoDetect";
const POLL_MS = 3000;
/** The lowest multiboxing actually gets - two accounts is still
 * multiboxing, not just "EVE is open" - so this is the floor regardless of
 * whether someone runs 2 accounts or a dozen. */
const AUTO_OPEN_THRESHOLD = 2;

/**
 * Auto-opens the multibox floating preview the moment 2+ EVE clients are
 * running, without needing the Multiboxing tab open first - call this ONCE
 * at the app root (App.tsx), the same reason the kill-history recorder runs
 * from app setup rather than only while Kills & Intel is open, since
 * MultiboxPage itself is lazy-loaded and its own client-polling effect stops
 * the moment you navigate away from that tab.
 *
 * Deliberately auto-OPENS only, never auto-closes: dropping back below 2
 * clients (one character logged out) doesn't hide a layout you may still be
 * looking at or repositioning - closing stays the Multiboxing tab's own
 * manual toggle. Once triggered, it won't re-open a preview you closed by
 * hand while still above the threshold - only a fresh climb back over 2
 * (after dropping below it) counts as a new detection.
 */
export function useMultiboxAutoDetect() {
  const [enabled, setEnabled] = usePersistentState<boolean>(STORAGE_KEY, true);
  const reportError = useErrorReporter();
  const armed = useRef(true);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;

    async function poll() {
      try {
        const [clients, overlayOpen] = await Promise.all([getMultiboxClients(), isMultiboxOverlayOpen()]);
        if (cancelled) return;
        if (clients.length < AUTO_OPEN_THRESHOLD) {
          armed.current = true;
          return;
        }
        if (armed.current && !overlayOpen) {
          armed.current = false;
          await openMultiboxOverlay();
        }
      } catch (err) {
        if (!cancelled) reportError(`Multibox auto-detect failed to check EVE clients: ${String(err)}`);
      }
    }

    poll();
    const interval = setInterval(poll, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  return [enabled, setEnabled] as const;
}
