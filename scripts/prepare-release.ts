import fs from 'node:fs';
import path from 'node:path';
import * as XLSX from 'xlsx';
import { detectWorkbookInputs } from '../src/importers/uploadBatch';
import { parseUploads } from '../src/importers/friendly';

// Source exports must be downloaded from the private Week 3 Google Drive folder first.
const root = path.resolve('data/private/releases/v0.1.0');
const files = [
  ['members', 'Members', 'members', '1oc3L23uh1yA0DahynUn66N9fU1-Of1xu-TltWpXRfUg'],
  ['attendance', 'Attendance', 'attendance', '1j0u58XrIWn9ZC5gs9zMOkGHfikE95-07jyXVY0gLWfY'],
  ['drivers', 'Drivers', 'availability', '1CP6XmSh9Tc9hfcvDdiQapn9NENgs2zi5TRBMy12ehA4'],
] as const;
const texts = {} as Record<'members' | 'attendance' | 'availability', string>;
const manifest: unknown[] = [];
for (const dir of ['empty-templates', 'week3-examples'])
  fs.mkdirSync(path.join(root, dir), { recursive: true });
for (const [file, tab, kind, id] of files) {
  const source = XLSX.read(fs.readFileSync(path.join(root, 'source-exports', `${file}.xlsx`)), {
    cellNF: true,
  });
  const table = XLSX.utils.sheet_to_json<unknown[]>(source.Sheets[tab], {
    header: 1,
    defval: '',
    blankrows: false,
  });
  const header = table[0];
  if (!header || header[0] !== 'Name') throw new Error(`Unexpected ${tab} headers`);
  const rows = table.filter((row, index) => index === 0 || row.some((value) => value !== ''));
  for (const [dir, data] of [
    ['week3-examples', rows],
    ['empty-templates', [header]],
  ] as const) {
    const sheet = XLSX.utils.aoa_to_sheet(data.map((row) => [...row]));
    sheet['!cols'] = header.map((_, index) => ({
      wch: index === 0 ? 28 : kind === 'members' ? 55 : 16,
    }));
    sheet['!autofilter'] = { ref: sheet['!ref']! };
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, sheet, tab);
    const output = path.join(root, dir, `${file}.xlsx`);
    fs.writeFileSync(
      output,
      XLSX.write(book, { type: 'buffer', bookType: 'xlsx', compression: true }),
    );
    const detected = detectWorkbookInputs(XLSX.read(fs.readFileSync(output), { cellNF: true }));
    if (Object.keys(detected).length !== 1 || !detected[kind])
      throw new Error(`Import detection failed: ${dir}/${file}`);
    if (dir === 'week3-examples') {
      texts[kind] = detected[kind]!.text;
      if (texts[kind] !== detectWorkbookInputs(source)[kind]!.text)
        throw new Error(`Source values changed: ${file}`);
    }
  }
  manifest.push({
    file: `${file}.xlsx`,
    source: `https://docs.google.com/spreadsheets/d/${id}/edit`,
    tab,
    rows: rows.length - 1,
    headers: header,
  });
}
const parsed = parseUploads(texts);
const counts = {
  errors: parsed.issues.filter((issue) => issue.severity === 'error').length,
  warnings: parsed.issues.filter((issue) => issue.severity === 'warning').length,
};
fs.writeFileSync(
  path.join(root, 'source-manifest.json'),
  JSON.stringify(
    {
      version: '0.1.0',
      retrievedAt: new Date().toISOString(),
      files: manifest,
      validation: counts,
      notes:
        'Visible input tables only; original exports retained separately. Dates and records are unchanged and require operational review.',
    },
    null,
    2,
  ),
);
fs.writeFileSync(
  path.join(root, 'validation-details.json'),
  JSON.stringify(parsed.issues, null, 2),
);
fs.copyFileSync('docs/TUTORIAL.md', path.join(root, 'TUTORIAL.md'));
fs.copyFileSync('docs/TUTORIAL.pdf', path.join(root, 'TUTORIAL.pdf'));
fs.cpSync('docs/tutorial-images', path.join(root, 'tutorial-images'), { recursive: true });
console.log(
  JSON.stringify({ release: root, workbooks: 6, sourceValuesPreserved: true, ...counts }),
);
