import { invoke } from "@tauri-apps/api/core";

export interface SessionCharacter {
  id: number;
  name: string;
  scopes: string[];
  portrait_url: string;
}

export interface Session {
  characters: SessionCharacter[];
  active_character_id: number | null;
}

export function startLogin(scopes: string[] = []): Promise<void> {
  return invoke("start_login", { scopes });
}

export function cancelLogin(): Promise<void> {
  return invoke("cancel_login");
}

export interface ServerStatus {
  online: boolean;
  players: number | null;
}

export function getServerStatus(): Promise<ServerStatus> {
  return invoke("get_server_status");
}

export function getSession(): Promise<Session> {
  return invoke("get_session");
}

export function setActiveCharacter(id: number): Promise<void> {
  return invoke("set_active_character", { id });
}

export function logoutCharacter(id: number): Promise<void> {
  return invoke("logout_character", { id });
}

export interface CharacterOverview {
  character_id: number;
  isk_balance: number | null;
  total_sp: number | null;
  training_skill_name: string | null;
  training_finish_date: string | null;
  queue_length: number | null;
  queue_ends_at: string | null;
  clone_state: string | null;
  ship_type_name: string | null;
  gender: string | null;
  race_name: string | null;
  bloodline_name: string | null;
  security_status: number | null;
  region_name: string | null;
  constellation_name: string | null;
  docked_at_name: string | null;
  system_name: string | null;
  corporation_name: string | null;
  alliance_name: string | null;
  needs_reauth: boolean;
}

export function getCharacterOverview(id: number): Promise<CharacterOverview> {
  return invoke("get_character_overview", { id });
}

export interface CharacterLocation {
  character_id: number;
  solar_system_id: number | null;
  solar_system_name: string | null;
  ship_type_id: number | null;
  ship_type_name: string | null;
  needs_reauth: boolean;
}

/** A character's current system + ship hull, for live location polling. */
export function getCharacterLocation(id: number): Promise<CharacterLocation> {
  return invoke("get_character_location", { id });
}

export interface SkillEntry {
  skill_id: number;
  name: string;
  group_name: string;
  rank: number;
  trained_level: number;
  skillpoints: number;
}

export interface CharacterSkills {
  total_sp: number | null;
  skills: SkillEntry[];
  needs_reauth: boolean;
}

export function getCharacterSkills(id: number): Promise<CharacterSkills> {
  return invoke("get_character_skills", { id });
}

export interface SkillPrerequisite {
  skill_id: number;
  skill_name: string;
  level: number;
}

export interface AllSkillEntry {
  skill_id: number;
  name: string;
  group_name: string;
  rank: number;
  primary_attribute: string | null;
  secondary_attribute: string | null;
  prerequisites: SkillPrerequisite[];
}

/** Every published skill in the game, grouped and ranked - cached on the Rust
 * side after the first call, so repeat visits (any character, any tab
 * revisit) return instantly. */
export function getAllSkills(): Promise<AllSkillEntry[]> {
  return invoke("get_all_skills");
}

export interface SkillQueueItem {
  skill_id: number;
  skill_name: string;
  queue_position: number;
  finished_level: number;
  start_date: string | null;
  finish_date: string | null;
  level_start_sp: number | null;
  level_end_sp: number | null;
  training_start_sp: number | null;
}

export interface CharacterSkillQueue {
  items: SkillQueueItem[];
  needs_reauth: boolean;
}

export function getCharacterSkillQueue(id: number): Promise<CharacterSkillQueue> {
  return invoke("get_character_skill_queue", { id });
}

export interface EmploymentEntry {
  corporation_id: number;
  corporation_name: string;
  start_date: string;
  is_deleted: boolean;
}

export function getCharacterEmploymentHistory(id: number): Promise<EmploymentEntry[]> {
  return invoke("get_character_employment_history", { id });
}

export interface ImplantEntry {
  type_id: number;
  name: string;
  slot: number;
  bonus_text: string | null;
  attribute: string | null;
  bonus: number | null;
}

export interface JumpCloneEntry {
  jump_clone_id: number;
  name: string | null;
  location_name: string;
  implants: ImplantEntry[];
}

export interface CharacterClones {
  home_location_name: string | null;
  active_implants: ImplantEntry[];
  jump_clones: JumpCloneEntry[];
  needs_reauth: boolean;
}

export function getCharacterClones(id: number): Promise<CharacterClones> {
  return invoke("get_character_clones", { id });
}

/** ESI's base attribute values - already post-remap (17 base + whatever
 * remap points were spent), not the raw unmodified 17. Implant bonuses are
 * separate, see ImplantEntry.attribute/bonus on the active clone's implants. */
export interface CharacterAttributes {
  charisma: number;
  intelligence: number;
  memory: number;
  perception: number;
  willpower: number;
  bonus_remaps: number;
  last_remap_date: string | null;
  accrued_remap_cooldown_date: string | null;
  needs_reauth: boolean;
}

export function getCharacterAttributes(id: number): Promise<CharacterAttributes> {
  return invoke("get_character_attributes", { id });
}

export interface ResearchAgentEntry {
  agent_id: number;
  agent_name: string;
  skill_type_id: number;
  skill_name: string;
  points_per_day: number;
  current_points: number;
  started_at: string;
}

export interface CharacterResearch {
  entries: ResearchAgentEntry[];
  needs_reauth: boolean;
}

export function getCharacterResearch(id: number): Promise<CharacterResearch> {
  return invoke("get_character_research", { id });
}

export interface FwTally {
  yesterday: number;
  last_week: number;
  total: number;
}

export interface CharacterFwStats {
  enlisted: boolean;
  faction_name: string | null;
  enlisted_on: string | null;
  // Absent (not zero) whenever the character has never enlisted in FW -
  // confirmed against a real ESI response, not just the (inaccurate here)
  // OpenAPI spec, which marks these "required".
  current_rank: number | null;
  highest_rank: number | null;
  kills: FwTally;
  victory_points: FwTally;
  needs_reauth: boolean;
}

export function getCharacterFwStats(id: number): Promise<CharacterFwStats> {
  return invoke("get_character_fw_stats", { id });
}

export interface StandingEntry {
  from_name: string;
  from_type: string;
  standing: number;
}

export interface CharacterStandings {
  entries: StandingEntry[];
  needs_reauth: boolean;
}

export function getCharacterStandings(id: number): Promise<CharacterStandings> {
  return invoke("get_character_standings", { id });
}

export interface ContactEntry {
  contact_id: number;
  contact_name: string;
  contact_type: string;
  standing: number;
  is_watched: boolean;
  is_blocked: boolean;
}

export interface CharacterContacts {
  entries: ContactEntry[];
  needs_reauth: boolean;
}

export function getCharacterContacts(id: number): Promise<CharacterContacts> {
  return invoke("get_character_contacts", { id });
}

export interface MedalEntry {
  title: string;
  description: string;
  corporation_name: string;
  date: string;
  reason: string;
  status: string;
}

export interface CharacterMedals {
  entries: MedalEntry[];
  needs_reauth: boolean;
}

export function getCharacterMedals(id: number): Promise<CharacterMedals> {
  return invoke("get_character_medals", { id });
}

export interface LoyaltyEntry {
  corporation_id: number;
  corporation_name: string;
  loyalty_points: number;
}

export interface CharacterLoyalty {
  entries: LoyaltyEntry[];
  needs_reauth: boolean;
}

export function getCharacterLoyalty(id: number): Promise<CharacterLoyalty> {
  return invoke("get_character_loyalty", { id });
}

export interface MiningLedgerEntry {
  date: string;
  solar_system_id: number;
  solar_system_name: string;
  type_id: number;
  type_name: string;
  quantity: number;
}

export interface CharacterMiningLedger {
  entries: MiningLedgerEntry[];
  needs_reauth: boolean;
}

/** Up to 90 days of mining history, aggregated by ESI per (date, system,
 * ore/ice type). */
export function getCharacterMiningLedger(id: number): Promise<CharacterMiningLedger> {
  return invoke("get_character_mining_ledger", { id });
}

export interface AssetEntry {
  item_id: number;
  type_id: number;
  type_name: string;
  group_name: string;
  region_name: string;
  quantity: number;
  location_name: string;
  location_flag: string;
}

export interface CharacterAssets {
  entries: AssetEntry[];
  needs_reauth: boolean;
}

export function getCharacterAssets(id: number): Promise<CharacterAssets> {
  return invoke("get_character_assets", { id });
}

export interface MarketOrderEntry {
  order_id: number;
  type_id: number;
  type_name: string;
  location_name: string;
  is_buy_order: boolean;
  price: number;
  volume_remain: number;
  volume_total: number;
  issued: string;
  duration: number;
  range: string;
  status: string;
}

export interface CharacterMarketOrders {
  entries: MarketOrderEntry[];
  needs_reauth: boolean;
}

export function getCharacterMarketOrders(id: number): Promise<CharacterMarketOrders> {
  return invoke("get_character_market_orders", { id });
}

export interface ContractEntry {
  contract_id: number;
  issuer_name: string;
  assignee_name: string | null;
  contract_type: string;
  status: string;
  title: string | null;
  date_issued: string;
  date_expired: string;
  price: number | null;
  reward: number | null;
  start_location_name: string | null;
  end_location_name: string | null;
}

export interface CharacterContracts {
  entries: ContractEntry[];
  needs_reauth: boolean;
}

export function getCharacterContracts(id: number): Promise<CharacterContracts> {
  return invoke("get_character_contracts", { id });
}

export interface ContractItemEntry {
  type_id: number;
  type_name: string;
  quantity: number;
  is_included: boolean;
  runs: number | null;
}

/** Item list for one item_exchange/auction contract - empty for courier contracts (nothing to list). */
export function getContractItems(id: number, contractId: number): Promise<ContractItemEntry[]> {
  return invoke("get_contract_items", { id, contractId });
}

export interface CalendarEventSummary {
  event_id: number;
  event_date: string;
  title: string;
  importance: number;
  event_response: string;
}

export interface CharacterCalendar {
  entries: CalendarEventSummary[];
  needs_reauth: boolean;
}

/** Up to the next 50 upcoming events, chronological - ESI doesn't expose more than that in one call. */
export function getCharacterCalendar(id: number): Promise<CharacterCalendar> {
  return invoke("get_character_calendar", { id });
}

export interface CalendarEventDetail {
  event_id: number;
  date: string;
  title: string;
  text: string;
  duration: number;
  importance: number;
  response: string;
  owner_id: number;
  owner_name: string;
  owner_type: string;
}

export function getCalendarEventDetail(id: number, eventId: number): Promise<CalendarEventDetail> {
  return invoke("get_calendar_event_detail", { id, eventId });
}

export interface IndustryJobEntry {
  job_id: number;
  activity_name: string;
  blueprint_type_name: string;
  product_type_name: string | null;
  station_name: string;
  status: string;
  runs: number;
  start_date: string;
  end_date: string;
}

export interface CharacterIndustryJobs {
  entries: IndustryJobEntry[];
  needs_reauth: boolean;
}

export function getCharacterIndustryJobs(id: number): Promise<CharacterIndustryJobs> {
  return invoke("get_character_industry_jobs", { id });
}

export interface TransactionEntry {
  transaction_id: number;
  date: string;
  type_id: number;
  type_name: string;
  location_name: string;
  quantity: number;
  unit_price: number;
  client_name: string;
  is_buy: boolean;
}

export interface CharacterTransactions {
  entries: TransactionEntry[];
  needs_reauth: boolean;
}

export function getCharacterTransactions(id: number): Promise<CharacterTransactions> {
  return invoke("get_character_transactions", { id });
}

export interface WalletJournalEntry {
  id: number;
  date: string;
  ref_type: string;
  amount: number;
  balance: number | null;
  description: string;
  first_party_name: string | null;
  second_party_name: string | null;
}

export interface CharacterWalletJournal {
  entries: WalletJournalEntry[];
  needs_reauth: boolean;
}

export function getCharacterWalletJournal(id: number): Promise<CharacterWalletJournal> {
  return invoke("get_character_wallet_journal", { id });
}

export interface MailEntry {
  mail_id: number;
  from_name: string;
  subject: string;
  timestamp: string | null;
  is_read: boolean;
}

export interface CharacterMail {
  entries: MailEntry[];
  needs_reauth: boolean;
}

export function getCharacterMail(id: number): Promise<CharacterMail> {
  return invoke("get_character_mail", { id });
}

export interface MailDetail {
  mail_id: number;
  from_name: string;
  subject: string;
  timestamp: string | null;
  body_text: string;
  recipient_names: string[];
  needs_reauth: boolean;
}

export function getMailDetail(id: number, mailId: number): Promise<MailDetail> {
  return invoke("get_mail_detail", { id, mailId });
}

export interface NotificationEntry {
  notification_id: number;
  sender_name: string;
  notification_type: string;
  timestamp: string;
  is_read: boolean;
}

export interface CharacterNotifications {
  entries: NotificationEntry[];
  needs_reauth: boolean;
}

export function getCharacterNotifications(id: number): Promise<CharacterNotifications> {
  return invoke("get_character_notifications", { id });
}

export interface PlanetEntry {
  planet_name: string;
  solar_system_name: string;
  planet_type: string;
  upgrade_level: number;
  num_pins: number;
  last_update: string;
}

export interface CharacterPlanets {
  entries: PlanetEntry[];
  needs_reauth: boolean;
}

export function getCharacterPlanets(id: number): Promise<CharacterPlanets> {
  return invoke("get_character_planets", { id });
}
