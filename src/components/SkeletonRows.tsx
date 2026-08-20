interface SkeletonRowsProps {
  /** How many placeholder rows to render. */
  count?: number;
  /** Row height in px - match whatever real content is about to replace this. */
  height?: number;
}

/** Row-shaped shimmer placeholder for any async panel that's about to show
 * a list/table - used in place of a bare "Loading..." string across the
 * killboard tabs (Corp/Alliance/Character), which previously had no
 * shared loading treatment at all. */
function SkeletonRows({ count = 6, height = 44 }: SkeletonRowsProps) {
  return (
    <div className="skeleton-rows" aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="skeleton-row" style={{ height }} />
      ))}
    </div>
  );
}

export default SkeletonRows;
