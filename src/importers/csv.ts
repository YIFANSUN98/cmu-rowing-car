export interface CsvTable {
  headers: string[];
  rows: Record<string, string>[];
  rowNumbers: number[];
}
// RFC 4180 quoting, BOM, CRLF and embedded newlines; errors are never silently skipped.
export function parseCsv(input: string): CsvTable {
  const text = input.replace(/^\uFEFF/, '');
  const table: string[][] = [];
  const rowNumbers: number[] = [];
  let row: string[] = [],
    value = '',
    quoted = false,
    closed = false,
    line = 1,
    start = 1;
  const endField = () => {
    row.push(value);
    value = '';
    closed = false;
  };
  const endRow = () => {
    endField();
    if (row.some((v) => v.trim())) {
      table.push(row);
      rowNumbers.push(start);
    }
    row = [];
    start = line + 1;
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          value += '"';
          i++;
        } else {
          quoted = false;
          closed = true;
        }
      } else {
        value += c;
        if (c === '\n') line++;
      }
      continue;
    }
    if (c === '"') {
      if (value || closed) throw new Error(`CSV row ${line}: unexpected quote.`);
      quoted = true;
    } else if (c === ',') endField();
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      endRow();
      line++;
    } else {
      if (closed) throw new Error(`CSV row ${line}: characters after closing quote.`);
      value += c;
    }
  }
  if (quoted) throw new Error(`CSV row ${start}: unclosed quote.`);
  if (value || row.length || closed) endRow();
  const headers = (table.shift() ?? []).map((x) => x.trim());
  rowNumbers.shift();
  if (!headers.length) throw new Error('The file is empty.');
  if (new Set(headers).size !== headers.length || headers.some((h) => !h))
    throw new Error('CSV headers must be unique and nonempty.');
  return {
    headers,
    rowNumbers,
    rows: table.map((r, i) => {
      if (r.length !== headers.length)
        throw new Error(
          `CSV row ${rowNumbers[i]} has ${r.length} columns; expected ${headers.length}.`,
        );
      return Object.fromEntries(headers.map((h, j) => [h, r[j].trim()]));
    }),
  };
}
export function writeCsv(
  headers: string[],
  rows: Record<string, unknown>[],
  protectFormulas = false,
): string {
  const quote = (x: unknown) => {
    let s = String(x ?? '');
    if (protectFormulas && /^[=+@\-\t\r]/.test(s)) s = "'" + s;
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  return (
    [
      headers.map(quote).join(','),
      ...rows.map((r) => headers.map((h) => quote(r[h])).join(',')),
    ].join('\r\n') + '\r\n'
  );
}
