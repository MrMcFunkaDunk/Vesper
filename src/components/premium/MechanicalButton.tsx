import type { ReactNode } from "react";

interface MechanicalButtonProps {
  children: ReactNode;
  onClick?: () => void;
  variant?: "primary" | "danger";
  disabled?: boolean;
  type?: "button" | "submit";
  title?: string;
}

/** A distinct, heavier control from the generic button treatment every
 * <button> already gets under a premium deck (premium-structure.css) -
 * thicker housing, a stronger press, reserved for a page's actual primary
 * actions (Compare Skills, Add Character) rather than every button in the
 * app, so it reads as a deliberately heavier control, not just "the same
 * button again". Renders a plain <button> with no special class under a
 * standard theme - premium-structure.css is the only thing that ever
 * styles .mechanical-button, so this is inert everywhere else. */
function MechanicalButton({ children, onClick, variant = "primary", disabled, type = "button", title }: MechanicalButtonProps) {
  return (
    <button
      type={type}
      className={`mechanical-button mechanical-button-${variant}`}
      onClick={onClick}
      disabled={disabled}
      title={title}
    >
      {children}
    </button>
  );
}

export default MechanicalButton;
