import { X } from "lucide-react";
import type { ChainSystem } from "../../lib/wormholes";
import { WH_SYSTEM_STATICS } from "../../lib/whSystemStatics";
import { EFFECT_LABELS, EFFECT_SYMBOLS, EFFECT_MODIFIERS, type WormholeEffect } from "../../lib/wormholeEffects";

interface ChainEffectSummaryProps {
  systems: ChainSystem[];
  onClose: () => void;
}

/** At-a-glance view of every environmental effect currently present in the
 * chain, grouped by effect type with the systems carrying it and what it
 * actually does (EFFECT_MODIFIERS) - so a Pulsar three hops back is visible
 * without having to click back through every system to remember which one
 * it was. Systems with no known effect (including anything outside
 * WH_SYSTEM_STATICS's verified coverage) are silently excluded. */
function ChainEffectSummary({ systems, onClose }: ChainEffectSummaryProps) {
  const byEffect = new Map<WormholeEffect, ChainSystem[]>();
  for (const system of systems) {
    const effect = WH_SYSTEM_STATICS[system.system_id]?.effect;
    if (!effect) continue;
    const list = byEffect.get(effect) ?? [];
    list.push(system);
    byEffect.set(effect, list);
  }

  return (
    <div className="wh-effects-panel">
      <div className="wh-system-header">
        <p className="wh-side-label">Chain Effects</p>
        <button type="button" className="wh-link-btn" onClick={onClose}>
          <X size={13} strokeWidth={2} /> Close
        </button>
      </div>

      {byEffect.size === 0 ? (
        <p className="detail-empty">No systems with a known environmental effect in this chain yet.</p>
      ) : (
        Array.from(byEffect.entries()).map(([effect, affected]) => (
          <div key={effect} className="wh-effect-group">
            <p className="wh-effect-group-title">
              {EFFECT_SYMBOLS[effect]} {EFFECT_LABELS[effect]}
            </p>
            <p className="wh-effect-group-systems">{affected.map((s) => s.system_name).join(", ")}</p>
            <ul className="wh-effect-modifiers">
              {EFFECT_MODIFIERS[effect].map((mod) => (
                <li key={mod.label} className={mod.good ? "wh-effect-mod-good" : "wh-effect-mod-bad"}>
                  {mod.good ? "▲" : "▼"} {mod.label}
                </li>
              ))}
            </ul>
          </div>
        ))
      )}
    </div>
  );
}

export default ChainEffectSummary;
