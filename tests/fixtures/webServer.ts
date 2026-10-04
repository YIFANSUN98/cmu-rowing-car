import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createApp } from '../../server/app.ts';
import { initialize } from '../../server/security.ts';
// Isolated credentials and files, never the owner's private data directory.
const directory = await mkdtemp(join(tmpdir(), 'rowing-browser-'));
await initialize(directory, 'browser-test-admin-key-only', 'browser-test-team-key-only');
const server = createApp({
  directory,
  origin: 'http://127.0.0.1:4173',
  dist: resolve('node_modules/.cache/rowing-browser-test'),
});
server.listen(4173, '127.0.0.1');
for (const signal of ['SIGTERM', 'SIGINT'])
  process.on(signal, () =>
    server.close(async () => {
      await rm(directory, { recursive: true, force: true });
      process.exit(0);
    }),
  );
