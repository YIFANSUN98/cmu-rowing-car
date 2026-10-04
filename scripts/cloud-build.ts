import { build } from 'esbuild';
import { build as viteBuild } from 'vite';
import { mkdir, copyFile, writeFile, readFile } from 'node:fs/promises';
await viteBuild({ base: '/', build: { outDir: 'dist-cloud', emptyOutDir: true } });
await build({
  entryPoints: ['cloud/pages/worker.ts'],
  outfile: 'dist-cloud/_worker.js',
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  minify: true,
});
// A real 404 page disables Pages' automatic index.html fallback for arbitrary/private paths.
await writeFile(
  'dist-cloud/404.html',
  '<!doctype html><html lang="en"><meta charset="utf-8"><title>Page not found</title><p>Page not found. <a href="/">Open CMU Rowing</a></p></html>',
);
await writeFile(
  'dist-cloud/_routes.json',
  JSON.stringify({
    version: 1,
    include: ['/*'],
    exclude: ['/assets/*', '/branding/*', '/favicon.svg'],
  }),
);
await copyFile('cloud/pages/headers', 'dist-cloud/_headers');
await mkdir('data/private/cloud/apps-script', { recursive: true, mode: 0o700 });
await build({
  entryPoints: ['cloud/apps-script/main.ts'],
  outfile: 'data/private/cloud/apps-script/Code.js',
  bundle: true,
  format: 'iife',
  globalName: 'Rowing',
  platform: 'neutral',
  target: 'es2020',
  footer: {
    js: 'function setup() { return Rowing.setup(); }\nfunction doGet(e) { return Rowing.doGet(e); }\nfunction doPost(e) { return Rowing.doPost(e); }',
  },
});
await copyFile(
  'cloud/apps-script/appsscript.json',
  'data/private/cloud/apps-script/appsscript.json',
);
try {
  const setup = await readFile('data/private/cloud/apps-script/Setup.js', 'utf8');
  const code = await readFile('data/private/cloud/apps-script/Code.js', 'utf8');
  await writeFile('data/private/cloud/Install.gs', setup + '\n' + code, { mode: 0o600 });
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
}
console.log(
  'Built the root-address website and private Apps Script backend. No deployment performed.',
);
