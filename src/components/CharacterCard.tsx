import type { PointerEvent as ReactPointerEvent } from "react";
import type { CharacterOverview, SessionCharacter } from "../lib/eve";
import { formatIsk, formatSp, formatTimeRemaining, formatQueueSummary } from "../lib/format";
import CloneStateBadge from "./CloneStateBadge";

interface CharacterCardProps {
  character: SessionCharacter;
  overview: CharacterOverview | null | undefined;
  isActive: boolean;
  pending: boolean;
  onSelect: () => void;
  onReauth: () => void;
  /** Drag-to-reorder passthrough (Dashboard's own "arrange your character
   * cards" control) - all optional so every other caller of this card
   * (Character Comparison, etc.) is unaffected. */
  dragRef?: (el: HTMLElement | null) => void;
  onDragPointerDown?: (e: ReactPointerEvent<HTMLElement>) => void;
  onDragPointerMove?: (e: ReactPointerEvent<HTMLElement>) => void;
  onDragPointerUp?: (e: ReactPointerEvent<HTMLElement>) => void;
  dragging?: boolean;
}

function CharacterCard({
  character,
  overview,
  isActive,
  pending,
  onSelect,
  onReauth,
  dragRef,
  onDragPointerDown,
  onDragPointerMove,
  onDragPointerUp,
  dragging,
}: CharacterCardProps) {
  const loading = overview === undefined;

  return (
    <div
      ref={dragRef}
      className={`character-card${isActive ? " character-card-active" : ""}${dragging ? " character-card-dragging" : ""}`}
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
      onPointerDown={onDragPointerDown}
      onPointerMove={onDragPointerMove}
      onPointerUp={onDragPointerUp}
    >
      <div className="character-card-header">
        <div className="character-card-portrait-wrap">
          <img className="character-card-portrait" src={character.portrait_url} alt="" />
          {!loading && <CloneStateBadge characterId={character.id} autoDetected={overview?.clone_state ?? null} />}
        </div>
        <div className="character-card-identity">
          <span className="character-card-name">{character.name}</span>
          <span className="character-card-corp">
            {overview?.corporation_name ?? "—"}
            {overview?.alliance_name ? ` • ${overview.alliance_name}` : ""}
          </span>
        </div>
      </div>

      {overview?.needs_reauth ? (
        <div className="character-card-reauth">
          <p>Sign in again to unlock wallet, skills, and location data.</p>
          <button
            type="button"
            className="character-card-reauth-btn"
            disabled={pending}
            onClick={(e) => {
              e.stopPropagation();
              onReauth();
            }}
          >
            {pending ? "Connecting..." : "Reconnect"}
          </button>
        </div>
      ) : (
        <div className="character-card-stats">
          <div className="character-card-isk">
            {loading ? "—" : overview?.isk_balance != null ? formatIsk(overview.isk_balance) : "—"}
          </div>
          <div className="character-card-sp">
            {loading ? "—" : overview?.total_sp != null ? formatSp(overview.total_sp) : "—"}
          </div>
          <div className="character-card-training">
            {loading
              ? "Loading..."
              : overview?.training_skill_name
                ? `Training: ${overview.training_skill_name}${
                    overview.training_finish_date ? ` (${formatTimeRemaining(overview.training_finish_date)})` : ""
                  }`
                : "Not training"}
          </div>
          {!loading && overview && formatQueueSummary(overview.queue_length, overview.queue_ends_at) && (
            <div className="character-card-queue">{formatQueueSummary(overview.queue_length, overview.queue_ends_at)}</div>
          )}
          <div className="character-card-location">
            {loading ? "" : [overview?.system_name, overview?.ship_type_name].filter(Boolean).join(" • ")}
          </div>
        </div>
      )}
    </div>
  );
}

export default CharacterCard;
