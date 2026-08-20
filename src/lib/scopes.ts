/**
 * Scopes requested for the Dashboard character grid and its full tabbed
 * detail page (Skills/Queue/Clones/Employment/Standings/Contacts/Medals/LP/
 * Assets/Market Orders/Contracts/Industry Jobs/Wallet/Transactions/Mail/
 * Notifications/Kill Log/Planetary). Requested on every login (new
 * character or re-adding an existing one) so a single source of truth keeps
 * LoginScreen and "Add character" from drifting apart. A character that
 * logged in before a scope was added here just sees that one tab's
 * "needs_reauth" empty state until they're re-added.
 */
export const DASHBOARD_SCOPES = [
  "esi-wallet.read_character_wallet.v1",
  "esi-skills.read_skills.v1",
  "esi-skills.read_skillqueue.v1",
  "esi-location.read_location.v1",
  "esi-location.read_ship_type.v1",
  "esi-clones.read_clones.v1",
  "esi-clones.read_implants.v1",
  "esi-universe.read_structures.v1",
  "esi-characters.read_standings.v1",
  "esi-characters.read_contacts.v1",
  "esi-characters.read_medals.v1",
  "esi-characters.read_loyalty.v1",
  "esi-assets.read_assets.v1",
  "esi-markets.read_character_orders.v1",
  "esi-contracts.read_character_contracts.v1",
  "esi-industry.read_character_jobs.v1",
  "esi-mail.read_mail.v1",
  "esi-characters.read_notifications.v1",
  "esi-planets.manage_planets.v1",
  "esi-calendar.read_calendar_events.v1",
  "esi-fittings.read_fittings.v1",
  "esi-fittings.write_fittings.v1",
  "esi-characters.read_agents_research.v1",
  "esi-characters.read_fw_stats.v1",
];
