import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, readFile, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { request, type Server } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createApp, API } from '../server/app';
import { initialize, credentials, issueSession, sign } from '../server/security';
import { applyLocalKeys, createLocalKeyFile, LOCAL_KEYS_FILE } from '../server/local-keys';
const origin = 'http://localhost:8080',
  adminKey = 'security-test-admin-secret',
  teamKey = 'security-test-team-secret';
// Exact minimum-length replacements exercise login, local import, and online rotation.
const newTeamKey = 'Tx4!z6Wq',
  newAdminKey = 'Ax7!m2Qp';
let directory: string, root: string, dist: string, server: Server, port: number;
type Login = { cookie: string; csrf: string };
function call(
  path: string,
  method = 'GET',
  value?: unknown,
  login?: Login,
  headers: Record<string, string> = {},
) {
  return new Promise<{
    status: number;
    body: any;
    text: string;
    headers: import('node:http').IncomingHttpHeaders;
  }>((resolve, reject) => {
    const req = request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method,
        headers: {
          Host: new URL(origin).host,
          ...(value === undefined
            ? {}
            : {
                'Content-Type': 'application/json',
                'Content-Length': String(Buffer.byteLength(JSON.stringify(value))),
              }),
          ...(method === 'GET' ? {} : { Origin: origin }),
          ...(login ? { Cookie: login.cookie, 'X-CSRF-Token': login.csrf } : {}),
          ...headers,
        },
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (s) => (text += s));
        res.on('end', () => {
          let body;
          try {
            body = JSON.parse(text);
          } catch {}
          resolve({ status: res.statusCode!, body, text, headers: res.headers });
        });
      },
    );
    req.on('error', reject);
    req.end(value === undefined ? undefined : JSON.stringify(value));
  });
}
async function login(key: string): Promise<Login> {
  const result = await call(API + 'login', 'POST', { key });
  expect(result.status).toBe(200);
  return { cookie: result.headers['set-cookie']![0].split(';')[0], csrf: result.body.csrf };
}
async function start() {
  server = createApp({ directory, origin, dist });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  port = (server.address() as { port: number }).port;
}
async function close() {
  await new Promise<void>((done, reject) => server.close((e) => (e ? reject(e) : done())));
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'rowing-auth-'));
  directory = join(root, 'private');
  dist = join(root, 'dist');
  await mkdir(dist);
  await writeFile(join(dist, 'index.html'), '<p>Public login shell</p>');
  await initialize(directory, adminKey, teamKey);
  await start();
});
afterEach(async () => {
  await close();
  await rm(root, { recursive: true, force: true });
});
const samplePlan = () => ({
  schemaVersion: 1,
  deadline: '05:15',
  days: [
    {
      date: '2026-10-05',
      routes: [
        {
          driver: 'Test Driver',
          start: { address: '10 Test Street, Pittsburgh, PA 15213', lat: 40.44, lng: -79.94 },
          destination: { address: '300 Waterfront Dr, Pittsburgh, PA 15222' },
          departure: 17000,
          arrival: 18000,
          stops: [
            {
              names: ['Test Rider'],
              place: { address: '20 Test Street, Pittsburgh, PA 15213' },
              arrival: 17400,
              departure: 17460,
            },
          ],
          drivingSeconds: 940,
          meters: 3500,
          seats: 5,
        },
      ],
    },
  ],
});
const inputs = {
  files: [
    {
      name: 'all.xlsx',
      base64: Buffer.from([0x50, 0x4b, 3, 4]).toString('base64'),
      kinds: ['members', 'attendance', 'availability'],
    },
  ],
};

describe('private server authorization and storage', () => {
  test('fails closed for unauthenticated and forged sessions; team can only read published routes', async () => {
    for (const path of ['plan', 'inputs', 'inputs/0', 'session'])
      expect((await call(API + path)).status).toBe(401);
    const team = await login(teamKey);
    expect((await call(API + 'plan', 'GET', undefined, team)).status).toBe(200);
    for (const [path, method, data] of [
      ['inputs', 'GET', undefined],
      ['inputs/0', 'GET', undefined],
      ['inputs', 'PUT', inputs],
      ['plan', 'PUT', samplePlan()],
      ['plan', 'DELETE', {}],
      ['password', 'POST', { role: 'admin', newKey: newAdminKey }],
    ] as const)
      expect((await call(API + path, method, data, team)).status).toBe(403);
    const token = team.cookie.split('=')[1].split('.')[0];
    const payload = JSON.parse(Buffer.from(token, 'base64url').toString());
    payload.role = 'admin';
    expect(
      (
        await call(API + 'inputs', 'GET', undefined, {
          ...team,
          cookie: `rowing_session=${Buffer.from(JSON.stringify(payload)).toString('base64url')}.fake`,
        })
      ).status,
    ).toBe(401);
    const config = await credentials(directory),
      expired = issueSession('team', config);
    expired.session.expires = Date.now() - 1000;
    const encoded = Buffer.from(JSON.stringify(expired.session)).toString('base64url');
    expect(
      (
        await call(API + 'plan', 'GET', undefined, {
          ...team,
          cookie: `rowing_session=${encoded}.${sign(encoded, config.secret)}`,
        })
      ).status,
    ).toBe(401);
  });
  test('checks Origin, CSRF, Host, and content type; cookie is HttpOnly and never CORS-enabled', async () => {
    const response = await call(API + 'login', 'POST', { key: adminKey });
    const cookie = response.headers['set-cookie']![0];
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
    const admin = { cookie: cookie.split(';')[0], csrf: response.body.csrf };
    const invalidHeaders: Record<string, string>[] = [
      { Origin: 'https://outside.example' },
      { Origin: '' },
      { 'X-CSRF-Token': '' },
      { 'Content-Type': 'text/plain' },
      { 'Sec-Fetch-Site': 'cross-site' },
    ];
    for (const headers of invalidHeaders)
      expect([403, 415]).toContain(
        (await call(API + 'plan', 'PUT', samplePlan(), admin, headers)).status,
      );
    expect(
      (await call(API + 'session', 'GET', undefined, admin, { Host: 'outside.example' })).status,
    ).toBe(403);
    expect(
      (
        await call(API + 'login', 'POST', { key: adminKey }, undefined, {
          Origin: 'https://outside.example',
        })
      ).status,
    ).toBe(403);
  });
  test('saves inputs privately, strips non-route fields from publication, and persists after restart', async () => {
    const admin = await login(adminKey),
      team = await login(teamKey);
    expect((await call(API + 'inputs', 'PUT', inputs, admin)).status).toBe(200);
    const download = await call(API + 'inputs/0', 'GET', undefined, admin);
    expect(download.status).toBe(200);
    expect(download.headers['content-disposition']).toContain('attachment');
    expect(download.headers['cache-control']).toBe('no-store');
    const plan = samplePlan() as any;
    plan.data = { members: ['PRIVATE UNUSED PERSON'] };
    plan.apiKey = 'PRIVATE API KEY';
    plan.days[0].routes[0].notes = 'PRIVATE NOTES';
    plan.days[0].routes[0].start.key = 'PRIVATE INTERNAL ID';
    expect((await call(API + 'plan', 'PUT', plan, admin)).status).toBe(200);
    await close();
    await start();
    const published = await call(API + 'plan', 'GET', undefined, team);
    expect(published.status).toBe(200);
    expect(published.text).not.toContain('PRIVATE');
    expect(published.body.plan).toEqual(samplePlan());
    expect((await stat(join(directory, 'credentials.json'))).mode & 0o777).toBe(0o600);
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    expect(await readFile(join(directory, 'credentials.json'), 'utf8')).not.toContain(adminKey);
    expect((await call(API + 'plan', 'DELETE', {}, admin)).status).toBe(200);
    expect((await call(API + 'plan', 'GET', undefined, team)).body).toBeNull();
  });
  test('static paths cannot reach private data, source files, symlinks, or traversal targets', async () => {
    await symlink(join(directory, 'credentials.json'), join(dist, 'stolen.js'));
    for (const path of [
      '/data/private/credentials.json',
      '/cmu-rowing-car/data/private/credentials.json',
      '/cmu-rowing-car/data/private/server/access-keys.txt',
      '/cmu-rowing-car/.env.local',
      '/cmu-rowing-car/server/security.ts',
      '/cmu-rowing-car/%2e%2e/private/credentials.json',
      '/cmu-rowing-car/assets/..%2f..%2fprivate/credentials.json',
      '/cmu-rowing-car/stolen.js',
    ])
      expect((await call(path)).status).toBe(404);
    const shell = await call('/cmu-rowing-car/');
    expect(shell.status).toBe(200);
    expect(shell.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(() => createApp({ directory: join(dist, 'private'), dist, origin })).toThrow();
    expect(() => createApp({ directory, origin: 'http://public.example' })).toThrow();
  });
  test('rejects oversized uploads, invalid routes, and unsafe filenames', async () => {
    const admin = await login(adminKey);
    expect(
      (await call(API + 'inputs', 'PUT', inputs, admin, { 'Content-Length': '24000000' })).status,
    ).toBe(413);
    expect(
      (
        await call(
          API + 'inputs',
          'PUT',
          { files: [{ ...inputs.files[0], name: '../bad.xlsx' }] },
          admin,
        )
      ).status,
    ).toBe(400);
    const plan = samplePlan();
    plan.days[0].routes[0].arrival = 20000;
    expect((await call(API + 'plan', 'PUT', plan, admin)).status).toBe(400);
    expect((await call(API + 'plan', 'GET', undefined, admin)).body).toBeNull();
  });
});

describe('editable local access keys', () => {
  const saveKeys = (admin = '', team = '') =>
    writeFile(
      join(directory, LOCAL_KEYS_FILE),
      `# Private local keys\r\nAdmin: ${admin}\r\nTeam: ${team}\r\n`,
      { mode: 0o644 },
    );

  test('saving a local team key applies automatically, revokes team sessions, and survives restart', async () => {
    const admin = await login(adminKey),
      team = await login(teamKey);
    await saveKeys('', newTeamKey);
    const checks = await Promise.all(
      Array.from({ length: 4 }, () => call(API + 'plan', 'GET', undefined, team)),
    );
    expect(checks.map((check) => check.status)).toEqual([401, 401, 401, 401]);
    expect((await call(API + 'inputs', 'GET', undefined, admin)).status).toBe(200);
    expect((await call(API + 'login', 'POST', { key: teamKey })).status).toBe(401);
    const current = await login(newTeamKey);
    const stored = await readFile(join(directory, 'credentials.json'), 'utf8');
    expect(stored).not.toContain(newTeamKey);
    expect((await stat(join(directory, LOCAL_KEYS_FILE))).mode & 0o777).toBe(0o600);
    await close();
    await start();
    expect((await call(API + 'plan', 'GET', undefined, current)).status).toBe(200);
    await rm(join(directory, LOCAL_KEYS_FILE));
    expect((await call(API + 'plan', 'GET', undefined, current)).status).toBe(200);
  });

  test('online changes are not overwritten by unchanged local values or edits of the other role', async () => {
    await createLocalKeyFile(directory, { admin: adminKey, team: teamKey });
    const admin = await login(adminKey);
    expect(
      (
        await call(
          API + 'password',
          'POST',
          {
            role: 'team',
            currentKey: adminKey,
            newKey: newTeamKey,
          },
          admin,
        )
      ).status,
    ).toBe(200);
    const team = await login(newTeamKey);
    await saveKeys(newAdminKey, teamKey); // The team entry still contains the old, applied value.
    expect((await call(API + 'session', 'GET', undefined, admin)).status).toBe(401);
    expect((await call(API + 'session', 'GET', undefined, team)).status).toBe(200);
    await login(newAdminKey);
    expect((await call(API + 'login', 'POST', { key: teamKey })).status).toBe(401);
    await close();
    await start();
    expect((await call(API + 'session', 'GET', undefined, team)).status).toBe(200);
  });

  test('invalid or incomplete edits retain both last valid keys and can be corrected', async () => {
    const original = await readFile(join(directory, 'credentials.json'), 'utf8');
    const admin = await login(adminKey),
      team = await login(teamKey);
    for (const content of [
      `Admin: ${newAdminKey}\nTeam: short7!\n`,
      `Admin: ${newAdminKey}\nTeam: ${newAdminKey}\n`,
      `Admin: ${teamKey}\nTeam: \n`,
      `Admin: ${newAdminKey}\n`,
      `Admin: ${newAdminKey}\nTeam: ${newTeamKey}\nTeam: ${teamKey}\n`,
      `Admin: ${newAdminKey}\nTeam: ${newTeamKey}\nUnknown: hidden-test-secret\n`,
    ]) {
      await writeFile(join(directory, LOCAL_KEYS_FILE), content);
      await expect(applyLocalKeys(directory)).rejects.toThrow();
      expect((await call(API + 'session', 'GET', undefined, admin)).status).toBe(200);
      expect((await call(API + 'session', 'GET', undefined, team)).status).toBe(200);
      expect(await readFile(join(directory, 'credentials.json'), 'utf8')).toBe(original);
    }
    await saveKeys(newAdminKey, newTeamKey);
    expect((await call(API + 'session', 'GET', undefined, admin)).status).toBe(401);
    expect((await call(API + 'session', 'GET', undefined, team)).status).toBe(401);
    await login(newAdminKey);
    await login(newTeamKey);
  });

  test('unchanged keys, formatting-only edits, and blank entries do not revoke sessions', async () => {
    const admin = await login(adminKey),
      team = await login(teamKey);
    const before = await credentials(directory);
    await saveKeys(adminKey, teamKey);
    expect((await applyLocalKeys(directory)).changed).toEqual([]);
    await writeFile(
      join(directory, LOCAL_KEYS_FILE),
      `\uFEFF# Revised comment\nteam: ${teamKey}\nadmin: ${adminKey}\n`,
    );
    expect((await applyLocalKeys(directory)).changed).toEqual([]);
    await saveKeys();
    expect((await applyLocalKeys(directory)).changed).toEqual([]);
    expect((await credentials(directory)).admin.version).toBe(before.admin.version);
    expect((await credentials(directory)).team.version).toBe(before.team.version);
    expect((await call(API + 'session', 'GET', undefined, admin)).status).toBe(200);
    expect((await call(API + 'session', 'GET', undefined, team)).status).toBe(200);
  });

  test('manual apply reports success without printing the supplied key', async () => {
    await saveKeys(newAdminKey);
    const result = await promisify(execFile)(process.execPath, ['server/access.ts', 'apply'], {
      cwd: resolve('.'),
      env: { ...process.env, PRIVATE_DATA_DIR: directory },
    });
    expect(result.stdout).toContain('Applied local admin keys');
    expect(result.stdout + result.stderr).not.toContain(newAdminKey);
    await login(newAdminKey);
    expect((await call(API + 'login', 'POST', { key: adminKey })).status).toBe(401);
  });

  test('local generated rotation also stays effective when the editable file has older values', async () => {
    await createLocalKeyFile(directory, { admin: adminKey, team: teamKey });
    await login(teamKey); // Establish applied local values.
    await promisify(execFile)(process.execPath, ['server/access.ts', 'rotate', 'team'], {
      cwd: resolve('.'),
      env: { ...process.env, PRIVATE_DATA_DIR: directory },
    });
    const text = await readFile(join(directory, 'team-replacement-key.txt'), 'utf8');
    await login(text.split('\n')[0].split(': ')[1]);
    expect((await call(API + 'login', 'POST', { key: teamKey })).status).toBe(401);
  });
});

describe('access-key rotation and revocation', () => {
  test('online team rotation rejects old keys and sessions, retaining admin access', async () => {
    const admin = await login(adminKey),
      team = await login(teamKey);
    for (const invalidKey of ['short7!', 'x'.repeat(257)])
      expect(
        (
          await call(
            API + 'password',
            'POST',
            {
              role: 'team',
              currentKey: adminKey,
              newKey: invalidKey,
            },
            admin,
          )
        ).status,
      ).toBe(400);
    expect((await call(API + 'plan', 'GET', undefined, team)).status).toBe(200);
    expect(
      (
        await call(
          API + 'password',
          'POST',
          { role: 'team', currentKey: adminKey, newKey: adminKey },
          admin,
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await call(
          API + 'password',
          'POST',
          { role: 'team', currentKey: 'not-the-admin-key!', newKey: newTeamKey },
          admin,
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await call(
          API + 'password',
          'POST',
          { role: 'team', currentKey: adminKey, newKey: newTeamKey },
          admin,
        )
      ).status,
    ).toBe(200);
    expect((await call(API + 'plan', 'GET', undefined, team)).status).toBe(401);
    expect((await call(API + 'inputs', 'GET', undefined, admin)).status).toBe(200);
    expect((await call(API + 'login', 'POST', { key: teamKey })).status).toBe(401);
    expect((await call(API + 'plan', 'GET', undefined, await login(newTeamKey))).status).toBe(200);
  });
  test('admin rotation revokes every admin session, preserving team access', async () => {
    const admin = await login(adminKey),
      otherAdmin = await login(adminKey),
      team = await login(teamKey);
    expect(
      (
        await call(
          API + 'password',
          'POST',
          { role: 'admin', currentKey: adminKey, newKey: newAdminKey },
          admin,
        )
      ).status,
    ).toBe(200);
    for (const old of [admin, otherAdmin])
      expect((await call(API + 'inputs', 'GET', undefined, old)).status).toBe(401);
    expect((await call(API + 'plan', 'GET', undefined, team)).status).toBe(200);
    expect((await call(API + 'login', 'POST', { key: adminKey })).status).toBe(401);
    expect((await call(API + 'inputs', 'GET', undefined, await login(newAdminKey))).status).toBe(
      200,
    );
  });
  test('local CLI rotation takes effect without restarting the server', async () => {
    const team = await login(teamKey),
      admin = await login(adminKey);
    const result = await promisify(execFile)(
      process.execPath,
      ['server/access.ts', 'rotate', 'team'],
      { cwd: resolve('.'), env: { ...process.env, PRIVATE_DATA_DIR: directory } },
    );
    expect(result.stdout).toContain('revoked its sessions');
    expect((await call(API + 'plan', 'GET', undefined, team)).status).toBe(401);
    expect((await call(API + 'inputs', 'GET', undefined, admin)).status).toBe(200);
    const keyFile = await readFile(join(directory, 'team-replacement-key.txt'), 'utf8');
    const replacement = keyFile.split('\n')[0].split(': ')[1];
    expect(result.stdout).not.toContain(replacement);
    expect((await call(API + 'plan', 'GET', undefined, await login(replacement))).status).toBe(200);
  });
  test('logout revokes a session even after restart, and repeated failed keys are rate limited', async () => {
    const admin = await login(adminKey);
    expect((await call(API + 'logout', 'POST', {}, admin)).status).toBe(200);
    await close();
    await start();
    expect((await call(API + 'session', 'GET', undefined, admin)).status).toBe(401);
    for (let i = 0; i < 10; i++)
      expect((await call(API + 'login', 'POST', { key: 'incorrect-access-key!' })).status).toBe(
        401,
      );
    expect((await call(API + 'login', 'POST', { key: adminKey })).status).toBe(429);
  });
});
