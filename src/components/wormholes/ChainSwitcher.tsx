import { useState } from "react";
import { Plus, Trash2, Pencil, Check, X, LocateFixed } from "lucide-react";
import type { ChainSummary } from "../../lib/wormholes";

interface ChainSwitcherProps {
  chains: ChainSummary[];
  activeChainId: string | null;
  onSelect: (id: string) => void;
  onCreate: (name: string) => void;
  onRename: (id: string, name: string) => void;
  onDelete: (id: string) => void;
  onToggleAutoMap: (id: string, enabled: boolean) => void;
}

function ChainSwitcher({ chains, activeChainId, onSelect, onCreate, onRename, onDelete, onToggleAutoMap }: ChainSwitcherProps) {
  const [creating, setCreating] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");

  function startCreate() {
    setDraftName("New Chain");
    setCreating(true);
    setRenamingId(null);
  }

  function confirmCreate() {
    const name = draftName.trim();
    if (name) onCreate(name);
    setCreating(false);
  }

  function startRename(chain: ChainSummary) {
    setDraftName(chain.name);
    setRenamingId(chain.id);
    setCreating(false);
  }

  function confirmRename() {
    const name = draftName.trim();
    if (renamingId && name) onRename(renamingId, name);
    setRenamingId(null);
  }

  return (
    <div className="wh-chain-switcher">
      {chains.map((chain) =>
        renamingId === chain.id ? (
          <div key={chain.id} className="wh-chain-rename">
            <input
              type="text"
              autoFocus
              value={draftName}
              onChange={(e) => setDraftName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") confirmRename();
                if (e.key === "Escape") setRenamingId(null);
              }}
            />
            <button type="button" onClick={confirmRename} title="Save">
              <Check size={13} strokeWidth={2} />
            </button>
            <button type="button" onClick={() => setRenamingId(null)} title="Cancel">
              <X size={13} strokeWidth={2} />
            </button>
          </div>
        ) : (
          <button
            key={chain.id}
            type="button"
            className={`wh-chain-pill${chain.id === activeChainId ? " wh-chain-pill-active" : ""}`}
            onClick={() => onSelect(chain.id)}
          >
            {chain.name}
            <span className="wh-chain-pill-count">{chain.system_count}</span>
            <span
              className={`wh-chain-pill-action wh-chain-automap-toggle${chain.auto_map_enabled ? " wh-chain-automap-toggle-active" : ""}`}
              onClick={(e) => {
                e.stopPropagation();
                onToggleAutoMap(chain.id, !chain.auto_map_enabled);
              }}
              title={chain.auto_map_enabled ? "Auto-map is on - click to turn off" : "Auto-map is off - click to track your live jumps onto this chain"}
            >
              <LocateFixed size={11} strokeWidth={2} />
            </span>
            <span
              className="wh-chain-pill-action"
              onClick={(e) => {
                e.stopPropagation();
                startRename(chain);
              }}
              title="Rename"
            >
              <Pencil size={11} strokeWidth={2} />
            </span>
            <span
              className="wh-chain-pill-action"
              onClick={(e) => {
                e.stopPropagation();
                if (confirm(`Delete chain "${chain.name}"? This cannot be undone.`)) onDelete(chain.id);
              }}
              title="Delete"
            >
              <Trash2 size={11} strokeWidth={2} />
            </span>
          </button>
        ),
      )}

      {creating ? (
        <div className="wh-chain-rename">
          <input
            type="text"
            autoFocus
            value={draftName}
            onChange={(e) => setDraftName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") confirmCreate();
              if (e.key === "Escape") setCreating(false);
            }}
          />
          <button type="button" onClick={confirmCreate} title="Save">
            <Check size={13} strokeWidth={2} />
          </button>
          <button type="button" onClick={() => setCreating(false)} title="Cancel">
            <X size={13} strokeWidth={2} />
          </button>
        </div>
      ) : (
        <button type="button" className="wh-chain-pill wh-chain-pill-new" onClick={startCreate}>
          <Plus size={13} strokeWidth={2} /> New Chain
        </button>
      )}
    </div>
  );
}

export default ChainSwitcher;
