// Small RFC 4180 CSV helpers shared by imports and exports.
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []; let row: string[] = []; let cell = ''; let quoted = false;
  const input = text.replace(/^﻿/, '');
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (quoted) { if (c === '"' && input[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') quoted = false; else cell += c; continue; }
    if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && input[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.some(c => c.trim()));
}
// Rows as objects keyed by lower-case header names with spaces and dashes turned into underscores.
export function csvRecords(text: string) {
  const [head, ...rows] = parseCsv(text);
  if (!head) return [];
  const keys = head.map(h => h.trim().toLowerCase().replace(/[\s-]+/g, '_'));
  return rows.map(r => Object.fromEntries(keys.map((k, i) => [k, (r[i] ?? '').trim()])));
}
// Spreadsheet cells that start with = + - @ (or a tab or carriage return) are formulas; prefix them so an
// export opened in Excel or Sheets can never run one.
export const csvCell = (value: unknown) => {
  let text = value === null || value === undefined ? '' : value instanceof Date ? value.toISOString() : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};
