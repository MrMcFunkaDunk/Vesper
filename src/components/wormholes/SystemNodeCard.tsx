import type { CSSProperties } from "react";
import { Handle, Position, type NodeProps, type Node } from "@xyflow/react";
import { Home, Skull } from "lucide-react";
import { securityColor, securityBand, formatSecurity } from "../../lib/format";

export interface SystemNodeCardData {
  systemName: string;
  isOrigin: boolean;
  isCurrent: boolean;
  security: number | null;
  regionName: string | null;
  killCount: number;
  standing: number | null;
  [key: string]: unknown;
}

export type SystemNodeType = Node<SystemNodeCardData, "system">;

const BAND_LABEL: Record<"high" | "low" | "null", string> = {
  high: "HI-SEC",
  low: "LOW-SEC",
  null: "NULL-SEC",
};

const HANDLE_POSITIONS = [Position.Top, Position.Right, Position.Bottom, Position.Left] as const;

function SystemNodeCard({ data, selected }: NodeProps<SystemNodeType>) {
  // Wormhole systems are stored with a sentinel security around -1.0 (see
  // typeIconUrl/securityColor callers elsewhere) - real k-space never goes
  // below 0.0, so this is the reliable way to tell "in a hole" from "null-sec".
  const isWormholeSpace = data.security != null && data.security < -0.5;
  const band = data.security != null ? securityBand(data.security) : null;
  const classColor = data.security != null ? securityColor(data.security) : "#8a8f98";
  const standingColor = data.standing != null ? (data.standing > 0 ? "#64b5f6" : data.standing < 0 ? "#cf6679" : null) : null;

  return (
    <div
      className="wh-node"
      data-current={data.isCurrent || undefined}
      data-home={data.isOrigin || undefined}
      data-selected={selected || undefined}
      style={
        {
          "--wh-node-class-color": classColor,
          ...(standingColor ? { "--wh-node-standing-color": standingColor } : {}),
        } as CSSProperties
      }
    >
      {HANDLE_POSITIONS.map((pos) => (
        <Handle key={pos} type="source" position={pos} id={pos} className="wh-node-handle" />
      ))}

      <div className="wh-node-header">
        {data.isCurrent && <span className="wh-node-current-dot" title="You are here" />}
        {data.isOrigin && (
          <span className="wh-node-home-icon" title="Origin system">
            <Home size={13} strokeWidth={2} />
          </span>
        )}
        <span className="wh-node-name">{data.systemName}</span>
        {data.security != null && (
          <span className="wh-node-truesec" style={{ color: classColor }}>
            {formatSecurity(data.security)}
          </span>
        )}
      </div>

      <div className="wh-node-meta">
        <span className="wh-node-class-badge" style={{ color: classColor }}>
          {isWormholeSpace ? "J-SPACE" : band ? BAND_LABEL[band] : ""}
        </span>
        {data.killCount > 0 && (
          <span className="wh-node-kill-badge" title={`${data.killCount} recent kill${data.killCount === 1 ? "" : "s"}`}>
            <Skull size={11} strokeWidth={2} /> {data.killCount}
          </span>
        )}
      </div>

      {!isWormholeSpace && data.regionName && <div className="wh-node-region">{data.regionName}</div>}
    </div>
  );
}

export default SystemNodeCard;
