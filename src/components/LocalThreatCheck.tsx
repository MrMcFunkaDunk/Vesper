import { useState } from "react";
import { ExternalLink } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { checkIntel, type IntelEntry } from "../lib/kills";
import { useErrorReporter } from "../hooks/useErrorReporter";
import { formatIsk } from "../lib/format";

interface LocalThreatCheckProps {
  onSelectCharacter: (characterId: number) => void;
}

function corpLogoUrl(id: number): string {
  return `https://images.evetech.net/corporations/${id}/logo?size=32`;
}

function portraitUrl(id: number): string {
  return `https://images.evetech.net/characters/${id}/portrait?size=64`;
}

type ThreatBand = "high" | "medium" | "low";

const THREAT_LABEL: Record<ThreatBand, string> = { high: "High", medium: "Medium", low: "Low" };

/** A pure danger_ratio can be misleading on its own - a pilot with 1 kill
 * and 0 losses shows 100% the same as a seasoned killer with 400. Folding
 * in raw activity is what separates "actually dangerous" from "no data
 * yet" - a pilot with zero killboard history reads as Low, not a fourth
 * "unknown" state, matching how a 0.0 score renders on the card itself. */
function threatBand(entry: IntelEntry): ThreatBand {
  if (entry.danger_ratio >= 90 && entry.ships_destroyed >= 5) return "high";
  if (entry.danger_ratio >= 60 || entry.ships_destroyed >= 20) return "medium";
  return "low";
}

/** A 0.0-10.0 score derived from zKillboard's own danger_ratio (0-100%) -
 * gives the card grid a single glanceable number the way a raw percentage
 * label doesn't. */
function threatScore(entry: IntelEntry): string {
  return (entry.danger_ratio / 10).toFixed(1);
}

function killDeathRatio(entry: IntelEntry): string {
  if (entry.ships_lost === 0) return entry.ships_destroyed > 0 ? "∞" : "0.0";
  return (entry.ships_destroyed / entry.ships_lost).toFixed(1);
}

function IntelPilotCard({
  entry,
  onSelectCharacter,
  onOpenZkillboard,
}: {
  entry: IntelEntry;
  onSelectCharacter: (characterId: number) => void;
  onOpenZkillboard: (characterId: number) => void;
}) {
  const band = threatBand(entry);
  return (
    <div className={`intel-check-card intel-check-card-${band}`}>
      <div className="intel-check-card-head">
        <img className="intel-check-card-portrait" src={portraitUrl(entry.character_id)} alt="" />
        <div className="intel-check-card-identity">
          <span
            className="intel-check-card-name kills-system-clickable"
            role="button"
            tabIndex={0}
            onClick={() => onSelectCharacter(entry.character_id)}
            onKeyDown={(ev) => {
              if (ev.key === "Enter" || ev.key === " ") {
                ev.preventDefault();
                onSelectCharacter(entry.character_id);
              }
            }}
          >
            {entry.character_name}
          </span>
          <span className="intel-check-card-corp">
            {entry.corporation_ticker && <img className="intel-check-card-corp-logo" src={corpLogoUrl(entry.corporation_id)} alt="" />}
            {entry.corporation_name ?? "—"}
            {entry.alliance_ticker ? ` [${entry.alliance_ticker}]` : entry.corporation_ticker ? ` [${entry.corporation_ticker}]` : ""}
          </span>
        </div>
        <div className={`intel-check-card-score intel-check-card-score-${band}`}>
          <span className="intel-check-card-score-number">{threatScore(entry)}</span>
          <span className="intel-check-card-score-label">{THREAT_LABEL[band]}</span>
        </div>
      </div>

      <div className="intel-check-card-stats">
        <span className="intel-check-stat-label">Kills</span>
        <span className="intel-check-stat-value character-stats-destroyed">{entry.ships_destroyed.toLocaleString()}</span>
        <span className="intel-check-stat-label">ISK Destroyed</span>
        <span className="intel-check-stat-value character-stats-destroyed">{formatIsk(entry.isk_destroyed)}</span>

        <span className="intel-check-stat-label">Losses</span>
        <span className="intel-check-stat-value character-stats-lost">{entry.ships_lost.toLocaleString()}</span>
        <span className="intel-check-stat-label">ISK Lost</span>
        <span className="intel-check-stat-value character-stats-lost">{formatIsk(entry.isk_lost)}</span>

        <span className="intel-check-stat-label">K/D Ratio</span>
        <span className="intel-check-stat-value">{killDeathRatio(entry)}</span>
        <span className="intel-check-stat-label">Solo Ratio</span>
        <span className="intel-check-stat-value">{entry.solo_ratio.toFixed(1)}%</span>

        <span className="intel-check-stat-label">Security</span>
        <span
          className={`intel-check-stat-value ${(entry.security_status ?? 0) >= 0 ? "character-security-positive" : "character-security-negative"}`}
        >
          {entry.security_status != null ? entry.security_status.toFixed(1) : "—"}
        </span>
        <span className="intel-check-stat-label">Danger</span>
        <span className={`intel-check-stat-value intel-check-danger-${band}`}>{entry.danger_ratio}%</span>
      </div>

      <button type="button" className="intel-check-card-zkill" onClick={() => onOpenZkillboard(entry.character_id)}>
        <ExternalLink size={12} strokeWidth={2} />
        View on zKillboard
      </button>
    </div>
  );
}

/** The Map page's "Local Threat" tab - paste a Local chat member list, get
 * killboard-backed intel on everyone in it. Formerly its own standalone
 * "Intel Check" nav page (alongside a Live Feed tab and this same D-Scan
 * tool - see DScanCheck.tsx); folded into Map, Gate & Intel Check since
 * that's where a pilot actually wants this mid-session, and Live Feed was
 * dropped outright as unused. */
function LocalThreatCheck({ onSelectCharacter }: LocalThreatCheckProps) {
  const [text, setText] = useState("");
  const [entries, setEntries] = useState<IntelEntry[] | null>(null);
  const [unresolved, setUnresolved] = useState<string[]>([]);
  const [checking, setChecking] = useState(false);
  const reportError = useErrorReporter();

  async function handleCheck() {
    // Newlines or commas both split into separate names - not spaces, since
    // EVE character names routinely contain them ("John Smith").
    const names = text
      .split(/[\n,]/)
      .map((line) => line.trim())
      .filter(Boolean);
    if (names.length === 0) return;

    setChecking(true);
    try {
      const result = await checkIntel(names);
      // Highest risk first, same as localthreat.xyz's default sort - anyone
      // with no killboard history at all sinks to the bottom rather than
      // competing with real danger_ratio values for the top spot.
      const sorted = [...result.entries].sort((a, b) => {
        const aActive = a.ships_destroyed + a.ships_lost > 0;
        const bActive = b.ships_destroyed + b.ships_lost > 0;
        if (aActive !== bActive) return aActive ? -1 : 1;
        return b.danger_ratio - a.danger_ratio;
      });
      setEntries(sorted);
      setUnresolved(result.unresolved);
    } catch (err) {
      reportError(`Intel check failed: ${String(err)}`);
    } finally {
      setChecking(false);
    }
  }

  function handleClear() {
    setText("");
    setEntries(null);
    setUnresolved([]);
  }

  function openZkillboard(characterId: number) {
    openUrl(`https://zkillboard.com/character/${characterId}/`).catch((err) =>
      reportError(`Failed to open link: ${String(err)}`),
    );
  }

  const bandCounts = { high: 0, medium: 0, low: 0 };
  for (const e of entries ?? []) bandCounts[threatBand(e)] += 1;

  return (
    <div className="intel-check-page">
      <p className="intel-check-intro">
        Paste names from Local chat to get intelligence on pilots in your system - killboard history, corp and
        alliance affiliations, and a threat score to help you decide whether to engage or dock up.
      </p>

      <textarea
        className="price-checker-input"
        placeholder={"Paste the Local chat member list here - one pilot name per line (or comma-separated)."}
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={8}
      />
      <p className="intel-check-hint">
        Paste directly from EVE Online's Local chat window. Names can be separated by new lines or commas. Due to
        API rate limits, processing is limited to 100 pilots at a time.
      </p>

      <div className="intel-check-actions">
        <button type="button" className="kills-sync-btn" onClick={handleCheck} disabled={checking || !text.trim()}>
          {checking ? "Analyzing..." : "Analyze Local"}
        </button>
        <button type="button" className="detail-back" onClick={handleClear} disabled={checking}>
          Clear
        </button>
      </div>

      {entries && (
        <>
          <div className="market-browser-stats">
            <div className="market-stat-card">
              <span className="market-stat-label">Total Pilots</span>
              <span className="market-stat-value">{entries.length}</span>
            </div>
            <div className="market-stat-card">
              <span className="market-stat-label">High Threat</span>
              <span className="market-stat-value" style={{ color: "var(--danger)" }}>
                {bandCounts.high}
              </span>
            </div>
            <div className="market-stat-card">
              <span className="market-stat-label">Medium Threat</span>
              <span className="market-stat-value" style={{ color: "var(--warning)" }}>
                {bandCounts.medium}
              </span>
            </div>
            <div className="market-stat-card">
              <span className="market-stat-label">Low Threat</span>
              <span className="market-stat-value" style={{ color: "var(--success)" }}>
                {bandCounts.low}
              </span>
            </div>
          </div>

          {unresolved.length > 0 && (
            <p className="detail-empty">
              Couldn't match {unresolved.length} name(s): {unresolved.join(", ")}
            </p>
          )}

          {entries.length === 0 ? (
            <p className="detail-empty">Nothing resolved - check the pasted names and try again.</p>
          ) : (
            <div className="intel-check-grid">
              {entries.map((e) => (
                <IntelPilotCard key={e.character_id} entry={e} onSelectCharacter={onSelectCharacter} onOpenZkillboard={openZkillboard} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

export default LocalThreatCheck;
