/** Finds an unoccupied spot near an anchor point for a newly-added chain
 * system - a clockwise ring search (try 8 compass angles at increasing
 * radii, keep the first candidate far enough from everything already
 * placed) rather than anything fancier, since a wormhole chain is at most
 * a few dozen nodes and this only needs to avoid literal overlap, not
 * produce a beautiful layout. Pure/no React or invoke dependency so it's
 * easy to reason about and test in isolation. */
export function findFreePosition(
  existing: { x: number; y: number }[],
  anchorX: number,
  anchorY: number,
  minSpacing = 260,
): { x: number; y: number } {
  if (existing.length === 0) {
    return { x: anchorX, y: anchorY };
  }

  // Node cards are ~160-200px wide, so the ring radii need real headroom -
  // the first ring is deliberately sized to clear one card width to the
  // right, which is also what makes a simple "add, then add again" flow
  // naturally lay out as a straight left-to-right line (angle 0 = due east
  // is always the first candidate tried) rather than needing a dedicated
  // "extend the line" special case.
  const RINGS = [260, 420, 620, 860];
  const ANGLE_STEPS = 8;

  let bestCandidate = { x: anchorX + RINGS[0], y: anchorY };
  let bestDistance = -Infinity;

  for (const radius of RINGS) {
    for (let step = 0; step < ANGLE_STEPS; step++) {
      const angle = (step / ANGLE_STEPS) * Math.PI * 2;
      const candidate = { x: anchorX + Math.cos(angle) * radius, y: anchorY + Math.sin(angle) * radius };
      const nearestDist = Math.min(...existing.map((p) => Math.hypot(p.x - candidate.x, p.y - candidate.y)));
      if (nearestDist >= minSpacing) {
        return candidate;
      }
      if (nearestDist > bestDistance) {
        bestDistance = nearestDist;
        bestCandidate = candidate;
      }
    }
  }

  return bestCandidate;
}
