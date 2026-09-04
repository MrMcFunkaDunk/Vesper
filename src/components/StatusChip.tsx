import { useTheme, isPremiumTheme } from "../hooks/useTheme";
import StatusLamp from "./premium/StatusLamp";

interface StatusChipProps {
  label: string;
  value: string;
  tone?: "online" | "warning" | "danger" | "neutral";
}

/** Used everywhere the app shows a "LABEL // VALUE" telemetry readout -
 * server status, character connection state, and a few others. Standard
 * themes keep rendering exactly what they always have (a plain dot); under
 * a premium deck it swaps in StatusLamp's physical-housing markup instead,
 * one change point that reaches every existing call site instead of
 * hand-editing each one. */
function StatusChip({ label, value, tone = "neutral" }: StatusChipProps) {
  const [theme] = useTheme();
  const premium = isPremiumTheme(theme);

  return (
    <span className={`status-chip status-chip-${tone}`}>
      <span className="status-chip-label">{label}</span>
      <span className="status-chip-sep">//</span>
      <span className="status-chip-value">
        {premium ? (
          <StatusLamp tone={tone} lit={tone !== "neutral"} blink={tone === "warning" || tone === "danger"} />
        ) : (
          <span className="status-chip-dot" />
        )}
        {value}
      </span>
    </span>
  );
}

export default StatusChip;
