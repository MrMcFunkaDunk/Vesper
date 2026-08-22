/** Shared CSV-export helpers - extracted from the Skills tab's own export
 * (the first place this existed in the app) so Assets, Wallet, and Market
 * tables can reuse the same quoting/download logic instead of each
 * reimplementing it. */

interface CsvColumn<T> {
  header: string;
  value: (row: T) => string | number;
}

function csvCell(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

export function toCsv<T>(rows: T[], columns: CsvColumn<T>[]): string {
  const header = columns.map((c) => csvCell(c.header)).join(",");
  const lines = rows.map((row) => columns.map((c) => csvCell(String(c.value(row)))).join(","));
  return [header, ...lines].join("\r\n");
}

/** Triggers a browser download of the given CSV text - no Tauri save
 * dialog involved, same as the app's existing skills export. */
export function downloadCsv(filename: string, csv: string): void {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
