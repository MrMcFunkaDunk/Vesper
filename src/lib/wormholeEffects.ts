// EVE Online wormhole system environmental effects: Pulsar, Black Hole,
// Cataclysmic Variable, Magnetar, Red Giant, Wolf-Rayet. A system's effect
// (if any) is fixed - see whSystemStatics.ts for the per-system data this
// keys against. This file is purely the descriptive reference table: what
// each effect does, for the chain effect summary.
//
// SOURCE: ported from eve-nexum's web/src/data/wormholes.ts (EFFECT_LABELS,
// EFFECT_MODIFIERS), whose own comment states magnitudes/direction were
// "verified against the live client". Not independently re-verified here.
//
// Imported: 2026-08-19.

export type WormholeEffect = "pulsar" | "black_hole" | "cataclysmic_variable" | "magnetar" | "red_giant" | "wolf_rayet";

export const WORMHOLE_EFFECTS: WormholeEffect[] = ["pulsar", "black_hole", "cataclysmic_variable", "magnetar", "red_giant", "wolf_rayet"];

export const EFFECT_LABELS: Record<WormholeEffect, string> = {
  pulsar: "Pulsar",
  black_hole: "Black Hole",
  cataclysmic_variable: "Cataclysmic Variable",
  magnetar: "Magnetar",
  red_giant: "Red Giant",
  wolf_rayet: "Wolf-Rayet",
};

export const EFFECT_SYMBOLS: Record<WormholeEffect, string> = {
  pulsar: "⚡",
  black_hole: "◉",
  cataclysmic_variable: "⟳",
  magnetar: "✦",
  red_giant: "★",
  wolf_rayet: "⚔",
};

export interface EffectModifier {
  label: string;
  /** true = beneficial (shown ▲), false = detrimental (shown ▼). Direction is fixed per effect; magnitude scales with system class. */
  good: boolean;
}

export const EFFECT_MODIFIERS: Record<WormholeEffect, EffectModifier[]> = {
  pulsar: [
    { label: "Shield HP", good: true },
    { label: "Cap Recharge", good: true },
    { label: "Neut/NOS Drain", good: true },
    { label: "Armor Resist", good: false },
    { label: "Sig Radius", good: false },
  ],
  black_hole: [
    { label: "Ship Velocity", good: true },
    { label: "Targeting Range", good: true },
    { label: "Missile Velocity", good: true },
    { label: "Missile & Vorton Explosion Velocity", good: true },
    { label: "Ship Agility", good: false },
    { label: "Stasis Web Strength", good: false },
  ],
  cataclysmic_variable: [
    { label: "Remote Armor Rep & Shield Boost", good: true },
    { label: "Cap Capacity", good: true },
    { label: "Cap Recharge Rate", good: false },
    { label: "Remote Cap Transfer", good: false },
    { label: "Local Armor Rep & Shield Boost", good: false },
  ],
  magnetar: [
    { label: "Weapon Damage", good: true },
    { label: "Explosion Radius", good: true },
    { label: "Drone Tracking", good: false },
    { label: "Tracking Speed", good: false },
    { label: "Targeting Range", good: false },
    { label: "Target Painter", good: false },
  ],
  red_giant: [
    { label: "Overheat", good: true },
    { label: "Smartbomb Damage & Range", good: true },
    { label: "Bomb Damage", good: true },
    { label: "Heat Damage", good: false },
  ],
  wolf_rayet: [
    { label: "Small Weapon Damage", good: true },
    { label: "Armor HP", good: true },
    { label: "Sig Radius Reduction", good: true },
    { label: "Shield Resists", good: false },
  ],
};
