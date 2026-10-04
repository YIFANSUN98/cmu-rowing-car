import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { importLegacy } from '../src/importers/legacy';
import { writeCsv } from '../src/importers/csv';
import { headers } from '../src/domain/validation';
const XLSX = createRequire(import.meta.url)('xlsx') as typeof import('xlsx');
const args = process.argv.slice(2);
const arg = (key: string, fallback = '') => {
  const i = args.indexOf('--' + key);
  return i < 0 ? fallback : args[i + 1];
};
const input = path.resolve(arg('input-dir', 'data/private/raw')),
  output = path.resolve(arg('output-dir', 'data/private/normalized'));
const privateRoot = path.resolve('data/private');
if (output !== privateRoot && !output.startsWith(privateRoot + path.sep))
  throw new Error('Derived personal data must be written under data/private/.');
const names = [
  'CMURC Members Info 2025-26.xlsx',
  'Cars week 1.xlsx',
  'Cars week 3.xlsx',
  'Cars week 4.xlsx',
];
const found = names.filter((n) => fs.existsSync(path.join(input, n))),
  missing = names.filter((n) => !found.includes(n));
const json = (key: string) =>
  arg(key) ? JSON.parse(fs.readFileSync(arg(key), 'utf8')) : undefined;
const report = importLegacy(
  found.map((name) => ({
    name,
    workbook: XLSX.readFile(path.join(input, name), { cellDates: false }),
  })),
  { aliases: json('aliases'), dates: json('dates') },
);
fs.mkdirSync(output, { recursive: true, mode: 0o700 });
const write = (name: string, value: string) =>
  fs.writeFileSync(path.join(output, name), value, { mode: 0o600 });
write('review-report.json', JSON.stringify({ ...report, missingSources: missing }, null, 2));
write(
  'members.draft.csv',
  writeCsv(
    headers.members,
    report.members.map((m) => ({ ...m })),
  ),
);
write(
  'attendance.staged.csv',
  writeCsv(
    [
      'date',
      'member_id',
      'attending',
      'transport_mode',
      'weekday',
      'sourceDay',
      'evidenceRoles',
      'assignmentOnly',
    ],
    report.attendance.map((r) => ({ ...r, evidenceRoles: r.evidenceRoles.join(';') })),
  ),
);
write('assignment-evidence.json', JSON.stringify(report.evidence, null, 2));
write('pickup-evidence.json', JSON.stringify(report.pickups, null, 2));
write('identity-review.json', JSON.stringify(report.identityReview, null, 2));
write(
  'dates.template.json',
  JSON.stringify(
    Object.fromEntries(report.sheets.map((s) => [s.workbook + '::' + s.sheet, ''])),
    null,
    2,
  ),
);
write('aliases.template.json', '{}\n');
write(
  'REVIEW.md',
  `# Private draft reconciliation\n\nNot operational inputs. No current driver availability has been inferred.\n\n${report.members.length} roster/provisional records, ${report.sheets.length} daily sheets, ${report.issues.length} review issues.\n\nReview identities in identity-review.json and map exact labels to existing IDs in an aliases JSON file. Review every pickup candidate/conflict; a pickup is not necessarily a home address. Supply explicit dates using dates.template.json. Re-run with --aliases and --dates, then explicitly confirm attendance, transport and pickups in the three canonical files. Obtain current driver availability separately. Unparsed Saturday cells require manual reconciliation.\n\nHistorical ownership flags appear only as evidence in review-report.json; they do not grant driver eligibility. No birthdays, phone numbers or Andrew IDs are imported.\n\nMissing sources: ${missing.join(', ') || 'none'}.\n`,
);
console.log(
  JSON.stringify(
    {
      output,
      missing,
      roster: report.members.filter((m) => m.member_id.startsWith('m-')).length,
      provisional: report.identityReview.length,
      dailySheets: report.sheets.length,
      issues: report.issues.length,
      rowerCounts: report.sheets.map((s) => ({
        file: s.workbook,
        sheet: s.sheet,
        count: s.rowerCount,
      })),
      normalizedRowerLabels: new Set(
        report.evidence
          .filter((e) => e.role === 'rower')
          .map((e) => e.label.trim().toLowerCase().replace(/\s+/g, ' ')),
      ).size,
    },
    null,
    2,
  ),
);
