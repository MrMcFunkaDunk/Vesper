import { useState } from "react";
import { resolveTypeIdsByName } from "../lib/market";
import { useErrorReporter } from "../hooks/useErrorReporter";
import { useSortableRows } from "../hooks/useSortableRows";
import { SortableTh } from "./SortableTh";
import { typeIconUrl } from "../lib/format";

interface DScanGroup {
  typeName: string;
  typeId: number | null;
  count: number;
}

/** EVE's own Directional Scanner clipboard format (Ctrl+A, Ctrl+C in the
 * D-Scan window): one tab-separated "Name\tType\tDistance" row per
 * detected item. Only the Type column matters for a count summary - Name
 * is often blank (ships) or a celestial's proper name, and distance isn't
 * needed to know what's out there. Malformed/header rows (anything that
 * doesn't split into exactly 3 tab-separated fields) are silently skipped. */
function parseDScan(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const line of text.split(/\r?\n/)) {
    const parts = line.split("\t");
    if (parts.length !== 3) continue;
    const typeName = parts[1].trim();
    if (!typeName) continue;
    counts.set(typeName, (counts.get(typeName) ?? 0) + 1);
  }
  return counts;
}

/** The Map page's "D-Scan" tab - paste a Directional Scan result, get an
 * instant type-by-type count. Formerly one of three tabs on the standalone
 * "Intel Check" nav page (alongside Local Threat and an unused Live Feed
 * tab); folded into Map, Gate & Intel Check since that's where a pilot
 * actually wants this mid-session. */
function DScanCheck() {
  const [dscanText, setDscanText] = useState("");
  const [dscanGroups, setDscanGroups] = useState<DScanGroup[] | null>(null);
  const sortedDscanGroups = useSortableRows(dscanGroups ?? [], {
    typeName: (g) => g.typeName,
    count: (g) => g.count,
  }, "count");
  const [dscanAnalyzing, setDscanAnalyzing] = useState(false);
  const reportError = useErrorReporter();

  async function handleAnalyzeDScan() {
    const counts = parseDScan(dscanText);
    if (counts.size === 0) {
      reportError("Couldn't find any tab-separated rows - paste directly from the D-Scan window (Ctrl+A, Ctrl+C there).");
      return;
    }
    setDscanAnalyzing(true);
    try {
      const typeIds = await resolveTypeIdsByName([...counts.keys()]);
      const groups = [...counts.entries()]
        .map(([typeName, count]) => ({ typeName, typeId: typeIds.get(typeName) ?? null, count }))
        .sort((a, b) => b.count - a.count);
      setDscanGroups(groups);
    } catch (err) {
      reportError(`Failed to analyze D-Scan: ${String(err)}`);
    } finally {
      setDscanAnalyzing(false);
    }
  }

  function handleClearDScan() {
    setDscanText("");
    setDscanGroups(null);
  }

  return (
    <div className="intel-check-page">
      <p className="intel-check-intro">
        Paste a Directional Scan result to get an instant count of every ship, structure, and object type it found -
        who and what is actually out there right now.
      </p>

      <textarea
        className="price-checker-input"
        placeholder={"Paste your D-Scan results here (Ctrl+A, Ctrl+C in the Directional Scanner window)."}
        value={dscanText}
        onChange={(e) => setDscanText(e.target.value)}
        rows={8}
      />
      <p className="intel-check-hint">
        Paste directly from EVE's Directional Scan results window - the tab-separated Name/Type/Distance format
        copies straight from there.
      </p>

      <div className="intel-check-actions">
        <button type="button" className="kills-sync-btn" onClick={handleAnalyzeDScan} disabled={dscanAnalyzing || !dscanText.trim()}>
          {dscanAnalyzing ? "Analyzing..." : "Analyze D-Scan"}
        </button>
        <button type="button" className="detail-back" onClick={handleClearDScan} disabled={dscanAnalyzing}>
          Clear
        </button>
      </div>

      {dscanGroups && (
        <>
          <div className="market-browser-stats">
            <div className="market-stat-card">
              <span className="market-stat-label">Total Objects</span>
              <span className="market-stat-value">{dscanGroups.reduce((sum, g) => sum + g.count, 0)}</span>
            </div>
            <div className="market-stat-card">
              <span className="market-stat-label">Distinct Types</span>
              <span className="market-stat-value">{dscanGroups.length}</span>
            </div>
          </div>
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <SortableTh label="Type" sortKey="typeName" activeKey={sortedDscanGroups.sortKey} dir={sortedDscanGroups.sortDir} onSort={sortedDscanGroups.sort} />
                  <SortableTh label="Count" sortKey="count" activeKey={sortedDscanGroups.sortKey} dir={sortedDscanGroups.sortDir} onSort={sortedDscanGroups.sort} numeric />
                </tr>
              </thead>
              <tbody>
                {sortedDscanGroups.rows.map((g) => (
                  <tr key={g.typeName}>
                    <td>
                      <span className="asset-item-cell">
                        {g.typeId != null && <img className="asset-item-icon" src={typeIconUrl(g.typeId, 32, g.typeName)} alt="" />}
                        {g.typeName}
                      </span>
                    </td>
                    <td className="data-table-numeric">{g.count}</td>
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

export default DScanCheck;
