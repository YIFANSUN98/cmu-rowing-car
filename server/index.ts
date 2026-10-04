import { resolve } from 'node:path';
import { createApp } from './app.ts';
import { activeCredentials as credentials } from './local-keys.ts';
const directory = resolve(process.env.PRIVATE_DATA_DIR ?? 'data/private/server');
const port = Number(process.env.PORT ?? 5174);
const origin = process.env.APP_ORIGIN ?? 'http://127.0.0.1:5173';
await credentials(directory); // Fail closed; never fall back to a default password.
const server = createApp({ directory, origin, dist: resolve(process.env.STATIC_DIR ?? 'dist') });
server.listen(port, process.env.HOST ?? '127.0.0.1', () =>
  console.log(`Private planner server listening on port ${port}.`),
);
for (const signal of ['SIGTERM', 'SIGINT'])
  process.on(signal, () => server.close(() => process.exit(0)));
