import { useEffect, useState } from "react";
import Sidebar, { NAV_ITEMS } from "./components/Sidebar";
import TopBar from "./components/TopBar";
import MainContent from "./components/MainContent";
import Dashboard from "./components/Dashboard";
import LoginScreen from "./components/LoginScreen";
import { getSession, setActiveCharacter, logoutCharacter, startLogin, type Session } from "./lib/eve";
import { DASHBOARD_SCOPES } from "./lib/scopes";
import "./App.css";

function App() {
  const [activeId, setActiveId] = useState(NAV_ITEMS[0].id);
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    refreshSession();
  }, []);

  async function refreshSession() {
    setLoading(true);
    try {
      const next = await getSession();
      setSession(next);
    } catch (err) {
      console.error(err);
      setSession({ characters: [], active_character_id: null });
    } finally {
      setLoading(false);
    }
  }

  const active = NAV_ITEMS.find((item) => item.id === activeId) ?? NAV_ITEMS[0];

  if (loading) {
    return <div className="app-loading">Loading...</div>;
  }

  if (!session || session.characters.length === 0) {
    return <LoginScreen onLoggedIn={refreshSession} />;
  }

  async function handleSwitch(id: number) {
    await setActiveCharacter(id);
    refreshSession();
  }

  async function handleAdd() {
    await startLogin(DASHBOARD_SCOPES);
    refreshSession();
  }

  async function handleLogout(id: number) {
    await logoutCharacter(id);
    refreshSession();
  }

  return (
    <div className="shell">
      <Sidebar activeId={activeId} onSelect={setActiveId} />
      <TopBar title={active.label} session={session} onSwitch={handleSwitch} onAdd={handleAdd} onLogout={handleLogout} />
      {activeId === "dashboard" ? (
        <Dashboard session={session} onSwitch={handleSwitch} onAdd={handleAdd} />
      ) : (
        <MainContent icon={active.icon} label={active.label} description={active.description} />
      )}
    </div>
  );
}

export default App;
