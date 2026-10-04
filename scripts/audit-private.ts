import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { loadEnv } from 'vite';
// Browser keys may appear only in the built bundle, never in public source files.
const configuredKeys = [
  process.env.VITE_TOMTOM_API_KEY,
  loadEnv('production', process.cwd(), 'VITE_').VITE_TOMTOM_API_KEY,
].filter((value): value is string => Boolean(value));
const XLSX = createRequire(import.meta.url)('xlsx') as typeof import('xlsx');
const lines = (args: string[]) =>
  execFileSync('git', args, { encoding: 'utf8' }).split('\n').filter(Boolean);
const tracked = lines(['ls-files']);
const publicFiles = [
  ...new Set([...tracked, ...lines(['ls-files', '--others', '--exclude-standard'])]),
];
const sensitivePath = (p: string) =>
  /(^|\/)(data\/private|exports\/private|\.env($|\.)|[^/]+\.(xlsx|xls|pem|key)$)/i.test(p) &&
  p !== '.env.example';
const trackedPrivate = tracked.filter(sensitivePath);
if (trackedPrivate.length)
  throw new Error(
    `Private files are tracked (${trackedPrivate.length}). Exclude them from any commit/deployment; do not automatically rewrite history.`,
  );
const walk = (dir: string): string[] =>
  fs.existsSync(dir)
    ? fs
        .readdirSync(dir, { withFileTypes: true })
        .flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]))
    : [];
const buildDirectory = process.env.PUBLIC_BUILD_DIR ?? 'dist';
const artifacts = walk(buildDirectory);
if (artifacts.some(sensitivePath)) throw new Error('Private file present in production output.');
const localKeyFile = path.join(
  process.env.PRIVATE_DATA_DIR ?? 'data/private/server',
  'access-keys.txt',
);
const localAccessKeys = fs.existsSync(localKeyFile)
  ? fs
      .readFileSync(localKeyFile, 'utf8')
      .split(/\r?\n/)
      .map((line) => /^(?:Admin|Team):\s*(.*)$/i.exec(line.trim())?.[1]?.trim())
      .filter((key): key is string => Boolean(key && key.length >= 8))
  : [];
const cloudConfig = 'data/private/cloud/deployment.json';
const cloudSecrets: string[] = fs.existsSync(cloudConfig)
  ? Object.entries(JSON.parse(fs.readFileSync(cloudConfig, 'utf8')))
      .filter(([key]) => ['bridgeSecret', 'sessionSecret'].includes(key))
      .map(([, value]) => String(value))
  : [];
const sources = [
  'CMURC Members Info 2025-26.xlsx',
  'Cars week 1.xlsx',
  'Cars week 3.xlsx',
  'Cars week 4.xlsx',
];
for (const source of sources.filter((s) => fs.existsSync(s)))
  execFileSync('git', ['check-ignore', '--quiet', source]);
const privateStrings = new Set<string>();
const roster = sources[0];
if (fs.existsSync(roster)) {
  const sheet = XLSX.readFile(roster).Sheets.INFO;
  for (const [key, cell] of Object.entries(sheet)) {
    if (!/^[ABFG]\d+$/.test(key) || Number(key.slice(1)) <= 1) continue;
    const value = String((cell as { v?: unknown }).v ?? '').trim();
    if (value.length >= 8 && !/study abroad|^novice$/i.test(value))
      privateStrings.add(value.toLowerCase());
  }
}
const inspect = [...publicFiles, ...artifacts].filter(
  (f) => fs.existsSync(f) && !f.endsWith('.png') && !f.endsWith('.jpg'),
);
for (const file of inspect) {
  const content = fs.readFileSync(file, 'utf8');
  if ([...localAccessKeys, ...cloudSecrets].some((key) => content.includes(key)))
    throw new Error(`Private login key found in ${file}. Value withheld.`);
  if (!file.startsWith(buildDirectory + '/') && configuredKeys.some((key) => content.includes(key)))
    throw new Error(
      `Configured TomTom browser key found in public source ${file}. Value withheld.`,
    );
  if (
    /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(content) ||
    (content.match(/AIza[0-9A-Za-z_-]{35}/g) ?? []).some(
      (key) => !file.startsWith('dist/') || key !== process.env.VITE_GOOGLE_MAPS_API_KEY,
    )
  )
    throw new Error(`Credential-like value found in ${file}.`);
  if (file === 'package-lock.json') continue;
  // The developer explicitly authorized these two public footer credits.
  // Remove only the approved full values before checking for private roster data.
  const normalized = content
    .toLowerCase()
    .replaceAll('yifan sun', '')
    .replaceAll('yifansu2@andrew.cmu.edu', '');
  for (const value of privateStrings)
    if (normalized.includes(value))
      throw new Error(
        `Potential private source value found in ${file}; inspect locally. Value withheld from output.`,
      );
}
console.log(
  JSON.stringify(
    {
      publicFilesInspected: publicFiles.length,
      buildFilesInspected: artifacts.length,
      trackedPrivateFiles: trackedPrivate.length,
      privateSourceAvailable: fs.existsSync(roster),
      privateComparisonValues: privateStrings.size,
      result: 'passed',
    },
    null,
    2,
  ),
);
