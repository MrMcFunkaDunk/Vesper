import { useEffect, useState } from "react";
import { Swords, Search } from "lucide-react";
import { getWarsForEntity, resolveEntityNames, type WarSummary, type WarParty } from "../lib/wars";
import { searchCharactersLive, searchEntitiesLive, getCharacterProfile, getCorporationProfile, type CharacterMatch, type EntityMatch } from "../lib/kills";
import { useErrorReporter } from "../hooks/useErrorReporter";
import { formatRelativeTime } from "../lib/format";
import CharacterSelectorStrip from "./CharacterSelectorStrip";
import type { SessionCharacter } from "../lib/eve";

interface WarsPageProps {
  characters: SessionCharacter[];
}

interface SelectedEntity {
  corporationId: number | null;
  corporationName: string | null;
  allianceId: number | null;
  allianceName: string | null;
  contextLabel: string;
}

type Suggestion = { kind: "character"; id: number; name: string } | { kind: "corporation" | "alliance"; id: number; name: string };

function partyLabel(party: WarParty | null, names: Record<string, string>): string {
  if (!party) return "Unknown";
  return names[String(party.id)] ?? `${party.is_alliance ? "Alliance" : "Corporation"} #${party.id}`;
}

function isEntitySide(party: WarParty | null, entity: SelectedEntity): boolean {
  if (!party) return false;
  if (party.is_alliance) return entity.allianceId != null && party.id === entity.allianceId;
  return entity.corporationId != null && party.id === entity.corporationId;
}

/** DOTLAN's own live activity feed already surfaces sovereignty/FW events -
 * this page is the complement: real ESI war state for a specific corp or
 * alliance, since ESI has no corp/alliance -> wars lookup of its own (see
 * wars.rs). Cross-linked from the Map screen and Kills & Intel per the
 * roadmap, both landing here. Search covers all three entity kinds -
 * character (proxies to their corp/alliance), corporation, and alliance -
 * since zKillboard's autocomplete returns all three from one query. */
function WarsPage({ characters }: WarsPageProps) {
  const [selectedCharacterId, setSelectedCharacterId] = useState<number | null>(characters[0]?.id ?? null);
  const [entity, setEntity] = useState<SelectedEntity | null>(null);
  const [wars, setWars] = useState<WarSummary[] | null>(null);
  const [names, setNames] = useState<Record<string, string>>({});
  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const reportError = useErrorReporter();

  // Resolve whichever character is selected (one of your own, or one found
  // via search) into their corp/alliance - that's what actually drives the
  // wars lookup.
  useEffect(() => {
    if (selectedCharacterId == null) return;
    let cancelled = false;
    getCharacterProfile(selectedCharacterId)
      .then((profile) => {
        if (cancelled) return;
        setEntity({
          corporationId: profile.corporation_id,
          corporationName: profile.corporation_name,
          allianceId: profile.alliance_id,
          allianceName: profile.alliance_name,
          contextLabel: profile.character_name,
        });
      })
      .catch((err) => reportError(`Failed to load character profile: ${String(err)}`));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCharacterId]);

  useEffect(() => {
    if (!entity) return;
    let cancelled = false;
    setWars(null);
    const entityIds = [entity.corporationId, entity.allianceId].filter((id): id is number => id != null);
    Promise.all(entityIds.map((id) => getWarsForEntity(id)))
      .then((lists) => {
        if (cancelled) return;
        const merged = new Map<number, WarSummary>();
        for (const list of lists) {
          for (const war of list) merged.set(war.id, war);
        }
        const result = [...merged.values()].sort((a, b) => b.declared.localeCompare(a.declared));
        setWars(result);
        const idsToResolve = new Set<number>();
        for (const war of result) {
          if (war.aggressor) idsToResolve.add(war.aggressor.id);
          if (war.defender) idsToResolve.add(war.defender.id);
          for (const ally of war.allies) idsToResolve.add(ally.id);
        }
        if (idsToResolve.size > 0) {
          resolveEntityNames([...idsToResolve])
            .then((resolved) => {
              if (!cancelled) setNames((prev) => ({ ...prev, ...resolved }));
            })
            .catch(() => {});
        }
      })
      .catch((err) => reportError(`Failed to load wars: ${String(err)}`));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entity]);

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < 3) {
      setSuggestions([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      Promise.all([searchCharactersLive(trimmed), searchEntitiesLive(trimmed)])
        .then(([characterResults, entityResults]: [CharacterMatch[], EntityMatch[]]) => {
          if (cancelled) return;
          const merged: Suggestion[] = [
            ...entityResults.map((e): Suggestion => ({ kind: e.is_alliance ? "alliance" : "corporation", id: e.id, name: e.name })),
            ...characterResults.map((c): Suggestion => ({ kind: "character", id: c.id, name: c.name })),
          ];
          setSuggestions(merged);
        })
        .catch(() => {});
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query]);

  function pickSuggestion(suggestion: Suggestion) {
    setQuery("");
    setSuggestions([]);
    if (suggestion.kind === "character") {
      setSelectedCharacterId(suggestion.id);
      return;
    }
    setSelectedCharacterId(null);
    if (suggestion.kind === "alliance") {
      setEntity({ corporationId: null, corporationName: null, allianceId: suggestion.id, allianceName: suggestion.name, contextLabel: suggestion.name });
      return;
    }
    // Corporation - also resolve its alliance affiliation for parity with
    // the character-driven flow, so a corp in an alliance shows both.
    setEntity({ corporationId: suggestion.id, corporationName: suggestion.name, allianceId: null, allianceName: null, contextLabel: suggestion.name });
    getCorporationProfile(suggestion.id)
      .then((profile) => {
        if (profile.alliance_id) {
          setEntity((prev) =>
            prev && prev.corporationId === suggestion.id
              ? { ...prev, allianceId: profile.alliance_id, allianceName: profile.alliance_name }
              : prev,
          );
        }
      })
      .catch(() => {});
  }

  return (
    <div className="wars-page">
      <div className="wars-page-header">
        <p className="eyebrow">
          <Swords size={14} strokeWidth={2} /> Wars
        </p>
        <h2>Active Wars</h2>
        <p className="wars-page-subtitle">
          Real ESI war state for a corporation or alliance. ESI has no direct corp/alliance lookup for this, so
          results come from a recently-synced window of wars - an old, never-formally-ended war could be missed.
        </p>
      </div>

      {characters.length > 0 && (
        <CharacterSelectorStrip characters={characters} selectedId={selectedCharacterId} onSelect={setSelectedCharacterId} />
      )}

      <div className="wars-search-row">
        <div className="wars-search-combobox">
          <Search size={15} strokeWidth={2} />
          <input
            type="text"
            placeholder="Search by character, corporation, or alliance..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        {suggestions.length > 0 && (
          <div className="wars-search-suggestions">
            {suggestions.map((s) => (
              <button key={`${s.kind}-${s.id}`} type="button" onClick={() => pickSuggestion(s)}>
                <span className={`wars-suggestion-kind wars-suggestion-kind-${s.kind}`}>{s.kind}</span>
                {s.name}
              </button>
            ))}
          </div>
        )}
      </div>

      {entity && (
        <p className="wars-entity-context">
          Showing wars for{" "}
          {entity.corporationName && <strong>{entity.corporationName}</strong>}
          {entity.corporationName && entity.allianceName && " / "}
          {entity.allianceName && <strong>{entity.allianceName}</strong>}
          {entity.contextLabel !== (entity.corporationName ?? entity.allianceName) && <> ({entity.contextLabel})</>}
        </p>
      )}

      {wars === null ? (
        <p className="detail-empty">Loading wars...</p>
      ) : wars.length === 0 ? (
        <p className="detail-empty">No active wars found for this corporation or alliance.</p>
      ) : (
        <div className="wars-list">
          {wars.map((war) => {
            const onOurSide = entity ? isEntitySide(war.aggressor, entity) || isEntitySide(war.defender, entity) : false;
            return (
              <div key={war.id} className={`wars-card${onOurSide ? " wars-card-involved" : ""}`}>
                <div className="wars-card-sides">
                  <span className="wars-card-aggressor">{partyLabel(war.aggressor, names)}</span>
                  <span className="wars-card-vs">vs</span>
                  <span className="wars-card-defender">{partyLabel(war.defender, names)}</span>
                </div>
                {war.allies.length > 0 && (
                  <p className="wars-card-allies">Allies: {war.allies.map((a) => partyLabel(a, names)).join(", ")}</p>
                )}
                <div className="wars-card-meta">
                  <span>Declared {formatRelativeTime(war.declared)}</span>
                  {war.mutual && <span className="wars-tag">Mutual</span>}
                  {war.open_for_allies && <span className="wars-tag">Open for allies</span>}
                  {war.retracted && <span className="wars-tag wars-tag-ending">Retracted - ending soon</span>}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default WarsPage;
