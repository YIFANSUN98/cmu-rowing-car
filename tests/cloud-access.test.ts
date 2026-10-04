import { expect, test } from 'vitest';
import { handle } from '../cloud/core.ts';
import { fixture, adminKey, teamKey, record, sampleInputs, samplePlan } from './cloud/host.ts';

test('conditional plan reads and combined startup stay authenticated and observe publication changes', () => {
  const f = fixture(),
    a = f.login(adminKey),
    t = f.login(teamKey);
  const first = f.call({ ...a, route: 'plan', method: 'PUT', body: samplePlan }).body as any;
  expect(f.call({ ...t, route: 'plan', knownPlanId: first.id }).body).toEqual({ unchanged: true });
  const records = structuredClone([...f.records]);
  expect((f.call({ ...t, route: 'session', includePlan: true }).body as any).publication).toEqual(
    first,
  );
  expect([...f.records]).toEqual(records); // Read requests need no writer lock.
  expect((f.call({ ...a, route: 'session', includePlan: true }).body as any).publication).toEqual(
    first,
  );
  expect(f.call({ ...a, route: 'session' }).body).not.toHaveProperty('publication');
  const login = f.call({
    route: 'login',
    method: 'POST',
    body: { key: teamKey, includePlan: true },
  });
  expect((login.body as any).publication).toEqual(first);
  expect(
    (
      f.call({ route: 'login', method: 'POST', body: { key: adminKey, includePlan: true } })
        .body as any
    ).publication,
  ).toEqual(first);
  const next = f.call({ ...a, route: 'plan', method: 'PUT', body: samplePlan }).body;
  expect(f.call({ ...t, route: 'plan', knownPlanId: first.id }).body).toEqual(next);
  f.call({ ...a, route: 'plan', method: 'DELETE', body: {} });
  expect(f.call({ ...t, route: 'plan', knownPlanId: first.id }).body).toBeNull();
  f.call({ ...t, route: 'logout', method: 'POST' });
  expect(f.call({ ...t, route: 'plan', knownPlanId: first.id }).status).toBe(401);
  f.call({ ...a, route: 'inputs', method: 'PUT', body: sampleInputs });
  const metadata = f.call({ ...a, route: 'inputs', metadataOnly: true });
  expect(metadata.status).toBe(200);
  expect(JSON.stringify(metadata.body)).not.toMatch(/base64/);
  expect(f.call({ ...t, route: 'inputs', metadataOnly: true }).status).toBe(401);
});

test('cloud API separates admin files from the allowlisted published plan', () => {
  const f = fixture(),
    admin = f.login(adminKey),
    team = f.login(teamKey);
  expect(f.call({ route: 'plan' }).status).toBe(401);
  expect(f.call({ ...team, route: 'inputs' }).status).toBe(403);
  expect(f.call({ ...team, route: 'inputs/0' }).status).toBe(403);
  expect(f.call({ ...team, route: 'plan', method: 'PUT', body: samplePlan }).status).toBe(403);
  expect(f.call({ ...admin, route: 'inputs', method: 'PUT', body: sampleInputs }).status).toBe(200);
  expect(f.call({ ...admin, route: 'inputs/0' }).download?.base64).toBe(
    sampleInputs.files[0].base64,
  );
  const result = f.call({ ...admin, route: 'plan', method: 'PUT', body: samplePlan });
  expect(result.status).toBe(200);
  expect(JSON.stringify(result)).not.toContain('privateRoster');
  expect(f.call({ ...team, route: 'plan' }).body).toEqual(result.body);
  expect(f.call({ ...admin, route: 'plan', method: 'DELETE', body: {} }).status).toBe(200);
  expect(f.call({ ...team, route: 'plan' }).body).toBeNull();
});
test('cloud access rejects CSRF, malformed files, invalid plans and replayed writes', () => {
  const f = fixture(),
    a = f.login(adminKey);
  expect(f.call({ ...a, csrf: '', route: 'plan', method: 'DELETE' }).status).toBe(403);
  expect(
    f.call({ ...a, route: 'inputs', method: 'PUT', body: { files: [sampleInputs.files[0]] } })
      .status,
  ).toBe(400);
  expect(f.call({ ...a, route: 'plan', method: 'PUT', body: {} }).status).toBe(400);
  const r = f.request({ ...a, route: 'plan', method: 'PUT', body: samplePlan });
  expect(handle(f.host, r).status).toBe(200);
  expect(handle(f.host, r).status).toBe(409);
  expect(f.call({ ...a, route: 'plan', timestamp: 0 }).status).toBe(403);
});
test('logout and expiry revoke access persistently', () => {
  const f = fixture(),
    a = f.login(adminKey),
    t = f.login(teamKey);
  expect(f.call({ ...a, route: 'logout', method: 'POST' }).status).toBe(200);
  expect(f.call({ ...a, route: 'session' }).status).toBe(401);
  expect(f.call({ ...t, route: 'session' }).status).toBe(200);
  f.advance(169 * 3600000);
  expect(f.call({ ...t, route: 'session' }).status).toBe(401);
});
test('eight-character online rotations invalidate only the changed role; stale local keys do not undo them', () => {
  const f = fixture(),
    a = f.login(adminKey),
    t = f.login(teamKey);
  const previous = f.host.get<any>('last-local-keys');
  expect(
    f.call({
      ...a,
      route: 'password',
      method: 'POST',
      body: { role: 'team', currentKey: adminKey, newKey: 'Tx4!z6Wq' },
    }).status,
  ).toBe(200);
  expect(f.call({ ...t, route: 'session' }).status).toBe(401);
  expect(f.call({ ...a, route: 'session' }).status).toBe(200);
  expect(
    f.call({ route: 'sync-keys', method: 'POST', maintenance: true, body: previous }).body,
  ).toEqual({ updated: [] });
  expect(f.login('Tx4!z6Wq').token).toBeTruthy();
  const updated = { ...previous, team: record('LocalNew!') };
  expect(
    f.call({ route: 'sync-keys', method: 'POST', maintenance: true, body: updated }).body,
  ).toEqual({ updated: ['team'] });
  expect(f.login('LocalNew!').token).toBeTruthy();
}, 15000);
test('failed logins are throttled across requests and resume after the timeout', () => {
  const f = fixture();
  for (let i = 0; i < 10; i++)
    expect(f.call({ route: 'login', method: 'POST', body: { key: 'short' } }).status).toBe(401);
  expect(f.call({ route: 'login', method: 'POST', body: { key: adminKey } }).status).toBe(429);
  f.advance(900001);
  expect(f.login(adminKey).token).toBeTruthy();
});
