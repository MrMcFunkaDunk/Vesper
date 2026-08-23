import { useMemo, useState } from "react";

export type SortDirection = "asc" | "desc";

export type SortAccessor<T> = (row: T) => string | number | null | undefined;

/**
 * Generic client-side sort for a table's already-fetched row array. Clicking
 * the same column again flips direction; clicking a new column starts
 * descending for numeric-looking values (most tables here rank by ISK/count,
 * where "biggest first" is the useful default) and ascending for the rest.
 */
export function useSortableRows<T>(rows: T[], accessors: Record<string, SortAccessor<T>>, initialKey?: string, initialDir?: SortDirection) {
  const [sortKey, setSortKey] = useState<string | null>(initialKey ?? null);
  const [sortDir, setSortDir] = useState<SortDirection>(initialDir ?? "desc");

  function sort(key: string, defaultDir?: SortDirection) {
    if (key === sortKey) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir(defaultDir ?? "desc");
    }
  }

  const sorted = useMemo(() => {
    if (!sortKey) return rows;
    const accessor = accessors[sortKey];
    if (!accessor) return rows;
    const withKeys = rows.map((row) => ({ row, v: accessor(row) }));
    withKeys.sort((a, b) => {
      const av = a.v;
      const bv = b.v;
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (typeof av === "number" && typeof bv === "number") return av - bv;
      return String(av).localeCompare(String(bv), undefined, { sensitivity: "base" });
    });
    if (sortDir === "desc") withKeys.reverse();
    return withKeys.map((w) => w.row);
  }, [rows, accessors, sortKey, sortDir]);

  return { rows: sorted, sortKey, sortDir, sort };
}

/**
 * Generic client-side substring filter over a text query, matched against
 * whatever fields a table wants searchable (name/ship/system/etc).
 */
export function useTextFilter<T>(rows: T[], fields: (row: T) => (string | number | null | undefined)[]) {
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((row) => fields(row).some((f) => f != null && String(f).toLowerCase().includes(q)));
  }, [rows, fields, query]);

  return { query, setQuery, filtered };
}

/**
 * A single-value dropdown filter over one column - "All" plus every distinct
 * value actually present in the current rows (so the option list never goes
 * stale or offers a choice that would return nothing), sorted for a stable
 * order. Chain several of these plus useTextFilter for a full filter bar;
 * each one filters whatever the previous one already narrowed down to, so
 * a picked value that's no longer reachable just quietly stops matching
 * rather than needing to be reset by hand.
 */
export function useSelectFilter<T>(rows: T[], accessor: (row: T) => string | null | undefined) {
  const [value, setValue] = useState<string>("");

  const options = useMemo(() => {
    const seen = new Set<string>();
    for (const row of rows) {
      const v = accessor(row);
      if (v) seen.add(v);
    }
    return Array.from(seen).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  }, [rows, accessor]);

  const filtered = useMemo(() => {
    if (!value) return rows;
    return rows.filter((row) => accessor(row) === value);
  }, [rows, accessor, value]);

  return { value, setValue, options, filtered };
}
