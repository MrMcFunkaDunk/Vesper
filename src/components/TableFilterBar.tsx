import { Search } from "lucide-react";

interface SelectFilterSpec {
  label: string;
  value: string;
  options: string[];
  onChange: (value: string) => void;
}

interface TableFilterBarProps {
  searchQuery: string;
  onSearchChange: (value: string) => void;
  searchPlaceholder: string;
  selects?: SelectFilterSpec[];
  /** Shown at the end of the bar, e.g. "42 of 613" - lets a filtered-down
   * table say so without the caller needing its own separate count line. */
  resultCount?: string;
}

/** A search box plus zero or more "All / <value>" dropdowns, for any table
 * that has more than a handful of rows - built once so every table filters
 * the same way instead of each page reinventing its own search input. Pair
 * with useTextFilter (search) and useSelectFilter (each dropdown) from
 * useSortableRows.ts, chaining one's output into the next's input rows. */
function TableFilterBar({ searchQuery, onSearchChange, searchPlaceholder, selects, resultCount }: TableFilterBarProps) {
  return (
    <div className="table-filter-bar">
      <div className="detail-search table-filter-search">
        <Search size={13} strokeWidth={2} />
        <input type="text" placeholder={searchPlaceholder} value={searchQuery} onChange={(e) => onSearchChange(e.target.value)} />
      </div>
      {selects?.map((s) => (
        <select key={s.label} value={s.value} onChange={(e) => s.onChange(e.target.value)} aria-label={s.label}>
          <option value="">{`All ${s.label}`}</option>
          {s.options.map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ))}
        </select>
      ))}
      {resultCount && <span className="table-filter-count">{resultCount}</span>}
    </div>
  );
}

export default TableFilterBar;
