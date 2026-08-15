import { useEffect, useState } from "react";
import TrackedSystemsFeed from "./TrackedSystemsFeed";
import RecentKillsFeed from "./RecentKillsFeed";
import KillDetailView from "./KillDetailView";
import CharacterKillboard from "./CharacterKillboard";

type KillsTab = "tracked" | "recent";

const TABS: { id: KillsTab; label: string }[] = [
  { id: "tracked", label: "Tracked Systems" },
  { id: "recent", label: "Most Recent Kills" },
];

type KillsView = { type: "feed" } | { type: "killDetail"; killmailId: number } | { type: "character"; characterId: number };

interface KillsIntelProps {
  /** A killmail to jump straight into, e.g. from clicking a kill in the Map's live ticker. */
  initialKillmailId?: number | null;
  onConsumeInitialKillmail?: () => void;
}

function KillsIntel({ initialKillmailId, onConsumeInitialKillmail }: KillsIntelProps) {
  const [tab, setTab] = useState<KillsTab>("tracked");
  // A small navigation stack rather than one flag, since kill detail and
  // character killboard link to each other in both directions (a kill's
  // attackers link to their killboard, a killboard's rows link back to
  // kill detail) - "back" needs to unwind wherever that chain actually
  // came from, not always land on the feed list.
  const [stack, setStack] = useState<KillsView[]>(
    initialKillmailId != null ? [{ type: "feed" }, { type: "killDetail", killmailId: initialKillmailId }] : [{ type: "feed" }],
  );

  useEffect(() => {
    if (initialKillmailId != null) {
      onConsumeInitialKillmail?.();
    }
    // Only meant to consume the value this component mounted with, so it
    // doesn't re-fire on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const current = stack[stack.length - 1];

  function pushKillDetail(killmailId: number) {
    setStack((s) => [...s, { type: "killDetail", killmailId }]);
  }

  function pushCharacter(characterId: number) {
    setStack((s) => [...s, { type: "character", characterId }]);
  }

  function goBack() {
    setStack((s) => (s.length > 1 ? s.slice(0, -1) : s));
  }

  function goHome() {
    setStack([{ type: "feed" }]);
  }

  const tabLabel = TABS.find((t) => t.id === tab)!.label;

  if (current.type === "killDetail") {
    return (
      <KillDetailView
        killmailId={current.killmailId}
        onBack={goBack}
        onSelectCharacter={pushCharacter}
        rootLabel={tabLabel}
        onGoHome={goHome}
      />
    );
  }

  if (current.type === "character") {
    return (
      <CharacterKillboard
        characterId={current.characterId}
        onBack={goBack}
        onSelectKill={pushKillDetail}
        onSelectCharacter={pushCharacter}
        rootLabel={tabLabel}
        onGoHome={goHome}
      />
    );
  }

  return (
    <main className="main main-kills">
      <div className="kills-page">
        <div className="kills-header">
          <p className="eyebrow">Kills & Intel</p>
          <h2>{tab === "tracked" ? "Tracked Systems" : "Most Recent Kills"}</h2>
        </div>

        <div className="kills-tabs">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              className={`kills-tab ${tab === t.id ? "kills-tab-active" : ""}`}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>

        {tab === "tracked" ? (
          <TrackedSystemsFeed onSelectKill={pushKillDetail} onSelectCharacter={pushCharacter} />
        ) : (
          <RecentKillsFeed onSelectKill={pushKillDetail} onSelectCharacter={pushCharacter} />
        )}
      </div>
    </main>
  );
}

export default KillsIntel;
