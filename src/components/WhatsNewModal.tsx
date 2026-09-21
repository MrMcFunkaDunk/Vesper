import { Sparkles, X } from "lucide-react";
import type { WhatsNewEntry } from "../hooks/useWhatsNew";
import ReleaseNotes from "./ReleaseNotes";

interface WhatsNewModalProps {
  entry: WhatsNewEntry | null;
  open: boolean;
  onClose: () => void;
}

/** Purely presentational - useWhatsNew (mounted once in App.tsx) owns the
 * version-check/fetch/notification logic, so the same entry can be shown
 * either automatically right after an update or reopened later from its
 * bell notification. */
function WhatsNewModal({ entry, open, onClose }: WhatsNewModalProps) {
  if (!open || !entry) return null;

  return (
    <div className="whats-new-backdrop" onClick={onClose}>
      <div className="whats-new-modal" onClick={(e) => e.stopPropagation()}>
        <div className="whats-new-header">
          <div>
            <p className="eyebrow">
              <Sparkles size={14} strokeWidth={2} /> What's New
            </p>
            <h3>VESPER {entry.version}</h3>
          </div>
          <button type="button" className="whats-new-close" onClick={onClose} aria-label="Close">
            <X size={18} strokeWidth={2} />
          </button>
        </div>
        <div className="whats-new-body">
          <ReleaseNotes body={entry.body} classPrefix="whats-new" />
        </div>
        <div className="whats-new-footer">
          <button type="button" className="kills-sync-btn" onClick={onClose}>
            Got it
          </button>
        </div>
      </div>
    </div>
  );
}

export default WhatsNewModal;
