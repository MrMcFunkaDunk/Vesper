/** A physical indicator lamp - housing, unlit material, illuminated core,
 * light bloom - instead of a flat colored dot with a box-shadow. Used by
 * StatusChip in place of its old .status-chip-dot whenever a premium deck
 * theme is active (see StatusChip.tsx); does nothing visually under any
 * standard theme, since none of its CSS classes are styled there - the
 * whole treatment lives in premium-structure.css, gated on
 * :root[data-theme="bulkhead"|"cold-ballast"|"command-deck"].
 *
 * Two housing shapes: a round bulb (`shape="circle"`, the default - most
 * status contexts) and a rectangular annunciator window (`shape="rect"`),
 * for the handful of places that want the "backlit legend plate" look
 * instead (see Annunciator, which uses this internally).
 *
 * `lit={false}` renders the housing in its dark, desaturated "unpowered"
 * material rather than just fading a lit one - an off lamp on real
 * equipment still has a visible physical presence, it just isn't glowing. */
export type LampTone = "online" | "warning" | "danger" | "neutral";

interface StatusLampProps {
  tone: LampTone;
  lit?: boolean;
  shape?: "circle" | "rect";
  /** Adds the hard, mechanical steps() blink used for caution/alert states -
   * never for a resting "online" lamp, which only gets the ambient bloom. */
  blink?: boolean;
  className?: string;
}

function StatusLamp({ tone, lit = true, shape = "circle", blink = false, className }: StatusLampProps) {
  return (
    <span
      className={[
        "status-lamp",
        `status-lamp-${shape}`,
        `status-lamp-${tone}`,
        lit ? "status-lamp-lit" : "status-lamp-unlit",
        blink ? "status-lamp-blink" : "",
        className ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <span className="status-lamp-core" />
    </span>
  );
}

export default StatusLamp;
