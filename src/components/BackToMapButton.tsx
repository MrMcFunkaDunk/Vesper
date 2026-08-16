import { Map as MapIcon } from "lucide-react";

interface BackToMapButtonProps {
  onClick: () => void;
}

/** Shared shortcut back to the Map tab, shown on every Kills & Intel view (the live feed and every drill-down) so a system/killmail lookup started from the map is always one click from getting back to it. */
function BackToMapButton({ onClick }: BackToMapButtonProps) {
  return (
    <button type="button" className="detail-back" onClick={onClick}>
      <MapIcon size={14} strokeWidth={2} />
      Back to Map
    </button>
  );
}

export default BackToMapButton;
