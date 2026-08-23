import { useEffect, useState, type FormEvent } from "react";
import { Search, X } from "lucide-react";
import { searchCharactersLive, searchEntitiesLive, type CharacterMatch, type EntityMatch } from "../lib/kills";
import { useTrackedEntities } from "../hooks/useTrackedEntities";
import type { TrackedEntityKind } from "../lib/trackedEntities";

interface Suggestion {
  id: number;
  name: string;
  kind: TrackedEntityKind;
}

const KIND_LABEL: Record<TrackedEntityKind, string> = {
  character: "Character",
  corporation: "Corporation",
  alliance: "Alliance",
};

function thumbnailUrl(kind: TrackedEntityKind, id: number): string {
  if (kind === "character") return `https://images.evetech.net/characters/${id}/portrait?size=256`;
  if (kind === "corporation") return `https://images.evetech.net/corporations/${id}/logo?size=256`;
  return `https://images.evetech.net/alliances/${id}/logo?size=256`;
}

function TrackedEntitiesPanel() {
  const { entities, loading, toggle } = useTrackedEntities();
  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < 3) {
      setSuggestions([]);
      setSuggestionsOpen(false);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      Promise.all([searchCharactersLive(trimmed), searchEntitiesLive(trimmed)])
        .then(([characterResults, entityResults]: [CharacterMatch[], EntityMatch[]]) => {
          if (cancelled) return;
          const merged: Suggestion[] = [
            ...characterResults.map((c): Suggestion => ({ id: c.id, name: c.name, kind: "character" })),
            ...entityResults.map((e): Suggestion => ({ id: e.id, name: e.name, kind: e.is_alliance ? "alliance" : "corporation" })),
          ];
          setSuggestions(merged);
          setSuggestionsOpen(merged.length > 0);
        })
        .catch(() => {
          if (!cancelled) setSuggestions([]);
        });
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query]);

  function handleAdd(s: Suggestion) {
    setQuery("");
    setSuggestions([]);
    setSuggestionsOpen(false);
    toggle(s.id, s.name, s.kind);
  }

  function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (suggestions.length > 0) handleAdd(suggestions[0]);
  }

  return (
    <div className="tracked-players-panel">
      <form className="kills-character-search-form" onSubmit={handleSubmit}>
        <div className="kills-add-combobox">
          <input
            type="text"
            placeholder="Search a character, corporation, or alliance"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onFocus={() => suggestions.length > 0 && setSuggestionsOpen(true)}
            onBlur={() => setTimeout(() => setSuggestionsOpen(false), 120)}
          />
          {suggestionsOpen && (
            <div className="gatecheck-slot-results kills-add-suggestions">
              {suggestions.map((s) => (
                <button key={`${s.kind}:${s.id}`} type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => handleAdd(s)}>
                  {s.name}
                  <span className="kills-add-suggestion-kind">{KIND_LABEL[s.kind]}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        <button type="submit" disabled={suggestions.length === 0}>
          <Search size={14} strokeWidth={2} />
          Search
        </button>
      </form>

      {loading ? (
        <p className="detail-empty">Loading tracked entities...</p>
      ) : entities.length === 0 ? (
        <p className="detail-empty">Not tracking anyone yet.</p>
      ) : (
        <div className="tracked-entity-grid">
          {entities.map((e) => (
            <div key={`${e.kind}:${e.entity_id}`} className="tracked-entity-card">
              <button
                type="button"
                className="tracked-entity-card-remove"
                onClick={() => toggle(e.entity_id, e.entity_name, e.kind)}
                aria-label={`Stop tracking ${e.entity_name}`}
                title="Stop tracking"
              >
                <X size={13} strokeWidth={2.5} />
              </button>
              <img
                className={`tracked-entity-card-image${e.kind !== "character" ? " tracked-entity-card-image-square" : ""}`}
                src={thumbnailUrl(e.kind, e.entity_id)}
                alt=""
              />
              <span className="tracked-entity-card-name">{e.entity_name}</span>
              <span className="tracked-entity-card-kind">{KIND_LABEL[e.kind]}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default TrackedEntitiesPanel;
