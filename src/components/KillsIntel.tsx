import { useEffect, useState } from "react";
import TrackedSystemsFeed from "./TrackedSystemsFeed";
import RecentKillsFeed from "./RecentKillsFeed";
import KillDetailView from "./KillDetailView";
import CharacterKillboard from "./CharacterKillboard";
import SystemKillboard, { type SystemSummary } from "./SystemKillboard";
import BackToMapButton from "./BackToMapButton";

type KillsTab = "tracked" | "recent";

const TABS: { id: KillsTab; label: string }[] = [
  { id: "tracked", label: "Tracked Systems" },
  { id: "recent", label: "Most Recent Kills" },
];

type KillsView =
  | { type: "feed" }
  | { type: "killDetail"; killmailId: number }
  | { type: "character"; characterId: number }
  | { type: "system"; system: SystemSummary };

interface KillsIntelProps {
  /** A killmail to jump straight into, e.g. from clicking a kill in the Map's live ticker. */
  initialKillmailId?: number | null;
  onConsumeInitialKillmail?: () => void;
  /** A system to jump straight into, e.g. from clicking a Gate Check row's "Kills & Intel" link. */
  initialSystem?: SystemSummary | null;
  onConsumeInitialSystem?: () => void;
  /** A character to jump straight into, e.g. from clicking a name in the Dashboard's Kill Log tab. */
  initialCharacterId?: number | null;
  onConsumeInitialCharacter?: () => void;
  onGoToMap: () => void;
}

function KillsIntel({
  initialKillmailId,
  onConsumeInitialKillmail,
  initialSystem,
  onConsumeInitialSystem,
  initialCharacterId,
  onConsumeInitialCharacter,
  onGoToMap,
}: KillsIntelProps) {
  const [tab, setTab] = useState<KillsTab>("tracked");
  // A small navigation stack rather than one flag, since kill detail and
  // character killboard link to each other in both directions (a kill's
  // attackers link to their killboard, a killboard's rows link back to
  // kill detail) - "back" needs to unwind wherever that chain actually
  // came from, not always land on the feed list.
  const [stack, setStack] = useState<KillsView[]>(() => {
    if (initialKillmailId != null) return [{ type: "feed" }, { type: "killDetail", killmailId: initialKillmailId }];
    if (initialSystem) return [{ type: "feed" }, { type: "system", system: initialSystem }];
    if (initialCharacterId != null) return [{ type: "feed" }, { type: "character", characterId: initialCharacterId }];
    return [{ type: "feed" }];
  });

  useEffect(() => {
    if (initialKillmailId != null) {
      onConsumeInitialKillmail?.();
    }
    if (initialSystem) {
      onConsumeInitialSystem?.();
    }
    if (initialCharacterId != null) {
      onConsumeInitialCharacter?.();
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

  function pushSystem(system: SystemSummary) {
    setStack((s) => [...s, { type: "system", system }]);
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
        onSelectSystem={pushSystem}
        rootLabel={tabLabel}
        onGoHome={goHome}
        onGoToMap={onGoToMap}
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
        onSelectSystem={pushSystem}
        rootLabel={tabLabel}
        onGoHome={goHome}
        onGoToMap={onGoToMap}
      />
    );
  }

  if (current.type === "system") {
    return (
      <SystemKillboard
        system={current.system}
        onBack={goBack}
        onSelectKill={pushKillDetail}
        onSelectCharacter={pushCharacter}
        onSelectSystem={pushSystem}
        rootLabel={tabLabel}
        onGoHome={goHome}
        onGoToMap={onGoToMap}
      />
    );
  }

  return (
    <main className="main main-kills">
      <div className="kills-page">
        <BackToMapButton onClick={onGoToMap} />

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
          <TrackedSystemsFeed onSelectKill={pushKillDetail} onSelectCharacter={pushCharacter} onSelectSystem={pushSystem} />
        ) : (
          <RecentKillsFeed onSelectKill={pushKillDetail} onSelectCharacter={pushCharacter} onSelectSystem={pushSystem} />
        )}
      </div>
    </main>
  );
}

export default KillsIntel;
