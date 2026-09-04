import { useEffect, useMemo, useState } from "react";
import { Pickaxe } from "lucide-react";
import { getMarketPrices } from "../lib/market";
import { getCharacterMiningLedger, type CharacterMiningLedger, type SessionCharacter } from "../lib/eve";
import { formatIsk, typeIconUrl } from "../lib/format";
import { useErrorReporter } from "../hooks/useErrorReporter";
import { useSortableRows } from "../hooks/useSortableRows";
import { useTheme, isPremiumTheme } from "../hooks/useTheme";
import TelemetryRail from "./premium/TelemetryRail";
import { SortableTh } from "./SortableTh";
import CharacterSelectorStrip from "./CharacterSelectorStrip";
import HelpBadge from "./HelpBadge";
import OreTableTab from "./OreTableTab";
import MarketHistoryTab from "./MarketHistoryTab";
import { HELP_CONTENT } from "../lib/helpContent";

type MiningTab = "ledger" | "oretable" | "markethistory";

function MiningLedgerTab({ characters }: { characters: SessionCharacter[] }) {
  const [theme] = useTheme();
  const premium = isPremiumTheme(theme);
  const [selectedId, setSelectedId] = useState<number | null>(characters[0]?.id ?? null);
  const [ledger, setLedger] = useState<CharacterMiningLedger | null>(null);
  const [prices, setPrices] = useState<Map<number, number>>(new Map());
  const reportError = useErrorReporter();

  useEffect(() => {
    getMarketPrices()
      .then((list) => {
        const map = new Map<number, number>();
        for (const p of list) if (p.average_price != null) map.set(p.type_id, p.average_price);
        setPrices(map);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    setLedger(null);
    if (selectedId == null) return;
    getCharacterMiningLedger(selectedId)
      .then(setLedger)
      .catch((err) => reportError(`Failed to load mining ledger: ${String(err)}`));
  }, [selectedId, reportError]);

  const grouped = useMemo(() => {
    if (!ledger) return [];
    const byType = new Map<number, { typeName: string; quantity: number }>();
    for (const e of ledger.entries) {
      const existing = byType.get(e.type_id);
      if (existing) existing.quantity += e.quantity;
      else byType.set(e.type_id, { typeName: e.type_name, quantity: e.quantity });
    }
    return [...byType.entries()]
      .map(([typeId, v]) => ({ typeId, ...v, value: (prices.get(typeId) ?? 0) * v.quantity }))
      .sort((a, b) => b.value - a.value);
  }, [ledger, prices]);

  const totalValue = grouped.reduce((sum, g) => sum + g.value, 0);
  const distinctDays = ledger ? new Set(ledger.entries.map((e) => e.date)).size : 0;
  const iskPerDay = distinctDays > 0 ? totalValue / distinctDays : 0;
  const sortedGrouped = useSortableRows(grouped, {
    typeName: (g) => g.typeName,
    quantity: (g) => g.quantity,
    value: (g) => g.value,
  }, "value");

  return (
    <div className="industry-production">
      {characters.length > 1 && <CharacterSelectorStrip characters={characters} selectedId={selectedId} onSelect={setSelectedId} />}
      {selectedId == null ? (
        <p className="detail-empty">No connected characters.</p>
      ) : !ledger ? (
        <p className="detail-empty">Loading mining ledger...</p>
      ) : ledger.needs_reauth ? (
        <p className="detail-empty">Sign in again to unlock the mining ledger for this character.</p>
      ) : ledger.entries.length === 0 ? (
        <p className="detail-empty">No mining activity recorded in the last 90 days.</p>
      ) : (
        <>
          <p className="settings-section-hint">
            Up to 90 days of mining history from ESI, valued at EVE-wide average price - a rough guide, not a
            guaranteed sell price.
          </p>
          {premium ? (
            <TelemetryRail
              items={[
                { label: "Total Value", value: formatIsk(totalValue) },
                { label: "Active Days", value: String(distinctDays) },
                { label: "ISK / Active Day", value: formatIsk(iskPerDay) },
              ]}
            />
          ) : (
            <div className="market-browser-stats">
              <div className="market-stat-card">
                <span className="market-stat-label">Total Value</span>
                <span className="market-stat-value market-stat-value-isk">{formatIsk(totalValue)}</span>
              </div>
              <div className="market-stat-card">
                <span className="market-stat-label">Active Days</span>
                <span className="market-stat-value">{distinctDays}</span>
              </div>
              <div className="market-stat-card">
                <span className="market-stat-label">ISK / Active Day</span>
                <span className="market-stat-value market-stat-value-isk">{formatIsk(iskPerDay)}</span>
              </div>
            </div>
          )}
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <SortableTh label="Ore / Ice" sortKey="typeName" activeKey={sortedGrouped.sortKey} dir={sortedGrouped.sortDir} onSort={sortedGrouped.sort} />
                  <SortableTh label="Quantity" sortKey="quantity" activeKey={sortedGrouped.sortKey} dir={sortedGrouped.sortDir} onSort={sortedGrouped.sort} numeric />
                  <SortableTh label="Est. Value" sortKey="value" activeKey={sortedGrouped.sortKey} dir={sortedGrouped.sortDir} onSort={sortedGrouped.sort} numeric />
                </tr>
              </thead>
              <tbody>
                {sortedGrouped.rows.map((g) => (
                  <tr key={g.typeId}>
                    <td>
                      <span className="asset-item-cell">
                        <img src={typeIconUrl(g.typeId, 32, g.typeName)} alt="" className="market-browser-row-icon" />
                        {g.typeName}
                      </span>
                    </td>
                    <td className="data-table-numeric">{g.quantity.toLocaleString()}</td>
                    <td className="data-table-numeric market-stat-value-isk">{formatIsk(g.value)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

function MiningPage({ characters }: { characters: SessionCharacter[] }) {
  const [tab, setTab] = useState<MiningTab>("oretable");

  return (
    <main className="main main-dashboard">
      <div className="dashboard">
        <div className="dashboard-header">
          <p className="eyebrow">
            <Pickaxe size={14} strokeWidth={2} /> Mining
          </p>
          <h2>Ore Value &amp; Mining History</h2>
          <p className="wh-page-subtitle">
            What's actually worth mining right now, and a real record of what you already have.
          </p>
        </div>

        <div className="character-tabs">
          <button type="button" className={`character-tab${tab === "oretable" ? " character-tab-active" : ""}`} onClick={() => setTab("oretable")}>
            Ore Table
          </button>
          <button type="button" className={`character-tab${tab === "ledger" ? " character-tab-active" : ""}`} onClick={() => setTab("ledger")}>
            Mining Ledger
          </button>
          <button
            type="button"
            className={`character-tab${tab === "markethistory" ? " character-tab-active" : ""}`}
            onClick={() => setTab("markethistory")}
          >
            Market History
          </button>
          <HelpBadge content={HELP_CONTENT[`mining.${tab}`] ?? HELP_CONTENT.mining} />
        </div>

        {tab === "oretable" ? (
          <OreTableTab />
        ) : tab === "ledger" ? (
          <MiningLedgerTab characters={characters} />
        ) : (
          <MarketHistoryTab />
        )}
      </div>
    </main>
  );
}

export default MiningPage;
