import StatusLamp, { type LampTone } from "./StatusLamp";

export type AnnunciatorState = "on" | "off" | "warn" | "danger";

const STATE_TONE: Record<AnnunciatorState, LampTone> = {
  on: "online",
  off: "neutral",
  warn: "warning",
  danger: "danger",
};

interface AnnunciatorProps {
  label: string;
  state: AnnunciatorState;
}

/** A rectangular backlit annunciator - "● ESI", "○ AUX" - built on the same
 * StatusLamp housing as the round indicators, just in the rect shape. Only
 * ever fed real, already-known VESPER state (see PremiumDashboard) - never
 * fabricated gameplay values, per the premium design brief's own repeated
 * rule against inventing status that doesn't exist. */
function Annunciator({ label, state }: AnnunciatorProps) {
  return (
    <span className={`annunciator annunciator-${state}`}>
      <StatusLamp shape="rect" tone={STATE_TONE[state]} lit={state !== "off"} blink={state === "warn" || state === "danger"} />
      <span className="annunciator-label">{label}</span>
    </span>
  );
}

export default Annunciator;
