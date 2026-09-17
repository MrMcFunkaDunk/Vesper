import { useMemo } from "react";
import { X } from "lucide-react";
import type { AssetEntry } from "../lib/eve";
import { typeIconUrl } from "../lib/format";

/** Display order for recognized slot groups - everything else (a plain
 * container's generic flag, anything not covered below) sorts after these,
 * alphabetically. */
const SLOT_ORDER = [
  "High Slots",
  "Mid Slots",
  "Low Slots",
  "Rigs",
  "Subsystems",
  "Drone Bay",
  "Fighter Bay",
  "Fighter Tubes",
  "Cargo Hold",
  "Fuel Bay",
  "Ship Maintenance Bay",
];

/** ESI's real location_flag values for a ship's own slots/bays - a plain
 * container just tags everything "Unlocked"/"AutoFit" instead, which falls
 * through to the raw-flag fallback below and still renders fine, just
 * without the ship-specific grouping. */
function slotGroupLabel(flag: string): string {
  if (/^HiSlot\d+$/.test(flag)) return "High Slots";
  if (/^MedSlot\d+$/.test(flag)) return "Mid Slots";
  if (/^LoSlot\d+$/.test(flag)) return "Low Slots";
  if (/^RigSlot\d+$/.test(flag)) return "Rigs";
  if (/^SubSystemSlot\d+$/.test(flag)) return "Subsystems";
  if (flag === "DroneBay") return "Drone Bay";
  if (flag === "FighterBay") return "Fighter Bay";
  if (/^FighterTube\d+$/.test(flag)) return "Fighter Tubes";
  if (flag === "Cargo") return "Cargo Hold";
  if (flag === "SpecializedFuelBay") return "Fuel Bay";
  if (flag === "ShipHangar") return "Ship Maintenance Bay";
  return flag;
}

/** The trailing slot number (HiSlot0, HiSlot1, ...) so modules within one
 * group keep the ship's own slot order instead of whatever order ESI
 * happened to return them in. */
function slotNumber(flag: string): number {
  const match = flag.match(/(\d+)$/);
  return match ? Number(match[1]) : 0;
}

interface ShipFitPanelProps {
  ship: AssetEntry;
  modules: AssetEntry[];
  onClose: () => void;
}

/** A ship's fit reconstructed straight from the Assets tab - every asset
 * whose location_id points back at this ship's own item_id, grouped by
 * slot the way a real fit reads. Only works for a ship sitting unpiloted in
 * a station/structure hangar, matching what ESI's asset endpoint can
 * actually see - an active, flown ship doesn't expose module-level detail
 * through this endpoint at all. */
function ShipFitPanel({ ship, modules, onClose }: ShipFitPanelProps) {
  const groups = useMemo(() => {
    const byLabel = new Map<string, AssetEntry[]>();
    for (const m of modules) {
      const label = slotGroupLabel(m.location_flag);
      const arr = byLabel.get(label);
      if (arr) arr.push(m);
      else byLabel.set(label, [m]);
    }
    for (const arr of byLabel.values()) {
      arr.sort((a, b) => slotNumber(a.location_flag) - slotNumber(b.location_flag));
    }
    return [...byLabel.entries()].sort(([a], [b]) => {
      const ai = SLOT_ORDER.indexOf(a);
      const bi = SLOT_ORDER.indexOf(b);
      if (ai === -1 && bi === -1) return a.localeCompare(b);
      if (ai === -1) return 1;
      if (bi === -1) return -1;
      return ai - bi;
    });
  }, [modules]);

  return (
    <div className="ship-fit-backdrop" onClick={onClose}>
      <div className="ship-fit-modal" onClick={(e) => e.stopPropagation()}>
        <div className="system-stats-header">
          <div>
            <h3>{ship.type_name}</h3>
            <p className="system-stats-subtitle">{ship.location_name}</p>
          </div>
          <button type="button" className="system-stats-close" onClick={onClose} aria-label="Close">
            <X size={16} strokeWidth={2} />
          </button>
        </div>
        <div className="system-stats-body">
          {groups.length === 0 ? (
            <p className="detail-empty">No modules, drones, or cargo found on this ship.</p>
          ) : (
            groups.map(([label, items]) => (
              <div key={label} className="ship-fit-slot-group">
                <p className="ship-fit-slot-label">{label}</p>
                <div className="ship-fit-slot-items">
                  {items.map((m) => (
                    <div key={m.item_id} className="ship-fit-slot-item">
                      <img className="asset-item-icon" src={typeIconUrl(m.type_id, 32, m.type_name)} alt="" />
                      <span className="ship-fit-slot-item-name">{m.type_name}</span>
                      {m.quantity > 1 && <span className="ship-fit-slot-item-qty">x{m.quantity.toLocaleString()}</span>}
                    </div>
                  ))}
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

export default ShipFitPanel;
