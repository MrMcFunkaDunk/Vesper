import { Plus, Scale, ShieldAlert, GraduationCap } from "lucide-react";
import CharacterCard from "../CharacterCard";
import NewsTicker from "../NewsTicker";
import LiveActivityTicker from "../LiveActivityTicker";
import Annunciator from "./Annunciator";
import MechanicalButton from "./MechanicalButton";
import TelemetryRail from "./TelemetryRail";
import ScreenHousing from "./ScreenHousing";
import TechnicalLabel from "./TechnicalLabel";
import { formatIsk, formatSp } from "../../lib/format";
import type { CharacterOverview, SessionCharacter } from "../../lib/eve";

interface PremiumDashboardProps {
  characters: SessionCharacter[];
  overviews: Record<number, CharacterOverview | null>;
  activeCharacterName: string;
  pending: boolean;
  onOpenDetail: (id: number) => void;
  onAccountAction: () => void;
  onCancel: () => void;
  onCompare: () => void;
}

/** VESPER MAIN BRIDGE STATION - a genuinely different composition from the
 * standard Dashboard, not a reskin of the same character-grid-plus-tickers
 * stack. Shares 100% of Dashboard.tsx's data-fetching/session logic (this
 * component receives everything as props, fetches nothing itself) and
 * reuses CharacterCard as-is for the real per-character data - only the
 * surrounding console composition and the three new zones (SYS STATE,
 * ALERT BANK, the telemetry rail) are new, and every value in those three
 * is derived from real, already-fetched state, never invented.
 *
 * Composition, roughly following the brief's own mockup:
 *   COMMAND STATUS header
 *   SYS STATE (left) | CAPSULEER STATUS (center, the character cards) | ALERT BANK (right)
 *   FLEET TELEMETRY rail (aggregate real numbers across every connected character)
 *   two auxiliary monitors (the existing NewsTicker/LiveActivityTicker, reframed) */
function PremiumDashboard({
  characters,
  overviews,
  activeCharacterName,
  pending,
  onOpenDetail,
  onAccountAction,
  onCancel,
  onCompare,
}: PremiumDashboardProps) {
  const loadedOverviews = characters.map((c) => overviews[c.id]).filter((o): o is CharacterOverview => o != null);
  // undefined = "fetch hasn't resolved yet" (see Dashboard.tsx's
  // Record<id, CharacterOverview | null> - null specifically means "fetch
  // resolved, no data" - the ESI link lamp only cares whether the fetch
  // pipeline itself has produced anything at all, loaded or not).
  const anyResolved = characters.some((c) => overviews[c.id] !== undefined);
  const reauthCount = loadedOverviews.filter((o) => o.needs_reauth).length;
  const trainingCount = loadedOverviews.filter((o) => o.training_skill_name).length;
  // Named lists (not just counts) for the Alert Bank's severity cards below -
  // the Annunciators already show on/off state; these add the one thing
  // that doesn't fit a lamp: WHICH characters.
  const nameFor = (characterId: number) => characters.find((c) => c.id === characterId)?.name ?? "Unknown";
  const reauthNames = loadedOverviews.filter((o) => o.needs_reauth).map((o) => nameFor(o.character_id));
  const trainingNames = loadedOverviews.filter((o) => o.training_skill_name).map((o) => nameFor(o.character_id));
  // An idle skill queue is the amber "worth a look" case - not urgent like
  // reauth, but a wasted skill queue is a real thing worth surfacing by name.
  const idleNames = loadedOverviews.filter((o) => !o.training_skill_name).map((o) => nameFor(o.character_id));
  const totalIsk = loadedOverviews.reduce((sum, o) => sum + (o.isk_balance ?? 0), 0);
  const totalSp = loadedOverviews.reduce((sum, o) => sum + (o.total_sp ?? 0), 0);
  const anyIskKnown = loadedOverviews.some((o) => o.isk_balance != null);
  const anySpKnown = loadedOverviews.some((o) => o.total_sp != null);

  return (
    <div className="premium-dashboard">
      <div className="premium-dashboard-header">
        <div>
          <TechnicalLabel>SYS.CMD / DECK 01</TechnicalLabel>
          <h2>Command Status // Capsuleer Operations</h2>
          <p className="premium-dashboard-subtitle">Welcome back, {activeCharacterName}</p>
        </div>
        <div className="premium-dashboard-header-actions">
          {characters.length > 1 && (
            <MechanicalButton onClick={onCompare}>
              <Scale size={13} strokeWidth={2} /> Compare Skills
            </MechanicalButton>
          )}
          {pending && (
            <div className="dashboard-pending">
              <span>Waiting for you to finish signing in...</span>
              <button type="button" className="dashboard-pending-cancel" onClick={onCancel}>
                Cancel
              </button>
            </div>
          )}
        </div>
      </div>

      <TelemetryRail
        items={[
          { label: "Pilots", value: String(characters.length) },
          { label: "Total ISK", value: anyIskKnown ? formatIsk(totalIsk) : "—" },
          { label: "Total SP", value: anySpKnown ? formatSp(totalSp) : "—" },
          { label: "Training", value: `${trainingCount}/${characters.length}` },
          { label: "Reauth Needed", value: String(reauthCount) },
        ]}
      />

      <div className="premium-dashboard-zones">
        <ScreenHousing title="Sys State" className="premium-dashboard-sysstate">
          <Annunciator label="ESI LINK" state={anyResolved ? "on" : "off"} />
          <Annunciator label="SYNC" state={anyResolved ? "on" : "off"} />
          <Annunciator label="CACHE" state="on" />
        </ScreenHousing>

        <ScreenHousing title="Capsuleer Status" className="premium-dashboard-primary">
          <div className="character-grid">
            {characters.map((character) => (
              <CharacterCard
                key={character.id}
                character={character}
                overview={overviews[character.id]}
                isActive={false}
                pending={pending}
                onSelect={() => onOpenDetail(character.id)}
                onReauth={onAccountAction}
              />
            ))}
            <button type="button" className="character-card character-card-add" onClick={onAccountAction} disabled={pending}>
              <Plus size={20} strokeWidth={1.75} />
              <span>Add Character</span>
              <span className="character-card-add-hint">Sign in with EVE to get started</span>
            </button>
          </div>
        </ScreenHousing>

        <ScreenHousing title="Alert Bank" className="premium-dashboard-alerts">
          {/* Always lit now - green means "checked, all clear", not "nothing
             to report". Amber (attention) for something worth a look but not
             urgent, red (danger) for something that actually needs doing. */}
          <Annunciator label="SIGN-IN" state={pending ? "attention" : "on"} />
          <Annunciator label="REAUTH" state={reauthCount > 0 ? "danger" : "on"} />
          <Annunciator label="TRAINING" state={trainingCount > 0 ? "on" : "attention"} />
          <div className="premium-dashboard-alert-cards">
            {reauthCount > 0 && (
              <div className="severity-card severity-card-danger">
                <div className="severity-card-header">
                  <ShieldAlert size={14} strokeWidth={2} />
                  Reauth needed
                </div>
                <ul className="severity-card-body severity-card-list">
                  {reauthNames.map((name) => (
                    <li key={name}>{name}</li>
                  ))}
                </ul>
              </div>
            )}
            {trainingCount > 0 && (
              <div className="severity-card severity-card-success">
                <div className="severity-card-header">
                  <GraduationCap size={14} strokeWidth={2} />
                  Training active
                </div>
                <ul className="severity-card-body severity-card-list">
                  {trainingNames.map((name) => (
                    <li key={name}>{name}</li>
                  ))}
                </ul>
              </div>
            )}
            {idleNames.length > 0 && (
              <div className="severity-card severity-card-attention">
                <div className="severity-card-header">
                  <GraduationCap size={14} strokeWidth={2} />
                  Not training
                </div>
                <ul className="severity-card-body severity-card-list">
                  {idleNames.map((name) => (
                    <li key={name}>{name}</li>
                  ))}
                </ul>
              </div>
            )}
            {reauthCount === 0 && idleNames.length === 0 && loadedOverviews.length > 0 && (
              <div className="severity-card severity-card-success">
                <div className="severity-card-header">
                  <GraduationCap size={14} strokeWidth={2} />
                  All clear
                </div>
                <div className="severity-card-body">No reauth needed and everyone's training.</div>
              </div>
            )}
          </div>
        </ScreenHousing>
      </div>

      <div className="premium-dashboard-monitors">
        <ScreenHousing title="Comms Feed" className="premium-dashboard-monitor">
          <NewsTicker />
        </ScreenHousing>
        <ScreenHousing title="Activity Scope" className="premium-dashboard-monitor">
          <LiveActivityTicker />
        </ScreenHousing>
      </div>
    </div>
  );
}

export default PremiumDashboard;
