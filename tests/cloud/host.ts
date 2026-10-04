import { createHmac, randomBytes, scryptSync } from 'node:crypto';
import { handle, type Host, type RequestData, type Reply } from '../../cloud/core.ts';
import type { Credentials } from '../../server/security.ts';
export const adminKey = 'CloudAdm1!',
  teamKey = 'CloudTeam1!';
export const sign = (v: string, key: string) =>
  createHmac('sha256', key).update(v).digest('base64url');
export const hash = (key: string, salt: string) =>
  scryptSync(key, salt, 64, { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 }).toString('hex');
const random = () => randomBytes(24).toString('base64url');
export const record = (key: string) => {
  const salt = random();
  return { salt, hash: hash(key, salt), version: random() };
};
const initial: Credentials = { secret: random(), admin: record(adminKey), team: record(teamKey) };
export function fixture() {
  const records = new Map<string, any>([
    ['credentials', structuredClone(initial)],
    ['last-local-keys', { admin: initial.admin, team: initial.team }],
  ]);
  const files = new Map<string, any>();
  let now = Date.now();
  const host: Host = {
    now: () => now,
    get: (key) => (records.has(key) ? structuredClone(records.get(key)) : null),
    put: (key, value) => {
      records.set(key, structuredClone(value));
    },
    remove: (key) => {
      records.delete(key);
    },
    keys: () => [...records.keys()],
    read: (key, metadataOnly) => {
      const value = structuredClone(files.get(key) ?? null);
      return value && key === 'inputs' && metadataOnly
        ? {
            savedAt: value.savedAt,
            files: value.files.map(({ name, kinds }: any) => ({ name, kinds })),
          }
        : value;
    },
    write: (key, value) => {
      files.set(key, structuredClone(value));
    },
    sign,
    hash,
    encode: (v) => Buffer.from(v).toString('base64url'),
    decode: (v) => Buffer.from(v, 'base64url').toString(),
    validExcel: (v) => {
      const b = Buffer.from(v, 'base64');
      return (
        b.length >= 4 &&
        b.length <= 5 * 1024 * 1024 &&
        b[0] === 80 &&
        b[1] === 75 &&
        b.toString('base64') === v
      );
    },
  };
  const request = (data: Partial<RequestData>): RequestData => ({
    timestamp: now,
    requestId: randomBytes(32).toString('hex'),
    entropy: randomBytes(32).toString('hex'),
    client: 'a'.repeat(64),
    route: '',
    method: 'GET',
    token: '',
    csrf: '',
    ...data,
  });
  const call = (data: Partial<RequestData>) => handle(host, request(data));
  const login = (key: string) => {
    const r = call({ route: 'login', method: 'POST', body: { key } });
    if (r.status !== 200) throw new Error('Fixture login failed');
    return { token: r.cookie!.value, csrf: (r.body as any).csrf };
  };
  return {
    host,
    records,
    files,
    request,
    call,
    login,
    advance: (ms: number) => {
      now += ms;
    },
  };
}
export const samplePlan = {
  schemaVersion: 1,
  deadline: '05:15',
  privateRoster: 'must be discarded',
  days: [
    {
      date: '2026-09-21',
      routes: [
        {
          driver: 'Demo Driver',
          start: { address: '1 Demo St' },
          destination: { address: '300 Waterfront Dr' },
          departure: 17000,
          arrival: 18000,
          stops: [],
          drivingSeconds: 1000,
          meters: 5000,
          seats: 5,
        },
      ],
    },
  ],
};
export const sampleInputs = {
  files: ['members', 'attendance', 'availability'].map((kind) => ({
    name: kind + '.xlsx',
    kinds: [kind],
    base64: Buffer.from([80, 75, 3, 4, 0]).toString('base64'),
  })),
};
