import { Minus, Plus } from "lucide-react";

interface NumberStepperInputProps {
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  className?: string;
  title?: string;
}

/** Every plain number input across the Industry tabs used the browser's own
 * up/down spinner arrows - replaced everywhere with explicit +/- buttons
 * instead, which are easier to hit precisely and read at a glance than the
 * native control's tiny hit targets. min/max are clamped the same way each
 * field's own onChange already did (an empty/invalid field falls back to 0
 * before clamping, which lands on the same floor every existing field's own
 * fallback constant already matched its min at).
 *
 * Lives in its own module (not defined inside IndustryPage.tsx) so pages
 * outside Industry - e.g. Mining's OreTableTab - can reuse it without a
 * cross-page import that would drag that whole page's module graph into
 * their own lazy-loaded chunk. */
export function NumberStepperInput({ value, onChange, min, max, step = 1, className, title }: NumberStepperInputProps) {
  function clamp(next: number): number {
    let result = next;
    if (min != null) result = Math.max(min, result);
    if (max != null) result = Math.min(max, result);
    return result;
  }

  return (
    <div className="industry-number-stepper" title={title}>
      <button
        type="button"
        className="industry-number-stepper-btn"
        onClick={() => onChange(clamp(value - step))}
        disabled={min != null && value <= min}
        aria-label="Decrease"
      >
        <Minus size={12} strokeWidth={2.5} />
      </button>
      <input
        type="number"
        className={className}
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(e) => onChange(clamp(Number(e.target.value) || 0))}
      />
      <button
        type="button"
        className="industry-number-stepper-btn"
        onClick={() => onChange(clamp(value + step))}
        disabled={max != null && value >= max}
        aria-label="Increase"
      >
        <Plus size={12} strokeWidth={2.5} />
      </button>
    </div>
  );
}

export default NumberStepperInput;
