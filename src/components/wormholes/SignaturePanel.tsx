import { useState } from "react";
import { Trash2 } from "lucide-react";
import {
  importSignatures,
  deleteSignature,
  type ChainSystem,
  type Signature,
  type SignatureKind,
} from "../../lib/wormholes";
import { useErrorReporter } from "../../hooks/useErrorReporter";

interface SignaturePanelProps {
  chainId: string;
  system: ChainSystem;
  signatures: Signature[];
  onChanged: () => void;
}

const KIND_BY_GROUP: Record<string, SignatureKind> = {
  "combat site": "combat",
  "data site": "data",
  "relic site": "relic",
  "gas site": "gas",
  "wormhole": "wormhole",
  "ore site": "ore",
};

function normalizeKind(group: string): SignatureKind {
  return KIND_BY_GROUP[group.trim().toLowerCase()] ?? "unknown";
}

/** Parses EVE's in-game Scanning window clipboard paste: one signature per
 * line, tab-separated (Sig ID, Group, Name, Signal Strength, Distance) -
 * some columns are blank until the site is actually scanned down, so this
 * only requires the leading Sig ID column to treat a line as a signature. */
function parseScanPaste(text: string): { sig_id: string; kind: SignatureKind; sig_type: string; signal_strength: string }[] {
  const results: { sig_id: string; kind: SignatureKind; sig_type: string; signal_strength: string }[] = [];
  for (const line of text.split("\n")) {
    const cols = line.split("\t").map((c) => c.trim());
    if (cols.length < 2) continue;
    const sigId = cols[0];
    if (!/^[A-Z]{3}-\d{3}$/.test(sigId)) continue;
    results.push({
      sig_id: sigId,
      kind: normalizeKind(cols[1] ?? ""),
      sig_type: cols[2] ?? "",
      signal_strength: cols[3] ?? "",
    });
  }
  return results;
}

const KIND_LABEL: Record<SignatureKind, string> = {
  unknown: "Unscanned",
  combat: "Combat",
  data: "Data",
  relic: "Relic",
  gas: "Gas",
  wormhole: "Wormhole",
  ore: "Ore",
};

const AGE_STALE_MS = 30 * 60 * 1000;
const AGE_OLD_MS = 2 * 60 * 60 * 1000;

function ageClass(lastSeenAt: number): string {
  const ageMs = Date.now() - lastSeenAt * 1000;
  if (ageMs > AGE_OLD_MS) return "wh-sig-age-old";
  if (ageMs > AGE_STALE_MS) return "wh-sig-age-stale";
  return "wh-sig-age-fresh";
}

function SignaturePanel({ chainId, system, signatures, onChanged }: SignaturePanelProps) {
  const [paste, setPaste] = useState("");
  const [importing, setImporting] = useState(false);
  const [missingIds, setMissingIds] = useState<string[]>([]);
  const reportError = useErrorReporter();

  async function handleImport() {
    const parsed = parseScanPaste(paste);
    if (parsed.length === 0) {
      reportError("No recognizable signatures found in that paste - copy directly from the in-game Scanning window.");
      return;
    }
    setImporting(true);
    try {
      const result = await importSignatures(chainId, system.id, parsed);
      setMissingIds(result.missing_sig_ids);
      setPaste("");
      onChanged();
    } catch (err) {
      reportError(`Failed to import signatures: ${String(err)}`);
    } finally {
      setImporting(false);
    }
  }

  async function handleDelete(signatureId: string) {
    try {
      await deleteSignature(chainId, signatureId);
      onChanged();
    } catch (err) {
      reportError(`Failed to delete signature: ${String(err)}`);
    }
  }

  return (
    <div className="wh-sig-panel">
      <p className="wh-side-label">Signatures in {system.system_name}</p>
      {signatures.length === 0 ? (
        <p className="detail-empty wh-sig-empty">No signatures scanned yet.</p>
      ) : (
        <div className="wh-sig-list">
          {signatures.map((sig) => (
            <div key={sig.id} className={`wh-sig-row ${ageClass(sig.last_seen_at)}`}>
              <span className="wh-sig-id">{sig.sig_id}</span>
              <span className="wh-sig-kind">{KIND_LABEL[sig.kind]}</span>
              <span className="wh-sig-type">{sig.sig_type || "—"}</span>
              <button type="button" onClick={() => handleDelete(sig.id)} title="Delete signature">
                <Trash2 size={12} strokeWidth={2} />
              </button>
            </div>
          ))}
        </div>
      )}

      {missingIds.length > 0 && (
        <p className="wh-sig-missing">
          Not in your last scan: {missingIds.join(", ")} - delete any that have decayed.
        </p>
      )}

      <textarea
        className="price-checker-input wh-sig-paste"
        placeholder="Paste the in-game Scanning window results here..."
        rows={4}
        value={paste}
        onChange={(e) => setPaste(e.target.value)}
      />
      <button type="button" className="kills-sync-btn" onClick={handleImport} disabled={importing || paste.trim().length === 0}>
        {importing ? "Importing..." : "Import Signatures"}
      </button>
    </div>
  );
}

export default SignaturePanel;
