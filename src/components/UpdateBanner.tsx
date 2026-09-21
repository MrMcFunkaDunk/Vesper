import { useEffect, useState } from "react";
import { Download, X } from "lucide-react";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { useErrorReporter } from "../hooks/useErrorReporter";
import { useNotificationCenter } from "../hooks/useNotificationCenter";
import { usePersistentState } from "../hooks/usePersistentState";
import { WHATS_NEW_PENDING_KEY, type PendingWhatsNew } from "../lib/whatsNew";
import type { WhatsNewEntry } from "../hooks/useWhatsNew";

interface UpdateBannerProps {
  /** Primes the shared What's New modal with this pending update's own
   * notes (already in hand from the update check) so its bell notification
   * can open a preview in-app - installing itself here means there's no
   * real reason to send anyone out to the GitHub release page anymore. */
  onPreviewUpdate?: (entry: WhatsNewEntry) => void;
}

/**
 * Checks for a new VESPER release once per app launch (silent - nothing
 * shows if there's nothing new), and offers a one-click download+install+
 * restart if there is. Never installs without the user clicking - an
 * early-build hobby app shouldn't force a surprise restart mid-session.
 */
function UpdateBanner({ onPreviewUpdate }: UpdateBannerProps) {
  const [update, setUpdate] = useState<Update | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [installing, setInstalling] = useState(false);
  const reportError = useErrorReporter();
  const { addNotification } = useNotificationCenter();
  const [, setPendingWhatsNew] = usePersistentState<PendingWhatsNew | null>(WHATS_NEW_PENDING_KEY, null);

  useEffect(() => {
    check()
      .then((result) => {
        if (result) {
          setUpdate(result);
          onPreviewUpdate?.({ version: result.version, body: result.body ?? "" });
          addNotification(
            "Vesper: New update available",
            `Version ${result.version} is ready (you're on ${result.currentVersion}) - click to see what's new.`,
            undefined,
            undefined,
            "update",
            "open-whats-new",
          );
        }
      })
      .catch(() => {
        // No network, or the update endpoint is briefly unreachable - not
        // worth interrupting the user over, just try again next launch.
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleInstall() {
    if (!update) return;
    setInstalling(true);
    try {
      await update.downloadAndInstall();
      // Stashed now, while the notes are already in hand from the update
      // check - the relaunched app reads this back to show What's New
      // without a second network round trip.
      setPendingWhatsNew({ version: update.version, body: update.body ?? "" });
      await relaunch();
    } catch (err) {
      setInstalling(false);
      reportError(`Failed to install the update: ${String(err)}`);
    }
  }

  if (!update || dismissed) return null;

  return (
    <div className="update-banner">
      <Download size={14} strokeWidth={2} />
      <span>
        VESPER {update.version} is available (you're on {update.currentVersion}).
      </span>
      <button type="button" className="update-banner-btn" onClick={handleInstall} disabled={installing}>
        {installing ? "Installing..." : "Update & Restart"}
      </button>
      <button type="button" className="update-banner-dismiss" onClick={() => setDismissed(true)} title="Dismiss" disabled={installing}>
        <X size={14} strokeWidth={2} />
      </button>
    </div>
  );
}

export default UpdateBanner;
