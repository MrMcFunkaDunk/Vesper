import { Fragment, useEffect, useMemo, useState } from "react";
import { ArrowLeft, Search, RefreshCw, Sparkles } from "lucide-react";
import { toCsv, downloadCsv } from "../lib/csvExport";
import {
  getCharacterOverview,
  getCharacterSkills,
  getAllSkills,
  getCharacterSkillQueue,
  getCharacterEmploymentHistory,
  getCharacterClones,
  getCharacterStandings,
  getCharacterContacts,
  getCharacterMedals,
  getCharacterLoyalty,
  getCharacterAssets,
  getCharacterMarketOrders,
  getCharacterContracts,
  getContractItems,
  getCharacterIndustryJobs,
  getCharacterTransactions,
  getCharacterWalletJournal,
  getCharacterMail,
  getMailDetail,
  getCharacterNotifications,
  getCharacterPlanets,
  getCharacterAttributes,
  getCharacterResearch,
  getCharacterFwStats,
  type CharacterAttributes,
  type CharacterResearch,
  type CharacterFwStats,
  type CharacterOverview,
  type CharacterSkills,
  type AllSkillEntry,
  type CharacterSkillQueue,
  type EmploymentEntry,
  type CharacterClones,
  type CharacterStandings,
  type CharacterContacts,
  type CharacterMedals,
  type CharacterLoyalty,
  type CharacterAssets,
  type CharacterMarketOrders,
  type CharacterContracts,
  type ContractItemEntry,
  type CharacterIndustryJobs,
  type CharacterTransactions,
  type CharacterWalletJournal,
  type CharacterMail,
  type MailDetail,
  type CharacterNotifications,
  type CharacterPlanets,
  type SessionCharacter,
} from "../lib/eve";
import { getCharacterKills, getCharacterLosses, type KillEntry } from "../lib/kills";
import { getMarketPrices } from "../lib/market";
import { recordAssetSnapshot, getAssetHistory, type AssetSnapshot } from "../lib/assetHistory";
import { checkAbyssalValue, type AbyssalValueResult } from "../lib/abyssal";
import InsuranceCalculator from "./InsuranceCalculator";
import SkillPlanTab from "./SkillPlanTab";
import {
  formatIsk,
  formatSp,
  formatTimeRemaining,
  formatTimeRemainingFull,
  formatEveDateTime,
  formatQueueSummary,
  typeIconUrl,
  standingClass,
} from "../lib/format";
import { useErrorReporter } from "../hooks/useErrorReporter";
import { useSortableRows, useTextFilter, useSelectFilter } from "../hooks/useSortableRows";
import { SortableTh } from "./SortableTh";
import TableFilterBar from "./TableFilterBar";
import { BASE_ATTRIBUTE_VALUE } from "../lib/skillTraining";
import { getCachedOverview, setCachedOverview, isTransientServerError } from "../lib/overviewCache";
import KillFeedTable from "./KillFeedTable";
import CloneStateBadge from "./CloneStateBadge";
import type { SystemSummary } from "./SystemKillboard";
import type { CorporationSummary } from "./CorporationKillboard";
import type { AllianceSummary } from "./AllianceKillboard";

interface CharacterDetailProps {
  character: SessionCharacter;
  characters: SessionCharacter[];
  onSwitchCharacter: (id: number) => void;
  onBack: () => void;
  onSelectKill: (killmailId: number) => void;
  onSelectCharacter: (characterId: number) => void;
  onSelectSystem: (system: SystemSummary) => void;
  onSelectCorporation: (corporation: CorporationSummary) => void;
  onSelectAlliance: (alliance: AllianceSummary) => void;
  /** Re-runs EVE SSO login so this character can grant any scopes it's missing (e.g. a tab added after it last logged in). */
  onReconnect: () => Promise<void>;
}

type SkillFilter = "all" | "trained" | "untrained" | "injected" | "1" | "2" | "3" | "4" | "5";

type CharacterTab =
  | "plan"
  | "skills"
  | "queue"
  | "clones"
  | "employment"
  | "standings"
  | "contacts"
  | "medals"
  | "lp"
  | "assets"
  | "marketOrders"
  | "contracts"
  | "insurance"
  | "industryJobs"
  | "wallet"
  | "transactions"
  | "mail"
  | "notifications"
  | "killLog"
  | "planetary"
  | "research"
  | "factionWarfare";

const TABS: { id: CharacterTab; label: string }[] = [
  { id: "queue", label: "Queue" },
  { id: "plan", label: "Plan" },
  { id: "skills", label: "Skills" },
  { id: "clones", label: "Clones" },
  { id: "employment", label: "Employment" },
  { id: "standings", label: "Standings" },
  { id: "contacts", label: "Contacts" },
  { id: "medals", label: "Medals" },
  { id: "lp", label: "LP" },
  { id: "assets", label: "Assets" },
  { id: "marketOrders", label: "Market Orders" },
  { id: "contracts", label: "Contracts" },
  { id: "insurance", label: "Insurance" },
  { id: "industryJobs", label: "Industry Jobs" },
  { id: "wallet", label: "Wallet" },
  { id: "transactions", label: "Transactions" },
  { id: "mail", label: "Mail" },
  { id: "notifications", label: "Notifications" },
  { id: "killLog", label: "Kill Log" },
  { id: "planetary", label: "Planetary" },
  { id: "research", label: "Research" },
  { id: "factionWarfare", label: "Faction Warfare" },
];

function SkillLevelPips({ level }: { level: number }) {
  return (
    <span className="skill-pips" aria-label={`Level ${level}`}>
      {[1, 2, 3, 4, 5].map((n) => (
        <span key={n} className={`skill-pip${n <= level ? " skill-pip-filled" : ""}`} />
      ))}
    </span>
  );
}

/** EveLens' 5-bucket standing classification (Terrible/Bad/Neutral/Good/Excellent). */
function standingLabel(value: number): string {
  if (value <= -5.5) return "Terrible";
  if (value <= -0.5) return "Bad";
  if (value < 0.5) return "Neutral";
  if (value < 5.5) return "Good";
  return "Excellent";
}

/** Two-sided bar centered at 0: a red segment grows left for negative standings,
 * a blue segment grows right for positive ones, each proportional to abs(value)/10. */
function StandingBar({ value }: { value: number }) {
  const width = Math.min(60, (Math.abs(value) / 10) * 60);
  return (
    <span className="standing-bar">
      <span className="standing-bar-center" />
      {value < 0 && <span className="standing-bar-segment standing-bar-negative" style={{ width }} />}
      {value > 0 && <span className="standing-bar-segment standing-bar-positive" style={{ width }} />}
    </span>
  );
}

function fmtDate(value: string | null): string {
  return value ? new Date(value).toLocaleString([], { timeZone: "UTC" }) : "—";
}

function contractStatusClass(status: string): string {
  if (["finished", "finished_issuer", "finished_contractor"].includes(status)) return "standing-text-positive";
  if (["cancelled", "rejected", "failed", "deleted", "reversed"].includes(status)) return "standing-text-negative";
  return "standing-text-neutral";
}

/** Compact "16 Aug 14:32" style used for skill queue end/start times, matching EveLens' queue display. */
function fmtShortDateTime(value: string): string {
  return new Date(value).toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  });
}

/** How long this specific queue step (this level, not the whole skill) actually takes to train. */
function formatSkillDuration(startIso: string, endIso: string): string {
  const ms = new Date(endIso).getTime() - new Date(startIso).getTime();
  if (ms <= 0) return "—";
  const totalMinutes = Math.round(ms / 60000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function fmtCount(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

/** A tiny value-over-time trend line - only ever as many points as there
 * are recorded days (starts empty, grows a day at a time), so this stays
 * hidden until there's at least two days to actually draw a line between. */
function AssetValueSparkline({ points }: { points: AssetSnapshot[] }) {
  if (points.length < 2) return null;
  const width = 220;
  const height = 40;
  const values = points.map((p) => p.total_value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const stepX = width / (points.length - 1);
  const coords = points.map((p, i) => `${(i * stepX).toFixed(1)},${(height - ((p.total_value - min) / range) * height).toFixed(1)}`);
  const change = values[values.length - 1] - values[0];
  const changePct = values[0] !== 0 ? (change / Math.abs(values[0])) * 100 : 0;
  return (
    <div className="asset-sparkline-wrap" title={`${points[0].snapshot_date} to ${points[points.length - 1].snapshot_date}`}>
      <svg viewBox={`0 0 ${width} ${height}`} className="asset-sparkline" preserveAspectRatio="none">
        <polyline points={coords.join(" ")} className={change >= 0 ? "asset-sparkline-line-up" : "asset-sparkline-line-down"} fill="none" />
      </svg>
      <span className={change >= 0 ? "wallet-amount-positive" : "wallet-amount-negative"}>
        {change >= 0 ? "+" : ""}
        {changePct.toFixed(1)}% over {points.length} day{points.length === 1 ? "" : "s"}
      </span>
    </div>
  );
}

/** Bonus remaps (new-player grants) bypass the normal once-a-year cooldown entirely - checked first regardless of accrued_remap_cooldown_date. */
function remapAvailabilityText(attributes: CharacterAttributes): string {
  if (attributes.bonus_remaps > 0) {
    return `${attributes.bonus_remaps} bonus remap${attributes.bonus_remaps === 1 ? "" : "s"} available`;
  }
  if (!attributes.accrued_remap_cooldown_date) return "Remap available";
  const cooldownEnds = new Date(attributes.accrued_remap_cooldown_date).getTime();
  if (cooldownEnds <= Date.now()) return "Remap available";
  return `Next remap: ${formatTimeRemaining(attributes.accrued_remap_cooldown_date)}`;
}

function CharacterDetail({
  character,
  characters,
  onSwitchCharacter,
  onBack,
  onSelectKill,
  onSelectCharacter,
  onSelectSystem,
  onSelectCorporation,
  onSelectAlliance,
  onReconnect,
}: CharacterDetailProps) {
  const [overview, setOverview] = useState<CharacterOverview | null>(null);
  const [attributes, setAttributes] = useState<CharacterAttributes | null>(null);
  const [reconnecting, setReconnecting] = useState(false);
  const [tab, setTab] = useState<CharacterTab>("queue");
  const [skills, setSkills] = useState<CharacterSkills | null>(null);
  const [allSkills, setAllSkills] = useState<AllSkillEntry[] | null>(null);
  const [skillQuery, setSkillQuery] = useState("");
  const [skillFilter, setSkillFilter] = useState<SkillFilter>("trained");
  const [collapsedSkillGroups, setCollapsedSkillGroups] = useState<Set<string>>(new Set());
  const [skillQueue, setSkillQueue] = useState<CharacterSkillQueue | null>(null);
  const [employment, setEmployment] = useState<EmploymentEntry[] | null>(null);
  const [clones, setClones] = useState<CharacterClones | null>(null);
  const [standings, setStandings] = useState<CharacterStandings | null>(null);
  const [contacts, setContacts] = useState<CharacterContacts | null>(null);
  const [medals, setMedals] = useState<CharacterMedals | null>(null);
  const [loyalty, setLoyalty] = useState<CharacterLoyalty | null>(null);
  const [assets, setAssets] = useState<CharacterAssets | null>(null);
  const [assetQuery, setAssetQuery] = useState("");
  const [assetGroupBy, setAssetGroupBy] = useState<"region" | "location" | "group">("region");
  const [expandedAssetGroups, setExpandedAssetGroups] = useState<Set<string>>(new Set());
  const [assetPrices, setAssetPrices] = useState<Map<number, number>>(new Map());
  const [assetHistory, setAssetHistory] = useState<AssetSnapshot[] | null>(null);
  const [abyssalChecks, setAbyssalChecks] = useState<Record<number, "checking" | "none" | AbyssalValueResult>>({});
  const [marketOrders, setMarketOrders] = useState<CharacterMarketOrders | null>(null);
  const [contracts, setContracts] = useState<CharacterContracts | null>(null);
  const [expandedContractId, setExpandedContractId] = useState<number | null>(null);
  const [contractItems, setContractItems] = useState<Record<number, ContractItemEntry[]>>({});
  const [industryJobs, setIndustryJobs] = useState<CharacterIndustryJobs | null>(null);
  const [transactions, setTransactions] = useState<CharacterTransactions | null>(null);
  const [walletJournal, setWalletJournal] = useState<CharacterWalletJournal | null>(null);
  const [mail, setMail] = useState<CharacterMail | null>(null);
  const [selectedMailId, setSelectedMailId] = useState<number | null>(null);
  const [mailDetail, setMailDetail] = useState<MailDetail | null>(null);
  const [mailDetailLoading, setMailDetailLoading] = useState(false);
  const [notifications, setNotifications] = useState<CharacterNotifications | null>(null);
  const [planets, setPlanets] = useState<CharacterPlanets | null>(null);
  const [research, setResearch] = useState<CharacterResearch | null>(null);
  const [fwStats, setFwStats] = useState<CharacterFwStats | null>(null);
  const [killLogTab, setKillLogTab] = useState<"kills" | "losses">("kills");
  const [kills, setKills] = useState<KillEntry[] | null>(null);
  const [losses, setLosses] = useState<KillEntry[] | null>(null);
  const reportError = useErrorReporter();

  const sortedStandings = useSortableRows(standings?.entries ?? [], {
    from_name: (s) => s.from_name,
    from_type: (s) => s.from_type,
    standing: (s) => s.standing,
  }, "standing");
  const sortedContacts = useSortableRows(contacts?.entries ?? [], {
    contact_name: (c) => c.contact_name,
    contact_type: (c) => c.contact_type,
    standing: (c) => c.standing,
  }, "standing");
  const sortedLoyalty = useSortableRows(loyalty?.entries ?? [], {
    corporation_name: (l) => l.corporation_name,
    loyalty_points: (l) => l.loyalty_points,
  });
  const marketOrdersText = useTextFilter(marketOrders?.entries ?? [], (o) => [o.type_name, o.location_name]);
  const marketOrdersSide = useSelectFilter(marketOrdersText.filtered, (o) => (o.is_buy_order ? "Buy" : "Sell"));
  const marketOrdersStatus = useSelectFilter(marketOrdersSide.filtered, (o) => o.status);
  const sortedMarketOrders = useSortableRows(marketOrdersStatus.filtered, {
    type_name: (o) => o.type_name,
    side: (o) => (o.is_buy_order ? "Buy" : "Sell"),
    status: (o) => o.status,
    price: (o) => o.price,
    volume_remain: (o) => o.volume_remain,
    location_name: (o) => o.location_name,
    issued: (o) => new Date(o.issued).getTime(),
  });
  const contractsText = useTextFilter(contracts?.entries ?? [], (c) => [c.title, c.issuer_name, c.assignee_name]);
  const contractsType = useSelectFilter(contractsText.filtered, (c) => c.contract_type);
  const contractsStatus = useSelectFilter(contractsType.filtered, (c) => c.status);
  const sortedContracts = useSortableRows(contractsStatus.filtered, {
    title: (c) => c.title || "",
    contract_type: (c) => c.contract_type,
    status: (c) => c.status,
    issuer_name: (c) => c.issuer_name,
    assignee_name: (c) => c.assignee_name ?? "",
    price: (c) => c.price ?? c.reward ?? 0,
    date_issued: (c) => new Date(c.date_issued).getTime(),
    date_expired: (c) => new Date(c.date_expired).getTime(),
  });
  const sortedIndustryJobs = useSortableRows(industryJobs?.entries ?? [], {
    activity_name: (j) => j.activity_name,
    blueprint_type_name: (j) => j.blueprint_type_name,
    product_type_name: (j) => j.product_type_name ?? "",
    status: (j) => j.status,
    runs: (j) => j.runs,
    station_name: (j) => j.station_name,
    end_date: (j) => new Date(j.end_date).getTime(),
  });
  const walletJournalText = useTextFilter(walletJournal?.entries.slice(0, 1000) ?? [], (e) => [e.description, e.ref_type, e.first_party_name, e.second_party_name]);
  const walletJournalType = useSelectFilter(walletJournalText.filtered, (e) => e.ref_type.replace(/_/g, " "));
  const sortedWalletJournal = useSortableRows(walletJournalType.filtered, {
    date: (e) => new Date(e.date).getTime(),
    ref_type: (e) => e.ref_type,
    description: (e) => e.description,
    amount: (e) => e.amount,
    balance: (e) => e.balance ?? 0,
  }, "date");
  const transactionsText = useTextFilter(transactions?.entries ?? [], (t) => [t.type_name, t.location_name, t.client_name]);
  const transactionsSide = useSelectFilter(transactionsText.filtered, (t) => (t.is_buy ? "Buy" : "Sell"));
  const sortedTransactions = useSortableRows(transactionsSide.filtered, {
    date: (t) => new Date(t.date).getTime(),
    side: (t) => (t.is_buy ? "Buy" : "Sell"),
    type_name: (t) => t.type_name,
    quantity: (t) => t.quantity,
    unit_price: (t) => t.unit_price,
    total: (t) => t.quantity * t.unit_price,
    location_name: (t) => t.location_name,
    client_name: (t) => t.client_name,
  }, "date");
  const sortedPlanets = useSortableRows(planets?.entries ?? [], {
    planet_name: (p) => p.planet_name,
    solar_system_name: (p) => p.solar_system_name,
    planet_type: (p) => p.planet_type,
    upgrade_level: (p) => p.upgrade_level,
    num_pins: (p) => p.num_pins,
    last_update: (p) => new Date(p.last_update).getTime(),
  });
  const sortedResearch = useSortableRows(research?.entries ?? [], {
    agent_name: (r) => r.agent_name,
    skill_name: (r) => r.skill_name,
    points_per_day: (r) => r.points_per_day,
    current_points: (r) => r.current_points,
    started_at: (r) => new Date(r.started_at).getTime(),
  });

  useEffect(() => {
    getMarketPrices()
      .then((list) => {
        const map = new Map<number, number>();
        for (const p of list) if (p.average_price != null) map.set(p.type_id, p.average_price);
        setAssetPrices(map);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (tab !== "assets" || !assets || assets.needs_reauth || assetPrices.size === 0) return;
    const totalValue = assets.entries.reduce((sum, a) => sum + (assetPrices.get(a.type_id) ?? 0) * a.quantity, 0);
    recordAssetSnapshot(character.id, totalValue)
      .then(() => getAssetHistory(character.id))
      .then(setAssetHistory)
      .catch(() => {});
  }, [tab, assets, assetPrices, character.id]);

  useEffect(() => {
    // Hydrate from the last successful fetch rather than blanking to null -
    // if Tranquility is down right now, this is the only data there is to
    // show until it comes back.
    setOverview(getCachedOverview(character.id));
    setAttributes(null);
    setSkills(null);
    setSkillQuery("");
    setSkillQueue(null);
    setEmployment(null);
    setClones(null);
    setStandings(null);
    setContacts(null);
    setMedals(null);
    setLoyalty(null);
    setAssets(null);
    setAssetQuery("");
    setAssetHistory(null);
    setAbyssalChecks({});
    setMarketOrders(null);
    setContracts(null);
    setExpandedContractId(null);
    setContractItems({});
    setIndustryJobs(null);
    setTransactions(null);
    setWalletJournal(null);
    setMail(null);
    setSelectedMailId(null);
    setMailDetail(null);
    setNotifications(null);
    setPlanets(null);
    setResearch(null);
    setFwStats(null);
    setKillLogTab("kills");
    setKills(null);
    setLosses(null);
    setTab("queue");

    getCharacterOverview(character.id)
      .then((result) => {
        setOverview(result);
        setCachedOverview(character.id, result);
      })
      .catch((err) => {
        // Expected during downtime, self-resolves once the auto-refresh poll
        // below succeeds - not worth an error modal, and whatever's already
        // showing (cached or from the previous character) stays put.
        if (!isTransientServerError(String(err))) {
          reportError(`Failed to load overview for ${character.name}: ${String(err)}`);
        }
      });
    // Loaded eagerly (not lazy-per-tab like the rest below) since it renders
    // in the always-visible header, not a tab body.
    getCharacterAttributes(character.id)
      .then(setAttributes)
      .catch((err) => {
        if (!isTransientServerError(String(err))) {
          reportError(`Failed to load attributes for ${character.name}: ${String(err)}`);
        }
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [character.id]);

  // Everything beyond the overview is loaded lazily, the first time its tab
  // is actually visited, rather than firing every ESI call up front for tabs
  // the user may never open.
  useEffect(() => {
    const id = character.id;
    if (tab === "queue" && !skillQueue) {
      getCharacterSkillQueue(id).then(setSkillQueue).catch((err) => reportError(`Failed to load skill queue: ${String(err)}`));
    } else if (tab === "skills" && !skills) {
      getCharacterSkills(id).then(setSkills).catch((err) => reportError(`Failed to load skills: ${String(err)}`));
      if (!allSkills) {
        getAllSkills()
          .then(setAllSkills)
          .catch((err) => reportError(`Failed to load full skill list: ${String(err)}`));
      }
    } else if (tab === "plan") {
      // The planner needs both the full catalog (with prerequisites/attributes,
      // for anything not yet trained) and the character's own trained levels
      // (to know what's already satisfied) - same two fetches the Skills tab
      // above triggers, just reached from a different tab.
      if (!skills) getCharacterSkills(id).then(setSkills).catch((err) => reportError(`Failed to load skills: ${String(err)}`));
      if (!allSkills) {
        getAllSkills()
          .then(setAllSkills)
          .catch((err) => reportError(`Failed to load full skill list: ${String(err)}`));
      }
    } else if (tab === "employment" && !employment) {
      getCharacterEmploymentHistory(id)
        .then(setEmployment)
        .catch((err) => reportError(`Failed to load employment history: ${String(err)}`));
    } else if (tab === "clones" && !clones) {
      getCharacterClones(id).then(setClones).catch((err) => reportError(`Failed to load clones: ${String(err)}`));
    } else if (tab === "standings" && !standings) {
      getCharacterStandings(id).then(setStandings).catch((err) => reportError(`Failed to load standings: ${String(err)}`));
    } else if (tab === "contacts" && !contacts) {
      getCharacterContacts(id).then(setContacts).catch((err) => reportError(`Failed to load contacts: ${String(err)}`));
    } else if (tab === "medals" && !medals) {
      getCharacterMedals(id).then(setMedals).catch((err) => reportError(`Failed to load medals: ${String(err)}`));
    } else if (tab === "lp" && !loyalty) {
      getCharacterLoyalty(id).then(setLoyalty).catch((err) => reportError(`Failed to load loyalty points: ${String(err)}`));
    } else if (tab === "assets" && !assets) {
      getCharacterAssets(id).then(setAssets).catch((err) => reportError(`Failed to load assets: ${String(err)}`));
    } else if (tab === "marketOrders" && !marketOrders) {
      getCharacterMarketOrders(id)
        .then(setMarketOrders)
        .catch((err) => reportError(`Failed to load market orders: ${String(err)}`));
    } else if (tab === "contracts" && !contracts) {
      getCharacterContracts(id).then(setContracts).catch((err) => reportError(`Failed to load contracts: ${String(err)}`));
    } else if (tab === "industryJobs" && !industryJobs) {
      getCharacterIndustryJobs(id)
        .then(setIndustryJobs)
        .catch((err) => reportError(`Failed to load industry jobs: ${String(err)}`));
    } else if (tab === "transactions" && !transactions) {
      getCharacterTransactions(id)
        .then(setTransactions)
        .catch((err) => reportError(`Failed to load transactions: ${String(err)}`));
    } else if (tab === "wallet" && !walletJournal) {
      getCharacterWalletJournal(id)
        .then(setWalletJournal)
        .catch((err) => reportError(`Failed to load wallet journal: ${String(err)}`));
    } else if (tab === "mail" && !mail) {
      getCharacterMail(id).then(setMail).catch((err) => reportError(`Failed to load mail: ${String(err)}`));
    } else if (tab === "notifications" && !notifications) {
      getCharacterNotifications(id)
        .then(setNotifications)
        .catch((err) => reportError(`Failed to load notifications: ${String(err)}`));
    } else if (tab === "planetary" && !planets) {
      getCharacterPlanets(id).then(setPlanets).catch((err) => reportError(`Failed to load planets: ${String(err)}`));
    } else if (tab === "killLog" && !kills) {
      getCharacterKills(id).then(setKills).catch((err) => reportError(`Failed to load kills: ${String(err)}`));
    } else if (tab === "research" && !research) {
      getCharacterResearch(id).then(setResearch).catch((err) => reportError(`Failed to load research points: ${String(err)}`));
    } else if (tab === "factionWarfare" && !fwStats) {
      getCharacterFwStats(id).then(setFwStats).catch((err) => reportError(`Failed to load faction warfare stats: ${String(err)}`));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, character.id]);

  // Keeps data fresh without a manual reload, matching EveLens/EveMon's frequent-
  // refresh behavior. Refetches the header overview (ISK/SP/training/queue) every
  // tick regardless of tab, plus whichever single tab is currently open - never
  // every tab at once, so switching tabs doesn't fan out into a burst of ESI calls
  // for screens the user isn't even looking at. Failures are swallowed silently
  // here (unlike the lazy-load fetches above) so a transient network hiccup on a
  // background poll doesn't pop an error toast; the next tick just tries again.
  useEffect(() => {
    const id = character.id;
    const interval = setInterval(() => {
      getCharacterOverview(id)
        .then((result) => {
          setOverview(result);
          setCachedOverview(id, result);
        })
        .catch(() => {});
      switch (tab) {
        case "queue":
          getCharacterSkillQueue(id).then(setSkillQueue).catch(() => {});
          break;
        case "skills":
          getCharacterSkills(id).then(setSkills).catch(() => {});
          break;
        case "employment":
          getCharacterEmploymentHistory(id).then(setEmployment).catch(() => {});
          break;
        case "clones":
          getCharacterClones(id).then(setClones).catch(() => {});
          break;
        case "standings":
          getCharacterStandings(id).then(setStandings).catch(() => {});
          break;
        case "contacts":
          getCharacterContacts(id).then(setContacts).catch(() => {});
          break;
        case "medals":
          getCharacterMedals(id).then(setMedals).catch(() => {});
          break;
        case "lp":
          getCharacterLoyalty(id).then(setLoyalty).catch(() => {});
          break;
        case "assets":
          getCharacterAssets(id).then(setAssets).catch(() => {});
          break;
        case "marketOrders":
          getCharacterMarketOrders(id).then(setMarketOrders).catch(() => {});
          break;
        case "contracts":
          getCharacterContracts(id).then(setContracts).catch(() => {});
          break;
        case "industryJobs":
          getCharacterIndustryJobs(id).then(setIndustryJobs).catch(() => {});
          break;
        case "wallet":
          getCharacterWalletJournal(id).then(setWalletJournal).catch(() => {});
          break;
        case "transactions":
          getCharacterTransactions(id).then(setTransactions).catch(() => {});
          break;
        case "mail":
          getCharacterMail(id).then(setMail).catch(() => {});
          break;
        case "notifications":
          getCharacterNotifications(id).then(setNotifications).catch(() => {});
          break;
        case "planetary":
          getCharacterPlanets(id).then(setPlanets).catch(() => {});
          break;
        case "killLog":
          if (killLogTab === "losses") getCharacterLosses(id).then(setLosses).catch(() => {});
          else getCharacterKills(id).then(setKills).catch(() => {});
          break;
        case "research":
          getCharacterResearch(id).then(setResearch).catch(() => {});
          break;
        case "factionWarfare":
          getCharacterFwStats(id).then(setFwStats).catch(() => {});
          break;
      }
    }, 120000);
    return () => clearInterval(interval);
  }, [tab, character.id, killLogTab]);

  function openMail(mailId: number) {
    setSelectedMailId(mailId);
    setMailDetail(null);
    setMailDetailLoading(true);
    getMailDetail(character.id, mailId)
      .then(setMailDetail)
      .catch((err) => reportError(`Failed to load mail: ${String(err)}`))
      .finally(() => setMailDetailLoading(false));
  }

  function handleKillLogTab(next: "kills" | "losses") {
    setKillLogTab(next);
    if (next === "losses" && losses === null) {
      getCharacterLosses(character.id)
        .then(setLosses)
        .catch((err) => reportError(`Failed to load losses: ${String(err)}`));
    }
  }

  async function handleReconnect() {
    setReconnecting(true);
    try {
      await onReconnect();
    } catch (err) {
      reportError(`Reconnect failed: ${String(err)}`);
    } finally {
      setReconnecting(false);
    }
  }

  const trainedLevelBySkillId = useMemo(() => {
    const map = new Map<number, number>();
    for (const s of skills?.skills ?? []) map.set(s.skill_id, s.trained_level);
    return map;
  }, [skills]);

  const mergedSkills = useMemo(() => {
    if (!allSkills) return null;
    const trainedById = new Map(skills?.skills.map((s) => [s.skill_id, s]) ?? []);
    return allSkills.map((s) => {
      const trained = trainedById.get(s.skill_id);
      return {
        skill_id: s.skill_id,
        name: s.name,
        group_name: s.group_name,
        rank: s.rank,
        trained_level: trained?.trained_level ?? 0,
        skillpoints: trained?.skillpoints ?? 0,
        // A skill can be injected (present in ESI's known-skills list) but
        // still sit at 0 SP if it's never been queued to train - that looks
        // and behaves identically to not having it at all, so "trained"
        // means actual SP invested, not merely "known to ESI".
        isTrained: (trained?.skillpoints ?? 0) > 0,
      };
    });
  }, [allSkills, skills]);

  const searchedSkills = (mergedSkills ?? []).filter((s) => s.name.toLowerCase().includes(skillQuery.toLowerCase()));
  const skillCounts: Record<SkillFilter, number> = {
    all: searchedSkills.length,
    trained: searchedSkills.filter((s) => s.isTrained).length,
    untrained: searchedSkills.filter((s) => !s.isTrained).length,
    injected: searchedSkills.filter((s) => s.isTrained && s.trained_level === 0).length,
    "1": searchedSkills.filter((s) => s.isTrained && s.trained_level === 1).length,
    "2": searchedSkills.filter((s) => s.isTrained && s.trained_level === 2).length,
    "3": searchedSkills.filter((s) => s.isTrained && s.trained_level === 3).length,
    "4": searchedSkills.filter((s) => s.isTrained && s.trained_level === 4).length,
    "5": searchedSkills.filter((s) => s.isTrained && s.trained_level === 5).length,
  };

  function matchesSkillFilter(s: (typeof searchedSkills)[number]): boolean {
    switch (skillFilter) {
      case "all":
        return true;
      case "trained":
        return s.isTrained;
      case "untrained":
        return !s.isTrained;
      case "injected":
        return s.isTrained && s.trained_level === 0;
      default:
        return s.isTrained && s.trained_level === Number(skillFilter);
    }
  }

  const visibleSkills = searchedSkills.filter(matchesSkillFilter);
  const skillGroups = new Map<string, typeof visibleSkills>();
  for (const s of visibleSkills) {
    const arr = skillGroups.get(s.group_name);
    if (arr) arr.push(s);
    else skillGroups.set(s.group_name, [s]);
  }

  function toggleSkillGroup(name: string) {
    setCollapsedSkillGroups((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  function csvFilename(suffix: string): string {
    return `${character.name.replace(/\s+/g, "_")}_${suffix}.csv`;
  }

  function exportSkillsCsv() {
    const csv = toCsv(visibleSkills, [
      { header: "Group", value: (s) => s.group_name },
      { header: "Skill", value: (s) => s.name },
      { header: "Rank", value: (s) => s.rank },
      { header: "Level", value: (s) => s.trained_level },
      { header: "Skillpoints", value: (s) => s.skillpoints },
    ]);
    downloadCsv(csvFilename("skills"), csv);
  }

  function exportAssetsCsv() {
    const csv = toCsv(filteredAssets, [
      { header: "Item", value: (a) => a.type_name },
      { header: "Group", value: (a) => a.group_name },
      { header: "Quantity", value: (a) => a.quantity },
      { header: "Value", value: (a) => (assetPrices.get(a.type_id) ?? 0) * a.quantity },
      { header: "Location", value: (a) => a.location_name },
      { header: "Region", value: (a) => a.region_name },
      { header: "Flag", value: (a) => a.location_flag },
    ]);
    downloadCsv(csvFilename("assets"), csv);
  }

  function exportWalletCsv() {
    if (!walletJournal) return;
    const csv = toCsv(walletJournal.entries, [
      { header: "Date", value: (e) => e.date },
      { header: "Type", value: (e) => e.ref_type },
      { header: "Description", value: (e) => e.description },
      { header: "Amount", value: (e) => e.amount },
      { header: "Balance", value: (e) => e.balance ?? "" },
      { header: "From", value: (e) => e.first_party_name ?? "" },
      { header: "To", value: (e) => e.second_party_name ?? "" },
    ]);
    downloadCsv(csvFilename("wallet_journal"), csv);
  }

  function exportTransactionsCsv() {
    if (!transactions) return;
    const csv = toCsv(transactions.entries, [
      { header: "Date", value: (t) => t.date },
      { header: "Side", value: (t) => (t.is_buy ? "Buy" : "Sell") },
      { header: "Item", value: (t) => t.type_name },
      { header: "Quantity", value: (t) => t.quantity },
      { header: "Unit Price", value: (t) => t.unit_price },
      { header: "Total", value: (t) => t.quantity * t.unit_price },
      { header: "Location", value: (t) => t.location_name },
      { header: "With", value: (t) => t.client_name },
    ]);
    downloadCsv(csvFilename("transactions"), csv);
  }

  const filteredAssets =
    assets?.entries.filter((a) => {
      const q = assetQuery.toLowerCase();
      return a.type_name.toLowerCase().includes(q) || a.location_name.toLowerCase().includes(q) || a.region_name.toLowerCase().includes(q);
    }) ?? [];

  function toggleAssetGroup(name: string) {
    setExpandedAssetGroups((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  /** On demand only - there's no cheap way to know in advance which assets
   * are mutated, so this checks one specific item's real item_id against
   * ESI when clicked, rather than eagerly checking the whole asset list. */
  async function handleCheckAbyssal(itemId: number, typeId: number) {
    setAbyssalChecks((prev) => ({ ...prev, [itemId]: "checking" }));
    try {
      const result = await checkAbyssalValue(typeId, itemId);
      setAbyssalChecks((prev) => ({ ...prev, [itemId]: result ?? "none" }));
    } catch (err) {
      reportError(`Failed to check abyssal value: ${String(err)}`);
      setAbyssalChecks((prev) => {
        const next = { ...prev };
        delete next[itemId];
        return next;
      });
    }
  }
  const activeKillLogList = killLogTab === "kills" ? kills : losses;

  function reauthNotice(label: string) {
    return <p className="detail-empty">Sign in again to unlock {label} for this character.</p>;
  }

  function renderTabContent() {
    switch (tab) {
      case "plan":
        return (
          <SkillPlanTab
            characterId={character.id}
            allSkills={allSkills}
            trainedLevelBySkillId={trainedLevelBySkillId}
            attributes={attributes}
            currentTotalSp={overview?.total_sp ?? null}
          />
        );

      case "queue":
        return !skillQueue ? (
          <p className="detail-empty">Loading skill queue...</p>
        ) : skillQueue.needs_reauth ? (
          reauthNotice("the skill queue")
        ) : skillQueue.items.length === 0 ? (
          <p className="detail-empty">No skills queued.</p>
        ) : (
          <>
          <div className="skill-queue-list">
            {skillQueue.items.map((item, index) => {
              const progress =
                index === 0 && item.level_start_sp != null && item.level_end_sp != null && item.training_start_sp != null
                  ? Math.min(
                      1,
                      Math.max(
                        0,
                        (item.training_start_sp - item.level_start_sp) / (item.level_end_sp - item.level_start_sp),
                      ),
                    )
                  : null;
              return (
                <div key={`${item.skill_id}-${item.queue_position}`} className="skill-queue-row">
                  <span className="skill-queue-position">{index + 1}</span>
                  <div className="skill-queue-main">
                    <span className="skill-queue-name">
                      {item.skill_name} <SkillLevelPips level={item.finished_level} />
                      {item.start_date && item.finish_date && (
                        <span className="skill-queue-step-duration">{formatSkillDuration(item.start_date, item.finish_date)}</span>
                      )}
                    </span>
                    {progress != null && (
                      <div className="skill-queue-progress-track">
                        <div className="skill-queue-progress-fill" style={{ width: `${progress * 100}%` }} />
                      </div>
                    )}
                  </div>
                  <span className={`skill-queue-eta${item.finish_date ? "" : " skill-queue-paused"}`}>
                    {item.finish_date ? (
                      <>
                        {formatTimeRemaining(item.finish_date)} remaining
                        <span className="skill-queue-eta-date">ends {fmtShortDateTime(item.finish_date)}</span>
                      </>
                    ) : (
                      "Paused"
                    )}
                  </span>
                </div>
              );
            })}
          </div>
          {(() => {
            const last = skillQueue.items[skillQueue.items.length - 1];
            return (
              <div className="skill-queue-footer">
                <span>
                  Skills in queue: <strong>{skillQueue.items.length}</strong>
                </span>
                {last.finish_date ? (
                  <>
                    <span className="skill-queue-footer-sep">|</span>
                    <span>
                      Ends in: <strong>{formatTimeRemainingFull(last.finish_date)}</strong>
                    </span>
                    <span className="skill-queue-footer-sep">|</span>
                    <span>
                      Ends on: <strong>{formatEveDateTime(last.finish_date)}</strong>
                    </span>
                  </>
                ) : (
                  <>
                    <span className="skill-queue-footer-sep">|</span>
                    <span>Queue is paused</span>
                  </>
                )}
              </div>
            );
          })()}
          </>
        );

      case "skills": {
        const pills: { id: SkillFilter; label: string }[] = [
          { id: "all", label: "All Skills" },
          { id: "trained", label: "Trained Only" },
          { id: "untrained", label: "Untrained" },
          { id: "injected", label: "Injected" },
          { id: "1", label: "Level I" },
          { id: "2", label: "Level II" },
          { id: "3", label: "Level III" },
          { id: "4", label: "Level IV" },
          { id: "5", label: "Level V" },
        ];
        return (
          <>
            <div className="detail-panel-header">
              <p className="eyebrow">Skills{skills ? ` — ${fmtCount(skills.total_sp ?? 0)} Total SP` : ""}</p>
              <div className="detail-search">
                <Search size={13} strokeWidth={2} />
                <input
                  type="text"
                  placeholder="Search skills..."
                  value={skillQuery}
                  onChange={(e) => setSkillQuery(e.target.value)}
                />
              </div>
            </div>
            {!skills || !allSkills ? (
              <p className="detail-empty">
                Loading skills{!allSkills ? " — building the full skill list, first load only can take a few seconds" : ""}...
              </p>
            ) : skills.needs_reauth ? (
              reauthNotice("skill data")
            ) : (
              <>
                <div className="skill-filter-bar">
                  <div className="skill-filter-pills">
                    {pills.map((p) => (
                      <button
                        key={p.id}
                        type="button"
                        className={`skill-filter-pill${skillFilter === p.id ? " skill-filter-pill-active" : ""}`}
                        onClick={() => setSkillFilter(p.id)}
                      >
                        {p.label} <span className="skill-filter-count">{skillCounts[p.id]}</span>
                      </button>
                    ))}
                  </div>
                  <div className="skill-filter-actions">
                    <button type="button" className="skill-action-btn" onClick={() => setCollapsedSkillGroups(new Set())}>
                      Expand All
                    </button>
                    <button
                      type="button"
                      className="skill-action-btn"
                      onClick={() => setCollapsedSkillGroups(new Set(skillGroups.keys()))}
                    >
                      Collapse All
                    </button>
                    <button type="button" className="skill-action-btn" onClick={exportSkillsCsv}>
                      Export CSV
                    </button>
                  </div>
                </div>
                {visibleSkills.length === 0 ? (
                  <p className="detail-empty">No skills match the current filter.</p>
                ) : (
                  <div className="skill-groups">
                    {Array.from(skillGroups.entries()).map(([groupName, groupSkills]) => {
                      const collapsed = collapsedSkillGroups.has(groupName);
                      const trainedInGroup = groupSkills.filter((s) => s.isTrained).length;
                      return (
                        <div key={groupName} className="skill-group">
                          <button type="button" className="skill-group-header" onClick={() => toggleSkillGroup(groupName)}>
                            <span className={`skill-group-caret${collapsed ? "" : " skill-group-caret-open"}`}>▸</span>
                            <span className="skill-group-name">{groupName}</span>
                            <span className="skill-group-count">
                              {trainedInGroup}/{groupSkills.length} trained
                            </span>
                          </button>
                          {!collapsed && (
                            <div className="skill-list">
                              {groupSkills.map((skill) => (
                                <div key={skill.skill_id} className={`skill-row${skill.isTrained ? "" : " skill-row-untrained"}`}>
                                  <span className="skill-name">
                                    {skill.name} <span className="skill-rank">Rank {skill.rank}</span>
                                  </span>
                                  <SkillLevelPips level={skill.trained_level} />
                                  <span className="skill-sp">{skill.isTrained ? `${fmtCount(skill.skillpoints)} SP` : "—"}</span>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </>
            )}
          </>
        );
      }

      case "employment": {
        // Timeline reads left-to-right chronologically, so oldest-first is
        // the natural reversal of the API's newest-first ordering.
        const timeline = employment ? [...employment].reverse() : [];
        return !employment ? (
          <p className="detail-empty">Loading employment history...</p>
        ) : employment.length === 0 ? (
          <p className="detail-empty">No employment history.</p>
        ) : (
          <div className="employment-timeline-wrap">
            <div className="employment-timeline">
              <div className="employment-timeline-line" />
              {timeline.map((entry, index) => {
                const isCurrent = index === timeline.length - 1;
                const endLabel = isCurrent
                  ? "Present"
                  : new Date(timeline[index + 1].start_date).toLocaleDateString([], { timeZone: "UTC" });
                return (
                  <div key={`${entry.corporation_id}-${entry.start_date}`} className="employment-node">
                    <img
                      className="employment-node-logo"
                      src={`https://images.evetech.net/corporations/${entry.corporation_id}/logo?size=64`}
                      alt=""
                    />
                    <span className={`employment-node-dot${isCurrent ? " employment-node-dot-current" : ""}`} />
                    <span className="employment-node-corp">{entry.corporation_name}</span>
                    <span className="employment-node-dates">
                      {new Date(entry.start_date).toLocaleDateString([], { timeZone: "UTC" })} – {endLabel}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        );
      }

      case "clones":
        return !clones ? (
          <p className="detail-empty">Loading clones...</p>
        ) : clones.needs_reauth ? (
          reauthNotice("clone data")
        ) : (
          <div className="clones-list">
            <div className="clone-card">
              <div className="clone-card-header">
                <span className="clone-name">Active Clone</span>
                <span className="clone-location">{clones.home_location_name ?? "Unknown"}</span>
              </div>
              <div className="clone-implants">
                {clones.active_implants.length === 0 ? (
                  <span className="detail-empty">
                    No implants shown - this needs a separate permission. Use Reconnect above to grant it.
                  </span>
                ) : (
                  clones.active_implants.map((implant) => (
                    <div key={implant.type_id} className="clone-implant-card">
                      <span className="clone-implant-slot">{implant.bonus_text ?? `Slot ${implant.slot}`}</span>
                      <span className="clone-implant-name">{implant.name}</span>
                    </div>
                  ))
                )}
              </div>
            </div>
            {clones.jump_clones.length === 0 ? (
              <p className="detail-empty">No jump clones installed.</p>
            ) : (
              clones.jump_clones.map((jc) => (
                <div key={jc.jump_clone_id} className="clone-card">
                  <div className="clone-card-header">
                    <span className="clone-name">{jc.name || "Unnamed Clone"}</span>
                    <span className="clone-location">{jc.location_name}</span>
                  </div>
                  <div className="clone-implants">
                    {jc.implants.length === 0 ? (
                      <span className="detail-empty">No implants.</span>
                    ) : (
                      jc.implants.map((implant) => (
                        <div key={implant.type_id} className="clone-implant-card">
                          <span className="clone-implant-slot">{implant.bonus_text ?? `Slot ${implant.slot}`}</span>
                          <span className="clone-implant-name">{implant.name}</span>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        );

      case "standings":
        return !standings ? (
          <p className="detail-empty">Loading standings...</p>
        ) : standings.needs_reauth ? (
          reauthNotice("standings")
        ) : standings.entries.length === 0 ? (
          <p className="detail-empty">No standings recorded.</p>
        ) : (
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <SortableTh label="Name" sortKey="from_name" activeKey={sortedStandings.sortKey} dir={sortedStandings.sortDir} onSort={sortedStandings.sort} />
                  <SortableTh label="Type" sortKey="from_type" activeKey={sortedStandings.sortKey} dir={sortedStandings.sortDir} onSort={sortedStandings.sort} />
                  <th>Standing</th>
                  <SortableTh label="Value" sortKey="standing" activeKey={sortedStandings.sortKey} dir={sortedStandings.sortDir} onSort={sortedStandings.sort} numeric />
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {sortedStandings.rows.map((s, i) => (
                    <tr key={i}>
                      <td>{s.from_name}</td>
                      <td>{s.from_type}</td>
                      <td>
                        <StandingBar value={s.standing} />
                      </td>
                      <td className={`data-table-numeric ${standingClass(s.standing)}`}>{s.standing.toFixed(2)}</td>
                      <td className={standingClass(s.standing)}>{standingLabel(s.standing)}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        );

      case "contacts":
        return !contacts ? (
          <p className="detail-empty">Loading contacts...</p>
        ) : contacts.needs_reauth ? (
          reauthNotice("contacts")
        ) : contacts.entries.length === 0 ? (
          <p className="detail-empty">No contacts saved.</p>
        ) : (
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <SortableTh label="Name" sortKey="contact_name" activeKey={sortedContacts.sortKey} dir={sortedContacts.sortDir} onSort={sortedContacts.sort} />
                  <SortableTh label="Type" sortKey="contact_type" activeKey={sortedContacts.sortKey} dir={sortedContacts.sortDir} onSort={sortedContacts.sort} />
                  <th>Standing</th>
                  <SortableTh label="Value" sortKey="standing" activeKey={sortedContacts.sortKey} dir={sortedContacts.sortDir} onSort={sortedContacts.sort} numeric />
                  <th>Flags</th>
                </tr>
              </thead>
              <tbody>
                {sortedContacts.rows.map((c, i) => (
                    <tr key={i} className={`contact-row-${standingClass(c.standing).replace("standing-text-", "")}`}>
                      <td className={standingClass(c.standing)}>{c.contact_name}</td>
                      <td>{c.contact_type}</td>
                      <td>
                        <StandingBar value={c.standing} />
                      </td>
                      <td className={`data-table-numeric ${standingClass(c.standing)}`}>{c.standing.toFixed(1)}</td>
                      <td>
                        {c.is_watched && <span className="data-table-tag">Watched</span>}
                        {c.is_blocked && <span className="data-table-tag data-table-tag-danger">Blocked</span>}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        );

      case "medals":
        return !medals ? (
          <p className="detail-empty">Loading medals...</p>
        ) : medals.needs_reauth ? (
          reauthNotice("medals")
        ) : medals.entries.length === 0 ? (
          <p className="detail-empty">No medals awarded.</p>
        ) : (
          <div className="medal-list">
            {medals.entries.map((m, i) => (
              <div key={i} className="medal-row">
                <div className="medal-info">
                  <span className="medal-title">{m.title}</span>
                  <span className="medal-meta">
                    {m.corporation_name} · {new Date(m.date).toLocaleDateString([], { timeZone: "UTC" })}
                  </span>
                  <span className="medal-reason">{m.reason || m.description}</span>
                </div>
              </div>
            ))}
          </div>
        );

      case "lp":
        return !loyalty ? (
          <p className="detail-empty">Loading loyalty points...</p>
        ) : loyalty.needs_reauth ? (
          reauthNotice("loyalty points")
        ) : loyalty.entries.length === 0 ? (
          <p className="detail-empty">No loyalty points earned.</p>
        ) : (
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <SortableTh label="Corporation" sortKey="corporation_name" activeKey={sortedLoyalty.sortKey} dir={sortedLoyalty.sortDir} onSort={sortedLoyalty.sort} />
                  <SortableTh label="Loyalty Points" sortKey="loyalty_points" activeKey={sortedLoyalty.sortKey} dir={sortedLoyalty.sortDir} onSort={sortedLoyalty.sort} numeric />
                </tr>
              </thead>
              <tbody>
                {sortedLoyalty.rows.map((l, i) => (
                  <tr key={i}>
                    <td>{l.corporation_name}</td>
                    <td className="data-table-numeric">{fmtCount(l.loyalty_points)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );

      case "assets": {
        const cappedAssets = filteredAssets.slice(0, 1000);
        const assetGroups = new Map<string, typeof cappedAssets>();
        for (const a of cappedAssets) {
          const key = assetGroupBy === "region" ? a.region_name : assetGroupBy === "location" ? a.location_name : a.group_name;
          const arr = assetGroups.get(key);
          if (arr) arr.push(a);
          else assetGroups.set(key, [a]);
        }
        const sortedAssetGroups = Array.from(assetGroups.entries()).sort((a, b) => a[0].localeCompare(b[0]));
        const totalAssetValue = cappedAssets.reduce((sum, a) => sum + (assetPrices.get(a.type_id) ?? 0) * a.quantity, 0);
        return (
          <>
            <div className="detail-panel-header">
              <p className="eyebrow">
                Assets{assets ? ` (${fmtCount(assets.entries.length)})` : ""}
                {assetPrices.size > 0 && (
                  <span className="asset-total-value" title="EVE-wide average price x quantity - a rough guide, not a guaranteed sell price.">
                    · {formatIsk(totalAssetValue)}
                  </span>
                )}
              </p>
              {assetHistory && <AssetValueSparkline points={assetHistory} />}
              <div className="detail-search">
                <Search size={13} strokeWidth={2} />
                <input
                  type="text"
                  placeholder="Search assets..."
                  value={assetQuery}
                  onChange={(e) => setAssetQuery(e.target.value)}
                />
              </div>
            </div>
            {!assets ? (
              <p className="detail-empty">Loading assets...</p>
            ) : assets.needs_reauth ? (
              reauthNotice("assets")
            ) : filteredAssets.length === 0 ? (
              <p className="detail-empty">No assets match "{assetQuery}".</p>
            ) : (
              <>
                <div className="skill-filter-bar">
                  <div className="skill-filter-pills">
                    {(["region", "location", "group"] as const).map((mode) => (
                      <button
                        key={mode}
                        type="button"
                        className={`skill-filter-pill${assetGroupBy === mode ? " skill-filter-pill-active" : ""}`}
                        onClick={() => setAssetGroupBy(mode)}
                      >
                        {mode === "region" ? "Region" : mode === "location" ? "Location" : "Item Group"}
                      </button>
                    ))}
                  </div>
                  <div className="skill-filter-actions">
                    <button
                      type="button"
                      className="skill-action-btn"
                      onClick={() => setExpandedAssetGroups(new Set(sortedAssetGroups.map(([k]) => k)))}
                    >
                      Expand All
                    </button>
                    <button type="button" className="skill-action-btn" onClick={() => setExpandedAssetGroups(new Set())}>
                      Collapse All
                    </button>
                    <button type="button" className="skill-action-btn" onClick={exportAssetsCsv}>
                      Export CSV
                    </button>
                  </div>
                </div>
                <div className="skill-groups">
                  {sortedAssetGroups.map(([groupName, groupAssets]) => {
                    const collapsed = !expandedAssetGroups.has(groupName);
                    const totalQty = groupAssets.reduce((sum, a) => sum + a.quantity, 0);
                    const groupValue = groupAssets.reduce((sum, a) => sum + (assetPrices.get(a.type_id) ?? 0) * a.quantity, 0);
                    return (
                      <div key={groupName} className="skill-group">
                        <button type="button" className="skill-group-header" onClick={() => toggleAssetGroup(groupName)}>
                          <span className={`skill-group-caret${collapsed ? "" : " skill-group-caret-open"}`}>▸</span>
                          <span className="skill-group-name">{groupName}</span>
                          <span className="skill-group-count">
                            {fmtCount(groupAssets.length)} items · {fmtCount(totalQty)} qty
                            {groupValue > 0 ? ` · ${formatIsk(groupValue)}` : ""}
                          </span>
                        </button>
                        {!collapsed && (
                          <div className="data-table-wrap">
                            <table className="data-table">
                              <thead>
                                <tr>
                                  <th>Item</th>
                                  <th className="data-table-numeric">Qty</th>
                                  <th className="data-table-numeric">Value</th>
                                  <th>Location</th>
                                  <th>Flag</th>
                                </tr>
                              </thead>
                              <tbody>
                                {groupAssets.map((a) => (
                                  <tr key={a.item_id}>
                                    <td>
                                      <span className="asset-item-cell">
                                        <img className="asset-item-icon" src={typeIconUrl(a.type_id, 32, a.type_name)} alt="" />
                                        {a.type_name}
                                      </span>
                                    </td>
                                    <td className="data-table-numeric">{fmtCount(a.quantity)}</td>
                                    <td className="data-table-numeric">
                                      {assetPrices.has(a.type_id) ? formatIsk((assetPrices.get(a.type_id) ?? 0) * a.quantity) : "—"}
                                      {(() => {
                                        const check = abyssalChecks[a.item_id];
                                        if (check === "checking") {
                                          return <span className="asset-abyssal-status">Checking...</span>;
                                        }
                                        if (check === "none") {
                                          return <span className="asset-abyssal-status">Not mutated</span>;
                                        }
                                        if (check) {
                                          return (
                                            <span
                                              className="asset-abyssal-status asset-abyssal-value"
                                              title="Estimate via MutaMarket (community-run, machine-learning model - not a guaranteed sell price)"
                                            >
                                              Abyssal: {check.estimated_value != null ? formatIsk(check.estimated_value) : "no estimate"}
                                            </span>
                                          );
                                        }
                                        return (
                                          <button
                                            type="button"
                                            className="asset-abyssal-check-btn"
                                            onClick={() => handleCheckAbyssal(a.item_id, a.type_id)}
                                            title="Check if this is a mutated (abyssal) item and estimate its real value via MutaMarket"
                                          >
                                            <Sparkles size={11} strokeWidth={2} />
                                          </button>
                                        );
                                      })()}
                                    </td>
                                    <td>{a.location_name}</td>
                                    <td>{a.location_flag}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </>
            )}
            {filteredAssets.length > 1000 && (
              <p className="detail-empty">
                Showing the first 1,000 of {fmtCount(filteredAssets.length)} matches - narrow your search to see more.
              </p>
            )}
          </>
        );
      }

      case "marketOrders":
        return !marketOrders ? (
          <p className="detail-empty">Loading market orders...</p>
        ) : marketOrders.needs_reauth ? (
          reauthNotice("market orders")
        ) : marketOrders.entries.length === 0 ? (
          <p className="detail-empty">No market orders found.</p>
        ) : (
          <>
            <TableFilterBar
              searchQuery={marketOrdersText.query}
              onSearchChange={marketOrdersText.setQuery}
              searchPlaceholder="Search item or location..."
              selects={[
                { label: "Sides", value: marketOrdersSide.value, options: marketOrdersSide.options, onChange: marketOrdersSide.setValue },
                { label: "Statuses", value: marketOrdersStatus.value, options: marketOrdersStatus.options, onChange: marketOrdersStatus.setValue },
              ]}
              resultCount={`${fmtCount(sortedMarketOrders.rows.length)} of ${fmtCount(marketOrders.entries.length)}`}
            />
            {sortedMarketOrders.rows.length === 0 ? (
              <p className="detail-empty">No market orders match the current filters.</p>
            ) : (
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <SortableTh label="Item" sortKey="type_name" activeKey={sortedMarketOrders.sortKey} dir={sortedMarketOrders.sortDir} onSort={sortedMarketOrders.sort} />
                  <SortableTh label="Side" sortKey="side" activeKey={sortedMarketOrders.sortKey} dir={sortedMarketOrders.sortDir} onSort={sortedMarketOrders.sort} />
                  <SortableTh label="Status" sortKey="status" activeKey={sortedMarketOrders.sortKey} dir={sortedMarketOrders.sortDir} onSort={sortedMarketOrders.sort} />
                  <SortableTh label="Price" sortKey="price" activeKey={sortedMarketOrders.sortKey} dir={sortedMarketOrders.sortDir} onSort={sortedMarketOrders.sort} numeric />
                  <SortableTh label="Remaining" sortKey="volume_remain" activeKey={sortedMarketOrders.sortKey} dir={sortedMarketOrders.sortDir} onSort={sortedMarketOrders.sort} numeric />
                  <SortableTh label="Location" sortKey="location_name" activeKey={sortedMarketOrders.sortKey} dir={sortedMarketOrders.sortDir} onSort={sortedMarketOrders.sort} />
                  <SortableTh label="Issued" sortKey="issued" activeKey={sortedMarketOrders.sortKey} dir={sortedMarketOrders.sortDir} onSort={sortedMarketOrders.sort} />
                </tr>
              </thead>
              <tbody>
                {sortedMarketOrders.rows.map((o) => (
                  <tr key={o.order_id}>
                    <td>
                      <span className="asset-item-cell">
                        <img className="asset-item-icon" src={typeIconUrl(o.type_id, 32, o.type_name)} alt="" />
                        {o.type_name}
                      </span>
                    </td>
                    <td>
                      <span className={`data-table-tag ${o.is_buy_order ? "" : "data-table-tag-danger"}`}>
                        {o.is_buy_order ? "Buy" : "Sell"}
                      </span>
                    </td>
                    <td>
                      <span className={`data-table-tag${o.status === "Active" ? "" : " data-table-tag-neutral"}`}>{o.status}</span>
                    </td>
                    <td className="data-table-numeric">{formatIsk(o.price)}</td>
                    <td className="data-table-numeric">
                      {fmtCount(o.volume_remain)} / {fmtCount(o.volume_total)}
                    </td>
                    <td>{o.location_name}</td>
                    <td>{fmtDate(o.issued)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
            )}
          </>
        );

      case "contracts": {
        const canExpand = (type: string) => type === "item_exchange" || type === "auction";
        const toggleContract = (contractId: number, type: string) => {
          if (!canExpand(type)) return;
          if (expandedContractId === contractId) {
            setExpandedContractId(null);
            return;
          }
          setExpandedContractId(contractId);
          if (!contractItems[contractId]) {
            getContractItems(character.id, contractId)
              .then((items) => setContractItems((prev) => ({ ...prev, [contractId]: items })))
              .catch((err) => reportError(`Failed to load contract items: ${String(err)}`));
          }
        };
        return !contracts ? (
          <p className="detail-empty">Loading contracts...</p>
        ) : contracts.needs_reauth ? (
          reauthNotice("contracts")
        ) : contracts.entries.length === 0 ? (
          <p className="detail-empty">No contracts found.</p>
        ) : (
          <>
            <TableFilterBar
              searchQuery={contractsText.query}
              onSearchChange={contractsText.setQuery}
              searchPlaceholder="Search title, issuer, or assignee..."
              selects={[
                { label: "Types", value: contractsType.value, options: contractsType.options, onChange: contractsType.setValue },
                { label: "Statuses", value: contractsStatus.value, options: contractsStatus.options, onChange: contractsStatus.setValue },
              ]}
              resultCount={`${fmtCount(sortedContracts.rows.length)} of ${fmtCount(contracts.entries.length)}`}
            />
            {sortedContracts.rows.length === 0 ? (
              <p className="detail-empty">No contracts match the current filters.</p>
            ) : (
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <SortableTh label="Contract" sortKey="title" activeKey={sortedContracts.sortKey} dir={sortedContracts.sortDir} onSort={sortedContracts.sort} />
                  <SortableTh label="Type" sortKey="contract_type" activeKey={sortedContracts.sortKey} dir={sortedContracts.sortDir} onSort={sortedContracts.sort} />
                  <SortableTh label="Status" sortKey="status" activeKey={sortedContracts.sortKey} dir={sortedContracts.sortDir} onSort={sortedContracts.sort} />
                  <SortableTh label="Issuer" sortKey="issuer_name" activeKey={sortedContracts.sortKey} dir={sortedContracts.sortDir} onSort={sortedContracts.sort} />
                  <SortableTh label="Assignee" sortKey="assignee_name" activeKey={sortedContracts.sortKey} dir={sortedContracts.sortDir} onSort={sortedContracts.sort} />
                  <SortableTh label="Price" sortKey="price" activeKey={sortedContracts.sortKey} dir={sortedContracts.sortDir} onSort={sortedContracts.sort} numeric />
                  <SortableTh label="Issued" sortKey="date_issued" activeKey={sortedContracts.sortKey} dir={sortedContracts.sortDir} onSort={sortedContracts.sort} />
                  <SortableTh label="Expires" sortKey="date_expired" activeKey={sortedContracts.sortKey} dir={sortedContracts.sortDir} onSort={sortedContracts.sort} />
                </tr>
              </thead>
              <tbody>
                {sortedContracts.rows.map((c) => (
                  <Fragment key={c.contract_id}>
                    <tr
                      className={canExpand(c.contract_type) ? "contract-row-expandable" : undefined}
                      onClick={() => toggleContract(c.contract_id, c.contract_type)}
                    >
                      <td>{c.title || "—"}</td>
                      <td>{c.contract_type}</td>
                      <td>
                        <span className={contractStatusClass(c.status)}>{c.status.replace(/_/g, " ")}</span>
                      </td>
                      <td>{c.issuer_name}</td>
                      <td>{c.assignee_name ?? "—"}</td>
                      <td className="data-table-numeric">{formatIsk(c.price ?? c.reward ?? 0)}</td>
                      <td>{fmtDate(c.date_issued)}</td>
                      <td>{fmtDate(c.date_expired)}</td>
                    </tr>
                    {expandedContractId === c.contract_id && (
                      <tr className="contract-items-row">
                        <td colSpan={8}>
                          {!contractItems[c.contract_id] ? (
                            <p className="detail-empty">Loading items...</p>
                          ) : contractItems[c.contract_id].length === 0 ? (
                            <p className="detail-empty">No items listed for this contract.</p>
                          ) : (
                            <>
                              <ul className="contract-items-list">
                                {contractItems[c.contract_id].map((item, i) => (
                                  <li key={i}>
                                    <img className="asset-item-icon" src={typeIconUrl(item.type_id, 32, item.type_name)} alt="" />
                                    {item.type_name}
                                    {item.quantity > 1 ? ` x${item.quantity.toLocaleString()}` : ""}
                                    {!item.is_included ? " (requested)" : ""}
                                  </li>
                                ))}
                              </ul>
                              {c.contract_type === "item_exchange" &&
                                assetPrices.size > 0 &&
                                (() => {
                                  const itemsValue = contractItems[c.contract_id]
                                    .filter((item) => item.is_included)
                                    .reduce((sum, item) => sum + (assetPrices.get(item.type_id) ?? 0) * item.quantity, 0);
                                  const price = c.price ?? 0;
                                  const delta = itemsValue - price;
                                  return (
                                    <p
                                      className="contract-value-delta"
                                      title="Included items priced at EVE-wide average - a rough guide, not a guaranteed sell price. Requested items (what you'd hand over) aren't counted."
                                    >
                                      Included items worth ~{formatIsk(itemsValue)} vs. asking {formatIsk(price)} -{" "}
                                      <span className={delta >= 0 ? "wallet-amount-positive" : "wallet-amount-negative"}>
                                        {delta >= 0 ? "+" : ""}
                                        {formatIsk(delta)} {delta >= 0 ? "under market" : "over market"}
                                      </span>
                                    </p>
                                  );
                                })()}
                            </>
                          )}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
            )}
          </>
        );
      }

      case "insurance":
        return <InsuranceCalculator />;

      case "industryJobs":
        return !industryJobs ? (
          <p className="detail-empty">Loading industry jobs...</p>
        ) : industryJobs.needs_reauth ? (
          reauthNotice("industry jobs")
        ) : industryJobs.entries.length === 0 ? (
          <p className="detail-empty">No industry jobs found.</p>
        ) : (
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <SortableTh label="Activity" sortKey="activity_name" activeKey={sortedIndustryJobs.sortKey} dir={sortedIndustryJobs.sortDir} onSort={sortedIndustryJobs.sort} />
                  <SortableTh label="Blueprint" sortKey="blueprint_type_name" activeKey={sortedIndustryJobs.sortKey} dir={sortedIndustryJobs.sortDir} onSort={sortedIndustryJobs.sort} />
                  <SortableTh label="Product" sortKey="product_type_name" activeKey={sortedIndustryJobs.sortKey} dir={sortedIndustryJobs.sortDir} onSort={sortedIndustryJobs.sort} />
                  <SortableTh label="Status" sortKey="status" activeKey={sortedIndustryJobs.sortKey} dir={sortedIndustryJobs.sortDir} onSort={sortedIndustryJobs.sort} />
                  <SortableTh label="Runs" sortKey="runs" activeKey={sortedIndustryJobs.sortKey} dir={sortedIndustryJobs.sortDir} onSort={sortedIndustryJobs.sort} numeric />
                  <SortableTh label="Station" sortKey="station_name" activeKey={sortedIndustryJobs.sortKey} dir={sortedIndustryJobs.sortDir} onSort={sortedIndustryJobs.sort} />
                  <SortableTh label="Ends" sortKey="end_date" activeKey={sortedIndustryJobs.sortKey} dir={sortedIndustryJobs.sortDir} onSort={sortedIndustryJobs.sort} />
                </tr>
              </thead>
              <tbody>
                {sortedIndustryJobs.rows.map((j) => (
                  <tr key={j.job_id}>
                    <td>{j.activity_name}</td>
                    <td>{j.blueprint_type_name}</td>
                    <td>{j.product_type_name ?? "—"}</td>
                    <td>{j.status}</td>
                    <td className="data-table-numeric">{fmtCount(j.runs)}</td>
                    <td>{j.station_name}</td>
                    <td>{fmtDate(j.end_date)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );

      case "wallet":
        return (
          <>
            <div className="wallet-balance-row">
              <div className="wallet-balance-card">
                <p className="eyebrow">ISK Balance</p>
                <h2>{overview?.isk_balance != null ? formatIsk(overview.isk_balance) : "—"}</h2>
              </div>
              {walletJournal && walletJournal.entries.length > 0 && (
                <button type="button" className="skill-action-btn" onClick={exportWalletCsv}>
                  Export CSV
                </button>
              )}
            </div>
            {!walletJournal ? (
              <p className="detail-empty">Loading wallet journal...</p>
            ) : walletJournal.needs_reauth ? (
              reauthNotice("the wallet journal")
            ) : walletJournal.entries.length === 0 ? (
              <p className="detail-empty">No wallet activity found.</p>
            ) : (
              <>
                <TableFilterBar
                  searchQuery={walletJournalText.query}
                  onSearchChange={walletJournalText.setQuery}
                  searchPlaceholder="Search description or party..."
                  selects={[{ label: "Types", value: walletJournalType.value, options: walletJournalType.options, onChange: walletJournalType.setValue }]}
                  resultCount={`${fmtCount(sortedWalletJournal.rows.length)} of ${fmtCount(walletJournal.entries.length)}`}
                />
                {sortedWalletJournal.rows.length === 0 ? (
                  <p className="detail-empty">No journal entries match the current filters.</p>
                ) : (
              <div className="data-table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <SortableTh label="Date" sortKey="date" activeKey={sortedWalletJournal.sortKey} dir={sortedWalletJournal.sortDir} onSort={sortedWalletJournal.sort} />
                      <SortableTh label="Type" sortKey="ref_type" activeKey={sortedWalletJournal.sortKey} dir={sortedWalletJournal.sortDir} onSort={sortedWalletJournal.sort} />
                      <SortableTh label="Description" sortKey="description" activeKey={sortedWalletJournal.sortKey} dir={sortedWalletJournal.sortDir} onSort={sortedWalletJournal.sort} />
                      <SortableTh label="Amount" sortKey="amount" activeKey={sortedWalletJournal.sortKey} dir={sortedWalletJournal.sortDir} onSort={sortedWalletJournal.sort} numeric />
                      <SortableTh label="Balance" sortKey="balance" activeKey={sortedWalletJournal.sortKey} dir={sortedWalletJournal.sortDir} onSort={sortedWalletJournal.sort} numeric />
                    </tr>
                  </thead>
                  <tbody>
                    {sortedWalletJournal.rows.map((e) => (
                      <tr key={e.id}>
                        <td>{fmtDate(e.date)}</td>
                        <td>{e.ref_type.replace(/_/g, " ")}</td>
                        <td>
                          {e.description}
                          {e.first_party_name && e.second_party_name
                            ? ` (${e.first_party_name} → ${e.second_party_name})`
                            : ""}
                        </td>
                        <td className={`data-table-numeric ${e.amount >= 0 ? "wallet-amount-positive" : "wallet-amount-negative"}`}>
                          {e.amount >= 0 ? "+" : ""}
                          {formatIsk(e.amount)}
                        </td>
                        <td className="data-table-numeric">{e.balance != null ? formatIsk(e.balance) : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
                )}
              </>
            )}
            {walletJournal && walletJournal.entries.length > 1000 && (
              <p className="detail-empty">Showing the most recent 1,000 of {fmtCount(walletJournal.entries.length)} entries.</p>
            )}
          </>
        );

      case "transactions":
        return !transactions ? (
          <p className="detail-empty">Loading transactions...</p>
        ) : transactions.needs_reauth ? (
          reauthNotice("transactions")
        ) : transactions.entries.length === 0 ? (
          <p className="detail-empty">No recent transactions.</p>
        ) : (
          <>
            <div className="detail-panel-header">
              <p className="eyebrow">Transactions ({fmtCount(transactions.entries.length)})</p>
              <button type="button" className="skill-action-btn" onClick={exportTransactionsCsv}>
                Export CSV
              </button>
            </div>
            <TableFilterBar
              searchQuery={transactionsText.query}
              onSearchChange={transactionsText.setQuery}
              searchPlaceholder="Search item, location, or client..."
              selects={[{ label: "Sides", value: transactionsSide.value, options: transactionsSide.options, onChange: transactionsSide.setValue }]}
              resultCount={`${fmtCount(sortedTransactions.rows.length)} of ${fmtCount(transactions.entries.length)}`}
            />
            {sortedTransactions.rows.length === 0 ? (
              <p className="detail-empty">No transactions match the current filters.</p>
            ) : (
            <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <SortableTh label="Date" sortKey="date" activeKey={sortedTransactions.sortKey} dir={sortedTransactions.sortDir} onSort={sortedTransactions.sort} />
                  <SortableTh label="Side" sortKey="side" activeKey={sortedTransactions.sortKey} dir={sortedTransactions.sortDir} onSort={sortedTransactions.sort} />
                  <SortableTh label="Item" sortKey="type_name" activeKey={sortedTransactions.sortKey} dir={sortedTransactions.sortDir} onSort={sortedTransactions.sort} />
                  <SortableTh label="Qty" sortKey="quantity" activeKey={sortedTransactions.sortKey} dir={sortedTransactions.sortDir} onSort={sortedTransactions.sort} numeric />
                  <SortableTh label="Unit Price" sortKey="unit_price" activeKey={sortedTransactions.sortKey} dir={sortedTransactions.sortDir} onSort={sortedTransactions.sort} numeric />
                  <SortableTh label="Total" sortKey="total" activeKey={sortedTransactions.sortKey} dir={sortedTransactions.sortDir} onSort={sortedTransactions.sort} numeric />
                  <SortableTh label="Location" sortKey="location_name" activeKey={sortedTransactions.sortKey} dir={sortedTransactions.sortDir} onSort={sortedTransactions.sort} />
                  <SortableTh label="With" sortKey="client_name" activeKey={sortedTransactions.sortKey} dir={sortedTransactions.sortDir} onSort={sortedTransactions.sort} />
                </tr>
              </thead>
              <tbody>
                {sortedTransactions.rows.map((t) => (
                  <tr key={t.transaction_id}>
                    <td>{fmtDate(t.date)}</td>
                    <td>
                      <span className={`data-table-tag ${t.is_buy ? "" : "data-table-tag-danger"}`}>
                        {t.is_buy ? "Buy" : "Sell"}
                      </span>
                    </td>
                    <td>
                      <span className="asset-item-cell">
                        <img className="asset-item-icon" src={typeIconUrl(t.type_id, 32, t.type_name)} alt="" />
                        {t.type_name}
                      </span>
                    </td>
                    <td className="data-table-numeric">{fmtCount(t.quantity)}</td>
                    <td className="data-table-numeric">{formatIsk(t.unit_price)}</td>
                    <td className={`data-table-numeric ${t.is_buy ? "wallet-amount-negative" : "wallet-amount-positive"}`}>
                      {t.is_buy ? "-" : "+"}
                      {formatIsk(t.quantity * t.unit_price)}
                    </td>
                    <td>{t.location_name}</td>
                    <td>{t.client_name}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
            )}
          </>
        );

      case "mail": {
        if (selectedMailId != null) {
          return (
            <div className="mail-detail">
              <button type="button" className="mail-back-btn" onClick={() => setSelectedMailId(null)}>
                <ArrowLeft size={13} strokeWidth={2} /> Back to list
              </button>
              {mailDetailLoading || !mailDetail ? (
                <p className="detail-empty">Loading message...</p>
              ) : mailDetail.needs_reauth ? (
                reauthNotice("this message")
              ) : (
                <>
                  <h3 className="mail-detail-subject">{mailDetail.subject}</h3>
                  <div className="mail-detail-meta">
                    <span>
                      <strong>From:</strong> {mailDetail.from_name}
                    </span>
                    <span>
                      <strong>To:</strong> {mailDetail.recipient_names.join(", ") || "—"}
                    </span>
                    <span>{fmtDate(mailDetail.timestamp)}</span>
                  </div>
                  <div className="mail-detail-body">{mailDetail.body_text || "(no body)"}</div>
                </>
              )}
            </div>
          );
        }
        return !mail ? (
          <p className="detail-empty">Loading mail...</p>
        ) : mail.needs_reauth ? (
          reauthNotice("mail")
        ) : mail.entries.length === 0 ? (
          <p className="detail-empty">No mail found.</p>
        ) : (
          <div className="mail-list">
            {mail.entries.map((m) => (
              <button
                key={m.mail_id}
                type="button"
                className={`mail-row mail-row-clickable${m.is_read ? "" : " mail-row-unread"}`}
                onClick={() => openMail(m.mail_id)}
              >
                <div className="mail-info">
                  <span className="mail-subject">{m.subject}</span>
                  <span className="mail-meta">
                    {m.from_name} · {fmtDate(m.timestamp)}
                  </span>
                </div>
              </button>
            ))}
          </div>
        );
      }

      case "notifications":
        return !notifications ? (
          <p className="detail-empty">Loading notifications...</p>
        ) : notifications.needs_reauth ? (
          reauthNotice("notifications")
        ) : notifications.entries.length === 0 ? (
          <p className="detail-empty">No notifications.</p>
        ) : (
          <div className="mail-list">
            {notifications.entries.map((n) => (
              <div key={n.notification_id} className={`mail-row${n.is_read ? "" : " mail-row-unread"}`}>
                <div className="mail-info">
                  <span className="mail-subject">{n.notification_type}</span>
                  <span className="mail-meta">
                    {n.sender_name} · {fmtDate(n.timestamp)}
                  </span>
                </div>
              </div>
            ))}
          </div>
        );

      case "killLog":
        return (
          <>
            <div className="kills-tabs">
              <button
                type="button"
                className={`kills-tab ${killLogTab === "kills" ? "kills-tab-active" : ""}`}
                onClick={() => handleKillLogTab("kills")}
              >
                Kills
              </button>
              <button
                type="button"
                className={`kills-tab ${killLogTab === "losses" ? "kills-tab-active" : ""}`}
                onClick={() => handleKillLogTab("losses")}
              >
                Losses
              </button>
            </div>
            {activeKillLogList === null ? (
              <p className="detail-empty">Loading {killLogTab}...</p>
            ) : activeKillLogList.length === 0 ? (
              <p className="detail-empty">No {killLogTab} recorded.</p>
            ) : (
              <KillFeedTable
                kills={activeKillLogList}
                onSelectKill={onSelectKill}
                onSelectCharacter={onSelectCharacter}
                onSelectSystem={onSelectSystem}
                onSelectCorporation={onSelectCorporation}
                onSelectAlliance={onSelectAlliance}
              />
            )}
          </>
        );

      case "planetary":
        return !planets ? (
          <p className="detail-empty">Loading planetary colonies...</p>
        ) : planets.needs_reauth ? (
          reauthNotice("planetary data")
        ) : planets.entries.length === 0 ? (
          <p className="detail-empty">No planetary colonies.</p>
        ) : (
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <SortableTh label="Planet" sortKey="planet_name" activeKey={sortedPlanets.sortKey} dir={sortedPlanets.sortDir} onSort={sortedPlanets.sort} />
                  <SortableTh label="System" sortKey="solar_system_name" activeKey={sortedPlanets.sortKey} dir={sortedPlanets.sortDir} onSort={sortedPlanets.sort} />
                  <SortableTh label="Type" sortKey="planet_type" activeKey={sortedPlanets.sortKey} dir={sortedPlanets.sortDir} onSort={sortedPlanets.sort} />
                  <SortableTh label="Level" sortKey="upgrade_level" activeKey={sortedPlanets.sortKey} dir={sortedPlanets.sortDir} onSort={sortedPlanets.sort} numeric />
                  <SortableTh label="Pins" sortKey="num_pins" activeKey={sortedPlanets.sortKey} dir={sortedPlanets.sortDir} onSort={sortedPlanets.sort} numeric />
                  <SortableTh label="Last Updated" sortKey="last_update" activeKey={sortedPlanets.sortKey} dir={sortedPlanets.sortDir} onSort={sortedPlanets.sort} />
                </tr>
              </thead>
              <tbody>
                {sortedPlanets.rows.map((p, i) => (
                  <tr key={i}>
                    <td>{p.planet_name}</td>
                    <td>{p.solar_system_name}</td>
                    <td>{p.planet_type}</td>
                    <td className="data-table-numeric">{p.upgrade_level}</td>
                    <td className="data-table-numeric">{p.num_pins}</td>
                    <td>{fmtDate(p.last_update)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );

      case "research":
        return !research ? (
          <p className="detail-empty">Loading research points...</p>
        ) : research.needs_reauth ? (
          reauthNotice("research points")
        ) : research.entries.length === 0 ? (
          <p className="detail-empty">No R&D agents assigned.</p>
        ) : (
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <SortableTh label="Agent" sortKey="agent_name" activeKey={sortedResearch.sortKey} dir={sortedResearch.sortDir} onSort={sortedResearch.sort} />
                  <SortableTh label="Field" sortKey="skill_name" activeKey={sortedResearch.sortKey} dir={sortedResearch.sortDir} onSort={sortedResearch.sort} />
                  <SortableTh label="Points/Day" sortKey="points_per_day" activeKey={sortedResearch.sortKey} dir={sortedResearch.sortDir} onSort={sortedResearch.sort} numeric />
                  <SortableTh label="Current Points" sortKey="current_points" activeKey={sortedResearch.sortKey} dir={sortedResearch.sortDir} onSort={sortedResearch.sort} numeric />
                  <SortableTh label="Started" sortKey="started_at" activeKey={sortedResearch.sortKey} dir={sortedResearch.sortDir} onSort={sortedResearch.sort} />
                </tr>
              </thead>
              <tbody>
                {sortedResearch.rows.map((r) => (
                  <tr key={r.agent_id}>
                    <td>{r.agent_name}</td>
                    <td>{r.skill_name}</td>
                    <td className="data-table-numeric">{r.points_per_day.toFixed(1)}</td>
                    <td className="data-table-numeric">{r.current_points.toFixed(1)}</td>
                    <td>{fmtDate(r.started_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );

      case "factionWarfare":
        return !fwStats ? (
          <p className="detail-empty">Loading faction warfare stats...</p>
        ) : fwStats.needs_reauth ? (
          reauthNotice("faction warfare stats")
        ) : !fwStats.enlisted ? (
          <p className="detail-empty">Not enlisted in Faction Warfare.</p>
        ) : (
          <>
            <div className="detail-panel-header">
              <p className="eyebrow">
                Fighting for {fwStats.faction_name ?? "Unknown Faction"} · Enlisted {fmtDate(fwStats.enlisted_on)}
              </p>
            </div>
            <div className="wallet-balance-row">
              <div className="wallet-balance-card">
                <p className="eyebrow">Current Rank</p>
                <h2>{fwStats.current_rank ?? "—"}</h2>
              </div>
              <div className="wallet-balance-card">
                <p className="eyebrow">Highest Rank</p>
                <h2>{fwStats.highest_rank ?? "—"}</h2>
              </div>
            </div>
            <div className="data-table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th></th>
                    <th className="data-table-numeric">Yesterday</th>
                    <th className="data-table-numeric">Last Week</th>
                    <th className="data-table-numeric">Total</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>Kills</td>
                    <td className="data-table-numeric">{fmtCount(fwStats.kills.yesterday)}</td>
                    <td className="data-table-numeric">{fmtCount(fwStats.kills.last_week)}</td>
                    <td className="data-table-numeric">{fmtCount(fwStats.kills.total)}</td>
                  </tr>
                  <tr>
                    <td>Victory Points</td>
                    <td className="data-table-numeric">{fmtCount(fwStats.victory_points.yesterday)}</td>
                    <td className="data-table-numeric">{fmtCount(fwStats.victory_points.last_week)}</td>
                    <td className="data-table-numeric">{fmtCount(fwStats.victory_points.total)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </>
        );

      default:
        return <p className="detail-empty">{TABS.find((t) => t.id === tab)?.label} isn't wired up yet.</p>;
    }
  }

  return (
    <main className="main main-character">
      <div className="character-page">
        <aside className="character-rail">
          {characters.map((c) => (
            <button
              key={c.id}
              type="button"
              className={`character-rail-icon${c.id === character.id ? " character-rail-icon-active" : ""}`}
              onClick={() => onSwitchCharacter(c.id)}
              title={c.name}
            >
              <img src={c.portrait_url} alt={c.name} />
            </button>
          ))}
        </aside>

        <div className="character-content">
          <button type="button" className="detail-back" onClick={onBack}>
            <ArrowLeft size={14} strokeWidth={2} />
            Back to Operations Overview
          </button>

          <div className="detail-header">
            <div className="detail-portrait-wrap">
              <img className="detail-portrait" src={character.portrait_url} alt="" />
              <CloneStateBadge characterId={character.id} autoDetected={overview?.clone_state ?? null} />
            </div>
            <div className="detail-identity">
              <h2>{character.name}</h2>
              {(overview?.gender || overview?.race_name || overview?.bloodline_name) && (
                <span className="detail-bio">
                  {[overview?.gender, overview?.race_name, overview?.bloodline_name].filter(Boolean).join(" · ")}
                </span>
              )}
              <span className="detail-corp">
                {overview?.corporation_name ?? "—"}
                {overview?.alliance_name ? ` • ${overview.alliance_name}` : ""}
              </span>
              <div className="detail-stats-row">
                <span className="detail-stats-isk">{overview?.isk_balance != null ? formatIsk(overview.isk_balance) : "—"}</span>
                <span className="detail-stats-sep">//</span>
                <span className="detail-stats-sp">{overview?.total_sp != null ? formatSp(overview.total_sp) : "—"}</span>
                <span className="detail-stats-sep">//</span>
                <span>{[overview?.system_name, overview?.ship_type_name].filter(Boolean).join(" · ") || "—"}</span>
              </div>
              {overview?.security_status != null && (
                <span className="detail-security">
                  Security Status:{" "}
                  <span className={overview.security_status >= 0 ? "standing-text-positive" : "standing-text-negative"}>
                    {overview.security_status.toFixed(2)}
                  </span>
                </span>
              )}
              {(overview?.region_name || overview?.constellation_name || overview?.system_name) && (
                <span className="detail-location-path">
                  Located in:{" "}
                  {[overview?.region_name, overview?.constellation_name, overview?.system_name].filter(Boolean).join(" > ")}
                </span>
              )}
              {overview?.docked_at_name && <span className="detail-location-path">Docked at: {overview.docked_at_name}</span>}
              {overview?.training_skill_name && (
                <span className="detail-training">
                  Training: {overview.training_skill_name}
                  {overview.training_finish_date ? ` (${formatTimeRemaining(overview.training_finish_date)})` : ""}
                  {formatQueueSummary(overview.queue_length, overview.queue_ends_at) && (
                    <span className="detail-training-queue"> · {formatQueueSummary(overview.queue_length, overview.queue_ends_at)}</span>
                  )}
                </span>
              )}
              {attributes && !attributes.needs_reauth && (
                <div className="attribute-row">
                  {(
                    [
                      ["Int", attributes.intelligence],
                      ["Per", attributes.perception],
                      ["Cha", attributes.charisma],
                      ["Wil", attributes.willpower],
                      ["Mem", attributes.memory],
                    ] as const
                  ).map(([label, value]) => (
                    <span
                      key={label}
                      className="attribute-pill"
                      title={`${value} = ${BASE_ATTRIBUTE_VALUE} base + ${value - BASE_ATTRIBUTE_VALUE} remap`}
                    >
                      {label} <strong>{value}</strong>
                    </span>
                  ))}
                  <span className="attribute-remap-note">{remapAvailabilityText(attributes)}</span>
                </div>
              )}
            </div>
            <button
              type="button"
              className="reconnect-button"
              onClick={handleReconnect}
              disabled={reconnecting}
              title="Opens EVE SSO in your browser - sign in as this character again to grant any permissions added since it last logged in"
            >
              <RefreshCw size={13} strokeWidth={2} className={reconnecting ? "kills-sync-spinning" : ""} />
              {reconnecting ? "Reconnecting..." : "Reconnect"}
            </button>
          </div>

          <div className="character-tabs">
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                className={`character-tab${tab === t.id ? " character-tab-active" : ""}`}
                onClick={() => setTab(t.id)}
              >
                {t.label}
              </button>
            ))}
          </div>

          <div className="detail-panel character-tab-panel">{renderTabContent()}</div>
        </div>
      </div>
    </main>
  );
}

export default CharacterDetail;
