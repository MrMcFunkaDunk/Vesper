interface StatusChipProps {
  label: string;
  value: string;
  tone?: "online" | "warning" | "danger" | "neutral";
}

function StatusChip({ label, value, tone = "neutral" }: StatusChipProps) {
  return (
    <span className={`status-chip status-chip-${tone}`}>
      <span className="status-chip-label">{label}</span>
      <span className="status-chip-sep">//</span>
      <span className="status-chip-value">
        <span className="status-chip-dot" />
        {value}
      </span>
    </span>
  );
}

export default StatusChip;
