import { beforeEach, afterEach, expect, test, vi } from 'vitest';
import { api, cached, remember, setAccess } from '../src/sharing/api';

beforeEach(() => {
  vi.stubGlobal('window', {
    location: { origin: 'https://fixture.invalid' },
    dispatchEvent: vi.fn(),
  });
  setAccess({ role: 'admin', csrf: 'fixture-session' });
});
afterEach(() => {
  setAccess();
  vi.unstubAllGlobals();
});

test('deduplicates simultaneous reads and uses authenticated version checks for unchanged plans', async () => {
  let release!: (value: Response) => void;
  const fetcher = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<Response>((r) => {
          release = r;
        }),
    )
    .mockResolvedValueOnce(Response.json({ unchanged: true }));
  vi.stubGlobal('fetch', fetcher);
  const a = api('plan'),
    b = api('plan');
  expect(fetcher).toHaveBeenCalledTimes(1);
  const plan = { id: 'first', publishedAt: 'fixture', plan: {} };
  release(Response.json(plan));
  expect(await a).toEqual(plan);
  expect(await b).toBe(await a);
  expect(await api('plan')).toBe(await a);
  expect(new URL(fetcher.mock.calls[1][0]).searchParams.get('version')).toBe('first');
  expect(fetcher.mock.calls[1][1].cache).toBe('no-store');
});

test('a read started before publishing cannot overwrite the new publication', async () => {
  let release!: (value: Response) => void;
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<Response>((r) => {
            release = r;
          }),
      )
      .mockResolvedValueOnce(Response.json({ id: 'new', plan: {} })),
  );
  const old = api('plan');
  await api('plan', 'PUT', {});
  release(Response.json({ id: 'old', plan: {} }));
  expect(await old).toMatchObject({ id: 'new' });
  expect(cached('plan')).toMatchObject({ id: 'new' });
});

test('logout clears private memory and discards responses from the previous session', async () => {
  let release!: (value: Response) => void;
  vi.stubGlobal(
    'fetch',
    vi.fn(
      () =>
        new Promise<Response>((r) => {
          release = r;
        }),
    ),
  );
  remember('plan', { id: 'private' });
  const old = api('plan');
  const rejected = expect(old).rejects.toThrow('session changed');
  setAccess();
  setAccess({ role: 'team', csrf: 'different-session' });
  release(Response.json({ id: 'old-private', plan: {} }));
  await rejected;
  expect(cached('plan')).toBeUndefined();
});
