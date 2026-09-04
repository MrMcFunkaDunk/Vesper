import { RefreshCw } from "lucide-react";
import CloneStateBadge from "../CloneStateBadge";
import MechanicalButton from "./MechanicalButton";
import ScreenHousing from "./ScreenHousing";
import TelemetryRail from "./TelemetryRail";
import TechnicalLabel from "./TechnicalLabel";
import Annunciator from "./Annunciator";
import { formatIsk, formatSp, formatTimeRemaining, formatQueueSummary, remapAvailabilityText } from "../../lib/format";
import { BASE_ATTRIBUTE_VALUE } from "../../lib/skillTraining";
import type { CharacterAttributes, CharacterOverview, SessionCharacter } from "../../lib/eve";

interface PremiumCharacterHeaderProps {
  character: SessionCharacter;
  overview: CharacterOverview | null;
  attributes: CharacterAttributes | null;
  reconnecting: boolean;
  onReconnect: () => void;
}

/** PILOT ID plate - replaces .detail-header under a premium deck. Same data
 * CharacterDetail.tsx already fetches (this takes it all as props, fetches
 * nothing itself); only the composition changes, from a stacked identity
 * card to a console readout: a telemetry rail for the ISK/SP/security
 * figures instead of a "//"-separated text row, and an annunciator strip
 * for the two real boolean states (training, needs reauth) instead of
 * burying them in prose. Everything below it - the character rail, the tab
 * bar, every tab's own content - is untouched and renders identically to
 * the standard theme. */
function PremiumCharacterHeader({ character, overview, attributes, reconnecting, onReconnect }: PremiumCharacterHeaderProps) {
  const bio = [overview?.gender, overview?.race_name, overview?.bloodline_name].filter(Boolean).join(" · ");
  const locationPath = [overview?.region_name, overview?.constellation_name, overview?.system_name].filter(Boolean).join(" > ");

  return (
    <ScreenHousing title="Pilot ID" className="premium-character-header">
      <div className="premium-character-header-top">
        <div className="premium-character-portrait-wrap">
          <img className="detail-portrait" src={character.portrait_url} alt="" />
          <CloneStateBadge characterId={character.id} autoDetected={overview?.clone_state ?? null} />
        </div>
        <div className="premium-character-identity">
          <TechnicalLabel>{`PLT.${character.id}`}</TechnicalLabel>
          <h2>{character.name}</h2>
          {bio && <span className="detail-bio">{bio}</span>}
          <span className="detail-corp">
            {overview?.corporation_name ?? "—"}
            {overview?.alliance_name ? ` • ${overview.alliance_name}` : ""}
          </span>
          {locationPath && <span className="detail-location-path">Located in: {locationPath}</span>}
          {overview?.docked_at_name && <span className="detail-location-path">Docked at: {overview.docked_at_name}</span>}
        </div>
        <MechanicalButton
          onClick={onReconnect}
          disabled={reconnecting}
          title="Opens EVE SSO in your browser - sign in as this character again to grant any permissions added since it last logged in"
        >
          <RefreshCw size={13} strokeWidth={2} className={reconnecting ? "kills-sync-spinning" : ""} />
          {reconnecting ? "Reconnecting..." : "Reconnect"}
        </MechanicalButton>
      </div>

      <TelemetryRail
        items={[
          { label: "ISK Balance", value: overview?.isk_balance != null ? formatIsk(overview.isk_balance) : "—" },
          { label: "Total SP", value: overview?.total_sp != null ? formatSp(overview.total_sp) : "—" },
          {
            label: "Sec. Status",
            value: overview?.security_status != null ? overview.security_status.toFixed(2) : "—",
          },
          { label: "Location", value: [overview?.system_name, overview?.ship_type_name].filter(Boolean).join(" · ") || "—" },
        ]}
      />

      <div className="premium-character-annunciators">
        <Annunciator label="Training" state={overview?.training_skill_name ? "on" : "off"} />
        <Annunciator label="Reauth" state={overview?.needs_reauth ? "danger" : "off"} />
      </div>

      {overview?.training_skill_name && (
        <p className="detail-training">
          Training: {overview.training_skill_name}
          {overview.training_finish_date ? ` (${formatTimeRemaining(overview.training_finish_date)})` : ""}
          {formatQueueSummary(overview.queue_length, overview.queue_ends_at) && (
            <span className="detail-training-queue"> · {formatQueueSummary(overview.queue_length, overview.queue_ends_at)}</span>
          )}
        </p>
      )}

      {attributes && !attributes.needs_reauth && (
        <div className="attribute-row">
          {(
            [
              ["Int", attributes.intelligence],
              ["Per", attributes.perception],
              ["Cha", attributes.charisma],
              ["Wil", attributes.willpower],
              ["Mem", attributes.memory],
            ] as const
          ).map(([label, value]) => (
            <span key={label} className="attribute-pill" title={`${value} = ${BASE_ATTRIBUTE_VALUE} base + ${value - BASE_ATTRIBUTE_VALUE} remap`}>
              {label} <strong>{value}</strong>
            </span>
          ))}
          <span className="attribute-remap-note">{remapAvailabilityText(attributes)}</span>
        </div>
      )}
    </ScreenHousing>
  );
}

export default PremiumCharacterHeader;
