import { usePersistentState } from "./usePersistentState";

const STORAGE_KEY = "vesper.kills.securityBandFilters";

export interface SecurityBandFilters {
  highsec: boolean;
  lowsec: boolean;
  nullsec: boolean;
  wspace: boolean;
}

const DEFAULT_FILTERS: SecurityBandFilters = { highsec: true, lowsec: true, nullsec: true, wspace: true };

/** Which security bands show in kill feeds - shared across Tracked Systems
 * and Most Recent Kills (same reasoning as useShowNpcKills: the choice
 * shouldn't reset when switching between them). All default on. */
export function useSecurityBandFilters() {
  const [filters, setFilters] = usePersistentState<SecurityBandFilters>(STORAGE_KEY, DEFAULT_FILTERS, (stored) => ({
    ...DEFAULT_FILTERS,
    ...stored,
  }));

  function toggle(band: keyof SecurityBandFilters) {
    setFilters((prev) => ({ ...prev, [band]: !prev[band] }));
  }

  return [filters, toggle] as const;
}
