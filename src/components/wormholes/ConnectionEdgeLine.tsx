import { BaseEdge, EdgeLabelRenderer, getStraightPath, type EdgeProps, type Edge } from "@xyflow/react";
import type { Connection } from "../../lib/wormholes";

export type ConnectionEdgeType = Edge<{ connection: Connection }, "connection">;

const MASS_COLOR: Record<string, string> = {
  fresh: "#5fbf8a",
  reduced: "#e0a85c",
  critical: "#e0685f",
};

function ConnectionEdgeLine({ sourceX, sourceY, targetX, targetY, data, selected }: EdgeProps<ConnectionEdgeType>) {
  const conn = data?.connection;
  const [edgePath, labelX, labelY] = getStraightPath({ sourceX, sourceY, targetX, targetY });
  if (!conn) return <BaseEdge path={edgePath} />;

  const isStargate = conn.kind === "stargate";
  const broken = !isStargate && (conn.from_signature_broken || conn.to_signature_broken);
  const color = isStargate ? "#5b9bd9" : broken ? "#e0685f" : MASS_COLOR[conn.mass_status] ?? "#8a8f98";

  return (
    <>
      <BaseEdge
        path={edgePath}
        style={{
          stroke: color,
          strokeWidth: selected ? 3 : isStargate ? 1.5 : 2,
          strokeDasharray: !isStargate && conn.is_eol ? "7 5" : undefined,
          opacity: isStargate ? 0.65 : 1,
        }}
      />
      <EdgeLabelRenderer>
        <div
          className={`wh-edge-label${isStargate ? " wh-edge-label-gate" : ""}${broken ? " wh-edge-label-broken" : ""}`}
          style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`, borderColor: color, color }}
        >
          {isStargate ? "G" : broken ? "!" : conn.wormhole_type}
        </div>
      </EdgeLabelRenderer>
    </>
  );
}

export default ConnectionEdgeLine;
