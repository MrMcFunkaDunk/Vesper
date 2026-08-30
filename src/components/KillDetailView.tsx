import { useEffect, useState, type KeyboardEvent, type ReactNode } from "react";
import { ArrowLeft, Copy, Check } from "lucide-react";
import { getKillDetail, type KillDetail, type SlotGroup, type TrackedEntry } from "../lib/kills";
import { getMarketPrices } from "../lib/market";
import { useErrorReporter } from "../hooks/useErrorReporter";
import { formatIsk, formatSecurity, securityColor, formatPercent, formatEveDateTime } from "../lib/format";
import FitWheel from "./FitWheel";
import type { SystemSummary } from "./SystemKillboard";
import type { CorporationSummary } from "./CorporationKillboard";
import type { AllianceSummary } from "./AllianceKillboard";
import type { MarketItemRef } from "./MarketBrowser";
import type { GateSummary } from "./GateKillboard";
import BackToMapButton from "./BackToMapButton";
import TrackToggleButton from "./TrackToggleButton";

/** Strips the "Stargate (X)" ESI wrapper down to the bare gate name, the
 * same display convention GateSummary/GateCheck already use. */
function bareGateName(locationName: string): string {
  return locationName.replace(/^Stargate \(/, "").replace(/\)$/, "");
}

interface KillDetailViewProps {
  killmailId: number;
  onBack: () => void;
  onSelectCharacter: (characterId: number) => void;
  onSelectSystem: (system: SystemSummary) => void;
  onSelectCorporation: (corporation: CorporationSummary) => void;
  onSelectAlliance: (alliance: AllianceSummary) => void;
  onSelectGate: (gate: GateSummary) => void;
  breadcrumb: ReactNode;
  onLabelReady?: (label: string) => void;
  onGoToMap: () => void;
  onSelectItem: (item: MarketItemRef) => void;
}

function corpLogoUrl(id: number): string {
  return `https://images.evetech.net/corporations/${id}/logo?size=64`;
}

function allianceLogoUrl(id: number): string {
  return `https://images.evetech.net/alliances/${id}/logo?size=64`;
}

const SLOT_GROUP_ORDER: SlotGroup[] = ["high", "mid", "low", "rig", "drone", "cargo", "other"];
const SLOT_GROUP_LABELS: Record<SlotGroup, string> = {
  high: "High Slots",
  mid: "Mid Slots",
  low: "Low Slots",
  rig: "Rigs",
  drone: "Drone Bay",
  cargo: "Cargo Hold",
  other: "Other",
};

interface AggregatedItem {
  item_type_id: number;
  item_type_name: string;
  quantity_destroyed: number;
  quantity_dropped: number;
}

/** A killmail records identical fitted items (e.g. 8 of the same turret, one per slot) as separate entries - merge same-type items within a slot group into one row with summed quantities, matching how zKillboard displays its item table. */
function aggregateItems(items: { item_type_id: number; item_type_name: string; quantity_destroyed: number; quantity_dropped: number }[]): AggregatedItem[] {
  const byType = new Map<number, AggregatedItem>();
  for (const item of items) {
    const existing = byType.get(item.item_type_id);
    if (existing) {
      existing.quantity_destroyed += item.quantity_destroyed;
      existing.quantity_dropped += item.quantity_dropped;
    } else {
      byType.set(item.item_type_id, { ...item });
    }
  }
  return Array.from(byType.values());
}

function KillDetailView({
  killmailId,
  onBack,
  onSelectCharacter,
  onSelectSystem,
  onSelectCorporation,
  onSelectAlliance,
  onSelectGate,
  breadcrumb,
  onLabelReady,
  onGoToMap,
  onSelectItem,
}: KillDetailViewProps) {
  const [detail, setDetail] = useState<KillDetail | null>(null);
  const [copiedLabel, setCopiedLabel] = useState<string | null>(null);
  const [prices, setPrices] = useState<Map<number, number>>(new Map());
  const reportError = useErrorReporter();

  useEffect(() => {
    setDetail(null);
    getKillDetail(killmailId)
      .then((d) => {
        setDetail(d);
        onLabelReady?.(`${d.ship_type_name} (${d.victim_character_name ?? "Unknown"})`);
      })
      .catch((err) => reportError(`Failed to load killmail detail: ${String(err)}`));
  }, [killmailId]);

  // Rough per-item valuation for the slot subtotals below, the same way
  // zKillboard itself does it - the killmail data has no per-item ISK
  // value at all, only the whole kill's total/destroyed/dropped value.
  // One bulk EVE-wide price list covers every kill viewed for the life of
  // this component, so it only needs fetching once, not per killmail.
  useEffect(() => {
    getMarketPrices()
      .then((list) => {
        const map = new Map<number, number>();
        for (const p of list) {
          if (p.average_price != null) map.set(p.type_id, p.average_price);
        }
        setPrices(map);
      })
      .catch(() => {});
  }, []);

  const totalDamage = detail?.attackers.reduce((sum, a) => sum + a.damage_done, 0) ?? 0;
  const finalBlowAttacker = detail?.attackers.find((a) => a.final_blow);
  const topDamageAttacker = detail?.attackers[0];
  const itemsByGroup = detail
    ? SLOT_GROUP_ORDER.map((group) => ({
        group,
        items: aggregateItems(detail.items.filter((i) => i.slot_group === group)),
      })).filter((g) => g.items.length > 0)
    : [];

  function groupSubtotal(items: AggregatedItem[]): { destroyed: number; dropped: number } {
    let destroyed = 0;
    let dropped = 0;
    for (const item of items) {
      const price = prices.get(item.item_type_id) ?? 0;
      destroyed += item.quantity_destroyed * price;
      dropped += item.quantity_dropped * price;
    }
    return { destroyed, dropped };
  }

  function copyToClipboard(label: string, text: string) {
    navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopiedLabel(label);
        setTimeout(() => setCopiedLabel((current) => (current === label ? null : current)), 1500);
      })
      .catch((err) => reportError(`Couldn't copy to clipboard: ${String(err)}`));
  }

  return (
    <main className="main main-detail">
      <div className="detail">
        {breadcrumb}

        <div className="kills-nav-buttons">
          <button type="button" className="detail-back" onClick={onBack}>
            <ArrowLeft size={14} strokeWidth={2} />
            Back
          </button>
          <BackToMapButton onClick={onGoToMap} />
        </div>

        {!detail ? (
          <p className="detail-empty">Loading killmail...</p>
        ) : (
          <>
            {detail.solo && <div className="kill-solo-banner">Solo Killmail</div>}

            <div className="detail-header">
              <div className="detail-avatar">
                {detail.victim_character_id && (
                  <img
                    className="detail-portrait"
                    src={`https://images.evetech.net/characters/${detail.victim_character_id}/portrait?size=128`}
                    alt=""
                  />
                )}
                {(detail.victim_corporation_id || detail.victim_alliance_id) && (
                  <div className="detail-logo-stack">
                    {detail.victim_corporation_id && (
                      <img
                        className="detail-logo"
                        src={corpLogoUrl(detail.victim_corporation_id)}
                        alt=""
                        title={detail.victim_corporation_name ?? undefined}
                      />
                    )}
                    {detail.victim_alliance_id && (
                      <img
                        className="detail-logo"
                        src={allianceLogoUrl(detail.victim_alliance_id)}
                        alt=""
                        title={detail.victim_alliance_name ?? undefined}
                      />
                    )}
                  </div>
                )}
              </div>
              <div className="detail-identity">
                <h2>
                  {detail.victim_character_id ? (
                    <span
                      className="detail-name-link"
                      role="button"
                      tabIndex={0}
                      onClick={() => onSelectCharacter(detail.victim_character_id!)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          onSelectCharacter(detail.victim_character_id!);
                        }
                      }}
                    >
                      {detail.victim_character_name ?? "Unknown"}
                    </span>
                  ) : (
                    (detail.victim_character_name ?? "Unknown")
                  )}
                  {detail.npc && <span className="kills-tag kills-tag-npc">NPC</span>}
                </h2>
                <span className="detail-corp">
                  {detail.victim_corporation_name && detail.victim_corporation_id ? (
                    <span
                      className="kills-identity-corp kills-system-clickable"
                      role="button"
                      tabIndex={0}
                      onClick={() => onSelectCorporation({ id: detail.victim_corporation_id!, name: detail.victim_corporation_name! })}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          onSelectCorporation({ id: detail.victim_corporation_id!, name: detail.victim_corporation_name! });
                        }
                      }}
                    >
                      {detail.victim_corporation_name}
                    </span>
                  ) : (
                    "—"
                  )}
                  {detail.victim_alliance_name && detail.victim_alliance_id ? (
                    <>
                      {" • "}
                      <span
                        className="kills-identity-alliance kills-system-clickable"
                        role="button"
                        tabIndex={0}
                        onClick={() => onSelectAlliance({ id: detail.victim_alliance_id!, name: detail.victim_alliance_name! })}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            onSelectAlliance({ id: detail.victim_alliance_id!, name: detail.victim_alliance_name! });
                          }
                        }}
                      >
                        {detail.victim_alliance_name}
                      </span>
                    </>
                  ) : (
                    ""
                  )}
                </span>
                <div className="detail-stats-row">
                  <span
                    className="kills-ship kills-system-clickable"
                    role="button"
                    tabIndex={0}
                    onClick={() => onSelectItem({ id: detail.ship_type_id, name: detail.ship_type_name })}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        onSelectItem({ id: detail.ship_type_id, name: detail.ship_type_name });
                      }
                    }}
                  >
                    {detail.ship_type_name}
                  </span>
                  <span className="detail-stats-sep">//</span>
                  <span>
                    {detail.system_security != null && (
                      <span className="kills-security" style={{ color: securityColor(detail.system_security) }}>
                        {formatSecurity(detail.system_security)}{" "}
                      </span>
                    )}
                    <span
                      className="kills-system-clickable"
                      role="button"
                      tabIndex={0}
                      style={detail.system_security != null ? { color: securityColor(detail.system_security) } : undefined}
                      onClick={() =>
                        onSelectSystem({
                          id: detail.system_id,
                          name: detail.system_name,
                          security: detail.system_security ?? 0,
                          regionName: detail.region_name,
                        })
                      }
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          onSelectSystem({
                            id: detail.system_id,
                            name: detail.system_name,
                            security: detail.system_security ?? 0,
                            regionName: detail.region_name,
                          });
                        }
                      }}
                    >
                      {detail.system_name}
                    </span>
                    {detail.region_name ? ` (${detail.region_name})` : ""}
                  </span>
                  <span className="detail-stats-sep">//</span>
                  <span>{formatIsk(detail.total_value)}</span>
                </div>
                {detail.location_name && (
                  <div className="detail-location-row">
                    <span>
                      {detail.location_id != null ? (
                        <span
                          className="kills-system-clickable"
                          role="button"
                          tabIndex={0}
                          onClick={() =>
                            onSelectGate({
                              id: detail.location_id!,
                              name: bareGateName(detail.location_name!),
                              systemId: detail.system_id,
                              systemName: detail.system_name,
                            })
                          }
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              onSelectGate({
                                id: detail.location_id!,
                                name: bareGateName(detail.location_name!),
                                systemId: detail.system_id,
                                systemName: detail.system_name,
                              });
                            }
                          }}
                        >
                          {detail.location_name}
                        </span>
                      ) : (
                        detail.location_name
                      )}
                      {detail.location_distance_m != null && (
                        <span className="detail-location-distance">
                          {" "}
                          {(detail.location_distance_m / 1000).toFixed(2)}km
                        </span>
                      )}
                    </span>
                    {detail.location_id != null && (
                      <TrackToggleButton
                        entry={
                          {
                            type: "gate",
                            id: detail.location_id,
                            name: detail.location_name,
                            systemIds: [detail.system_id],
                          } satisfies TrackedEntry
                        }
                      />
                    )}
                  </div>
                )}
              </div>
            </div>

            <div className="detail-panel">
              <p className="eyebrow">Kill Stats</p>
              <div className="kill-stats-grid">
                <span className="kill-stats-label">Time</span>
                <span className="kill-stats-value">{formatEveDateTime(detail.time)}</span>
                <span className="kill-stats-label">Points</span>
                <span className="kill-stats-value">{detail.points}</span>
                <span className="kill-stats-label">Damage Taken</span>
                <span className="kill-stats-value">{new Intl.NumberFormat("en-US").format(detail.damage_taken)}</span>
                <span className="kill-stats-label">Destroyed</span>
                <span className="kill-stats-value kill-stats-destroyed">
                  {formatIsk(detail.destroyed_value)} ({formatPercent(detail.destroyed_value, detail.total_value)})
                </span>
                <span className="kill-stats-label">Dropped</span>
                <span className="kill-stats-value kill-stats-dropped">
                  {formatIsk(detail.dropped_value)} ({formatPercent(detail.dropped_value, detail.total_value)})
                </span>
                <span className="kill-stats-label">Total</span>
                <span className="kill-stats-value kill-stats-total">{formatIsk(detail.total_value)}</span>
              </div>
            </div>

            <div className="kill-export-row">
              <button
                type="button"
                className="kill-export-btn"
                onClick={() =>
                  copyToClipboard(
                    "ingame",
                    `<url=killReport:${detail.killmail_id}:${detail.hash}>${detail.victim_character_name ?? "Unknown"} - ${detail.ship_type_name} - ${formatIsk(detail.total_value)}</url>`,
                  )
                }
              >
                {copiedLabel === "ingame" ? <Check size={13} strokeWidth={2} /> : <Copy size={13} strokeWidth={2} />}
                {copiedLabel === "ingame" ? "Copied" : "Copy In-Game Link"}
              </button>
              <button
                type="button"
                className="kill-export-btn"
                onClick={() => copyToClipboard("zkb", `https://zkillboard.com/kill/${detail.killmail_id}/`)}
              >
                {copiedLabel === "zkb" ? <Check size={13} strokeWidth={2} /> : <Copy size={13} strokeWidth={2} />}
                {copiedLabel === "zkb" ? "Copied" : "Copy zKillboard Link"}
              </button>
            </div>

            <div className="kill-highlight-row">
              {finalBlowAttacker && (
                <div className="kill-highlight-card">
                  <p className="eyebrow">Final Blow</p>
                  <div
                    className={`kill-highlight-person ${finalBlowAttacker.character_id ? "kills-person-clickable" : ""}`}
                    {...(finalBlowAttacker.character_id
                      ? {
                          role: "button" as const,
                          tabIndex: 0,
                          onClick: () => onSelectCharacter(finalBlowAttacker.character_id!),
                          onKeyDown: (e: KeyboardEvent) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              onSelectCharacter(finalBlowAttacker.character_id!);
                            }
                          },
                        }
                      : {})}
                  >
                    <div className="kills-avatar-stack">
                      {finalBlowAttacker.character_id ? (
                        <img
                          className="kill-highlight-portrait"
                          src={`https://images.evetech.net/characters/${finalBlowAttacker.character_id}/portrait?size=64`}
                          alt=""
                        />
                      ) : (
                        <span className="kill-highlight-portrait kills-portrait-blank" />
                      )}
                      {finalBlowAttacker.corporation_id && (
                        <img
                          className="kills-logo"
                          src={corpLogoUrl(finalBlowAttacker.corporation_id)}
                          alt=""
                          title={finalBlowAttacker.corporation_name ?? undefined}
                        />
                      )}
                      {finalBlowAttacker.alliance_id && (
                        <img
                          className="kills-logo"
                          src={allianceLogoUrl(finalBlowAttacker.alliance_id)}
                          alt=""
                          title={finalBlowAttacker.alliance_name ?? undefined}
                        />
                      )}
                    </div>
                    <div className="kills-identity">
                      <span className="kills-identity-name">{finalBlowAttacker.character_name ?? "—"}</span>
                      {finalBlowAttacker.corporation_name && finalBlowAttacker.corporation_id && (
                        <span
                          className="kills-identity-corp kills-system-clickable"
                          role="button"
                          tabIndex={0}
                          onClick={(e) => {
                            e.stopPropagation();
                            onSelectCorporation({ id: finalBlowAttacker.corporation_id!, name: finalBlowAttacker.corporation_name! });
                          }}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              e.stopPropagation();
                              onSelectCorporation({ id: finalBlowAttacker.corporation_id!, name: finalBlowAttacker.corporation_name! });
                            }
                          }}
                        >
                          {finalBlowAttacker.corporation_name}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              )}
              {topDamageAttacker && (
                <div className="kill-highlight-card">
                  <p className="eyebrow">Top Damage</p>
                  <div
                    className={`kill-highlight-person ${topDamageAttacker.character_id ? "kills-person-clickable" : ""}`}
                    {...(topDamageAttacker.character_id
                      ? {
                          role: "button" as const,
                          tabIndex: 0,
                          onClick: () => onSelectCharacter(topDamageAttacker.character_id!),
                          onKeyDown: (e: KeyboardEvent) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              onSelectCharacter(topDamageAttacker.character_id!);
                            }
                          },
                        }
                      : {})}
                  >
                    <div className="kills-avatar-stack">
                      {topDamageAttacker.character_id ? (
                        <img
                          className="kill-highlight-portrait"
                          src={`https://images.evetech.net/characters/${topDamageAttacker.character_id}/portrait?size=64`}
                          alt=""
                        />
                      ) : (
                        <span className="kill-highlight-portrait kills-portrait-blank" />
                      )}
                      {topDamageAttacker.corporation_id && (
                        <img
                          className="kills-logo"
                          src={corpLogoUrl(topDamageAttacker.corporation_id)}
                          alt=""
                          title={topDamageAttacker.corporation_name ?? undefined}
                        />
                      )}
                      {topDamageAttacker.alliance_id && (
                        <img
                          className="kills-logo"
                          src={allianceLogoUrl(topDamageAttacker.alliance_id)}
                          alt=""
                          title={topDamageAttacker.alliance_name ?? undefined}
                        />
                      )}
                    </div>
                    <div className="kills-identity">
                      <span className="kills-identity-name">{topDamageAttacker.character_name ?? "—"}</span>
                      {topDamageAttacker.corporation_name && topDamageAttacker.corporation_id && (
                        <span
                          className="kills-identity-corp kills-system-clickable"
                          role="button"
                          tabIndex={0}
                          onClick={(e) => {
                            e.stopPropagation();
                            onSelectCorporation({ id: topDamageAttacker.corporation_id!, name: topDamageAttacker.corporation_name! });
                          }}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              e.stopPropagation();
                              onSelectCorporation({ id: topDamageAttacker.corporation_id!, name: topDamageAttacker.corporation_name! });
                            }
                          }}
                        >
                          {topDamageAttacker.corporation_name}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </div>

            <div className="detail-panel">
              <p className="eyebrow">Fit</p>
              <FitWheel shipTypeId={detail.ship_type_id} shipTypeName={detail.ship_type_name} items={detail.items} />
            </div>

            {itemsByGroup.length > 0 && (
              <div className="detail-panel">
                <p className="eyebrow">Item(s)</p>
                <div className="kill-item-groups">
                  {itemsByGroup.map(({ group, items }) => {
                    const subtotal = groupSubtotal(items);
                    return (
                    <div key={group} className="kill-item-group">
                      <p className="kill-item-group-label">{SLOT_GROUP_LABELS[group]}</p>
                      <div className="kill-item-list">
                        {items.map((item) => (
                          <div key={item.item_type_id} className="kill-item-row">
                            <img
                              className="kill-item-icon"
                              src={`https://images.evetech.net/types/${item.item_type_id}/icon?size=32`}
                              alt=""
                            />
                            <span
                              className="kill-item-name kills-system-clickable"
                              role="button"
                              tabIndex={0}
                              onClick={() => onSelectItem({ id: item.item_type_id, name: item.item_type_name })}
                              onKeyDown={(e) => {
                                if (e.key === "Enter" || e.key === " ") {
                                  e.preventDefault();
                                  onSelectItem({ id: item.item_type_id, name: item.item_type_name });
                                }
                              }}
                            >
                              {item.item_type_name}
                            </span>
                            <span className="kill-item-qty">
                              {item.quantity_destroyed > 0 && (
                                <span className="kill-item-qty-destroyed">×{item.quantity_destroyed}</span>
                              )}
                              {item.quantity_dropped > 0 && (
                                <span className="kill-item-qty-dropped">×{item.quantity_dropped}</span>
                              )}
                            </span>
                          </div>
                        ))}
                      </div>
                      <div className="kill-item-group-subtotal">
                        <span className="kill-stats-destroyed">{formatIsk(subtotal.destroyed)}</span>
                        <span className="kill-stats-dropped">{formatIsk(subtotal.dropped)}</span>
                      </div>
                    </div>
                    );
                  })}
                </div>
              </div>
            )}

            <div className="detail-panel">
              <p className="eyebrow">Attackers ({detail.attackers.length})</p>
              <div className="kill-attacker-list">
                {detail.attackers.map((attacker, i) => {
                  const pct = totalDamage > 0 ? (attacker.damage_done / totalDamage) * 100 : 0;
                  return (
                    <div key={i} className="kill-attacker-row">
                      <div className="kills-avatar-stack">
                        {attacker.character_id ? (
                          <img
                            className="kills-portrait"
                            src={`https://images.evetech.net/characters/${attacker.character_id}/portrait?size=32`}
                            alt=""
                          />
                        ) : (
                          <span className="kills-portrait kills-portrait-blank" />
                        )}
                        {attacker.corporation_id && (
                          <img
                            className="kills-logo"
                            src={corpLogoUrl(attacker.corporation_id)}
                            alt=""
                            title={attacker.corporation_name ?? undefined}
                          />
                        )}
                        {attacker.alliance_id && (
                          <img
                            className="kills-logo"
                            src={allianceLogoUrl(attacker.alliance_id)}
                            alt=""
                            title={attacker.alliance_name ?? undefined}
                          />
                        )}
                      </div>
                      <span className="kill-attacker-name-cell">
                        <span
                          className={`kill-attacker-name ${attacker.character_id ? "detail-name-link" : ""}`}
                          {...(attacker.character_id
                            ? {
                                role: "button" as const,
                                tabIndex: 0,
                                onClick: () => onSelectCharacter(attacker.character_id!),
                                onKeyDown: (e: KeyboardEvent) => {
                                  if (e.key === "Enter" || e.key === " ") {
                                    e.preventDefault();
                                    onSelectCharacter(attacker.character_id!);
                                  }
                                },
                              }
                            : {})}
                        >
                          {attacker.character_name ?? "Unknown"}
                        </span>
                        {attacker.corporation_name && attacker.corporation_id && (
                          <span
                            className="kill-attacker-corp kills-system-clickable"
                            role="button"
                            tabIndex={0}
                            onClick={() => onSelectCorporation({ id: attacker.corporation_id!, name: attacker.corporation_name! })}
                            onKeyDown={(e) => {
                              if (e.key === "Enter" || e.key === " ") {
                                e.preventDefault();
                                onSelectCorporation({ id: attacker.corporation_id!, name: attacker.corporation_name! });
                              }
                            }}
                          >
                            ({attacker.corporation_name})
                          </span>
                        )}
                      </span>
                      <span className="kill-attacker-ship">{attacker.ship_type_name ?? ""}</span>
                      <span className="kill-attacker-badges">
                        {attacker.final_blow && <span className="kill-final-blow-badge">Final Blow</span>}
                        {i === 0 && <span className="kill-top-damage-badge">Top Damage</span>}
                      </span>
                      <span className="kill-attacker-damage">{pct.toFixed(0)}%</span>
                    </div>
                  );
                })}
              </div>
            </div>

            {detail.insurance.length > 0 && (
              <div className="detail-panel">
                <p className="eyebrow">Insurance Possible Payouts</p>
                <div className="kill-insurance-table">
                  <div className="kill-insurance-row kill-insurance-header">
                    <span>Type</span>
                    <span>Cost</span>
                    <span>Payout</span>
                  </div>
                  {detail.insurance.map((level) => (
                    <div key={level.name} className="kill-insurance-row">
                      <span>{level.name}</span>
                      <span>{formatIsk(level.cost)}</span>
                      <span>{formatIsk(level.payout)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </main>
  );
}

export default KillDetailView;
