import { afterEach, expect, test, vi } from 'vitest';
import worker, { callScript, type Env } from '../cloud/pages/worker.ts';
import { handle } from '../cloud/core.ts';
import { fixture, sign, adminKey, teamKey, sampleInputs } from './cloud/host.ts';
const origin = 'https://rowing-test.pages.dev',
  secret = 'b'.repeat(64),
  url = 'https://script.google.com/macros/s/test/exec';
const env: Env = {
  APP_ORIGIN: origin,
  APPS_SCRIPT_URL: url,
  DRIVE_BRIDGE_SECRET: secret,
  ASSETS: { fetch: async () => new Response('<p>Login</p>') },
};
afterEach(() => vi.unstubAllGlobals());
function setup() {
  const f = fixture();
  const fetcher = vi.fn(async (input: string | URL | Request, options?: RequestInit) => {
    expect(String(input)).toBe(url);
    const envelope = JSON.parse(String(options?.body));
    expect(envelope.signature).toBe(sign(envelope.message, secret));
    return Response.json(handle(f.host, JSON.parse(envelope.message)));
  });
  vi.stubGlobal('fetch', fetcher);
  const call = (
    route: string,
    method = 'GET',
    body?: unknown,
    auth?: { cookie: string; csrf: string },
    extra: Record<string, string> = {},
  ) =>
    worker.fetch(
      new Request(`${origin}/api/${route}`, {
        method,
        headers: {
          ...(method !== 'GET' ? { Origin: origin, 'Content-Type': 'application/json' } : {}),
          ...(auth ? { Cookie: auth.cookie, 'X-CSRF-Token': auth.csrf } : {}),
          ...extra,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      env,
    );
  const login = async (key: string) => {
    const result = await call('login', 'POST', { key });
    expect(result.status).toBe(200);
    const cookie = result.headers.get('set-cookie')!;
    expect(cookie).toContain('__Host-rowing_session=');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).toContain('Secure');
    return { cookie: cookie.split(';')[0], csrf: ((await result.json()) as any).csrf };
  };
  return { f, fetcher, call, login };
}
test('same-origin gateway sets secure cookies and protects file downloads', async () => {
  const { call, login } = setup(),
    admin = await login(adminKey),
    team = await login(teamKey);
  expect((await call('session')).status).toBe(401);
  expect((await call('inputs', 'PUT', sampleInputs, admin)).status).toBe(200);
  const file = await call('inputs/0', 'GET', undefined, admin);
  expect(file.status).toBe(200);
  expect(file.headers.get('content-type')).toContain('spreadsheetml');
  expect(Buffer.from(await file.arrayBuffer()).toString('base64')).toBe(
    sampleInputs.files[0].base64,
  );
  expect((await call('inputs/0', 'GET', undefined, team)).status).toBe(403);
  expect(
    (await call('plan', 'DELETE', {}, admin, { Origin: 'https://outside.example' })).status,
  ).toBe(403);
  expect(
    (await call('plan', 'GET', undefined, admin, { 'Sec-Fetch-Site': 'cross-site' })).status,
  ).toBe(403);
  expect((await call('sync-keys', 'POST', {}, admin)).status).toBe(404);
  expect((await call('logout', 'POST', {}, admin)).headers.get('set-cookie')).toContain(
    'Max-Age=0',
  );
  expect((await call('session', 'GET', undefined, admin)).status).toBe(401);
});
test('bridge follows only the Google response redirect and never forwards POST secrets', async () => {
  const f = fixture();
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { Location: 'https://script.googleusercontent.com/macros/echo?key=test' },
      }),
    )
    .mockResolvedValueOnce(Response.json({ status: 401, body: {} }));
  expect((await callScript(url, secret, f.request({}), fetcher)).status).toBe(401);
  expect(fetcher.mock.calls[1][1]).not.toHaveProperty('body');
  expect(fetcher.mock.calls[1][1].signal).toBe(fetcher.mock.calls[0][1].signal);
  expect(fetcher.mock.calls[1][1].headers).toEqual({ 'User-Agent': 'CMU-Rowing/1.0' });
  const bad = vi
    .fn()
    .mockResolvedValue(
      new Response(null, { status: 302, headers: { Location: 'https://outside.example' } }),
    );
  await expect(callScript(url, secret, f.request({}), bad)).rejects.toThrow();
  expect(bad).toHaveBeenCalledTimes(1);
  const chained = vi
    .fn()
    .mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { Location: 'https://script.googleusercontent.com/macros/echo?key=first' },
      }),
    )
    .mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { Location: 'https://script.googleusercontent.com/macros/echo?key=second' },
      }),
    )
    .mockResolvedValueOnce(Response.json({ status: 401, body: {} }));
  expect((await callScript(url, secret, f.request({}), chained)).status).toBe(401);
  expect(chained.mock.calls[2][1]).not.toHaveProperty('body');
  const pending = vi
    .fn()
    .mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { Location: 'https://script.googleusercontent.com/macros/echo?key=pending' },
      }),
    )
    .mockResolvedValueOnce(new Response('Not found yet', { status: 404 }))
    .mockResolvedValueOnce(Response.json({ status: 200, body: { ok: true } }));
  expect((await callScript(url, secret, f.request({ method: 'PUT' }), pending)).status).toBe(200);
  expect(pending.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(1);
});
test('missing configuration and upstream failures fail closed without revealing secrets', async () => {
  const { call } = setup();
  expect(
    (await worker.fetch(new Request(origin + '/api/session'), { ...env, DRIVE_BRIDGE_SECRET: '' }))
      .status,
  ).toBe(503);
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error(secret)));
  const failure = await call('login', 'POST', { key: adminKey });
  expect(failure.status).toBe(503);
  expect(await failure.text()).not.toContain(secret);
  expect(
    (await worker.fetch(new Request(origin + '/data/private/server/credentials.json'), env)).status,
  ).toBe(404);
});

test('gateway decodes the inert Apps Script HTML reply without executing its content', async () => {
  const f = fixture();
  const reply = {
    status: 200,
    body: { name: 'Rower é 🛶', text: '</script><script>untrusted()</script>' },
  };
  const encoded = Buffer.from(JSON.stringify(reply)).toString('base64url');
  const fetcher = vi
    .fn()
    .mockResolvedValue(
      new Response(
        '<html><pre>ROWING_RESULT_BEGIN_' + encoded + '_ROWING_RESULT_END</pre></html>',
        { headers: { 'Content-Type': 'text/html' } },
      ),
    );
  expect(await callScript(url, secret, f.request({}), fetcher)).toEqual(reply);
  expect(fetcher).toHaveBeenCalledTimes(1);
});

test('legacy startup runs session and plan reads concurrently and returns an authenticated publication', async () => {
  const { f, call, fetcher } = setup();
  const auth = f.login(teamKey);
  const publication = { id: 'fixture-plan', plan: { days: [] } };
  f.files.set('plan', publication);
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started: string[] = [];
  fetcher.mockImplementation(async (_input, options) => {
    const data = JSON.parse(JSON.parse(String(options?.body)).message);
    started.push(data.route);
    await waiting;
    expect(data.includePlan).toBe(false);
    return Response.json(handle(f.host, data));
  });
  const response = call('session?includePlan=1', 'GET', undefined, {
    cookie: '__Host-rowing_session=' + auth.token,
    csrf: auth.csrf,
  });
  await vi.waitFor(() => expect(started.sort()).toEqual(['plan', 'session']));
  release();
  expect(await (await response).json()).toMatchObject({ role: 'team', publication });
});

test('parallel startup never returns a plan after the session check rejects access', async () => {
  const { call, login, fetcher } = setup();
  const auth = await login(teamKey);
  fetcher.mockImplementation(async (_input, options) => {
    const data = JSON.parse(JSON.parse(String(options?.body)).message);
    return Response.json(
      data.route === 'session'
        ? { status: 401, body: { error: 'Session expired.' } }
        : { status: 200, body: { id: 'private-plan' } },
    );
  });
  const response = await call('session?includePlan=1', 'GET', undefined, auth);
  expect(response.status).toBe(401);
  expect(await response.text()).not.toContain('private-plan');
});

test('upgraded backends use one combined startup call when enabled', async () => {
  const { f, fetcher } = setup();
  const auth = f.login(teamKey);
  const response = await worker.fetch(
    new Request(origin + '/api/session?includePlan=1', {
      headers: { Cookie: '__Host-rowing_session=' + auth.token },
    }),
    { ...env, COMBINED_PLAN_STARTUP: '1' },
  );
  expect(await response.json()).toMatchObject({ role: 'team', publication: null });
  expect(fetcher).toHaveBeenCalledTimes(1);
});

test('read-only bridge calls have a short deadline while writes retain their original deadline', async () => {
  const f = fixture();
  const deadline = vi.spyOn(AbortSignal, 'timeout');
  const fetcher = vi.fn(async () => Response.json({ status: 200, body: {} }));
  try {
    await callScript(url, secret, f.request({ method: 'GET' }), fetcher);
    expect(deadline).toHaveBeenLastCalledWith(8000);
    await callScript(url, secret, f.request({ method: 'PUT' }), fetcher);
    expect(deadline).toHaveBeenLastCalledWith(90000);
  } finally {
    deadline.mockRestore();
  }
});

test('legacy startup derives matching session and CSRF from one backend-authenticated plan read', async () => {
  const { f, fetcher } = setup();
  const signingSecret = f.host.get<any>('credentials')!.secret;
  const publication = { id: 'current', plan: { days: [] } };
  f.files.set('plan', publication);
  for (const key of [adminKey, teamKey]) {
    const auth = f.login(key);
    fetcher.mockClear();
    const response = await worker.fetch(
      new Request(origin + '/api/session?includePlan=1&version=current', {
        headers: { Cookie: '__Host-rowing_session=' + auth.token },
      }),
      { ...env, SESSION_SIGNING_SECRET: signingSecret },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      role: key === adminKey ? 'admin' : 'team',
      csrf: auth.csrf,
      publication,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  }
});

test('one-read startup still rejects revoked sessions and rotated role versions', async () => {
  const { f } = setup();
  const signingSecret = f.host.get<any>('credentials')!.secret;
  const call = (token: string) =>
    worker.fetch(
      new Request(origin + '/api/session?includePlan=1', {
        headers: { Cookie: '__Host-rowing_session=' + token },
      }),
      { ...env, SESSION_SIGNING_SECRET: signingSecret },
    );
  const revoked = f.login(teamKey);
  f.call({ ...revoked, route: 'logout', method: 'POST' });
  expect((await call(revoked.token)).status).toBe(401);
  const rotated = f.login(teamKey);
  const credentials = f.host.get<any>('credentials')!;
  credentials.team.version = 'new-version';
  f.host.put('credentials', credentials);
  expect((await call(rotated.token)).status).toBe(401);
});

test('a mismatched gateway signing secret falls back to the authoritative session response', async () => {
  const { f, fetcher } = setup();
  const auth = f.login(teamKey);
  const response = await worker.fetch(
    new Request(origin + '/api/session?includePlan=1', {
      headers: { Cookie: '__Host-rowing_session=' + auth.token },
    }),
    { ...env, SESSION_SIGNING_SECRET: 'different-secret' },
  );
  expect(await response.json()).toEqual({ role: 'team', csrf: auth.csrf, publication: null });
  expect(fetcher).toHaveBeenCalledTimes(2);
});
