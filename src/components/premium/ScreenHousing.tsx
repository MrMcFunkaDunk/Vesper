import type { ReactNode } from "react";

interface ScreenHousingProps {
  title?: string;
  children: ReactNode;
  className?: string;
}

/** The bezel + recessed-display construction layer - a console-mounted
 * screen, not a floating card. Used to frame a zone of the Premium
 * Dashboard (and reusable anywhere else that wants the same "console
 * plane vs. display plane" contrast). Inert under a standard theme; only
 * .screen-housing's premium CSS gives it any visual presence. */
function ScreenHousing({ title, children, className }: ScreenHousingProps) {
  return (
    <div className={`screen-housing ${className ?? ""}`}>
      {title && <div className="screen-housing-title">{title}</div>}
      <div className="screen-housing-display">{children}</div>
    </div>
  );
}

export default ScreenHousing;
