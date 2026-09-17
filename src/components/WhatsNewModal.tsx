import { useEffect, useState } from "react";
import { Sparkles, X } from "lucide-react";
import { getVersion } from "@tauri-apps/api/app";
import { usePersistentState } from "../hooks/usePersistentState";
import { RELEASES_API_BASE, WHATS_NEW_PENDING_KEY, WHATS_NEW_SEEN_KEY, type PendingWhatsNew } from "../lib/whatsNew";
import ReleaseNotes from "./ReleaseNotes";

/**
 * Shows once per version, the launch right after VESPER updates - not every
 * launch on that version. Prefers the release notes UpdateBanner already
 * stashed right before its own relaunch (no network needed); falls back to
 * fetching that exact version's GitHub release notes for anyone who updated
 * some other way (manual download, fresh install after this feature
 * shipped). Never shows on a genuinely first-ever launch - there's no
 * "before" to compare against, so that launch just records the baseline.
 */
function WhatsNewModal() {
  const [seenVersion, setSeenVersion] = usePersistentState<string | null>(WHATS_NEW_SEEN_KEY, null);
  const [pending, setPending] = usePersistentState<PendingWhatsNew | null>(WHATS_NEW_PENDING_KEY, null);
  const [entry, setEntry] = useState<{ version: string; body: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const version = await getVersion();
      if (cancelled) return;

      if (seenVersion == null) {
        setSeenVersion(version);
        return;
      }
      if (seenVersion === version) return;

      if (pending && pending.version === version && pending.body.trim()) {
        setEntry({ version, body: pending.body });
        return;
      }

      try {
        const res = await fetch(`${RELEASES_API_BASE}/v${version}`);
        if (!res.ok) return;
        const data = (await res.json()) as { body?: string };
        if (!cancelled && data.body && data.body.trim()) {
          setEntry({ version, body: data.body });
        }
      } catch {
        // No network right now - just try again next launch. seenVersion
        // only advances once the user actually sees (or dismisses) this,
        // so a missed check here isn't a missed changelog forever.
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleClose() {
    if (entry) {
      setSeenVersion(entry.version);
      if (pending?.version === entry.version) setPending(null);
    }
    setEntry(null);
  }

  if (!entry) return null;

  return (
    <div className="whats-new-backdrop" onClick={handleClose}>
      <div className="whats-new-modal" onClick={(e) => e.stopPropagation()}>
        <div className="whats-new-header">
          <div>
            <p className="eyebrow">
              <Sparkles size={14} strokeWidth={2} /> What's New
            </p>
            <h3>VESPER {entry.version}</h3>
          </div>
          <button type="button" className="whats-new-close" onClick={handleClose} aria-label="Close">
            <X size={18} strokeWidth={2} />
          </button>
        </div>
        <div className="whats-new-body">
          <ReleaseNotes body={entry.body} classPrefix="whats-new" />
        </div>
        <div className="whats-new-footer">
          <button type="button" className="kills-sync-btn" onClick={handleClose}>
            Got it
          </button>
        </div>
      </div>
    </div>
  );
}

export default WhatsNewModal;
