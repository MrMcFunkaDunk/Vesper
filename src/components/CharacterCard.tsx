import type { CharacterOverview, SessionCharacter } from "../lib/eve";

interface CharacterCardProps {
  character: SessionCharacter;
  overview: CharacterOverview | null | undefined;
  isActive: boolean;
  onSelect: () => void;
  onReauth: () => void;
}

function formatIsk(value: number): string {
  return `${new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value)} ISK`;
}

function formatSp(value: number): string {
  return `${new Intl.NumberFormat("en-US").format(value)} SP`;
}

function formatTimeRemaining(iso: string): string {
  const diffMs = new Date(iso).getTime() - Date.now();
  if (diffMs <= 0) return "finishing soon";
  const totalMinutes = Math.floor(diffMs / 60000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function CharacterCard({ character, overview, isActive, onSelect, onReauth }: CharacterCardProps) {
  const loading = overview === undefined;

  return (
    <div
      className={`character-card${isActive ? " character-card-active" : ""}`}
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
    >
      <div className="character-card-header">
        <img className="character-card-portrait" src={character.portrait_url} alt="" />
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
            onClick={(e) => {
              e.stopPropagation();
              onReauth();
            }}
          >
            Reconnect
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
          <div className="character-card-location">
            {loading ? "" : [overview?.system_name, overview?.ship_type_name].filter(Boolean).join(" • ")}
          </div>
        </div>
      )}
    </div>
  );
}

export default CharacterCard;
