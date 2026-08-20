import { useEffect, useRef, useState } from "react";

const STORAGE_KEY = "vesper.kills.securityBandFilters";

export interface SecurityBandFilters {
  highsec: boolean;
  lowsec: boolean;
  nullsec: boolean;
  wspace: boolean;
}

const DEFAULT_FILTERS: SecurityBandFilters = { highsec: true, lowsec: true, nullsec: true, wspace: true };

function readFilters(): SecurityBandFilters {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_FILTERS;
    return { ...DEFAULT_FILTERS, ...(JSON.parse(raw) as Partial<SecurityBandFilters>) };
  } catch {
    return DEFAULT_FILTERS;
  }
}

/** Which security bands show in kill feeds - shared across Tracked Systems
 * and Most Recent Kills (same reasoning as useShowNpcKills: the choice
 * shouldn't reset when switching between them). All default on. */
export function useSecurityBandFilters() {
  const [filters, setFilters] = useState<SecurityBandFilters>(() => readFilters());

  const hydrated = useRef(false);
  useEffect(() => {
    if (!hydrated.current) {
      hydrated.current = true;
      return;
    }
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(filters));
    } catch {
      // Not worth surfacing - worst case the preference doesn't persist.
    }
  }, [filters]);

  function toggle(band: keyof SecurityBandFilters) {
    setFilters((prev) => ({ ...prev, [band]: !prev[band] }));
  }

  return [filters, toggle] as const;
}
