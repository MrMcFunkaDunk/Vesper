import type { SortDirection } from "../hooks/useSortableRows";

interface SortableThProps {
  label: string;
  sortKey: string;
  activeKey: string | null;
  dir: SortDirection;
  onSort: (key: string) => void;
  numeric?: boolean;
  defaultDir?: SortDirection;
}

/** Drop-in replacement for a plain <th> that adds click-to-sort, matching
 * the existing .data-table th styling exactly and only adding a caret. */
export function SortableTh({ label, sortKey, activeKey, dir, onSort, numeric }: SortableThProps) {
  const active = activeKey === sortKey;
  return (
    <th
      className={`data-table-th-sortable${numeric ? " data-table-numeric" : ""}`}
      onClick={() => onSort(sortKey)}
      aria-sort={active ? (dir === "asc" ? "ascending" : "descending") : "none"}
    >
      {label}
      <span className={`data-table-sort-caret${active ? " data-table-sort-caret-active" : ""}`}>
        {active ? (dir === "asc" ? "▲" : "▼") : "▲▼"}
      </span>
    </th>
  );
}
