import { Star } from "lucide-react";
import { useTrackedSystemsActivity } from "../hooks/useTrackedSystemsActivity";
import type { TrackedEntry } from "../lib/kills";

interface TrackToggleButtonProps {
  entry: TrackedEntry;
}

/** The "+ Track" control shown on System/Constellation/Region killboard
 * headers - reads and writes the same tracked list Tracked Systems shows,
 * via the root-level provider, so there's no prop-drilling needed from
 * KillsIntel down to whichever drill-down view is currently showing. */
function TrackToggleButton({ entry }: TrackToggleButtonProps) {
  const { entries, addEntry, removeEntry } = useTrackedSystemsActivity();
  const tracked = entries.some((e) => e.type === entry.type && e.id === entry.id);

  return (
    <button
      type="button"
      className={`kills-track-button${tracked ? " kills-track-button-active" : ""}`}
      onClick={() => (tracked ? removeEntry(entry.type, entry.id) : addEntry(entry))}
    >
      <Star size={13} strokeWidth={2} fill={tracked ? "currentColor" : "none"} />
      {tracked ? "Tracked" : "Track"}
    </button>
  );
}

export default TrackToggleButton;
