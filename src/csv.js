// CSV cells for the roster export. Pure (no DOM), so it's unit-tested.
//
// Same rule as the DataHacks site's src/organizer/csv.ts: text that starts
// like a spreadsheet formula (= + - @, tab, CR) gets a leading ' so Excel or
// Sheets shows it instead of running it (a name like =HYPERLINK("…","x")).
// Numbers are left alone. Every cell is quoted, with quotes doubled.

const FORMULA_START = /^[=+\-@\t\r]/;

/** The text of one cell, neutralised but not yet quoted. */
export function csvText(value) {
  if (value === null || value === undefined) return "";
  const text = Array.isArray(value) ? value.join("; ") : String(value);
  return typeof value !== "number" && FORMULA_START.test(text) ? `'${text}` : text;
}

/** One quoted CSV cell. */
export function csvCell(value) {
  return `"${csvText(value).replace(/"/g, '""')}"`;
}

/** Rows (arrays of values) to CSV text. */
export function toCsv(rows, newline = "\n") {
  return rows.map((row) => row.map(csvCell).join(",")).join(newline);
}
