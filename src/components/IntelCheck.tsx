import { useEffect, useMemo, useRef, useState } from "react";
import { ExternalLink, Radio } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { checkIntel, type IntelEntry } from "../lib/kills";
import { listIntelChannels, pollIntelChannel, type IntelChannelInfo, type IntelLine } from "../lib/intelFeed";
import { resolveTypeIdsByName } from "../lib/market";
import { useIntelChannel } from "../hooks/useIntelChannel";
import { useErrorReporter } from "../hooks/useErrorReporter";
import { useSortableRows } from "../hooks/useSortableRows";
import { SortableTh } from "./SortableTh";
import { formatIsk, typeIconUrl } from "../lib/format";

interface IntelCheckProps {
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

/** Shared between the paste tool's result grid and the Live tab's single
 * "last checked" panel - same threat-band styling and stat layout either way. */
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

type IntelCheckTab = "paste" | "live" | "dscan";

const INTEL_CHECK_TABS: { id: IntelCheckTab; label: string }[] = [
  { id: "paste", label: "Paste Local" },
  { id: "live", label: "Live Feed" },
  { id: "dscan", label: "D-Scan" },
];

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

/** How often the Live tab re-polls its watched channel's log file for new
 * lines - frequent enough to feel live, far short of hammering disk I/O. */
const INTEL_FEED_POLL_MS = 4000;

/** Feed rows kept on screen - old ones fall off rather than growing forever
 * across a long session. */
const INTEL_FEED_MAX_LINES = 200;

function IntelCheck({ onSelectCharacter }: IntelCheckProps) {
  const [tab, setTab] = useState<IntelCheckTab>("paste");
  const [text, setText] = useState("");
  const [entries, setEntries] = useState<IntelEntry[] | null>(null);
  const [unresolved, setUnresolved] = useState<string[]>([]);
  const [checking, setChecking] = useState(false);
  const reportError = useErrorReporter();

  const [channels, setChannels] = useState<IntelChannelInfo[] | null>(null);
  const [selectedChannel, setSelectedChannel] = useIntelChannel();
  const [selectedListener, setSelectedListener] = useState<string | null>(null);
  const [feedLines, setFeedLines] = useState<IntelLine[]>([]);
  const [checkedPilot, setCheckedPilot] = useState<IntelEntry | null>(null);
  const [checkingSpeaker, setCheckingSpeaker] = useState<string | null>(null);
  const cursorRef = useRef(0);

  const [dscanText, setDscanText] = useState("");
  const [dscanGroups, setDscanGroups] = useState<DScanGroup[] | null>(null);
  const sortedDscanGroups = useSortableRows(dscanGroups ?? [], {
    typeName: (g) => g.typeName,
    count: (g) => g.count,
  }, "count");
  const [dscanAnalyzing, setDscanAnalyzing] = useState(false);

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

  // Distinct characters seen in the logs, most-recently-active first (channels
  // is already sorted that way) - lets the user pick "which of my characters"
  // before narrowing down to "which of their channels", instead of scanning
  // one long list of every (channel, character) pair mixed together.
  const listeners = useMemo(() => {
    if (!channels) return [];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const c of channels) {
      if (!seen.has(c.listener)) {
        seen.add(c.listener);
        out.push(c.listener);
      }
    }
    return out;
  }, [channels]);

  const channelsForListener = useMemo(
    () => (channels && selectedListener ? channels.filter((c) => c.listener === selectedListener) : []),
    [channels, selectedListener],
  );

  useEffect(() => {
    if (tab !== "live" || channels !== null) return;
    listIntelChannels()
      .then((result) => {
        setChannels(result);
        // Restore whichever character was previously watching, if they still
        // have logs - otherwise leave it unset so the picker shows.
        if (selectedChannel && result.some((c) => c.listener === selectedChannel.listener)) {
          setSelectedListener(selectedChannel.listener);
        }
      })
      .catch((err) => reportError(`Failed to read EVE chat logs: ${String(err)}`));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, channels]);

  function handlePickListener(listener: string) {
    setSelectedListener(listener);
    setSelectedChannel(null);
  }

  useEffect(() => {
    if (tab !== "live" || !selectedChannel) return;
    let cancelled = false;
    cursorRef.current = 0;
    setFeedLines([]);

    async function poll() {
      try {
        const result = await pollIntelChannel(selectedChannel!.channelName, selectedChannel!.listener, cursorRef.current);
        if (cancelled) return;
        cursorRef.current = result.cursor;
        if (result.lines.length > 0) {
          setFeedLines((prev) => [...result.lines].reverse().concat(prev).slice(0, INTEL_FEED_MAX_LINES));
        }
      } catch (err) {
        if (!cancelled) reportError(`Live intel feed error: ${String(err)}`);
      }
    }

    poll();
    const interval = setInterval(poll, INTEL_FEED_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, selectedChannel?.channelName]);

  async function handleCheckSpeaker(speaker: string) {
    setCheckingSpeaker(speaker);
    try {
      const result = await checkIntel([speaker]);
      if (result.entries.length > 0) {
        setCheckedPilot(result.entries[0]);
      } else {
        reportError(`Couldn't resolve "${speaker}" to a character.`);
      }
    } catch (err) {
      reportError(`Intel check failed: ${String(err)}`);
    } finally {
      setCheckingSpeaker(null);
    }
  }

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
    <main className="main main-intel-check">
      <div className="intel-check-page">
        <div className="intel-check-header">
          <p className="eyebrow">Intel Check</p>
          <h2>{tab === "paste" ? "Local Threat Check" : tab === "live" ? "Live Intel Feed" : "D-Scan Analysis"}</h2>
          <p className="intel-check-intro">
            {tab === "paste"
              ? "Paste names from Local chat to get intelligence on pilots in your system - killboard history, corp and alliance affiliations, and a threat score to help you decide whether to engage or dock up."
              : tab === "live"
                ? "Reads EVE's own local chat log for a channel you pick - no copy-paste needed. Click any name to run the same threat check against them."
                : "Paste a Directional Scan result to get an instant count of every ship, structure, and object type it found - who and what is actually out there right now."}
          </p>
        </div>

        <div className="kills-tabs">
          {INTEL_CHECK_TABS.map((t) => (
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

        {tab === "paste" ? (
          <>
            <textarea
              className="price-checker-input"
              placeholder={"Paste the Local chat member list here - one pilot name per line (or comma-separated)."}
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={8}
            />
            <p className="intel-check-hint">
              Paste directly from EVE Online's Local chat window. Names can be separated by new lines or commas. Due
              to API rate limits, processing is limited to 100 pilots at a time.
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
          </>
        ) : tab === "live" ? (
          <>
            {channels === null ? (
              <p className="detail-empty">Reading EVE chat logs...</p>
            ) : channels.length === 0 ? (
              <p className="detail-empty">
                No local chat logs found. In-game, enable Settings &gt; Chat &gt; "Log chat to file", then join an
                intel channel.
              </p>
            ) : !selectedListener ? (
              <div className="intel-feed-listener-picker">
                <p className="intel-feed-checked-label">Which character?</p>
                <div className="intel-feed-listener-grid">
                  {listeners.map((listener) => (
                    <button key={listener} type="button" className="intel-feed-listener-chip" onClick={() => handlePickListener(listener)}>
                      {listener}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <div className="intel-feed-toolbar-wrap">
                <div className="intel-feed-toolbar">
                  <button
                    type="button"
                    className="detail-back"
                    onClick={() => {
                      setSelectedListener(null);
                      setSelectedChannel(null);
                    }}
                  >
                    Change character
                  </button>
                  <select
                    className="market-region-select"
                    value={selectedChannel ? `${selectedChannel.channelName}|${selectedChannel.listener}` : ""}
                    onChange={(e) => {
                      const [channelName, listener] = e.target.value.split("|");
                      setSelectedChannel(channelName ? { channelName, listener: listener ?? "" } : null);
                    }}
                  >
                    <option value="">Select a channel to watch...</option>
                    {channelsForListener.map((c) => (
                      <option key={c.channel_name} value={`${c.channel_name}|${c.listener}`}>
                        {c.channel_name}
                      </option>
                    ))}
                  </select>
                  {selectedChannel && (
                    <span className="intel-feed-status">
                      <Radio size={13} strokeWidth={2} className="intel-feed-live-dot" />
                      Watching {selectedChannel.channelName}
                    </span>
                  )}
                </div>
                <p className="intel-feed-selected-listener">Selected character: {selectedListener}</p>
              </div>
            )}

            {checkingSpeaker && <p className="detail-empty">Checking {checkingSpeaker}...</p>}

            {checkedPilot && (
              <div className="intel-feed-checked">
                <p className="intel-feed-checked-label">Last checked</p>
                <IntelPilotCard entry={checkedPilot} onSelectCharacter={onSelectCharacter} onOpenZkillboard={openZkillboard} />
              </div>
            )}

            {selectedChannel && (
              <div className="intel-feed-list">
                {feedLines.length === 0 ? (
                  <p className="detail-empty">Waiting for new messages in {selectedChannel.channelName}...</p>
                ) : (
                  feedLines.map((line, i) => (
                    <div key={i} className="intel-feed-line">
                      <span className="intel-feed-line-time">{line.timestamp.split(" ")[1] ?? line.timestamp}</span>
                      <button type="button" className="intel-feed-line-speaker" onClick={() => handleCheckSpeaker(line.speaker)}>
                        {line.speaker}
                      </button>
                      <span className="intel-feed-line-message">{line.message}</span>
                    </div>
                  ))
                )}
              </div>
            )}
          </>
        ) : (
          <>
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
          </>
        )}
      </div>
    </main>
  );
}

export default IntelCheck;
