// Minimal RFC 4180 CSV: quoted fields, doubled quotes, commas and newlines inside quotes, CRLF or LF.
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [], field = '', quoted = false;
  const input = text.replace(/^﻿/, '');
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (quoted) {
      if (c === '"' && input[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && input[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const [header, ...body] = rows.filter(r => r.some(cell => cell.trim() !== ''));
  if (!header) return [];
  // Undo writeCsv's formula guard so values round-trip exactly.
  return body.map(cells => Object.fromEntries(header.map((h, i) => [h.trim(), (cells[i] ?? '').trim().replace(/^'(?=[=+\-@])/, '')])));
}

const cell = (value: unknown) => {
  const text = value === null || value === undefined ? '' : String(value);
  // Leading =, +, - or @ would run as a formula in spreadsheet apps; prefix it so it stays text.
  const safe = /^[=+\-@]/.test(text) ? `'${text}` : text;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

// Excel-friendly: BOM so UTF-8 opens correctly, CRLF line endings.
export function writeCsv(header: string[], rows: Record<string, unknown>[]): string {
  return '﻿' + [header.join(','), ...rows.map(r => header.map(h => cell(r[h])).join(','))].join('\r\n') + '\r\n';
}
