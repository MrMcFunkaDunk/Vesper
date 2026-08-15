/**
 * Scopes requested for the Dashboard character grid: wallet balance, total
 * SP + current training, and current ship/system. Requested on every login
 * (new character or re-adding an existing one) so a single source of truth
 * keeps LoginScreen and "Add character" from drifting apart.
 */
export const DASHBOARD_SCOPES = [
  "esi-wallet.read_character_wallet.v1",
  "esi-skills.read_skills.v1",
  "esi-skills.read_skillqueue.v1",
  "esi-location.read_location.v1",
  "esi-location.read_ship_type.v1",
];
