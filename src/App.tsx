import { lazy, Suspense, useEffect, useState } from "react";
import Sidebar, { NAV_ITEMS } from "./components/Sidebar";
import TopBar from "./components/TopBar";
import MainContent from "./components/MainContent";
import Dashboard from "./components/Dashboard";
import ProximityFlashOverlay from "./components/ProximityFlashOverlay";
import UpdateBanner from "./components/UpdateBanner";

// Every other page is lazy-loaded - each one only needs its (often
// substantial, e.g. React Flow for the wormhole finder) code once the user
// actually navigates there, instead of all of it landing in the initial
// startup bundle alongside the shell and Dashboard.
const CharacterDetail = lazy(() => import("./components/CharacterDetail"));
const KillsIntel = lazy(() => import("./components/KillsIntel"));
const MapPage = lazy(() => import("./components/MapPage"));
const MailPage = lazy(() => import("./components/MailPage"));
const WalletMarketPage = lazy(() => import("./components/WalletMarketPage"));
const PlanetaryIndustry = lazy(() => import("./components/PlanetaryIndustry"));
const IntelCheck = lazy(() => import("./components/IntelCheck"));
const SettingsPage = lazy(() => import("./components/SettingsPage"));
const CalendarPage = lazy(() => import("./components/CalendarPage"));
const FittingsPage = lazy(() => import("./components/FittingsPage"));
const PathWormholeFinderPage = lazy(() => import("./components/PathWormholeFinderPage"));
const IndustryPage = lazy(() => import("./components/IndustryPage"));
const MiningPage = lazy(() => import("./components/MiningPage"));
const MultiboxPage = lazy(() => import("./components/MultiboxPage"));
import type { SystemSummary } from "./components/SystemKillboard";
import type { CorporationSummary } from "./components/CorporationKillboard";
import type { AllianceSummary } from "./components/AllianceKillboard";
import type { GateSummary } from "./components/GateKillboard";
import type { MarketItemRef } from "./components/MarketBrowser";
import LoginScreen from "./components/LoginScreen";
import { getSession, setActiveCharacter, logoutCharacter, startLogin, type Session } from "./lib/eve";
import { DASHBOARD_SCOPES } from "./lib/scopes";
import { useErrorReporter } from "./hooks/useErrorReporter";
import { CharacterLocationProvider } from "./hooks/useCharacterLocation";
import { ChainAutoMappingEffect } from "./hooks/useChainAutoMapping";
import { SkillQueueWatchEffect } from "./hooks/useSkillQueueWatch";
import { TrackedEntityEventsEffect } from "./hooks/useTrackedEntityEvents";
import ToastStack from "./components/ToastStack";
import { useDefaultLandingTab } from "./hooks/useDefaultLandingTab";
import { useReduceMotion } from "./hooks/useReduceMotion";
import { useTheme } from "./hooks/useTheme";
import "./App.css";
// Premium deck themes (Bulkhead/Cold Ballast/Command Deck) live entirely
// outside App.css, in their own small stylesheet architecture - never
// capable of altering the six standard themes above. premium-structure.css
// is scoped behind :root[data-theme="x"] selectors since it retrofits
// classes standard themes also use; premium-instruments.css isn't scoped
// the same way, since every class it styles (.annunciator,
// .mechanical-button, .screen-housing, .premium-dashboard*) belongs to
// brand-new components under src/components/premium/ that only ever
// render from behind an isPremiumTheme(theme) check in the first place -
// see that file's own header for why. Tokens first, then the shared
// component language every deck reads those tokens through, then the new
// hardware library + Premium Dashboard, then each deck's own
// distinguishing geometry.
import "./themes/premium/premium-tokens.css";
import "./themes/premium/premium-structure.css";
import "./themes/premium/premium-instruments.css";
import "./themes/premium/bulkhead.css";
import "./themes/premium/cold-ballast.css";
import "./themes/premium/command-deck.css";

function App() {
  const [activeId, setActiveId] = useDefaultLandingTab(NAV_ITEMS[0].id);
  useReduceMotion();
  useTheme();
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailCharacterId, setDetailCharacterId] = useState<number | null>(null);
  const [pendingKillmailId, setPendingKillmailId] = useState<number | null>(null);
  const [pendingSystem, setPendingSystem] = useState<SystemSummary | null>(null);
  const [pendingCharacterId, setPendingCharacterId] = useState<number | null>(null);
  const [pendingCorporation, setPendingCorporation] = useState<CorporationSummary | null>(null);
  const [pendingAlliance, setPendingAlliance] = useState<AllianceSummary | null>(null);
  const [pendingGate, setPendingGate] = useState<GateSummary | null>(null);
  const [pendingMarketItem, setPendingMarketItem] = useState<MarketItemRef | null>(null);
  const [pendingFitShipTypeId, setPendingFitShipTypeId] = useState<number | null>(null);
  const reportError = useErrorReporter();

  // The Map page owns real per-session state worth keeping warm across
  // navigation - the canvas's own zoom/pan, the heat map, and (via
  // useRecentActivity) the live kill feed it's already streaming - none of
  // which should have to rebuild from scratch every time the user leaves
  // and comes back. Rendered in a persistent sibling below instead of
  // inside the tab switch, so it mounts once on first visit and then just
  // toggles visibility with CSS from then on.
  const [mapVisited, setMapVisited] = useState(false);
  useEffect(() => {
    if (activeId === "map") setMapVisited(true);
  }, [activeId]);

  useEffect(() => {
    refreshSession();
  }, []);

  async function refreshSession() {
    setLoading(true);
    try {
      const next = await getSession();
      setSession(next);
    } catch (err) {
      reportError(String(err));
      // A transient failure here (disk hiccup, momentary lock) shouldn't
      // blank out a session that already loaded successfully - that would
      // force every character through EVE SSO again just to reappear in the
      // switcher, even though their stored tokens were never actually lost.
      // Only fall back to an empty session if we've never loaded one at all.
      setSession((prev) => prev ?? { characters: [], active_character_id: null });
    } finally {
      setLoading(false);
    }
  }

  const active = NAV_ITEMS.find((item) => item.id === activeId) ?? NAV_ITEMS[0];

  // Only the very first load (nothing fetched yet) blanks the whole app -
  // a character switch also flips `loading` briefly, but bouncing the
  // entire shell (sidebar, topbar, overlay) out and back in for that is
  // unnecessarily disruptive: it unmounts ProximityFlashOverlay mid-session,
  // which was causing a spurious red flash on every character click (its
  // effect sees whatever pulseToken already exists on remount and treats it
  // as a brand-new alert). Session is already loaded by then, so there's
  // nothing meaningful for a full loading screen to protect against.
  if (loading && session === null) {
    return <div className="app-loading">Loading...</div>;
  }

  if (!session || session.characters.length === 0) {
    return <LoginScreen onLoggedIn={refreshSession} />;
  }

  function handleSelectNav(id: string) {
    setActiveId(id);
    if (id !== "dashboard") {
      setDetailCharacterId(null);
    }
  }

  async function handleSwitch(id: number) {
    await setActiveCharacter(id);
    refreshSession();
  }

  function handleOpenDetail(id: number) {
    handleSwitch(id);
    setDetailCharacterId(id);
  }

  function handleOpenKillmail(killmailId: number) {
    setPendingKillmailId(killmailId);
    setActiveId("kills");
  }

  function handleOpenSystemKills(system: SystemSummary) {
    setPendingSystem(system);
    setActiveId("kills");
  }

  function handleOpenCharacterKillboard(characterId: number) {
    setPendingCharacterId(characterId);
    setActiveId("kills");
  }

  function handleOpenCorporationKillboard(corporation: CorporationSummary) {
    setPendingCorporation(corporation);
    setActiveId("kills");
  }

  function handleOpenAllianceKillboard(alliance: AllianceSummary) {
    setPendingAlliance(alliance);
    setActiveId("kills");
  }

  function handleOpenGateKillboard(gate: GateSummary) {
    setPendingGate(gate);
    setActiveId("kills");
  }

  function handleGoToMap() {
    setActiveId("map");
  }

  function handleOpenMarketItem(item: MarketItemRef) {
    setPendingMarketItem(item);
    setActiveId("wallet");
  }

  function handleFitShip(shipTypeId: number) {
    setPendingFitShipTypeId(shipTypeId);
    setActiveId("fittings-fleets");
  }

  async function handleAdd() {
    await startLogin(DASHBOARD_SCOPES);
    refreshSession();
  }

  async function handleLogout(id: number) {
    await logoutCharacter(id);
    refreshSession();
  }

  const detailCharacter = session.characters.find((c) => c.id === detailCharacterId);

  return (
    <CharacterLocationProvider characterId={session.active_character_id}>
      <ChainAutoMappingEffect
        characterName={session.characters.find((c) => c.id === session.active_character_id)?.name ?? null}
      />
      <SkillQueueWatchEffect characters={session.characters} />
      <TrackedEntityEventsEffect />
      <div className="shell">
        <ProximityFlashOverlay />
        <UpdateBanner />
        <ToastStack />
        <Sidebar activeId={activeId} onSelect={handleSelectNav} />
        <TopBar
          title={active.label}
          activeId={activeId}
          session={session}
          onSwitch={handleSwitch}
          onAdd={handleAdd}
          onLogout={handleLogout}
          onOpenKillmail={handleOpenKillmail}
        />
        <Suspense fallback={<div className="app-loading">Loading...</div>}>
        {activeId === "dashboard" ? (
          detailCharacter ? (
            <CharacterDetail
              character={detailCharacter}
              characters={session.characters}
              onSwitchCharacter={handleOpenDetail}
              onBack={() => setDetailCharacterId(null)}
              onSelectKill={handleOpenKillmail}
              onSelectCharacter={handleOpenCharacterKillboard}
              onSelectSystem={handleOpenSystemKills}
              onSelectCorporation={handleOpenCorporationKillboard}
              onSelectAlliance={handleOpenAllianceKillboard}
              onReconnect={handleAdd}
            />
          ) : (
            <Dashboard session={session} onOpenDetail={handleOpenDetail} onAdd={handleAdd} />
          )
        ) : activeId === "kills" ? (
          <KillsIntel
            characters={session.characters}
            initialKillmailId={pendingKillmailId}
            onConsumeInitialKillmail={() => setPendingKillmailId(null)}
            initialSystem={pendingSystem}
            onConsumeInitialSystem={() => setPendingSystem(null)}
            initialCharacterId={pendingCharacterId}
            onConsumeInitialCharacter={() => setPendingCharacterId(null)}
            initialCorporation={pendingCorporation}
            onConsumeInitialCorporation={() => setPendingCorporation(null)}
            initialAlliance={pendingAlliance}
            onConsumeInitialAlliance={() => setPendingAlliance(null)}
            initialGate={pendingGate}
            onConsumeInitialGate={() => setPendingGate(null)}
            onGoToMap={handleGoToMap}
            onSelectItem={handleOpenMarketItem}
          />
        ) : activeId === "map" ? null : activeId === "mail" ? (
          <MailPage characters={session.characters} initialCharacterId={session.active_character_id} />
        ) : activeId === "wallet" ? (
          <WalletMarketPage
            characters={session.characters}
            initialCharacterId={session.active_character_id}
            initialMarketItem={pendingMarketItem}
            onConsumeInitialMarketItem={() => setPendingMarketItem(null)}
            onFitShip={handleFitShip}
          />
        ) : activeId === "intel-check" ? (
          <IntelCheck onSelectCharacter={handleOpenCharacterKillboard} />
        ) : activeId === "planetary" ? (
          <PlanetaryIndustry characters={session.characters} />
        ) : activeId === "settings" ? (
          <SettingsPage session={session} onAdd={handleAdd} onLogout={handleLogout} />
        ) : activeId === "calendar" ? (
          <CalendarPage characters={session.characters} initialCharacterId={session.active_character_id} />
        ) : activeId === "fittings-fleets" ? (
          <FittingsPage
            characters={session.characters}
            initialShipTypeId={pendingFitShipTypeId}
            onConsumeInitialShipTypeId={() => setPendingFitShipTypeId(null)}
          />
        ) : activeId === "path-wormhole-finder" ? (
          <PathWormholeFinderPage
            activeCharacterId={session.active_character_id}
            activeCharacterName={session.characters.find((c) => c.id === session.active_character_id)?.name ?? null}
            characters={session.characters}
            onSelectSystem={handleOpenSystemKills}
          />
        ) : activeId === "industry" ? (
          <IndustryPage />
        ) : activeId === "mining" ? (
          <MiningPage characters={session.characters} />
        ) : activeId === "multiboxing" ? (
          <MultiboxPage />
        ) : (
          <MainContent icon={active.icon} label={active.label} description={active.description} />
        )}
        </Suspense>
        {mapVisited && (
          <div style={{ display: activeId === "map" ? "contents" : "none" }}>
            <Suspense fallback={<div className="app-loading">Loading...</div>}>
              <MapPage
                onSelectKill={handleOpenKillmail}
                onSelectSystem={handleOpenSystemKills}
                onSelectGate={handleOpenGateKillboard}
                characters={session.characters}
              />
            </Suspense>
          </div>
        )}
      </div>
    </CharacterLocationProvider>
  );
}

export default App;
