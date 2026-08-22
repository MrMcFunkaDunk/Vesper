import { useState } from "react";
import { Volume2, VolumeX, RefreshCw, ShieldCheck } from "lucide-react";
import { playProximityAlert } from "../lib/sound";
import { useSoundEnabled } from "../hooks/useSoundEnabled";
import { useNotificationPreferences } from "../hooks/useNotificationPreferences";
import { useDefaultTradeHub } from "../hooks/useDefaultTradeHub";
import { useReduceMotion } from "../hooks/useReduceMotion";
import { useDefaultLandingTab } from "../hooks/useDefaultLandingTab";
import { useColorOverrides } from "../hooks/useColorOverrides";
import { useNavOrder } from "../hooks/useNavOrder";
import { resyncMarketData } from "../lib/market";
import type { Session } from "../lib/eve";
import { TRADE_HUB_REGIONS } from "../lib/map";
import { NAV_ITEMS } from "./Sidebar";
import { useErrorReporter } from "../hooks/useErrorReporter";
import SettingsSyncPanel from "./SettingsSyncPanel";

interface SettingsPageProps {
  session: Session;
  onAdd: () => void;
  onLogout: (id: number) => void;
}

type SettingsTab = "general" | "sync";

/** Strips the "esi-"/".v1" boilerplate every scope carries and turns the
 * dot/underscore-separated remainder into something readable, e.g.
 * "esi-wallet.read_character_wallet.v1" -> "wallet: read character wallet". */
function formatScope(scope: string): string {
  return scope
    .replace(/^esi-/, "")
    .replace(/\.v\d+$/, "")
    .replace(/\./g, ": ")
    .replace(/_/g, " ");
}

function SettingsPage({ session, onAdd, onLogout }: SettingsPageProps) {
  const [tab, setTab] = useState<SettingsTab>("general");
  const [tested, setTested] = useState(false);
  const [soundEnabled, setSoundEnabled] = useSoundEnabled();
  const { prefs: notifPrefs, setEnabled: setNotifEnabled, update: updateNotifPrefs, permissionDenied } = useNotificationPreferences();
  const [hubRegionId, setHubRegionId] = useDefaultTradeHub();
  const [reduceMotion, setReduceMotion] = useReduceMotion();
  const [landingTab, setLandingTab] = useDefaultLandingTab(NAV_ITEMS[0].id);
  const { resetAll: resetColors } = useColorOverrides("vesper.colors.sidebar");
  const { setOrder } = useNavOrder(NAV_ITEMS.map((item) => item.id));
  const [resyncing, setResyncing] = useState(false);
  const [resyncDone, setResyncDone] = useState(false);
  const [expandedCharacterId, setExpandedCharacterId] = useState<number | null>(null);
  const reportError = useErrorReporter();

  function handleTestSound() {
    playProximityAlert();
    setTested(true);
    window.setTimeout(() => setTested(false), 1200);
  }

  function handleRemoveCharacter(id: number, name: string) {
    if (!window.confirm(`Remove ${name}? You'll need to sign back in via EVE SSO to add them again.`)) return;
    onLogout(id);
  }

  async function handleResync() {
    setResyncing(true);
    setResyncDone(false);
    try {
      await resyncMarketData();
      setResyncDone(true);
      window.setTimeout(() => setResyncDone(false), 2500);
    } catch (err) {
      reportError(`Failed to re-sync market/industry data: ${String(err)}`);
    } finally {
      setResyncing(false);
    }
  }

  return (
    <main className="main main-settings">
      <div className="settings-page">
        <div className="settings-header">
          <p className="eyebrow">Settings</p>
          <h2>App Preferences</h2>
          <p className="settings-intro">Manage logged-in characters, granted scopes, notifications, and app-wide preferences.</p>
        </div>

        <div className="kills-tabs">
          <button type="button" className={`kills-tab ${tab === "general" ? "kills-tab-active" : ""}`} onClick={() => setTab("general")}>
            General
          </button>
          <button type="button" className={`kills-tab ${tab === "sync" ? "kills-tab-active" : ""}`} onClick={() => setTab("sync")}>
            Settings Sync
          </button>
        </div>

        {tab === "sync" ? (
          <SettingsSyncPanel characters={session.characters} />
        ) : (
          <>
        <div className="settings-section">
          <h3>Characters &amp; Scopes</h3>
          <p className="settings-section-hint">
            Every character you've logged in with and the ESI permissions they granted. If a feature shows a "needs
            reauth" message, re-adding the character here picks up any scopes added since they last logged in.
          </p>
          <div className="settings-character-list">
            {session.characters.map((character) => (
              <div key={character.id} className="settings-character-row">
                <div className="settings-character-summary">
                  <img className="account-portrait" src={character.portrait_url} alt="" />
                  <span className="settings-character-name">{character.name}</span>
                  <span className="settings-character-scope-count">{character.scopes.length} scopes granted</span>
                  <button
                    type="button"
                    className="wh-link-btn"
                    onClick={() => setExpandedCharacterId((id) => (id === character.id ? null : character.id))}
                  >
                    {expandedCharacterId === character.id ? "Hide scopes" : "View scopes"}
                  </button>
                  <button type="button" className="wh-link-btn settings-character-remove" onClick={() => handleRemoveCharacter(character.id, character.name)}>
                    Remove
                  </button>
                </div>
                {expandedCharacterId === character.id && (
                  <ul className="settings-scope-list">
                    {character.scopes.map((scope) => (
                      <li key={scope}>
                        <ShieldCheck size={11} strokeWidth={2} /> {formatScope(scope)}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
          </div>
          <button type="button" className="kills-sync-btn" onClick={onAdd}>
            + Add / Re-authenticate a Character
          </button>
        </div>

        <div className="settings-section">
          <h3>Notifications</h3>
          <p className="settings-section-hint">
            Native desktop notifications for things that matter even when VESPER isn't the focused window. Turning
            this on will prompt Windows for notification permission once.
          </p>
          <div className="settings-section-row">
            <button
              type="button"
              className={`kills-sync-btn${notifPrefs.enabled ? "" : " kills-npc-toggle-off"}`}
              onClick={() => setNotifEnabled(!notifPrefs.enabled)}
            >
              Notifications: {notifPrefs.enabled ? "On" : "Off"}
            </button>
            {permissionDenied && <span className="settings-permission-denied">Windows denied notification permission - enable it for VESPER in system settings.</span>}
          </div>
          {notifPrefs.enabled && (
            <div className="settings-notification-grid">
              <label className="settings-checkbox-row">
                <input type="checkbox" checked={notifPrefs.proximityKills} onChange={(e) => updateNotifPrefs("proximityKills", e.target.checked)} />
                Proximity kill alerts (a kill lands near your tracked location)
              </label>
              <label className="settings-checkbox-row">
                <input type="checkbox" checked={notifPrefs.autoMapJumps} onChange={(e) => updateNotifPrefs("autoMapJumps", e.target.checked)} />
                New wormhole mapped (auto-map detects a fresh connection)
              </label>
              <label className="settings-checkbox-row">
                <input type="checkbox" checked={notifPrefs.skillQueueEmpty} onChange={(e) => updateNotifPrefs("skillQueueEmpty", e.target.checked)} />
                Skill queue empty
              </label>
              <label className="settings-checkbox-row">
                <input
                  type="checkbox"
                  checked={notifPrefs.skillQueueLowHours != null}
                  onChange={(e) => updateNotifPrefs("skillQueueLowHours", e.target.checked ? 24 : null)}
                />
                Skill queue running low, under
                <input
                  type="number"
                  min={1}
                  className="settings-inline-number"
                  disabled={notifPrefs.skillQueueLowHours == null}
                  value={notifPrefs.skillQueueLowHours ?? 24}
                  onChange={(e) => updateNotifPrefs("skillQueueLowHours", Math.max(1, Number(e.target.value) || 1))}
                />
                hours queued
              </label>
            </div>
          )}
        </div>

        <div className="settings-section">
          <h3>Proximity Alert Sound</h3>
          <p className="settings-section-hint">
            Plays when a kill lands in your current system or one jump away. The red screen flash always happens
            regardless of this setting - this only controls the sound on top of it.
          </p>
          <div className="settings-section-row">
            <button
              type="button"
              className={`kills-sync-btn${soundEnabled ? "" : " kills-npc-toggle-off"}`}
              onClick={() => setSoundEnabled(!soundEnabled)}
              title={soundEnabled ? "Mute the proximity alert sound" : "Unmute the proximity alert sound"}
            >
              {soundEnabled ? <Volume2 size={14} strokeWidth={2} /> : <VolumeX size={14} strokeWidth={2} />}
              Sound: {soundEnabled ? "On" : "Off"}
            </button>
            <button type="button" className="detail-back" onClick={handleTestSound}>
              {tested ? "Played!" : "Test Sound"}
            </button>
          </div>
        </div>

        <div className="settings-section">
          <h3>Default Trade Hub</h3>
          <p className="settings-section-hint">
            The trade hub Industry, Market Browser, Screener, and Wallet contracts start on - switch it here instead
            of re-picking a hub on every page.
          </p>
          <select className="industry-field-input settings-hub-select" value={hubRegionId} onChange={(e) => setHubRegionId(Number(e.target.value))}>
            {TRADE_HUB_REGIONS.map((h) => (
              <option key={h.regionId} value={h.regionId}>
                {h.regionName}
              </option>
            ))}
          </select>
        </div>

        <div className="settings-section">
          <h3>Display</h3>
          <label className="settings-checkbox-row">
            <input type="checkbox" checked={reduceMotion} onChange={(e) => setReduceMotion(e.target.checked)} />
            Reduce motion (stops the skill-queue training pulse and the proximity-alert flash)
          </label>
          <div className="settings-section-row">
            <span className="settings-inline-label">Default landing tab</span>
            <select className="industry-field-input settings-hub-select" value={landingTab} onChange={(e) => setLandingTab(e.target.value)}>
              {NAV_ITEMS.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="settings-section">
          <h3>Sidebar</h3>
          <p className="settings-section-hint">
            Icon colors (right-click a nav item to set one) and drag-to-reorder are saved automatically - these just
            undo them in bulk.
          </p>
          <div className="settings-section-row">
            <button type="button" className="detail-back" onClick={resetColors}>
              Reset Icon Colors
            </button>
            <button
              type="button"
              className="detail-back"
              onClick={() => setOrder(NAV_ITEMS.map((item) => item.id))}
            >
              Reset Nav Order
            </button>
          </div>
        </div>

        <div className="settings-section">
          <h3>Reference Data</h3>
          <p className="settings-section-hint">
            Re-downloads the market/industry catalog (item names, blueprints, reprocessing yields) from CCP's static
            data export. Only touches redownloadable reference data - never your chains, signatures, or characters.
          </p>
          <button type="button" className="kills-sync-btn" onClick={handleResync} disabled={resyncing}>
            <RefreshCw size={13} strokeWidth={2} className={resyncing ? "market-resync-spin" : undefined} />
            {resyncing ? "Re-syncing..." : resyncDone ? "Done!" : "Re-sync Market & Industry Data"}
          </button>
        </div>
          </>
        )}
      </div>
    </main>
  );
}

export default SettingsPage;
