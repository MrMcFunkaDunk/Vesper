import { useEffect, useState } from "react";
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
 * native control's tiny hit targets.
 *
 * The field itself is a plain text input, not type="number" - a controlled
 * number input can't ever actually go blank (an empty string coerces to 0,
 * which immediately re-renders the field showing "0" instead of empty), so
 * clearing it to type a fresh value always left a stray leading 0 behind
 * to delete first. Typed text is tracked separately from the committed
 * numeric value: onChange only fires once what's typed actually parses to
 * a real number, so the field can sit genuinely empty (or mid-typing, like
 * a bare "-" or a trailing ".") without forcing a premature 0 onto it.
 * Blurring away from something that never parsed (or was left blank)
 * snaps back to the last real committed value instead of leaving garbage
 * or a permanently-empty field behind.
 *
 * Lives in its own module (not defined inside IndustryPage.tsx) so pages
 * outside Industry - e.g. Mining's OreTableTab - can reuse it without a
 * cross-page import that would drag that whole page's module graph into
 * their own lazy-loaded chunk. */
export function NumberStepperInput({ value, onChange, min, max, step = 1, className, title }: NumberStepperInputProps) {
  const [text, setText] = useState(String(value));

  // Keeps the displayed text in sync whenever the committed value changes
  // from outside this field's own typing (the +/- buttons, a loaded system
  // preset, Calculate resetting inputs, etc.) - guarded so it never fights
  // the user's own in-progress typing: while what's currently typed still
  // parses to the same number already committed, there's nothing to sync.
  useEffect(() => {
    if (Number(text) !== value) setText(String(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

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
        type="text"
        inputMode="decimal"
        className={className}
        value={text}
        onChange={(e) => {
          const raw = e.target.value;
          setText(raw);
          const parsed = Number(raw);
          if (raw.trim() !== "" && !Number.isNaN(parsed)) onChange(clamp(parsed));
        }}
        onBlur={() => {
          if (text.trim() === "" || Number(text) !== value) setText(String(value));
        }}
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
