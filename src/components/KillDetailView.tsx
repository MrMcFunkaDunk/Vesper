import { useEffect, useState } from "react";
import { ArrowLeft } from "lucide-react";
import { getKillDetail, type KillDetail } from "../lib/kills";
import { useErrorReporter } from "../hooks/useErrorReporter";
import { formatIsk, formatSecurity, securityBand } from "../lib/format";

interface KillDetailViewProps {
  killmailId: number;
  onBack: () => void;
}

function corpLogoUrl(id: number): string {
  return `https://images.evetech.net/corporations/${id}/logo?size=64`;
}

function allianceLogoUrl(id: number): string {
  return `https://images.evetech.net/alliances/${id}/logo?size=64`;
}

function KillDetailView({ killmailId, onBack }: KillDetailViewProps) {
  const [detail, setDetail] = useState<KillDetail | null>(null);
  const reportError = useErrorReporter();

  useEffect(() => {
    setDetail(null);
    getKillDetail(killmailId)
      .then(setDetail)
      .catch((err) => reportError(`Failed to load killmail detail: ${String(err)}`));
  }, [killmailId]);

  const destroyedItems = detail?.items.filter((i) => i.quantity_destroyed > 0) ?? [];
  const droppedItems = detail?.items.filter((i) => i.quantity_dropped > 0) ?? [];
  const totalDamage = detail?.attackers.reduce((sum, a) => sum + a.damage_done, 0) ?? 0;

  return (
    <main className="main main-detail">
      <div className="detail">
        <button type="button" className="detail-back" onClick={onBack}>
          <ArrowLeft size={14} strokeWidth={2} />
          Back to Recent Activity
        </button>

        {!detail ? (
          <p className="detail-empty">Loading killmail...</p>
        ) : (
          <>
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
                <h2>{detail.victim_character_name ?? "Unknown"}</h2>
                <span className="detail-corp">
                  {detail.victim_corporation_name ?? "—"}
                  {detail.victim_alliance_name ? ` • ${detail.victim_alliance_name}` : ""}
                </span>
                <div className="detail-stats-row">
                  <span>{detail.ship_type_name}</span>
                  <span className="detail-stats-sep">//</span>
                  <span>
                    {detail.system_security != null && (
                      <span className={`kills-security kills-security-${securityBand(detail.system_security)}`}>
                        {formatSecurity(detail.system_security)}{" "}
                      </span>
                    )}
                    {detail.system_name}
                    {detail.region_name ? ` (${detail.region_name})` : ""}
                  </span>
                  <span className="detail-stats-sep">//</span>
                  <span>{formatIsk(detail.total_value)}</span>
                </div>
              </div>
            </div>

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
                      <span className="kill-attacker-name">
                        {attacker.character_name ?? "Unknown"}
                        {attacker.corporation_name ? ` (${attacker.corporation_name})` : ""}
                      </span>
                      <span className="kill-attacker-ship">{attacker.ship_type_name ?? ""}</span>
                      {attacker.final_blow && <span className="kill-final-blow-badge">Final Blow</span>}
                      <span className="kill-attacker-damage">{pct.toFixed(0)}%</span>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="detail-panel">
              <p className="eyebrow">Destroyed ({destroyedItems.length})</p>
              {destroyedItems.length === 0 ? (
                <p className="detail-empty">Nothing listed as destroyed.</p>
              ) : (
                <div className="kill-item-list">
                  {destroyedItems.map((item) => (
                    <div key={`d-${item.item_type_id}`} className="kill-item-row">
                      <span className="kill-item-name">{item.item_type_name}</span>
                      <span className="kill-item-qty">x{item.quantity_destroyed}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {droppedItems.length > 0 && (
              <div className="detail-panel">
                <p className="eyebrow">Dropped ({droppedItems.length})</p>
                <div className="kill-item-list">
                  {droppedItems.map((item) => (
                    <div key={`p-${item.item_type_id}`} className="kill-item-row">
                      <span className="kill-item-name">{item.item_type_name}</span>
                      <span className="kill-item-qty">x{item.quantity_dropped}</span>
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
