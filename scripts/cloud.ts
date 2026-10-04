import { randomBytes } from 'node:crypto';
import { readFile, mkdir, writeFile, chmod } from 'node:fs/promises';
import { resolve } from 'node:path';
import { activeCredentials } from '../server/local-keys.ts';
import { callScript } from '../cloud/pages/worker.ts';
import type { RequestData } from '../cloud/core.ts';

const root = resolve('data/private/cloud');
const configFile = resolve(root, 'deployment.json');
const random = () => randomBytes(32).toString('hex');
type Config = {
  folderId: string;
  project: string;
  origin: string;
  bridgeSecret: string;
  sessionSecret: string;
  appsScriptUrl?: string;
  backendCombinedStartup?: boolean;
};
async function save(path: string, value: string) {
  await writeFile(path, value, { mode: 0o600 });
  await chmod(path, 0o600);
}
async function config(): Promise<Config> {
  try {
    return JSON.parse(await readFile(configFile, 'utf8'));
  } catch {
    throw new Error('Run npm run cloud:prepare -- --folder GOOGLE_DRIVE_FOLDER_ID first.');
  }
}
const args = process.argv.slice(2),
  command = args[0];
const option = (name: string) => {
  const i = args.indexOf(name);
  return i < 0 ? undefined : args[i + 1];
};
async function call(c: Config, input: Partial<RequestData>) {
  if (!c.appsScriptUrl)
    throw new Error('Set the deployed Apps Script URL with cloud:configure first.');
  const reply = await callScript(c.appsScriptUrl, c.bridgeSecret, {
    timestamp: Date.now(),
    requestId: random(),
    entropy: random(),
    client: random(),
    route: '',
    method: 'POST',
    token: '',
    csrf: '',
    ...input,
  });
  if (reply.status !== 200)
    throw new Error(`Cloud backend returned ${reply.status}. ${(reply.body as any)?.error ?? ''}`);
  return reply;
}
try {
  if (command === 'prepare') {
    await mkdir(resolve(root, 'apps-script'), { recursive: true, mode: 0o700 });
    let c: Config;
    try {
      c = JSON.parse(await readFile(configFile, 'utf8'));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      const folderId = option('--folder'),
        project = option('--project') ?? 'cmu-rowing';
      if (
        !folderId ||
        !/^[A-Za-z0-9_-]{20,}$/.test(folderId) ||
        !/^[a-z0-9][a-z0-9-]{1,57}[a-z0-9]$/.test(project)
      )
        throw new Error('Supply a private Drive folder ID and valid project name.');
      c = {
        folderId,
        project,
        origin: `https://${project}.pages.dev`,
        bridgeSecret: random(),
        sessionSecret: random(),
      };
      await save(configFile, JSON.stringify(c, null, 2));
    }
    const keys = await activeCredentials(resolve('data/private/server'));
    const credentials = { admin: keys.admin, team: keys.team, secret: c.sessionSecret };
    await save(
      resolve(root, 'apps-script/Setup.js'),
      'const ROWING_SETUP = ' +
        JSON.stringify({ folderId: c.folderId, bridgeSecret: c.bridgeSecret, credentials }) +
        ';\n',
    );
    console.log(
      'Prepared private Apps Script setup using the current keys. Existing cloud keys will not be overwritten by setup.',
    );
  } else if (command === 'configure') {
    const c = await config(),
      url = option('--apps-script-url'),
      origin = option('--origin');
    if (url) {
      if (!/^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(url))
        throw new Error('Use the deployed /exec web app URL.');
      c.appsScriptUrl = url;
    }
    if (origin) {
      const u = new URL(origin);
      if (u.protocol !== 'https:' || u.origin !== origin)
        throw new Error('Use an HTTPS origin without a path.');
      c.origin = origin;
    }
    await save(configFile, JSON.stringify(c, null, 2));
    if (c.appsScriptUrl)
      await save(
        resolve(root, 'pages-secrets.json'),
        JSON.stringify({
          APP_ORIGIN: c.origin,
          APPS_SCRIPT_URL: c.appsScriptUrl,
          DRIVE_BRIDGE_SECRET: c.bridgeSecret,
          SESSION_SIGNING_SECRET: c.sessionSecret,
          ...(c.backendCombinedStartup ? { COMBINED_PLAN_STARTUP: '1' } : {}),
        }),
      );
    console.log('Saved cloud configuration privately.');
  } else if (command === 'sync-keys') {
    const c = await config(),
      keys = await activeCredentials(resolve('data/private/server'));
    const reply = await call(c, {
      route: 'sync-keys',
      maintenance: true,
      body: { admin: keys.admin, team: keys.team },
    });
    console.log(
      'Cloud key synchronization completed. Updated roles:',
      (reply.body as any).updated.join(', ') || 'none',
    );
  } else if (command === 'check') {
    const c = await config();
    // No key needed: a configured bridge must return the authentication boundary.
    const r = await callScript(c.appsScriptUrl ?? '', c.bridgeSecret, {
      timestamp: Date.now(),
      requestId: random(),
      entropy: random(),
      client: random(),
      route: 'session',
      method: 'GET',
      token: '',
      csrf: '',
    });
    if (r.status !== 401)
      throw new Error(`Expected authentication boundary; received ${r.status}.`);
    console.log('Apps Script responds through the signed bridge and rejects anonymous access.');
  } else if (command === 'migrate') {
    const c = await config();
    const rows = (await readFile('data/private/server/access-keys.txt', 'utf8')).split(/\r?\n/);
    const key = rows.map((l) => /^Admin:\s*(.*)$/i.exec(l.trim())?.[1]).find(Boolean);
    if (!key) throw new Error('The local Admin key is required to import current files.');
    const login = await call(c, { route: 'login', body: { key } });
    const auth = { token: login.cookie!.value, csrf: (login.body as any).csrf };
    try {
      // Never replace a cloud plan or input set that an admin has already saved.
      for (const name of ['inputs', 'plan'] as const) {
        const current = await call(c, { ...auth, route: name, method: 'GET' });
        if (current.body) {
          console.log(`Existing cloud ${name} preserved.`);
          continue;
        }
        let stored;
        try {
          stored = JSON.parse(await readFile(`data/private/server/${name}.json`, 'utf8'));
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue;
          throw e;
        }
        if (!stored) continue;
        await call(c, {
          ...auth,
          route: name,
          method: 'PUT',
          body: name === 'plan' ? stored.plan : stored,
        });
        console.log(`Imported current ${name}.`);
      }
    } finally {
      await call(c, { ...auth, route: 'logout', body: {} });
    }
  } else throw new Error('Choose prepare, configure, check, migrate, or sync-keys.');
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
}
