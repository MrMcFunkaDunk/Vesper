import { useState } from "react";
import type { Session } from "../lib/eve";

interface TopBarProps {
  title: string;
  session: Session;
  onSwitch: (id: number) => void;
  onAdd: () => void;
  onLogout: (id: number) => void;
}

function TopBar({ title, session, onSwitch, onAdd, onLogout }: TopBarProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const active =
    session.characters.find((c) => c.id === session.active_character_id) ??
    session.characters[0];

  return (
    <header className="topbar">
      <h1 className="topbar-title">{title}</h1>
      <div className="account-menu">
        <button
          type="button"
          className="account-trigger"
          onClick={() => setMenuOpen((open) => !open)}
        >
          {active ? (
            <>
              <img className="account-portrait" src={active.portrait_url} alt="" />
              <span>{active.name}</span>
            </>
          ) : (
            <>
              <span className="status-dot" />
              Not signed in
            </>
          )}
        </button>
        {menuOpen && (
          <div className="account-panel">
            {session.characters.map((character) => (
              <div key={character.id} className="account-row">
                <button
                  type="button"
                  className={`account-row-select${
                    character.id === session.active_character_id ? " account-row-active" : ""
                  }`}
                  onClick={() => {
                    onSwitch(character.id);
                    setMenuOpen(false);
                  }}
                >
                  <img className="account-portrait" src={character.portrait_url} alt="" />
                  <span>{character.name}</span>
                </button>
                <button
                  type="button"
                  className="account-row-logout"
                  onClick={() => onLogout(character.id)}
                >
                  Log out
                </button>
              </div>
            ))}
            <button
              type="button"
              className="account-add"
              onClick={() => {
                onAdd();
                setMenuOpen(false);
              }}
            >
              + Add character
            </button>
          </div>
        )}
      </div>
    </header>
  );
}

export default TopBar;
