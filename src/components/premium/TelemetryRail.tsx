export interface TelemetryItem {
  label: string;
  value: string;
}

/** A horizontal strip of small labelled readouts - "N PILOTS", "TOTAL ISK"
 * - always fed real, already-computed VESPER values by the caller (see
 * PremiumDashboard's aggregate math). Never fabricates a number itself. */
function TelemetryRail({ items }: { items: TelemetryItem[] }) {
  return (
    <div className="telemetry-rail">
      {items.map((item) => (
        <div className="telemetry-rail-item" key={item.label}>
          <span className="telemetry-rail-label">{item.label}</span>
          <span className="telemetry-rail-value">{item.value}</span>
        </div>
      ))}
    </div>
  );
}

export default TelemetryRail;
