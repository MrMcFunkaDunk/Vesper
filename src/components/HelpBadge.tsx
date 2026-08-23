import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import type { HelpContent } from "../lib/helpContent";

/** A field is either one paragraph or several - always render as a list of <p>s. */
function paragraphs(value: string | string[]) {
  const list = Array.isArray(value) ? value : [value];
  return list.map((p, i) => <p key={i} className="help-badge-popover-body">{p}</p>);
}

interface HelpBadgeProps {
  content: HelpContent;
  /** Popover opens to the right by default (top bar usage); pages with less
   * room to the right of the badge can flip it. */
  align?: "left" | "right";
}

/** A small "?" button that opens a popover explaining what the page/tab it
 * sits next to does, how to use it, and what you get out of it - closes on
 * an outside click, an Escape press, or picking a different page (content
 * changing while open, tracked via a key on the wrapping component, isn't
 * this component's job). */
function HelpBadge({ content, align = "right" }: HelpBadgeProps) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handlePointerDown(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    }
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    window.addEventListener("mousedown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("mousedown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  return (
    <div className="help-badge-wrap" ref={wrapRef}>
      <button
        type="button"
        className={`help-badge-button${open ? " help-badge-button-active" : ""}`}
        aria-label={`Help: ${content.title}`}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        ?
      </button>
      {open && (
        <div className={`help-badge-popover help-badge-popover-${align}`} role="dialog" aria-label={`${content.title} help`}>
          <div className="help-badge-popover-header">
            <p className="help-badge-popover-title">{content.title}</p>
            <button type="button" className="help-badge-popover-close" aria-label="Close" onClick={() => setOpen(false)}>
              <X size={14} />
            </button>
          </div>
          <div className="help-badge-popover-section">
            <p className="help-badge-popover-label">What it does</p>
            {paragraphs(content.what)}
          </div>
          <div className="help-badge-popover-section">
            <p className="help-badge-popover-label">How to use it</p>
            {paragraphs(content.how)}
          </div>
          <div className="help-badge-popover-section">
            <p className="help-badge-popover-label">What you'll get</p>
            {paragraphs(content.gives)}
          </div>
        </div>
      )}
    </div>
  );
}

export default HelpBadge;
