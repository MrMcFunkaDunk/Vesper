interface WordmarkProps {
  className?: string;
}

/**
 * Oxanium has no Greek glyph coverage, so the Ξ in VΞSPER would silently
 * fall back to whatever generic sans-serif the OS has - substituting Inter
 * (which does cover Greek) explicitly keeps that swap consistent everywhere
 * instead of leaving it to per-machine font fallback.
 */
function Wordmark({ className = "" }: WordmarkProps) {
  return (
    <span className={`brand-word ${className}`.trim()}>
      V<span className="brand-word-xi">Ξ</span>SPER
    </span>
  );
}

export default Wordmark;
