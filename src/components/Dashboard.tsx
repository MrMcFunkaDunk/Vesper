import { useEffect, useState } from "react";
import { Plus } from "lucide-react";
import StatusChip from "./StatusChip";
import CharacterCard from "./CharacterCard";
import { getCharacterOverview, type CharacterOverview, type Session, type SessionCharacter } from "../lib/eve";

interface DashboardProps {
  session: Session;
  onSwitch: (id: number) => void;
  onAdd: () => Promise<void>;
}

function Dashboard({ session, onSwitch, onAdd }: DashboardProps) {
  const [overviews, setOverviews] = useState<Record<number, CharacterOverview | null>>({});
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const characterIds = session.characters.map((c) => c.id).join(",");

  function fetchOverview(character: SessionCharacter) {
    getCharacterOverview(character.id)
      .then((overview) => setOverviews((prev) => ({ ...prev, [character.id]: overview })))
      .catch((err) => {
        console.error(`Failed to load overview for ${character.name}`, err);
        setOverviews((prev) => ({ ...prev, [character.id]: null }));
      });
  }

  useEffect(() => {
    session.characters.forEach(fetchOverview);
    // Re-fetch when the connected character list changes; handleAccountAction
    // covers the case where an existing character's tokens change instead.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [characterIds]);

  // Adding a character and reconnecting an existing one both go through EVE
  // SSO the same way. A reconnect doesn't change the character ID list, so
  // the effect above wouldn't re-fetch on its own - re-fetch explicitly once
  // the login flow completes, for whichever characters are on screen now.
  //
  // Guarded against re-entry and reports failures visibly: a silent failure
  // here (e.g. the loopback port briefly unavailable) previously looked
  // identical to "nothing happened" from the user's side.
  async function handleAccountAction() {
    if (pending) return;
    setPending(true);
    setError("");
    try {
      await onAdd();
      session.characters.forEach(fetchOverview);
    } catch (err) {
      console.error("Sign-in failed", err);
      setError(String(err));
    } finally {
      setPending(false);
    }
  }

  const activeCharacter =
    session.characters.find((c) => c.id === session.active_character_id) ?? session.characters[0];

  return (
    <main className="main main-dashboard">
      <div className="dashboard">
        <div className="dashboard-header">
          <p className="eyebrow">Operations Overview</p>
          <h2>Welcome back, {activeCharacter.name}</h2>
          <StatusChip label={activeCharacter.name} value="Connected" tone="online" />
          {error && <p className="dashboard-error">{error}</p>}
        </div>

        <div className="character-grid">
          {session.characters.map((character) => (
            <CharacterCard
              key={character.id}
              character={character}
              overview={overviews[character.id]}
              isActive={character.id === session.active_character_id}
              pending={pending}
              onSelect={() => onSwitch(character.id)}
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
            <span>{pending ? "Connecting..." : "Add Character"}</span>
            <span className="character-card-add-hint">Sign in with EVE to get started</span>
          </button>
        </div>
      </div>
    </main>
  );
}

export default Dashboard;
