import { useEffect } from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  BackgroundVariant,
  ConnectionMode,
  useNodesState,
  useEdgesState,
  type NodeMouseHandler,
  type EdgeMouseHandler,
  type OnConnect,
  type OnNodeDrag,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { ChainSystem, Connection } from "../../lib/wormholes";
import SystemNodeCard, { type SystemNodeCardData, type SystemNodeType } from "./SystemNodeCard";
import ConnectionEdgeLine, { type ConnectionEdgeType } from "./ConnectionEdgeLine";

const NODE_TYPES = { system: SystemNodeCard };
const EDGE_TYPES = { connection: ConnectionEdgeLine };

interface ChainCanvasProps {
  systems: ChainSystem[];
  connections: Connection[];
  selectedSystemId: string | null;
  selectedConnectionId: string | null;
  onSelectSystem: (id: string | null) => void;
  onSelectConnection: (id: string | null) => void;
  /** Fired once per drag, on release, so the backend isn't hit on every
   * intermediate drag frame - React Flow's own onNodesChange drives the
   * drag itself locally in the interim. */
  onMoveSystem: (id: string, x: number, y: number) => void;
  /** Fired when the user drags a connection line from one system's handle to
   * another - React Flow's native connect gesture, replacing the old
   * click-node-then-click-node "Connect mode" toggle entirely. */
  onConnect: (fromId: string, toId: string) => void;
  securityBySystemId: Map<number, number>;
  killCountBySystemId: Map<number, number>;
  standingBySystemId: Map<number, number>;
  regionBySystemId: Map<number, string>;
  currentLiveSystemId: number | null;
}

function buildNodeData(
  s: ChainSystem,
  currentLiveSystemId: number | null,
  securityBySystemId: Map<number, number>,
  regionBySystemId: Map<number, string>,
  killCountBySystemId: Map<number, number>,
  standingBySystemId: Map<number, number>,
): SystemNodeCardData {
  return {
    systemName: s.system_name,
    isOrigin: s.is_origin,
    isCurrent: s.system_id === currentLiveSystemId,
    security: securityBySystemId.get(s.system_id) ?? null,
    regionName: regionBySystemId.get(s.system_id) ?? null,
    killCount: killCountBySystemId.get(s.system_id) ?? 0,
    standing: standingBySystemId.get(s.system_id) ?? null,
  };
}

function ChainCanvasInner({
  systems,
  connections,
  selectedSystemId,
  selectedConnectionId,
  onSelectSystem,
  onSelectConnection,
  onMoveSystem,
  onConnect,
  securityBySystemId,
  killCountBySystemId,
  standingBySystemId,
  regionBySystemId,
  currentLiveSystemId,
}: ChainCanvasProps) {
  // The React-Flow-recommended pattern: nodes/edges live in React Flow's own
  // state (via useNodesState/useEdgesState), and onNodesChange/onEdgesChange
  // is wired straight through so React Flow can properly track per-node
  // measurement/drag state internally - hand-rolling a separate position
  // store (an earlier version of this component did) leaves React Flow's
  // own nodes uninitialized and breaks dragging entirely (confirmed via its
  // own console warning: "trying to drag a node that is not initialized").
  const [nodes, setNodes, onNodesChange] = useNodesState<SystemNodeType>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<ConnectionEdgeType>([]);

  // Syncs from the systems prop (backend state) into React Flow's node
  // state, preserving whatever position React Flow currently has for a
  // node already on the canvas (so a completed drag's persisted position
  // doesn't cause a visible snap) while still picking up fresh live-intel
  // data (security/kills/standing) and brand-new systems from auto-map-building.
  useEffect(() => {
    setNodes((current) => {
      const currentById = new Map(current.map((n) => [n.id, n]));
      return systems.map((s) => {
        const existing = currentById.get(s.id);
        return {
          id: s.id,
          type: "system" as const,
          position: existing?.position ?? { x: s.x, y: s.y },
          selected: s.id === selectedSystemId,
          data: buildNodeData(s, currentLiveSystemId, securityBySystemId, regionBySystemId, killCountBySystemId, standingBySystemId),
        };
      });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [systems, selectedSystemId, currentLiveSystemId, securityBySystemId, regionBySystemId, killCountBySystemId, standingBySystemId]);

  useEffect(() => {
    setEdges(
      connections.map((c) => ({
        id: c.id,
        type: "connection" as const,
        source: c.from_chain_system_id,
        target: c.to_chain_system_id,
        selected: c.id === selectedConnectionId,
        data: { connection: c },
      })),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connections, selectedConnectionId]);

  const handleNodeDragStop: OnNodeDrag = (_e, node) => {
    onMoveSystem(node.id, node.position.x, node.position.y);
  };

  const handleNodeClick: NodeMouseHandler = (_e, node) => {
    onSelectSystem(node.id);
  };

  const handleEdgeClick: EdgeMouseHandler = (_e, edge) => {
    onSelectConnection(edge.id);
  };

  const handlePaneClick = () => {
    onSelectSystem(null);
    onSelectConnection(null);
  };

  const handleConnect: OnConnect = (params) => {
    if (params.source && params.target && params.source !== params.target) {
      onConnect(params.source, params.target);
    }
  };

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={NODE_TYPES}
      edgeTypes={EDGE_TYPES}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onNodeDragStop={handleNodeDragStop}
      onNodeClick={handleNodeClick}
      onEdgeClick={handleEdgeClick}
      onPaneClick={handlePaneClick}
      onConnect={handleConnect}
      connectionMode={ConnectionMode.Loose}
      fitView
      className="wh-flow"
      proOptions={{ hideAttribution: true }}
    >
      <Background variant={BackgroundVariant.Dots} gap={24} size={1} color="#24262b" />
      <Controls showInteractive={false} />
    </ReactFlow>
  );
}

function ChainCanvas(props: ChainCanvasProps) {
  return (
    <ReactFlowProvider>
      <ChainCanvasInner {...props} />
    </ReactFlowProvider>
  );
}

export default ChainCanvas;
