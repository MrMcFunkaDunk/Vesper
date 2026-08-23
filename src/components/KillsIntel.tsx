import { useEffect, useState, type FormEvent, type KeyboardEvent } from "react";
import { Search, Swords } from "lucide-react";
import TrackedSystemsFeed from "./TrackedSystemsFeed";
import RecentKillsFeed from "./RecentKillsFeed";
import BattleReportsFeed from "./BattleReportsFeed";
import KillReportsFeed from "./KillReportsFeed";
import TopKillStatsFeed from "./TopKillStatsFeed";
import KillHistoryBackfillBar from "./KillHistoryBackfillBar";
import TrackedEntitiesPanel from "./TrackedEntitiesPanel";
import KillDetailView from "./KillDetailView";
import CharacterKillboard from "./CharacterKillboard";
import SystemKillboard, { type SystemSummary } from "./SystemKillboard";
import ConstellationKillboard, { type ConstellationSummary } from "./ConstellationKillboard";
import RegionKillboard, { type RegionSummary } from "./RegionKillboard";
import CorporationKillboard, { type CorporationSummary } from "./CorporationKillboard";
import AllianceKillboard, { type AllianceSummary } from "./AllianceKillboard";
import BackToMapButton from "./BackToMapButton";
import { useErrorReporter } from "../hooks/useErrorReporter";
import { searchCharacter, searchCharactersLive, searchEntitiesLive, type CharacterMatch, type EntityMatch } from "../lib/kills";
import type { MarketItemRef } from "./MarketBrowser";

type KillsTab = "tracked" | "recent" | "battles" | "reports" | "topstats" | "trackedplayers";

interface SearchSuggestion {
  kind: "character" | "corporation" | "alliance";
  id: number;
  name: string;
}

const TABS: { id: KillsTab; label: string }[] = [
  { id: "tracked", label: "Tracked Systems" },
  { id: "recent", label: "Most Recent Kills" },
  { id: "battles", label: "Battles" },
  { id: "reports", label: "Kill Reports" },
  { id: "topstats", label: "Top Stats" },
  { id: "trackedplayers", label: "Tracked Players" },
];

type KillsView =
  | { type: "feed" }
  | { type: "killDetail"; killmailId: number }
  | { type: "character"; characterId: number }
  | { type: "system"; system: SystemSummary }
  | { type: "constellation"; constellation: ConstellationSummary }
  | { type: "region"; region: RegionSummary }
  | { type: "corporation"; corporation: CorporationSummary }
  | { type: "alliance"; alliance: AllianceSummary };

interface KillsIntelProps {
  /** A killmail to jump straight into, e.g. from clicking a kill in the Map's live ticker. */
  initialKillmailId?: number | null;
  onConsumeInitialKillmail?: () => void;
  /** A system to jump straight into, e.g. from clicking a Gate Check row's "Kills & Intel" link. */
  initialSystem?: SystemSummary | null;
  onConsumeInitialSystem?: () => void;
  /** A character to jump straight into, e.g. from clicking a name in the Dashboard's Kill Log tab. */
  initialCharacterId?: number | null;
  onConsumeInitialCharacter?: () => void;
  /** A corporation/alliance to jump straight into, e.g. from clicking a corp/alliance name anywhere in Kills & Intel. */
  initialCorporation?: CorporationSummary | null;
  onConsumeInitialCorporation?: () => void;
  initialAlliance?: AllianceSummary | null;
  onConsumeInitialAlliance?: () => void;
  onGoToMap: () => void;
  onGoToWars: () => void;
  onSelectItem: (item: MarketItemRef) => void;
}

function KillsIntel({
  initialKillmailId,
  onConsumeInitialKillmail,
  initialSystem,
  onConsumeInitialSystem,
  initialCharacterId,
  onConsumeInitialCharacter,
  initialCorporation,
  onConsumeInitialCorporation,
  initialAlliance,
  onConsumeInitialAlliance,
  onGoToMap,
  onGoToWars,
  onSelectItem,
}: KillsIntelProps) {
  const [tab, setTab] = useState<KillsTab>("tracked");
  const [characterQuery, setCharacterQuery] = useState("");
  const [searchingCharacter, setSearchingCharacter] = useState(false);
  const [characterSuggestions, setCharacterSuggestions] = useState<SearchSuggestion[]>([]);
  const [characterSuggestionsOpen, setCharacterSuggestionsOpen] = useState(false);
  const [characterHighlightIndex, setCharacterHighlightIndex] = useState(0);
  const reportError = useErrorReporter();

  // Live suggestions as the user types, debounced so every keystroke doesn't
  // fire its own request - backed by zKillboard's own site-search autocomplete
  // (real partial matching, not ESI's exact-name-only), merging character
  // and corp/alliance results into one dropdown like WarsPage's search does.
  useEffect(() => {
    const trimmed = characterQuery.trim();
    if (!trimmed) {
      setCharacterSuggestions([]);
      setCharacterSuggestionsOpen(false);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      Promise.all([searchCharactersLive(trimmed), searchEntitiesLive(trimmed)])
        .then(([characterResults, entityResults]: [CharacterMatch[], EntityMatch[]]) => {
          if (cancelled) return;
          const merged: SearchSuggestion[] = [
            ...characterResults.map((c): SearchSuggestion => ({ kind: "character", id: c.id, name: c.name })),
            ...entityResults.map((e): SearchSuggestion => ({ kind: e.is_alliance ? "alliance" : "corporation", id: e.id, name: e.name })),
          ];
          setCharacterSuggestions(merged);
          setCharacterSuggestionsOpen(merged.length > 0);
          setCharacterHighlightIndex(0);
        })
        .catch(() => {
          if (!cancelled) setCharacterSuggestions([]);
        });
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [characterQuery]);
  // A small navigation stack rather than one flag, since kill detail and
  // character killboard link to each other in both directions (a kill's
  // attackers link to their killboard, a killboard's rows link back to
  // kill detail) - "back" needs to unwind wherever that chain actually
  // came from, not always land on the feed list.
  const [stack, setStack] = useState<KillsView[]>(() => {
    if (initialKillmailId != null) return [{ type: "feed" }, { type: "killDetail", killmailId: initialKillmailId }];
    if (initialSystem) return [{ type: "feed" }, { type: "system", system: initialSystem }];
    if (initialCharacterId != null) return [{ type: "feed" }, { type: "character", characterId: initialCharacterId }];
    if (initialCorporation) return [{ type: "feed" }, { type: "corporation", corporation: initialCorporation }];
    if (initialAlliance) return [{ type: "feed" }, { type: "alliance", alliance: initialAlliance }];
    return [{ type: "feed" }];
  });

  useEffect(() => {
    if (initialKillmailId != null) {
      onConsumeInitialKillmail?.();
    }
    if (initialSystem) {
      onConsumeInitialSystem?.();
    }
    if (initialCharacterId != null) {
      onConsumeInitialCharacter?.();
    }
    if (initialCorporation) {
      onConsumeInitialCorporation?.();
    }
    if (initialAlliance) {
      onConsumeInitialAlliance?.();
    }
    // Only meant to consume the value this component mounted with, so it
    // doesn't re-fire on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const current = stack[stack.length - 1];

  function pushKillDetail(killmailId: number) {
    setStack((s) => [...s, { type: "killDetail", killmailId }]);
  }

  function pushCharacter(characterId: number) {
    setStack((s) => [...s, { type: "character", characterId }]);
  }

  function pickCharacterSuggestion(match: SearchSuggestion) {
    if (match.kind === "character") pushCharacter(match.id);
    else if (match.kind === "corporation") pushCorporation({ id: match.id, name: match.name });
    else pushAlliance({ id: match.id, name: match.name });
    setCharacterQuery("");
    setCharacterSuggestions([]);
    setCharacterSuggestionsOpen(false);
  }

  async function handleSearchCharacter(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (characterSuggestionsOpen && characterSuggestions[characterHighlightIndex]) {
      pickCharacterSuggestion(characterSuggestions[characterHighlightIndex]);
      return;
    }
    const name = characterQuery.trim();
    if (!name) return;
    setSearchingCharacter(true);
    try {
      const match = await searchCharacter(name);
      if (!match) {
        reportError(`No character found named "${name}". This needs an exact match - check the spelling.`);
        return;
      }
      pushCharacter(match.id);
      setCharacterQuery("");
    } catch (err) {
      reportError(`Character lookup failed: ${String(err)}`);
    } finally {
      setSearchingCharacter(false);
    }
  }

  function handleCharacterKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (!characterSuggestionsOpen || characterSuggestions.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setCharacterHighlightIndex((i) => Math.min(i + 1, characterSuggestions.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setCharacterHighlightIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Escape") {
      setCharacterSuggestionsOpen(false);
    }
  }

  function pushSystem(system: SystemSummary) {
    setStack((s) => [...s, { type: "system", system }]);
  }

  function pushConstellation(constellation: ConstellationSummary) {
    setStack((s) => [...s, { type: "constellation", constellation }]);
  }

  function pushRegion(region: RegionSummary) {
    setStack((s) => [...s, { type: "region", region }]);
  }

  function pushCorporation(corporation: CorporationSummary) {
    setStack((s) => [...s, { type: "corporation", corporation }]);
  }

  function pushAlliance(alliance: AllianceSummary) {
    setStack((s) => [...s, { type: "alliance", alliance }]);
  }

  function goBack() {
    setStack((s) => (s.length > 1 ? s.slice(0, -1) : s));
  }

  function goHome() {
    setStack([{ type: "feed" }]);
  }

  const tabLabel = TABS.find((t) => t.id === tab)!.label;

  if (current.type === "killDetail") {
    return (
      <KillDetailView
        killmailId={current.killmailId}
        onBack={goBack}
        onSelectCharacter={pushCharacter}
        onSelectSystem={pushSystem}
        onSelectCorporation={pushCorporation}
        onSelectAlliance={pushAlliance}
        rootLabel={tabLabel}
        onGoHome={goHome}
        onGoToMap={onGoToMap}
        onSelectItem={onSelectItem}
      />
    );
  }

  if (current.type === "character") {
    return (
      <CharacterKillboard
        characterId={current.characterId}
        onBack={goBack}
        onSelectKill={pushKillDetail}
        onSelectCharacter={pushCharacter}
        onSelectSystem={pushSystem}
        onSelectCorporation={pushCorporation}
        onSelectAlliance={pushAlliance}
        onSelectItem={onSelectItem}
        rootLabel={tabLabel}
        onGoHome={goHome}
        onGoToMap={onGoToMap}
      />
    );
  }

  if (current.type === "system") {
    return (
      <SystemKillboard
        system={current.system}
        onBack={goBack}
        onSelectKill={pushKillDetail}
        onSelectCharacter={pushCharacter}
        onSelectSystem={pushSystem}
        onSelectConstellation={pushConstellation}
        onSelectRegion={pushRegion}
        onSelectCorporation={pushCorporation}
        onSelectAlliance={pushAlliance}
        rootLabel={tabLabel}
        onGoHome={goHome}
        onGoToMap={onGoToMap}
      />
    );
  }

  if (current.type === "constellation") {
    return (
      <ConstellationKillboard
        constellation={current.constellation}
        onBack={goBack}
        onSelectKill={pushKillDetail}
        onSelectCharacter={pushCharacter}
        onSelectSystem={pushSystem}
        onSelectRegion={pushRegion}
        onSelectCorporation={pushCorporation}
        onSelectAlliance={pushAlliance}
        rootLabel={tabLabel}
        onGoHome={goHome}
        onGoToMap={onGoToMap}
      />
    );
  }

  if (current.type === "region") {
    return (
      <RegionKillboard
        region={current.region}
        onBack={goBack}
        onSelectKill={pushKillDetail}
        onSelectCharacter={pushCharacter}
        onSelectSystem={pushSystem}
        onSelectConstellation={pushConstellation}
        onSelectCorporation={pushCorporation}
        onSelectAlliance={pushAlliance}
        rootLabel={tabLabel}
        onGoHome={goHome}
        onGoToMap={onGoToMap}
      />
    );
  }

  if (current.type === "corporation") {
    return (
      <CorporationKillboard
        corporation={current.corporation}
        onBack={goBack}
        onSelectKill={pushKillDetail}
        onSelectCharacter={pushCharacter}
        onSelectSystem={pushSystem}
        onSelectCorporation={pushCorporation}
        onSelectAlliance={pushAlliance}
        onSelectItem={onSelectItem}
        rootLabel={tabLabel}
        onGoHome={goHome}
        onGoToMap={onGoToMap}
      />
    );
  }

  if (current.type === "alliance") {
    return (
      <AllianceKillboard
        alliance={current.alliance}
        onBack={goBack}
        onSelectKill={pushKillDetail}
        onSelectCharacter={pushCharacter}
        onSelectSystem={pushSystem}
        onSelectCorporation={pushCorporation}
        onSelectAlliance={pushAlliance}
        onSelectItem={onSelectItem}
        rootLabel={tabLabel}
        onGoHome={goHome}
        onGoToMap={onGoToMap}
      />
    );
  }

  return (
    <main className="main main-kills">
      <div className="kills-page">
        <div className="kills-page-nav-row">
          <BackToMapButton onClick={onGoToMap} />
          <button type="button" className="detail-back" onClick={onGoToWars}>
            <Swords size={14} strokeWidth={2} />
            Wars
          </button>
        </div>

        <div className="kills-header">
          <p className="eyebrow">Kills & Intel</p>
          <h2>{tabLabel}</h2>
        </div>

        {tab !== "trackedplayers" && (
        <form className="kills-character-search-form" onSubmit={handleSearchCharacter}>
          <div className="kills-add-combobox">
            <input
              type="text"
              placeholder="Search a character, corporation, or alliance"
              value={characterQuery}
              onChange={(e) => setCharacterQuery(e.target.value)}
              onKeyDown={handleCharacterKeyDown}
              onFocus={() => characterSuggestions.length > 0 && setCharacterSuggestionsOpen(true)}
              onBlur={() => setTimeout(() => setCharacterSuggestionsOpen(false), 120)}
              disabled={searchingCharacter}
            />
            {characterSuggestionsOpen && (
              <div className="gatecheck-slot-results kills-add-suggestions">
                {characterSuggestions.map((match, i) => (
                  <button
                    key={`${match.kind}-${match.id}`}
                    type="button"
                    className={i === characterHighlightIndex ? "kills-add-suggestion-active" : undefined}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => pickCharacterSuggestion(match)}
                  >
                    <img
                      className={`kills-character-suggestion-portrait${match.kind === "character" ? "" : " kills-add-suggestion-logo"}`}
                      src={
                        match.kind === "character"
                          ? `https://images.evetech.net/characters/${match.id}/portrait?size=32`
                          : match.kind === "corporation"
                            ? `https://images.evetech.net/corporations/${match.id}/logo?size=32`
                            : `https://images.evetech.net/alliances/${match.id}/logo?size=32`
                      }
                      alt=""
                    />
                    {match.name}
                    {match.kind !== "character" && (
                      <span className="kills-add-suggestion-kind">{match.kind === "corporation" ? "Corp" : "Alliance"}</span>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>
          <button type="submit" disabled={searchingCharacter || !characterQuery.trim()}>
            <Search size={14} strokeWidth={2} />
            {searchingCharacter ? "Searching..." : "Search"}
          </button>
        </form>
        )}

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

        {tab === "tracked" ? (
          <TrackedSystemsFeed
            onSelectKill={pushKillDetail}
            onSelectCharacter={pushCharacter}
            onSelectSystem={pushSystem}
            onSelectCorporation={pushCorporation}
            onSelectAlliance={pushAlliance}
          />
        ) : tab === "recent" ? (
          <RecentKillsFeed
            onSelectKill={pushKillDetail}
            onSelectCharacter={pushCharacter}
            onSelectSystem={pushSystem}
            onSelectCorporation={pushCorporation}
            onSelectAlliance={pushAlliance}
          />
        ) : tab === "battles" ? (
          <BattleReportsFeed
            onSelectKill={pushKillDetail}
            onSelectCharacter={pushCharacter}
            onSelectSystem={pushSystem}
            onSelectCorporation={pushCorporation}
            onSelectAlliance={pushAlliance}
          />
        ) : tab === "reports" ? (
          <>
            <KillHistoryBackfillBar />
            <KillReportsFeed
              onSelectKill={pushKillDetail}
              onSelectCharacter={pushCharacter}
              onSelectSystem={pushSystem}
              onSelectCorporation={pushCorporation}
              onSelectAlliance={pushAlliance}
            />
          </>
        ) : tab === "topstats" ? (
          <>
            <KillHistoryBackfillBar />
            <TopKillStatsFeed onSelectCharacter={pushCharacter} onSelectCorporation={pushCorporation} onSelectAlliance={pushAlliance} />
          </>
        ) : (
          <TrackedEntitiesPanel />
        )}
      </div>
    </main>
  );
}

export default KillsIntel;
