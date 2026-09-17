import { useEffect, useState } from "react";
import { ChevronDown } from "lucide-react";
import { fetchReleaseHistory, type ReleaseHistoryEntry } from "../lib/whatsNew";
import { formatDateHeading } from "../lib/format";
import ReleaseNotes from "./ReleaseNotes";

/** Settings' "every past release, click one to see what changed" list -
 * the same GitHub release notes WhatsNewModal shows for the version just
 * updated to, but browsable for any past version too. Fetched once when
 * this section mounts (Settings is already a deliberate navigation, not a
 * hot path, so there's no need to gate this behind its own extra click). */
function UpdateHistoryPanel() {
  const [releases, setReleases] = useState<ReleaseHistoryEntry[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [expandedVersion, setExpandedVersion] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchReleaseHistory()
      .then((entries) => {
        if (!cancelled) setReleases(entries);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="settings-section">
      <h3>Update History</h3>
      <p className="settings-section-hint">Every VESPER release, most recent first - click a version to see what changed.</p>
      {failed ? (
        <p className="settings-permission-denied">Couldn't load release history.</p>
      ) : !releases ? (
        <p className="detail-empty">Loading release history...</p>
      ) : releases.length === 0 ? (
        <p className="detail-empty">No releases found.</p>
      ) : (
        <div className="update-history-entries">
          {releases.map((r) => {
            const expanded = expandedVersion === r.version;
            return (
              <div key={r.version} className="update-history-entry">
                <button
                  type="button"
                  className="update-history-entry-header"
                  onClick={() => setExpandedVersion(expanded ? null : r.version)}
                >
                  <ChevronDown size={14} strokeWidth={2} className={expanded ? "" : "fit-section-chevron-closed"} />
                  <span className="update-history-version">v{r.version}</span>
                  {r.publishedAt && <span className="update-history-date">{formatDateHeading(r.publishedAt)}</span>}
                </button>
                {expanded && (
                  <div className="update-history-entry-body">
                    {r.body.trim() ? (
                      <ReleaseNotes body={r.body} classPrefix="update-history" />
                    ) : (
                      <p className="update-history-paragraph">No release notes for this version.</p>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default UpdateHistoryPanel;
