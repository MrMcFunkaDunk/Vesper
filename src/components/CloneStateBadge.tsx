import { useCloneStateOverride } from "../hooks/useCloneStateOverride";

interface CloneStateBadgeProps {
  characterId: number;
  autoDetected: string | null;
}

/** Ω Omega / α Alpha indicator, click to cycle. ESI has no clone-state field
 * anywhere, so the auto-detected value (skill-cap based, computed backend-side)
 * is just a starting point - clicking cycles Auto → Alpha → Omega → Auto,
 * persisted locally per character. */
function CloneStateBadge({ characterId, autoDetected }: CloneStateBadgeProps) {
  const { overrides, cycleOverride } = useCloneStateOverride();
  const manual = overrides[characterId];
  const effective = manual ?? autoDetected;

  function handleClick(e: React.MouseEvent) {
    e.stopPropagation();
    cycleOverride(characterId, autoDetected);
  }

  if (!effective) {
    return (
      <button type="button" className="clone-state-badge clone-state-unset" onClick={handleClick}>
        Set clone state
      </button>
    );
  }

  const isOmega = effective === "Omega";
  return (
    <button
      type="button"
      className={`clone-state-badge ${isOmega ? "clone-state-omega" : "clone-state-alpha"}`}
      onClick={handleClick}
      title={manual ? "Manually set - click to change" : "Auto-detected from trained skills - click to override"}
    >
      <span className="clone-state-glyph">{isOmega ? "Ω" : "α"}</span>
      {effective}
    </button>
  );
}

export default CloneStateBadge;
