import { useEffect, useRef, useState } from "react";
import { Plus, Scale } from "lucide-react";
import StatusChip from "./StatusChip";
import CharacterCard from "./CharacterCard";
import NewsTicker from "./NewsTicker";
import LiveActivityTicker from "./LiveActivityTicker";
import CharacterComparisonView from "./CharacterComparisonView";
import {
  cancelLogin,
  getCharacterOverview,
  type CharacterOverview,
  type Session,
  type SessionCharacter,
} from "../lib/eve";
import { useErrorReporter } from "../hooks/useErrorReporter";
import { getAllCachedOverviews, setCachedOverview, isTransientServerError } from "../lib/overviewCache";

interface DashboardProps {
  session: Session;
  onOpenDetail: (id: number) => void;
  onAdd: () => Promise<void>;
}

function Dashboard({ session, onOpenDetail, onAdd }: DashboardProps) {
  // Hydrated from the last successful fetch (persisted to localStorage) so a
  // launch during Tranquility's daily downtime shows stale-but-real numbers
  // instead of every card stuck on "Loading..." with nothing to show.
  const [overviews, setOverviews] = useState<Record<number, CharacterOverview | null>>(() => getAllCachedOverviews());
  const [pending, setPending] = useState(false);
  const [comparing, setComparing] = useState(false);
  const cancelledRef = useRef(false);
  const reportError = useErrorReporter();
  const characterIds = session.characters.map((c) => c.id).join(",");

  function fetchOverview(character: SessionCharacter) {
    getCharacterOverview(character.id)
      .then((overview) => {
        setOverviews((prev) => ({ ...prev, [character.id]: overview }));
        setCachedOverview(character.id, overview);
      })
      .catch((err) => {
        // A gateway timeout / "tranquility unreachable" during downtime is
        // expected and self-resolving (auto-refresh will pick it up the
        // moment the server's back) - not worth an error modal. Whatever's
        // already on screen (cached or previously fetched) stays put rather
        // than being blanked out; only a character with genuinely nothing
        // yet falls back to the empty-state "—" placeholders.
        if (!isTransientServerError(String(err))) {
          reportError(`Failed to load overview for ${character.name}: ${String(err)}`);
        }
        setOverviews((prev) => (prev[character.id] !== undefined ? prev : { ...prev, [character.id]: null }));
      });
  }

  useEffect(() => {
    session.characters.forEach(fetchOverview);
    // Re-fetch when the connected character list changes; handleAccountAction
    // covers the case where an existing character's tokens change instead.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [characterIds]);

  // Keeps ISK/SP/training/queue on every card fresh without a manual reload,
  // matching the same auto-refresh cadence as the character detail page.
  // Failures are swallowed silently - a background poll hiccup shouldn't pop
  // an error toast while the user is just looking at the grid.
  useEffect(() => {
    const interval = setInterval(() => {
      session.characters.forEach((character) => {
        getCharacterOverview(character.id)
          .then((overview) => {
            setOverviews((prev) => ({ ...prev, [character.id]: overview }));
            setCachedOverview(character.id, overview);
          })
          .catch(() => {});
      });
    }, 120000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [characterIds]);

  // Adding a character and reconnecting an existing one both go through EVE
  // SSO the same way. A reconnect doesn't change the character ID list, so
  // the effect above wouldn't re-fetch on its own - re-fetch explicitly once
  // the login flow completes, for whichever characters are on screen now.
  //
  // Guarded against re-entry and reports failures visibly: a silent failure
  // here (e.g. the loopback port briefly unavailable) previously looked
  // identical to "nothing happened" from the user's side. handleCancel gives
  // a way out if the SSO page is slow to load or the flow just hangs,
  // instead of being stuck until the 5-minute backend timeout.
  async function handleAccountAction() {
    if (pending) return;
    setPending(true);
    try {
      await onAdd();
      session.characters.forEach(fetchOverview);
    } catch (err) {
      if (cancelledRef.current) {
        cancelledRef.current = false;
      } else {
        reportError(`Sign-in failed: ${String(err)}`);
      }
    } finally {
      setPending(false);
    }
  }

  async function handleCancel() {
    cancelledRef.current = true;
    await cancelLogin();
  }

  const activeCharacter =
    session.characters.find((c) => c.id === session.active_character_id) ?? session.characters[0];

  if (comparing) {
    return <CharacterComparisonView characters={session.characters} onClose={() => setComparing(false)} />;
  }

  return (
    <main className="main main-dashboard">
      <div className="dashboard">
        <div className="dashboard-header">
          <p className="eyebrow">Operations Overview</p>
          <h2>Welcome back, {activeCharacter.name}</h2>
          <StatusChip label={activeCharacter.name} value="Connected" tone="online" />
          {session.characters.length > 1 && (
            <button type="button" className="skill-action-btn dashboard-compare-btn" onClick={() => setComparing(true)}>
              <Scale size={13} strokeWidth={2} /> Compare Skills
            </button>
          )}
          {pending && (
            <div className="dashboard-pending">
              <span>Waiting for you to finish signing in...</span>
              <button type="button" className="dashboard-pending-cancel" onClick={handleCancel}>
                Cancel
              </button>
            </div>
          )}
        </div>

        <div className="character-grid">
          {session.characters.map((character) => (
            <CharacterCard
              key={character.id}
              character={character}
              overview={overviews[character.id]}
              isActive={character.id === session.active_character_id}
              pending={pending}
              onSelect={() => onOpenDetail(character.id)}
              onReauth={handleAccountAction}
            />
          ))}
          <button
            type="button"
            className="character-card character-card-add"
            onClick={handleAccountAction}
            disabled={pending}
          >
            <Plus size={20} strokeWidth={1.75} />
            <span>Add Character</span>
            <span className="character-card-add-hint">Sign in with EVE to get started</span>
          </button>
        </div>

        <NewsTicker />
        <LiveActivityTicker />
      </div>
    </main>
  );
}

export default Dashboard;
