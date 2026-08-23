import { Bell, BellRing } from "lucide-react";
import { useTrackedEntities } from "../hooks/useTrackedEntities";
import type { TrackedEntityKind } from "../lib/trackedEntities";

interface TrackEntityButtonProps {
  entityId: number;
  entityName: string;
  kind: TrackedEntityKind;
}

/** "Track"/"Tracking" toggle for a character/corporation/alliance profile
 * header - the same tracked-entity list Settings' Tracked Players panel
 * manages, just reachable from wherever the user is already looking at the
 * entity instead of only via a separate search box. */
function TrackEntityButton({ entityId, entityName, kind }: TrackEntityButtonProps) {
  const { isTracked, toggle } = useTrackedEntities();
  const tracked = isTracked(entityId, kind);

  return (
    <button
      type="button"
      className={`track-entity-btn${tracked ? " track-entity-btn-active" : ""}`}
      onClick={() => toggle(entityId, entityName, kind)}
      title={tracked ? `Stop tracking kills/deaths for ${entityName}` : `Get notified when ${entityName} appears on a killmail`}
    >
      {tracked ? <BellRing size={13} strokeWidth={2} /> : <Bell size={13} strokeWidth={2} />}
      {tracked ? "Tracking" : "Track"}
    </button>
  );
}

export default TrackEntityButton;
