import { useState } from "react";
import Sidebar, { NAV_ITEMS } from "./components/Sidebar";
import TopBar from "./components/TopBar";
import MainContent from "./components/MainContent";
import "./App.css";

function App() {
  const [activeId, setActiveId] = useState(NAV_ITEMS[0].id);
  const active = NAV_ITEMS.find((item) => item.id === activeId) ?? NAV_ITEMS[0];

  return (
    <div className="shell">
      <Sidebar activeId={activeId} onSelect={setActiveId} />
      <TopBar title={active.label} />
      <MainContent
        icon={active.icon}
        label={active.label}
        description={active.description}
      />
    </div>
  );
}

export default App;
