// EVE Online wormhole type reference data.
//
// PRIMARY SOURCE (ground truth, numeric mass/time values): CCP's own Static Data
// Export (SDE), mirrored by Fuzzwork Enterprises. Values were read directly out of
// the SDE's dgmTypeAttributes table for every "Wormhole <CODE>" item in invTypes
// (group 988), using attributeIDs 1381 (wormholeTargetSystemClass), 1382
// (wormholeMaxStableTime), 1383 (wormholeMaxStableMass) and 1385 (wormholeMaxJumpMass).
//   https://www.fuzzwork.co.uk/dump/latest/csv/  (dump dated 2026-08-17, pulled 2026-08-19)
//
// CROSS-CHECKED AGAINST: whtype.info, an actively-maintained community wormhole
// reference (its underlying data file was fetched directly):
//   https://whtype.info/  (js/wormholes.js)
// whtype.info's total-mass and lifetime figures matched the SDE for all but 2 of the
// ~99 codes (see flagged rows below). Its per-jump mass is only given as a ship-size
// category there, not an exact kg figure, so it was used as a corroborating check
// rather than a numeric source.
//
// ALSO CHECKED: EVE University wiki, "Wormhole attributes" page (raw wikitext pulled
// live, not the rendered page):
//   https://wiki.eveuniversity.org/index.php?title=Wormhole_attributes&action=raw
// This wiki table diverges from the SDE ground truth on ~25 of the ~99 codes (mostly
// total-mass values for the 8 "frigate hole" types, and several lifetime values that
// look like they predate a later CCP rebalance). Where it disagreed with the SDE, the
// SDE value was used. It was also missing 4 codes entirely (I078, J492, L687, O546)
// that exist in the SDE and in whtype.info.
//
// Verified/compiled: 2026-08-19.
//
// Notes on specific fields:
// - K162 is the generic, class-agnostic exit signature. EVE gives it no mass/time
//   attributes of its own — the real limits only become knowable once you jump it and
//   see the "real" type code from the far side. maxMassKg/maxJumpMassKg/lifetimeHours
//   are therefore null for K162; do not treat that as "unlimited".
// - leadsToClass "HS/LS/NS" (code C729) is CCP's static Pochven <-> adjacent-k-space
//   connection type; it has 27 separate in-game type IDs (one per specific border
//   system) that all share identical mass/jump/lifetime stats but lead to different
//   security classes depending on which Pochven system you're in. There is no single
//   correct security class to show for it.
// - The five "Drifter-*" classes (Barbican, Conflux, Redoubt, Sentinel, Vidette) are
//   the one-off Drifter hub systems, each reachable via its own dedicated wormhole
//   type rather than a numbered W-space class.
//
// LOWER-CONFIDENCE / FLAG FOR DOUBLE-CHECK:
// - C248, S199: whtype.info lists lifetime as 24h; the SDE says 16h. SDE value used.
//   Everywhere else the two sources agreed on lifetime and total mass, so this is
//   flagged rather than silently trusted either way.
// - I078, L687, O546, J492: not present in the EVE University table at all, so only
//   two sources (SDE + whtype.info) exist for these four rather than three; they did
//   agree on every field for J492, and on total mass/lifetime for I078/L687/O546
//   (whtype.info doesn't give an exact jump-mass number, only "up to Battlecruiser",
//   which is consistent with the SDE's 62,000,000 kg figure used here).

export interface WormholeTypeInfo {
  code: string;
  leadsToClass: string;   // e.g. "C1", "C2", ..., "C6", "HS", "LS", "NS", "Thera", "Unknown"
  maxMassKg: number | null;
  maxJumpMassKg: number | null;
  lifetimeHours: number | null;
}

export const WORMHOLE_TYPES: WormholeTypeInfo[] = [
  { code: "A009", leadsToClass: "C13", maxMassKg: 3000000000, maxJumpMassKg: 5000000, lifetimeHours: 4.5 },
  { code: "A239", leadsToClass: "LS", maxMassKg: 2000000000, maxJumpMassKg: 375000000, lifetimeHours: 24 },
  { code: "A641", leadsToClass: "HS", maxMassKg: 2000000000, maxJumpMassKg: 1000000000, lifetimeHours: 16 },
  { code: "A982", leadsToClass: "C6", maxMassKg: 3000000000, maxJumpMassKg: 375000000, lifetimeHours: 24 },
  { code: "B041", leadsToClass: "C6", maxMassKg: 3000000000, maxJumpMassKg: 1000000000, lifetimeHours: 48 },
  { code: "B274", leadsToClass: "HS", maxMassKg: 2000000000, maxJumpMassKg: 375000000, lifetimeHours: 24 },
  { code: "B449", leadsToClass: "HS", maxMassKg: 2000000000, maxJumpMassKg: 1000000000, lifetimeHours: 16 },
  { code: "B520", leadsToClass: "HS", maxMassKg: 3000000000, maxJumpMassKg: 1000000000, lifetimeHours: 48 },
  { code: "B735", leadsToClass: "Drifter-Barbican", maxMassKg: 750000000, maxJumpMassKg: 375000000, lifetimeHours: 16 },
  { code: "C008", leadsToClass: "C5", maxMassKg: 3000000000, maxJumpMassKg: 5000000, lifetimeHours: 4.5 },
  { code: "C125", leadsToClass: "C2", maxMassKg: 1000000000, maxJumpMassKg: 62000000, lifetimeHours: 16 },
  { code: "C140", leadsToClass: "LS", maxMassKg: 3300000000, maxJumpMassKg: 2000000000, lifetimeHours: 24 },
  { code: "C247", leadsToClass: "C3", maxMassKg: 2000000000, maxJumpMassKg: 375000000, lifetimeHours: 16 },
  { code: "C248", leadsToClass: "NS", maxMassKg: 3300000000, maxJumpMassKg: 2000000000, lifetimeHours: 16 },
  { code: "C391", leadsToClass: "LS", maxMassKg: 3300000000, maxJumpMassKg: 2000000000, lifetimeHours: 48 },
  { code: "C414", leadsToClass: "Drifter-Conflux", maxMassKg: 750000000, maxJumpMassKg: 375000000, lifetimeHours: 16 },
  { code: "C729", leadsToClass: "HS/LS/NS", maxMassKg: 1000000000, maxJumpMassKg: 410000000, lifetimeHours: 12 },
  { code: "D364", leadsToClass: "C2", maxMassKg: 1000000000, maxJumpMassKg: 375000000, lifetimeHours: 16 },
  { code: "D382", leadsToClass: "C2", maxMassKg: 2000000000, maxJumpMassKg: 375000000, lifetimeHours: 16 },
  { code: "D792", leadsToClass: "HS", maxMassKg: 3000000000, maxJumpMassKg: 1000000000, lifetimeHours: 24 },
  { code: "D845", leadsToClass: "HS", maxMassKg: 5000000000, maxJumpMassKg: 375000000, lifetimeHours: 24 },
  { code: "E004", leadsToClass: "C1", maxMassKg: 3000000000, maxJumpMassKg: 5000000, lifetimeHours: 4.5 },
  { code: "E175", leadsToClass: "C4", maxMassKg: 2000000000, maxJumpMassKg: 375000000, lifetimeHours: 16 },
  { code: "E545", leadsToClass: "NS", maxMassKg: 2000000000, maxJumpMassKg: 375000000, lifetimeHours: 16 },
  { code: "E587", leadsToClass: "NS", maxMassKg: 3000000000, maxJumpMassKg: 1000000000, lifetimeHours: 16 },
  { code: "F135", leadsToClass: "Thera", maxMassKg: 750000000, maxJumpMassKg: 375000000, lifetimeHours: 16 },
  { code: "F216", leadsToClass: "Pochven", maxMassKg: 1000000000, maxJumpMassKg: 375000000, lifetimeHours: 12 },
  { code: "F353", leadsToClass: "Thera", maxMassKg: 100000000, maxJumpMassKg: 62000000, lifetimeHours: 16 },
  { code: "G008", leadsToClass: "C6", maxMassKg: 3000000000, maxJumpMassKg: 5000000, lifetimeHours: 4.5 },
  { code: "G024", leadsToClass: "C2", maxMassKg: 2000000000, maxJumpMassKg: 375000000, lifetimeHours: 16 },
  { code: "H121", leadsToClass: "C1", maxMassKg: 500000000, maxJumpMassKg: 62000000, lifetimeHours: 16 },
  { code: "H296", leadsToClass: "C5", maxMassKg: 3300000000, maxJumpMassKg: 2000000000, lifetimeHours: 24 },
  { code: "H900", leadsToClass: "C5", maxMassKg: 3000000000, maxJumpMassKg: 375000000, lifetimeHours: 24 },
  { code: "I078", leadsToClass: "Pochven", maxMassKg: 100000000, maxJumpMassKg: 62000000, lifetimeHours: 4.5 },
  { code: "I182", leadsToClass: "C2", maxMassKg: 2000000000, maxJumpMassKg: 375000000, lifetimeHours: 16 },
  { code: "J244", leadsToClass: "LS", maxMassKg: 1000000000, maxJumpMassKg: 62000000, lifetimeHours: 24 },
  { code: "J377", leadsToClass: "LS", maxMassKg: 1000000000, maxJumpMassKg: 62000000, lifetimeHours: 24 },
  { code: "J492", leadsToClass: "LS", maxMassKg: 1000000000, maxJumpMassKg: 62000000, lifetimeHours: 24 },
  { code: "K162", leadsToClass: "K162", maxMassKg: null, maxJumpMassKg: null, lifetimeHours: null },
  { code: "K329", leadsToClass: "NS", maxMassKg: 3000000000, maxJumpMassKg: 375000000, lifetimeHours: 16 },
  { code: "K346", leadsToClass: "NS", maxMassKg: 3000000000, maxJumpMassKg: 375000000, lifetimeHours: 16 },
  { code: "L005", leadsToClass: "C2", maxMassKg: 3000000000, maxJumpMassKg: 5000000, lifetimeHours: 4.5 },
  { code: "L031", leadsToClass: "Thera", maxMassKg: 3000000000, maxJumpMassKg: 1000000000, lifetimeHours: 16 },
  { code: "L477", leadsToClass: "C3", maxMassKg: 2000000000, maxJumpMassKg: 375000000, lifetimeHours: 16 },
  { code: "L614", leadsToClass: "C5", maxMassKg: 1000000000, maxJumpMassKg: 62000000, lifetimeHours: 24 },
  { code: "L687", leadsToClass: "Pochven", maxMassKg: 100000000, maxJumpMassKg: 62000000, lifetimeHours: 4.5 },
  { code: "M001", leadsToClass: "C4", maxMassKg: 3000000000, maxJumpMassKg: 5000000, lifetimeHours: 4.5 },
  { code: "M164", leadsToClass: "Thera", maxMassKg: 2000000000, maxJumpMassKg: 1000000000, lifetimeHours: 16 },
  { code: "M267", leadsToClass: "C3", maxMassKg: 1000000000, maxJumpMassKg: 375000000, lifetimeHours: 16 },
  { code: "M555", leadsToClass: "C5", maxMassKg: 3000000000, maxJumpMassKg: 1000000000, lifetimeHours: 24 },
  { code: "M609", leadsToClass: "C4", maxMassKg: 1000000000, maxJumpMassKg: 62000000, lifetimeHours: 16 },
  { code: "N062", leadsToClass: "C5", maxMassKg: 3000000000, maxJumpMassKg: 375000000, lifetimeHours: 24 },
  { code: "N110", leadsToClass: "HS", maxMassKg: 1000000000, maxJumpMassKg: 62000000, lifetimeHours: 24 },
  { code: "N290", leadsToClass: "LS", maxMassKg: 3000000000, maxJumpMassKg: 375000000, lifetimeHours: 24 },
  { code: "N432", leadsToClass: "C5", maxMassKg: 3300000000, maxJumpMassKg: 2000000000, lifetimeHours: 24 },
  { code: "N766", leadsToClass: "C2", maxMassKg: 2000000000, maxJumpMassKg: 375000000, lifetimeHours: 16 },
  { code: "N770", leadsToClass: "C5", maxMassKg: 3000000000, maxJumpMassKg: 375000000, lifetimeHours: 24 },
  { code: "N944", leadsToClass: "LS", maxMassKg: 3300000000, maxJumpMassKg: 2000000000, lifetimeHours: 24 },
  { code: "N968", leadsToClass: "C3", maxMassKg: 2000000000, maxJumpMassKg: 375000000, lifetimeHours: 16 },
  { code: "O128", leadsToClass: "C4", maxMassKg: 1000000000, maxJumpMassKg: 375000000, lifetimeHours: 24 },
  { code: "O477", leadsToClass: "C3", maxMassKg: 2000000000, maxJumpMassKg: 375000000, lifetimeHours: 16 },
  { code: "O546", leadsToClass: "Pochven", maxMassKg: 100000000, maxJumpMassKg: 62000000, lifetimeHours: 4.5 },
  { code: "O883", leadsToClass: "C3", maxMassKg: 1000000000, maxJumpMassKg: 62000000, lifetimeHours: 16 },
  { code: "P060", leadsToClass: "C1", maxMassKg: 500000000, maxJumpMassKg: 62000000, lifetimeHours: 16 },
  { code: "Q003", leadsToClass: "NS", maxMassKg: 3000000000, maxJumpMassKg: 5000000, lifetimeHours: 4.5 },
  { code: "Q063", leadsToClass: "HS", maxMassKg: 500000000, maxJumpMassKg: 62000000, lifetimeHours: 16 },
  { code: "Q317", leadsToClass: "C1", maxMassKg: 500000000, maxJumpMassKg: 62000000, lifetimeHours: 16 },
  { code: "R051", leadsToClass: "LS", maxMassKg: 3000000000, maxJumpMassKg: 1000000000, lifetimeHours: 16 },
  { code: "R081", leadsToClass: "C4", maxMassKg: 1000000000, maxJumpMassKg: 375000000, lifetimeHours: 12 },
  { code: "R259", leadsToClass: "Drifter-Redoubt", maxMassKg: 750000000, maxJumpMassKg: 375000000, lifetimeHours: 16 },
  { code: "R474", leadsToClass: "C6", maxMassKg: 3000000000, maxJumpMassKg: 375000000, lifetimeHours: 24 },
  { code: "R943", leadsToClass: "C2", maxMassKg: 750000000, maxJumpMassKg: 375000000, lifetimeHours: 16 },
  { code: "S047", leadsToClass: "HS", maxMassKg: 3000000000, maxJumpMassKg: 375000000, lifetimeHours: 24 },
  { code: "S199", leadsToClass: "NS", maxMassKg: 3300000000, maxJumpMassKg: 2000000000, lifetimeHours: 16 },
  { code: "S804", leadsToClass: "C6", maxMassKg: 1000000000, maxJumpMassKg: 62000000, lifetimeHours: 24 },
  { code: "S877", leadsToClass: "Drifter-Sentinel", maxMassKg: 750000000, maxJumpMassKg: 375000000, lifetimeHours: 16 },
  { code: "T405", leadsToClass: "C4", maxMassKg: 2000000000, maxJumpMassKg: 375000000, lifetimeHours: 16 },
  { code: "T458", leadsToClass: "Thera", maxMassKg: 500000000, maxJumpMassKg: 62000000, lifetimeHours: 16 },
  { code: "U210", leadsToClass: "LS", maxMassKg: 3000000000, maxJumpMassKg: 375000000, lifetimeHours: 24 },
  { code: "U319", leadsToClass: "C6", maxMassKg: 3300000000, maxJumpMassKg: 2000000000, lifetimeHours: 48 },
  { code: "U372", leadsToClass: "Pochven", maxMassKg: 1000000000, maxJumpMassKg: 375000000, lifetimeHours: 12 },
  { code: "U574", leadsToClass: "C6", maxMassKg: 3000000000, maxJumpMassKg: 375000000, lifetimeHours: 24 },
  { code: "V283", leadsToClass: "NS", maxMassKg: 3000000000, maxJumpMassKg: 1000000000, lifetimeHours: 16 },
  { code: "V301", leadsToClass: "C1", maxMassKg: 500000000, maxJumpMassKg: 62000000, lifetimeHours: 16 },
  { code: "V753", leadsToClass: "C6", maxMassKg: 3300000000, maxJumpMassKg: 2000000000, lifetimeHours: 24 },
  { code: "V898", leadsToClass: "LS", maxMassKg: 2000000000, maxJumpMassKg: 1000000000, lifetimeHours: 16 },
  { code: "V911", leadsToClass: "C5", maxMassKg: 3300000000, maxJumpMassKg: 2000000000, lifetimeHours: 24 },
  { code: "V928", leadsToClass: "Drifter-Vidette", maxMassKg: 750000000, maxJumpMassKg: 375000000, lifetimeHours: 16 },
  { code: "W237", leadsToClass: "C6", maxMassKg: 3300000000, maxJumpMassKg: 2000000000, lifetimeHours: 24 },
  { code: "X450", leadsToClass: "NS", maxMassKg: 1000000000, maxJumpMassKg: 375000000, lifetimeHours: 12 },
  { code: "X702", leadsToClass: "C3", maxMassKg: 1000000000, maxJumpMassKg: 375000000, lifetimeHours: 24 },
  { code: "X877", leadsToClass: "C4", maxMassKg: 2000000000, maxJumpMassKg: 375000000, lifetimeHours: 16 },
  { code: "Y683", leadsToClass: "C4", maxMassKg: 2000000000, maxJumpMassKg: 375000000, lifetimeHours: 16 },
  { code: "Y790", leadsToClass: "C1", maxMassKg: 500000000, maxJumpMassKg: 62000000, lifetimeHours: 16 },
  { code: "Z006", leadsToClass: "C3", maxMassKg: 3000000000, maxJumpMassKg: 5000000, lifetimeHours: 4.5 },
  { code: "Z060", leadsToClass: "NS", maxMassKg: 1000000000, maxJumpMassKg: 62000000, lifetimeHours: 16 },
  { code: "Z142", leadsToClass: "NS", maxMassKg: 3300000000, maxJumpMassKg: 2000000000, lifetimeHours: 16 },
  { code: "Z457", leadsToClass: "C4", maxMassKg: 2000000000, maxJumpMassKg: 375000000, lifetimeHours: 16 },
  { code: "Z647", leadsToClass: "C1", maxMassKg: 500000000, maxJumpMassKg: 62000000, lifetimeHours: 16 },
  { code: "Z971", leadsToClass: "C1", maxMassKg: 100000000, maxJumpMassKg: 62000000, lifetimeHours: 16 },
];
