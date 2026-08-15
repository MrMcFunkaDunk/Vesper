import { useState } from "react";
import TrackedSystemsFeed from "./TrackedSystemsFeed";
import RecentKillsFeed from "./RecentKillsFeed";
import KillDetailView from "./KillDetailView";

type KillsTab = "tracked" | "recent";

const TABS: { id: KillsTab; label: string }[] = [
  { id: "tracked", label: "Tracked Systems" },
  { id: "recent", label: "Most Recent Kills" },
];

function KillsIntel() {
  const [tab, setTab] = useState<KillsTab>("tracked");
  const [selectedKillId, setSelectedKillId] = useState<number | null>(null);

  if (selectedKillId != null) {
    return <KillDetailView killmailId={selectedKillId} onBack={() => setSelectedKillId(null)} />;
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
          <TrackedSystemsFeed onSelectKill={setSelectedKillId} />
        ) : (
          <RecentKillsFeed onSelectKill={setSelectedKillId} />
        )}
      </div>
    </main>
  );
}

export default KillsIntel;
