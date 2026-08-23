import { useEffect, useMemo, useState } from "react";
import {
  getCharacterOverview,
  getCharacterMarketOrders,
  getCharacterTransactions,
  getCharacterWalletJournal,
  type CharacterOverview,
  type CharacterMarketOrders,
  type CharacterTransactions,
  type CharacterWalletJournal,
  type SessionCharacter,
  type TransactionEntry,
} from "../lib/eve";
import { getPublicContracts, type PublicContractEntry } from "../lib/market";
import { getMapData, type MapData } from "../lib/map";
import { formatIsk, typeIconUrl } from "../lib/format";
import { useDefaultTradeHub } from "../hooks/useDefaultTradeHub";
import CharacterSelectorStrip from "./CharacterSelectorStrip";
import MarketBrowser, { type MarketItemRef } from "./MarketBrowser";
import ItemDatabase from "./ItemDatabase";
import Appraisal from "./Appraisal";
import Screener from "./Screener";
import LpStorePanel from "./LpStorePanel";
import InsuranceCalculator from "./InsuranceCalculator";
import MineralTicker from "./MineralTicker";
import HelpBadge from "./HelpBadge";
import { HELP_CONTENT } from "../lib/helpContent";
import { useSortableRows } from "../hooks/useSortableRows";
import { SortableTh } from "./SortableTh";

type WalletMarketTab = "browser" | "itemdb" | "appraisal" | "screener" | "lpstore" | "contracts" | "insurance" | "wallet" | "transactions" | "orders";

const TABS: { id: WalletMarketTab; label: string }[] = [
  { id: "browser", label: "Market Browser" },
  { id: "itemdb", label: "Item Database" },
  { id: "appraisal", label: "Appraisal" },
  { id: "screener", label: "Screener" },
  { id: "lpstore", label: "LP Store" },
  { id: "contracts", label: "Contracts" },
  { id: "insurance", label: "Insurance" },
  { id: "orders", label: "Orders" },
  { id: "wallet", label: "Wallet" },
  { id: "transactions", label: "Transactions" },
];

type ContractTypeFilter = "all" | "item_exchange" | "auction" | "courier" | "loan";

function contractTypeLabel(type: string): string {
  switch (type) {
    case "item_exchange":
      return "Item Exchange";
    case "auction":
      return "Auction";
    case "courier":
      return "Courier";
    case "loan":
      return "Loan";
    default:
      return type;
  }
}

interface WalletMarketPageProps {
  characters: SessionCharacter[];
  initialCharacterId: number | null;
  /** An item to jump straight into the Market Browser on, e.g. from clicking an item on a kill's fit. */
  initialMarketItem?: MarketItemRef | null;
  onConsumeInitialMarketItem?: () => void;
  /** Item Database's "Fit This Ship" button jumps to the Fittings & Fleets
   * builder with this ship pre-selected - a cross-page hop, so it's a
   * callback up to App.tsx rather than local state. */
  onFitShip: (shipTypeId: number) => void;
}

function fmtDate(value: string | null): string {
  return value ? new Date(value).toLocaleString([], { timeZone: "UTC" }) : "—";
}

function fmtCount(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

function reauthNotice(label: string) {
  return <p className="detail-empty">Sign in again to unlock {label} for this character.</p>;
}

interface RealizedPnl {
  realizedProfit: number;
  matchedBuyCost: number;
  matchedSellRevenue: number;
  /** Sold quantity with no matching buy in the visible transaction
   * history (e.g. mined, manufactured, or bought before history starts) -
   * tracked separately rather than assumed to be pure profit, since its
   * real cost basis is unknown. */
  unmatchedSellQuantity: number;
  unmatchedSellValue: number;
}

/** FIFO-matches every buy against later sells of the same item, oldest
 * buy consumed first - the standard cost-basis method, and the only one
 * that doesn't need to know which literal unit was sold. Entirely derived
 * from the transaction list already being fetched for the table below;
 * no new backend call. */
function computeRealizedPnl(entries: TransactionEntry[]): RealizedPnl {
  const byType = new Map<number, TransactionEntry[]>();
  for (const t of entries) {
    const list = byType.get(t.type_id);
    if (list) list.push(t);
    else byType.set(t.type_id, [t]);
  }

  let realizedProfit = 0;
  let matchedBuyCost = 0;
  let matchedSellRevenue = 0;
  let unmatchedSellQuantity = 0;
  let unmatchedSellValue = 0;

  for (const list of byType.values()) {
    const sorted = [...list].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
    const lots: { qty: number; price: number }[] = [];
    for (const t of sorted) {
      if (t.is_buy) {
        lots.push({ qty: t.quantity, price: t.unit_price });
        continue;
      }
      let remaining = t.quantity;
      while (remaining > 0 && lots.length > 0) {
        const lot = lots[0];
        const consumed = Math.min(lot.qty, remaining);
        realizedProfit += (t.unit_price - lot.price) * consumed;
        matchedBuyCost += lot.price * consumed;
        matchedSellRevenue += t.unit_price * consumed;
        lot.qty -= consumed;
        remaining -= consumed;
        if (lot.qty === 0) lots.shift();
      }
      if (remaining > 0) {
        unmatchedSellQuantity += remaining;
        unmatchedSellValue += remaining * t.unit_price;
      }
    }
  }

  return { realizedProfit, matchedBuyCost, matchedSellRevenue, unmatchedSellQuantity, unmatchedSellValue };
}

function WalletMarketPage({
  characters,
  initialCharacterId,
  initialMarketItem,
  onConsumeInitialMarketItem,
  onFitShip,
}: WalletMarketPageProps) {
  const [tab, setTab] = useState<WalletMarketTab>("browser");
  const [selectedId, setSelectedId] = useState<number | null>(initialCharacterId ?? characters[0]?.id ?? null);

  useEffect(() => {
    if (initialMarketItem) setTab("browser");
  }, [initialMarketItem]);
  const [overview, setOverview] = useState<CharacterOverview | null>(null);
  const [marketOrders, setMarketOrders] = useState<CharacterMarketOrders | null>(null);
  const [transactions, setTransactions] = useState<CharacterTransactions | null>(null);
  const [walletJournal, setWalletJournal] = useState<CharacterWalletJournal | null>(null);

  const [defaultTradeHub] = useDefaultTradeHub();
  const [mapData, setMapData] = useState<MapData | null>(null);
  const [contractRegionId, setContractRegionId] = useState(defaultTradeHub);
  const [contracts, setContracts] = useState<PublicContractEntry[] | null>(null);
  const [contractTypeFilter, setContractTypeFilter] = useState<ContractTypeFilter>("all");
  const [contractQuery, setContractQuery] = useState("");

  const realizedPnl = useMemo(() => (transactions ? computeRealizedPnl(transactions.entries) : null), [transactions]);

  const characterScoped = tab === "wallet" || tab === "transactions" || tab === "orders";
  // LP Store also needs a selected character (for its LP balances) but not
  // the wallet/orders/transactions bundle characterScoped's effect fetches.
  const showCharacterStrip = characterScoped || tab === "lpstore";

  useEffect(() => {
    if (!characterScoped || selectedId == null) return;
    setOverview(null);
    setMarketOrders(null);
    setTransactions(null);
    setWalletJournal(null);
    getCharacterOverview(selectedId).then(setOverview).catch(() => {});
    getCharacterMarketOrders(selectedId).then(setMarketOrders).catch(() => {});
    getCharacterTransactions(selectedId).then(setTransactions).catch(() => {});
    getCharacterWalletJournal(selectedId).then(setWalletJournal).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, characterScoped]);

  useEffect(() => {
    if (tab === "contracts" && !mapData) {
      getMapData().then(setMapData).catch(() => {});
    }
  }, [tab, mapData]);

  useEffect(() => {
    if (tab !== "contracts") return;
    setContracts(null);
    getPublicContracts(contractRegionId)
      .then(setContracts)
      .catch(() => setContracts([]));
  }, [tab, contractRegionId]);

  const filteredContracts = useMemo(() => {
    if (!contracts) return null;
    const q = contractQuery.trim().toLowerCase();
    return contracts.filter((c) => {
      if (contractTypeFilter !== "all" && c.contract_type !== contractTypeFilter) return false;
      if (q && !(c.title?.toLowerCase().includes(q) || c.issuer_corporation_name.toLowerCase().includes(q))) return false;
      return true;
    });
  }, [contracts, contractTypeFilter, contractQuery]);

  const sortedContracts = useSortableRows(filteredContracts?.slice(0, 500) ?? [], {
    contract_type: (c) => c.contract_type,
    title: (c) => c.title || "",
    issuer_corporation_name: (c) => c.issuer_corporation_name,
    price: (c) => (c.contract_type === "courier" ? c.reward : c.price),
    collateral: (c) => (c.contract_type === "courier" ? c.collateral : 0),
    volume: (c) => c.volume,
    date_expired: (c) => new Date(c.date_expired).getTime(),
  });
  const sortedMarketOrders = useSortableRows(marketOrders?.entries ?? [], {
    type_name: (o) => o.type_name,
    side: (o) => (o.is_buy_order ? "Buy" : "Sell"),
    status: (o) => o.status,
    price: (o) => o.price,
    volume_remain: (o) => o.volume_remain,
    location_name: (o) => o.location_name,
    issued: (o) => new Date(o.issued).getTime(),
  });
  const sortedWalletJournal = useSortableRows(walletJournal?.entries.slice(0, 1000) ?? [], {
    date: (e) => new Date(e.date).getTime(),
    ref_type: (e) => e.ref_type,
    description: (e) => e.description,
    amount: (e) => e.amount,
    balance: (e) => e.balance ?? 0,
  }, "date");
  const sortedTransactions = useSortableRows(transactions?.entries ?? [], {
    date: (t) => new Date(t.date).getTime(),
    side: (t) => (t.is_buy ? "Buy" : "Sell"),
    type_name: (t) => t.type_name,
    quantity: (t) => t.quantity,
    unit_price: (t) => t.unit_price,
    total: (t) => t.quantity * t.unit_price,
    location_name: (t) => t.location_name,
    client_name: (t) => t.client_name,
  }, "date");

  return (
    <main className="main main-wallet-market">
      <div className="wallet-market-page">
        <div className="wallet-market-header">
          <p className="eyebrow">Wallet & Market</p>
          <div className="dashboard-header-title-row">
            <h2>{TABS.find((t) => t.id === tab)!.label}</h2>
            <HelpBadge content={HELP_CONTENT[`wallet.${tab}`] ?? HELP_CONTENT.wallet} />
          </div>
        </div>

        <MineralTicker />

        <div className="kills-tabs">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              className={`kills-tab ${tab === t.id ? "kills-tab-active" : ""}`}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>

        {showCharacterStrip && (
          <CharacterSelectorStrip characters={characters} selectedId={selectedId} onSelect={setSelectedId} />
        )}

        {tab === "browser" ? (
          <MarketBrowser
            characters={characters}
            initialItem={initialMarketItem}
            onConsumeInitialItem={onConsumeInitialMarketItem}
          />
        ) : tab === "itemdb" ? (
          <ItemDatabase onSelectShip={onFitShip} />
        ) : tab === "appraisal" ? (
          <Appraisal />
        ) : tab === "screener" ? (
          <Screener />
        ) : tab === "lpstore" ? (
          <LpStorePanel characterId={selectedId} />
        ) : tab === "contracts" ? (
          <div className="wallet-market-body">
            <div className="contracts-toolbar">
              <select
                className="market-region-select"
                value={contractRegionId}
                onChange={(e) => setContractRegionId(Number(e.target.value))}
              >
                {(mapData?.regions ?? [])
                  .slice()
                  .sort((a, b) => a.name.localeCompare(b.name))
                  .map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
              </select>
              <select
                className="market-region-select"
                value={contractTypeFilter}
                onChange={(e) => setContractTypeFilter(e.target.value as ContractTypeFilter)}
              >
                <option value="all">All types</option>
                <option value="item_exchange">Item Exchange</option>
                <option value="auction">Auction</option>
                <option value="courier">Courier</option>
                <option value="loan">Loan</option>
              </select>
              <input
                type="text"
                className="contracts-search-input"
                placeholder="Search title or issuer corp..."
                value={contractQuery}
                onChange={(e) => setContractQuery(e.target.value)}
              />
            </div>

            {!filteredContracts ? (
              <p className="detail-empty">Loading public contracts...</p>
            ) : filteredContracts.length === 0 ? (
              <p className="detail-empty">No public contracts match this filter.</p>
            ) : (
              <div className="data-table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <SortableTh label="Type" sortKey="contract_type" activeKey={sortedContracts.sortKey} dir={sortedContracts.sortDir} onSort={sortedContracts.sort} />
                      <SortableTh label="Contract" sortKey="title" activeKey={sortedContracts.sortKey} dir={sortedContracts.sortDir} onSort={sortedContracts.sort} />
                      <SortableTh label="Issuer" sortKey="issuer_corporation_name" activeKey={sortedContracts.sortKey} dir={sortedContracts.sortDir} onSort={sortedContracts.sort} />
                      <SortableTh label="Price / Reward" sortKey="price" activeKey={sortedContracts.sortKey} dir={sortedContracts.sortDir} onSort={sortedContracts.sort} numeric />
                      <SortableTh label="Collateral" sortKey="collateral" activeKey={sortedContracts.sortKey} dir={sortedContracts.sortDir} onSort={sortedContracts.sort} numeric />
                      <SortableTh label="Volume" sortKey="volume" activeKey={sortedContracts.sortKey} dir={sortedContracts.sortDir} onSort={sortedContracts.sort} numeric />
                      <th>Location</th>
                      <SortableTh label="Expires" sortKey="date_expired" activeKey={sortedContracts.sortKey} dir={sortedContracts.sortDir} onSort={sortedContracts.sort} />
                    </tr>
                  </thead>
                  <tbody>
                    {sortedContracts.rows.map((c) => (
                      <tr key={c.contract_id}>
                        <td>
                          <span className="data-table-tag data-table-tag-neutral">{contractTypeLabel(c.contract_type)}</span>
                        </td>
                        <td>{c.title || "—"}</td>
                        <td>{c.issuer_corporation_name}</td>
                        <td className="data-table-numeric">{formatIsk(c.contract_type === "courier" ? c.reward : c.price)}</td>
                        <td className="data-table-numeric">{c.contract_type === "courier" ? formatIsk(c.collateral) : "—"}</td>
                        <td className="data-table-numeric">{c.volume.toLocaleString()} m³</td>
                        <td>
                          {c.contract_type === "courier" && c.end_location_name
                            ? `${c.start_location_name ?? "—"} → ${c.end_location_name}`
                            : c.start_location_name ?? "—"}
                        </td>
                        <td>{fmtDate(c.date_expired)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {filteredContracts && filteredContracts.length > 500 && (
              <p className="detail-empty">Showing the first 500 of {filteredContracts.length.toLocaleString()} matching contracts.</p>
            )}
          </div>
        ) : tab === "insurance" ? (
          <InsuranceCalculator />
        ) : selectedId == null ? (
          <p className="detail-empty">No connected characters.</p>
        ) : tab === "orders" ? (
          <div className="wallet-market-body">
            {!marketOrders ? (
              <p className="detail-empty">Loading market orders...</p>
            ) : marketOrders.needs_reauth ? (
              reauthNotice("market orders")
            ) : marketOrders.entries.length === 0 ? (
              <p className="detail-empty">No market orders found.</p>
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
          </div>
        ) : tab === "wallet" ? (
          <div className="wallet-market-body">
            <div className="wallet-balance-row">
              <div className="wallet-balance-card">
                <p className="eyebrow">ISK Balance</p>
                <h2>{overview?.isk_balance != null ? formatIsk(overview.isk_balance) : "—"}</h2>
              </div>
            </div>
            {!walletJournal ? (
              <p className="detail-empty">Loading wallet journal...</p>
            ) : walletJournal.needs_reauth ? (
              reauthNotice("the wallet journal")
            ) : walletJournal.entries.length === 0 ? (
              <p className="detail-empty">No wallet activity found.</p>
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
                          {e.first_party_name && e.second_party_name ? ` (${e.first_party_name} → ${e.second_party_name})` : ""}
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
            {walletJournal && walletJournal.entries.length > 1000 && (
              <p className="detail-empty">Showing the most recent 1,000 of {fmtCount(walletJournal.entries.length)} entries.</p>
            )}
          </div>
        ) : (
          <div className="wallet-market-body">
            {!transactions ? (
              <p className="detail-empty">Loading transactions...</p>
            ) : transactions.needs_reauth ? (
              reauthNotice("transactions")
            ) : transactions.entries.length === 0 ? (
              <p className="detail-empty">No recent transactions.</p>
            ) : (
              <>
                {realizedPnl && (
                  <div className="market-browser-stats">
                    <div className="market-stat-card" title="FIFO-matched: each sale is matched against the oldest still-unsold buy of that item.">
                      <span className="market-stat-label">Realized P&amp;L</span>
                      <span className={`market-stat-value ${realizedPnl.realizedProfit >= 0 ? "wallet-amount-positive" : "wallet-amount-negative"}`}>
                        {formatIsk(realizedPnl.realizedProfit)}
                      </span>
                    </div>
                    <div className="market-stat-card">
                      <span className="market-stat-label">Matched Buy Cost</span>
                      <span className="market-stat-value">{formatIsk(realizedPnl.matchedBuyCost)}</span>
                    </div>
                    <div className="market-stat-card">
                      <span className="market-stat-label">Matched Sell Revenue</span>
                      <span className="market-stat-value">{formatIsk(realizedPnl.matchedSellRevenue)}</span>
                    </div>
                    {realizedPnl.unmatchedSellQuantity > 0 && (
                      <div
                        className="market-stat-card"
                        title="Sold with no matching buy in this transaction history - likely mined, manufactured, looted, or bought before this history started. Not counted in Realized P&L since its real cost is unknown."
                      >
                        <span className="market-stat-label">Unmatched Sells</span>
                        <span className="market-stat-value">{formatIsk(realizedPnl.unmatchedSellValue)}</span>
                      </div>
                    )}
                  </div>
                )}
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
                          <span className={`data-table-tag ${t.is_buy ? "" : "data-table-tag-danger"}`}>{t.is_buy ? "Buy" : "Sell"}</span>
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
              </>
            )}
          </div>
        )}
      </div>
    </main>
  );
}

export default WalletMarketPage;
