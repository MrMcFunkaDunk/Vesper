import { useEffect, useRef, useState } from "react";
import type { ReprocessingFacility, ReprocessingRig, SecurityBand } from "../lib/industryMath";

const STORAGE_KEY = "vesper.settings.industryDefaults";

export interface ProductionDefaults {
  materialEfficiency: number;
  timeEfficiency: number;
  /** Opaque - IndustryPage.tsx's own StructureTier union, kept as a plain
   * string here so this hook doesn't need to import a page component's
   * local type. Falls back to a sane default if the page doesn't recognize it. */
  structure: string;
  facilityTax: number;
}

export interface ReprocessingDefaults {
  facility: ReprocessingFacility;
  rig: ReprocessingRig;
  security: SecurityBand;
  reprocessingLevel: number;
  reprocessingEfficiencyLevel: number;
  oreProcessingLevel: number;
  /** Opaque - see ProductionDefaults.structure. */
  implant: string;
}

export interface IndustryDefaults {
  production: ProductionDefaults;
  reprocessing: ReprocessingDefaults;
}

const DEFAULTS: IndustryDefaults = {
  production: { materialEfficiency: 10, timeEfficiency: 20, structure: "engineering_complex", facilityTax: 0.0025 },
  reprocessing: {
    facility: "citadel_or_engineering_complex",
    rig: "t2",
    security: "highsec",
    reprocessingLevel: 5,
    reprocessingEfficiencyLevel: 4,
    oreProcessingLevel: 5,
    implant: "none",
  },
};

function readDefaults(): IndustryDefaults {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULTS;
    const parsed = JSON.parse(raw) as Partial<IndustryDefaults>;
    return {
      production: { ...DEFAULTS.production, ...parsed.production },
      reprocessing: { ...DEFAULTS.reprocessing, ...parsed.reprocessing },
    };
  } catch {
    return DEFAULTS;
  }
}

/** Saved default inputs for the Industry tab's Production and Reprocessing
 * calculators (LazyBlacksmith-style per-activity profile) - so the
 * calculators open with your own usual ME/TE/facility/skill setup instead
 * of resetting to generic values every visit. */
export function useIndustryDefaults() {
  const [defaults, setDefaults] = useState<IndustryDefaults>(() => readDefaults());

  const hydrated = useRef(false);
  useEffect(() => {
    if (!hydrated.current) {
      hydrated.current = true;
      return;
    }
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(defaults));
    } catch {
      // Not worth surfacing - worst case the preference doesn't persist.
    }
  }, [defaults]);

  function saveProductionDefaults(next: ProductionDefaults) {
    setDefaults((prev) => ({ ...prev, production: next }));
  }

  function saveReprocessingDefaults(next: ReprocessingDefaults) {
    setDefaults((prev) => ({ ...prev, reprocessing: next }));
  }

  return { defaults, saveProductionDefaults, saveReprocessingDefaults };
}
