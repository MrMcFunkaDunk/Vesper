import type { SessionCharacter } from "../lib/eve";

interface CharacterSelectorStripProps {
  characters: SessionCharacter[];
  selectedId: number | null;
  onSelect: (id: number) => void;
}

/** A row of portrait pills for picking which connected character a
 * multi-character page (Mail, Wallet & Market) is currently showing.
 * Hidden entirely for a single-character account, where there's nothing to switch between. */
function CharacterSelectorStrip({ characters, selectedId, onSelect }: CharacterSelectorStripProps) {
  if (characters.length <= 1) return null;
  return (
    <div className="char-selector-strip">
      {characters.map((c) => (
        <button
          key={c.id}
          type="button"
          className={`char-selector-pill${c.id === selectedId ? " char-selector-pill-active" : ""}`}
          onClick={() => onSelect(c.id)}
        >
          <img src={c.portrait_url} alt="" className="char-selector-portrait" />
          {c.name}
        </button>
      ))}
    </div>
  );
}

export default CharacterSelectorStrip;
