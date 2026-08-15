import type { KillItemEntry, SlotGroup } from "../lib/kills";

interface FitWheelProps {
  shipTypeId: number;
  shipTypeName: string;
  items: KillItemEntry[];
}

interface WheelSlot {
  flag: number;
  group: SlotGroup;
  module: KillItemEntry;
  ammo: KillItemEntry | null;
}

const WHEEL_GROUPS: SlotGroup[] = ["high", "mid", "low", "rig", "drone"];
const MIN_ARC_DEG = 22;
const ICON_SPACING_PX = 62;
const MIN_OUTER_RADIUS = 175;
const MAX_OUTER_RADIUS = 300;
const RING_GAP = 62;
const MIN_INNER_RADIUS = 95;

function polarOffset(angleDeg: number, radius: number) {
  const rad = (angleDeg * Math.PI) / 180;
  return { x: Math.sin(rad) * radius, y: -Math.cos(rad) * radius };
}

/** A flag can hold a fitted module plus whatever's loaded in it (ammo, a crystal, a script) - quantity alone doesn't reliably tell them apart (frequency crystals sit at qty 1, same as the module), so this trusts the item's real category (is_charge, resolved server-side via ESI) and only falls back to the old qty guess if that lookup didn't resolve for anything at this flag. */
function pickModuleAndAmmo(entries: KillItemEntry[]): { module: KillItemEntry; ammo: KillItemEntry | null } {
  const modules = entries.filter((e) => !e.is_charge);
  const charges = entries.filter((e) => e.is_charge);
  if (modules.length > 0) {
    return { module: modules[0], ammo: charges[0] ?? null };
  }
  const sorted = [...entries].sort(
    (a, b) => a.quantity_destroyed + a.quantity_dropped - (b.quantity_destroyed + b.quantity_dropped),
  );
  return { module: sorted[0], ammo: sorted[1] ?? null };
}

function FitWheel({ shipTypeId, shipTypeName, items }: FitWheelProps) {
  const byFlag = new Map<number, KillItemEntry[]>();
  for (const item of items) {
    if (!WHEEL_GROUPS.includes(item.slot_group)) continue;
    const entries = byFlag.get(item.flag) ?? [];
    entries.push(item);
    byFlag.set(item.flag, entries);
  }

  const grouped = new Map<SlotGroup, WheelSlot[]>(WHEEL_GROUPS.map((g) => [g, []]));
  for (const [flag, entries] of byFlag) {
    const { module, ammo } = pickModuleAndAmmo(entries);
    grouped.get(module.slot_group)?.push({ flag, group: module.slot_group, module, ammo });
  }
  for (const group of WHEEL_GROUPS) {
    grouped.get(group)!.sort((a, b) => a.flag - b.flag);
  }

  const totalSlots = WHEEL_GROUPS.reduce((sum, g) => sum + grouped.get(g)!.length, 0);
  const nonEmptyCount = WHEEL_GROUPS.filter((g) => grouped.get(g)!.length > 0).length;

  // Give each group an arc proportional to how many slots it actually has
  // (not an equal share) so a hull with 8 high slots and 2 mid slots
  // doesn't cram 8 icons into the same 72 degrees as 2 - with a floor so a
  // lone occupied slot still gets a readable arc.
  const reservedForMin = nonEmptyCount * MIN_ARC_DEG;
  const remaining = Math.max(0, 360 - reservedForMin);
  const arcFor = (group: SlotGroup) => {
    const count = grouped.get(group)!.length;
    return count === 0 ? 0 : MIN_ARC_DEG + (remaining * count) / totalSlots;
  };

  const outerRadius =
    totalSlots === 0
      ? MIN_OUTER_RADIUS
      : Math.max(MIN_OUTER_RADIUS, Math.min(MAX_OUTER_RADIUS, (ICON_SPACING_PX * totalSlots) / (2 * Math.PI)));
  const innerRadius = Math.max(MIN_INNER_RADIUS, outerRadius - RING_GAP);
  const wheelSize = outerRadius * 2 + 90;

  let cursor = -arcFor("high") / 2;
  const slots = WHEEL_GROUPS.flatMap((group) => {
    const arc = arcFor(group);
    const groupSlots = grouped.get(group)!;
    const placed = groupSlots.map((slot, i) => {
      const angle = cursor + (arc * (i + 0.5)) / groupSlots.length;
      return { slot, outer: polarOffset(angle, outerRadius), inner: polarOffset(angle, innerRadius) };
    });
    cursor += arc;
    return placed;
  });

  return (
    <div className="fit-wheel" style={{ width: wheelSize, height: wheelSize }}>
      <img
        className="fit-wheel-ship"
        src={`https://images.evetech.net/types/${shipTypeId}/render?size=256`}
        alt={shipTypeName}
      />
      {slots.length === 0 && <p className="fit-wheel-empty">No fitted modules recorded.</p>}
      {slots.map(({ slot, outer, inner }) => {
        const { module, ammo, group } = slot;
        const destroyed = module.quantity_destroyed > 0;
        const dropped = module.quantity_dropped > 0;
        const moduleQty = module.quantity_destroyed + module.quantity_dropped;
        const state = destroyed ? "destroyed" : dropped ? "dropped" : "";
        return (
          <div key={slot.flag}>
            <div
              className={`fit-wheel-slot fit-wheel-slot-${group} ${state && `fit-wheel-slot-${state}`}`}
              style={{ left: `calc(50% + ${outer.x}px)`, top: `calc(50% + ${outer.y}px)` }}
              title={`${module.item_type_name}${moduleQty > 1 ? ` x${moduleQty}` : ""}`}
            >
              <img src={`https://images.evetech.net/types/${module.item_type_id}/icon?size=64`} alt="" />
              {moduleQty > 1 && <span className="fit-wheel-slot-qty">{moduleQty}</span>}
            </div>
            {ammo && (
              <div
                className="fit-wheel-ammo-slot"
                style={{ left: `calc(50% + ${inner.x}px)`, top: `calc(50% + ${inner.y}px)` }}
                title={`${ammo.item_type_name} x${ammo.quantity_destroyed + ammo.quantity_dropped}`}
              >
                <img src={`https://images.evetech.net/types/${ammo.item_type_id}/icon?size=32`} alt="" />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

export default FitWheel;
