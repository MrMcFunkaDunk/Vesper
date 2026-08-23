import { useEffect, useState } from "react";
import { Download, X } from "lucide-react";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { useErrorReporter } from "../hooks/useErrorReporter";
import { useNotificationCenter } from "../hooks/useNotificationCenter";

/**
 * Checks for a new VESPER release once per app launch (silent - nothing
 * shows if there's nothing new), and offers a one-click download+install+
 * restart if there is. Never installs without the user clicking - an
 * early-build hobby app shouldn't force a surprise restart mid-session.
 */
function UpdateBanner() {
  const [update, setUpdate] = useState<Update | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [installing, setInstalling] = useState(false);
  const reportError = useErrorReporter();
  const { addNotification } = useNotificationCenter();

  useEffect(() => {
    check()
      .then((result) => {
        if (result) {
          setUpdate(result);
          addNotification("Vesper: New update available", `Version ${result.version} is ready (you're on ${result.currentVersion}).`);
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
