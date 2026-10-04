import { cleanPlan } from '../src/sharing/schema.ts';
import type { Credentials, Role, Session } from '../server/security.ts';

// This module runs in Apps Script, not in the browser or a Cloudflare CPU-limited worker.
export interface RequestData {
  timestamp: number;
  requestId: string;
  entropy: string;
  client: string;
  route: string;
  method: string;
  token: string;
  csrf: string;
  body?: any;
  maintenance?: boolean;
  knownPlanId?: string;
  metadataOnly?: boolean;
  includePlan?: boolean;
}
export interface Reply {
  status: number;
  body?: unknown;
  cookie?: { value: string; seconds: number };
  download?: { name: string; base64: string };
}
export interface Host {
  now(): number;
  get<T>(key: string): T | null;
  put(key: string, value: unknown): void;
  remove(key: string): void;
  keys(): string[];
  read(name: 'inputs' | 'plan', metadataOnly?: boolean): any;
  write(name: 'inputs' | 'plan', value: any): void;
  sign(value: string, secret: string): string;
  encode(value: string): string;
  decode(value: string): string;
  hash(key: string, salt: string): string;
  validExcel(base64: string): boolean;
}
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export function refuse(status: number, message: string): never {
  throw new ApiError(status, message);
}
export function equal(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let different = 0;
  for (let i = 0; i < a.length; i++) different |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return different === 0;
}
const validKey = (v: unknown): v is string =>
  typeof v === 'string' && v.length >= 8 && v.length <= 256;
function validRecord(v: any): boolean {
  return (
    /^[A-Za-z0-9_-]{32}$/.test(v?.salt) &&
    /^[a-f0-9]{128}$/.test(v?.hash) &&
    /^[A-Za-z0-9_-]{32}$/.test(v?.version)
  );
}
export function handle(host: Host, req: RequestData): Reply {
  try {
    return dispatch(host, req);
  } catch (error) {
    return {
      status: error instanceof ApiError ? error.status : 503,
      body: {
        error:
          error instanceof ApiError
            ? error.message
            : 'Private storage is temporarily unavailable. Please try again shortly.',
      },
    };
  }
}
function dispatch(h: Host, r: RequestData): Reply {
  const now = h.now();
  if (
    !Number.isFinite(r.timestamp) ||
    Math.abs(now - r.timestamp) > 120000 ||
    !/^[a-f0-9]{64}$/.test(r.requestId) ||
    !/^[a-f0-9]{64}$/.test(r.entropy) ||
    !/^[a-f0-9]{64}$/.test(r.client)
  )
    refuse(403, 'Invalid request.');
  const c = h.get<Credentials>('credentials');
  if (!c) refuse(503, 'Website access is not configured yet.');
  // Persistent replay/revocation/rate records: CacheService eviction must not restore access.
  if (r.method !== 'GET' || r.maintenance) {
    // Reads do not mutate bookkeeping, so they need not queue behind Drive writes.
    const transient = h.keys().filter((k) => /^(replay|revoked|rate):/.test(k));
    let live = 0;
    for (const k of transient) {
      const record = h.get<{ until: number }>(k);
      if (record && record.until <= now) h.remove(k);
      else live++;
    }
    if (live > 1800) refuse(429, 'Too many requests. Try again shortly.');
    if (h.get('replay:' + r.requestId))
      refuse(409, 'This request was already received. Refresh before trying again.');
    h.put('replay:' + r.requestId, { until: now + 120000 });
  }
  let sequence = 0;
  // CSPRNG entropy is generated on the trusted gateway/CLI; never accept browser entropy.
  const random = () => h.sign(`${r.entropy}:${sequence++}`, c.secret).slice(0, 32);
  const matches = (key: string, record: Credentials['admin']) =>
    equal(h.hash(key, record.salt), record.hash);
  const password = (key: string) => {
    const salt = random();
    return { salt, hash: h.hash(key, salt), version: random() };
  };
  const ok = (body: unknown): Reply => ({ status: 200, body });
  if (r.maintenance) {
    if (
      r.route !== 'sync-keys' ||
      r.method !== 'POST' ||
      !validRecord(r.body?.admin) ||
      !validRecord(r.body?.team)
    )
      refuse(400, 'Invalid maintenance request.');
    // Only changed local records replace keys. An unchanged file cannot undo an online reset.
    const previous = h.get<Pick<Credentials, 'admin' | 'team'>>('last-local-keys');
    const updated: Role[] = [];
    for (const role of ['admin', 'team'] as const) {
      if (!previous || JSON.stringify(previous[role]) !== JSON.stringify(r.body[role])) {
        c[role] = r.body[role];
        updated.push(role);
      }
    }
    h.put('credentials', c);
    h.put('last-local-keys', { admin: r.body.admin, team: r.body.team });
    return ok({ updated });
  }
  const rateKey = 'rate:' + r.client;
  const authenticate = (work: () => Reply): Reply => {
    const ip = h.get<{ count: number; until: number }>(rateKey) ?? {
      count: 0,
      until: now + 900000,
    };
    const global = h.get<{ count: number; until: number }>('rate:global') ?? {
      count: 0,
      until: now + 60000,
    };
    if (ip.count >= 10 || global.count >= 120)
      refuse(429, 'Too many attempts. Wait a few minutes before trying again.');
    h.put('rate:global', { ...global, count: global.count + 1 });
    try {
      const result = work();
      h.remove(rateKey);
      return result;
    } catch (error) {
      if (error instanceof ApiError && error.status === 401)
        h.put(rateKey, { ...ip, count: ip.count + 1 });
      throw error;
    }
  };
  const csrf = (s: Session) => h.sign(`csrf:${s.nonce}`, c.secret);
  if (r.route === 'login' && r.method === 'POST')
    return authenticate(() => {
      if (!validKey(r.body?.key)) refuse(401, 'That access key was not recognized.');
      const admin = matches(r.body.key, c.admin),
        team = matches(r.body.key, c.team);
      const role: Role = admin
        ? 'admin'
        : team
          ? 'team'
          : refuse(401, 'That access key was not recognized.');
      const seconds = (role === 'admin' ? 12 : 168) * 3600;
      const s: Session = {
        role,
        version: c[role].version,
        expires: now + seconds * 1000,
        nonce: random(),
      };
      const payload = h.encode(JSON.stringify(s));
      return {
        ...ok({
          role,
          csrf: csrf(s),
          ...(r.body?.includePlan ? { publication: h.read('plan') } : {}),
        }),
        cookie: { value: payload + '.' + h.sign(payload, c.secret), seconds },
      };
    });
  let s: Session | null = null;
  try {
    const [payload, signature, extra] = (r.token ?? '').split('.');
    if (
      r.token.length <= 1500 &&
      payload &&
      signature &&
      !extra &&
      equal(signature, h.sign(payload, c.secret))
    ) {
      const value = JSON.parse(h.decode(payload)) as Session;
      if (
        (value.role === 'admin' || value.role === 'team') &&
        value.version === c[value.role].version &&
        Number.isFinite(value.expires) &&
        value.expires > now &&
        /^[A-Za-z0-9_-]{32}$/.test(value.nonce) &&
        !h.get('revoked:' + value.nonce)
      )
        s = value;
    }
  } catch {
    /* fail closed */
  }
  if (!s) refuse(401, 'Please sign in with the current access key.');
  const session = s;
  if (r.method !== 'GET' && !equal(r.csrf ?? '', csrf(session)))
    refuse(403, 'Refresh the page before making changes.');
  if (r.route === 'session' && r.method === 'GET')
    return ok({
      role: session.role,
      csrf: csrf(session),
      ...(r.includePlan ? { publication: h.read('plan') } : {}),
    });
  if (r.route === 'logout' && r.method === 'POST') {
    h.put('revoked:' + session.nonce, { until: session.expires });
    return { ...ok({ ok: true }), cookie: { value: '', seconds: 0 } };
  }
  if (r.route === 'plan' && r.method === 'GET') {
    const publication = h.read('plan');
    return ok(
      r.knownPlanId && publication?.id === r.knownPlanId ? { unchanged: true } : publication,
    );
  }
  if (session.role !== 'admin')
    refuse(403, 'Only an admin can access files or change this website.');
  if (r.route === 'password' && r.method === 'POST')
    return authenticate(() => {
      const input = r.body;
      if ((input?.role !== 'admin' && input?.role !== 'team') || !validKey(input?.newKey))
        refuse(400, 'Choose a role and a key of 8–256 characters.');
      if (!validKey(input.currentKey) || !matches(input.currentKey, c.admin))
        refuse(401, 'Enter the current admin key.');
      if (matches(input.newKey, c.admin) || matches(input.newKey, c.team))
        refuse(400, 'Choose a new key, different from both current keys.');
      c[input.role as Role] = password(input.newKey);
      h.put('credentials', c);
      return {
        ...ok({ ok: true }),
        ...(input.role === 'admin' ? { cookie: { value: '', seconds: 0 } } : {}),
      };
    });
  if (r.route === 'inputs' && r.method === 'GET') return ok(h.read('inputs', r.metadataOnly));
  if (r.route === 'inputs' && r.method === 'PUT') {
    const input = cleanInputs(h, r.body);
    h.write('inputs', input);
    return ok({ savedAt: input.savedAt });
  }
  if (/^inputs\/[0-2]$/.test(r.route) && r.method === 'GET') {
    const file = h.read('inputs')?.files[Number(r.route.split('/')[1])];
    if (!file) refuse(404, 'File not found.');
    return { status: 200, download: { name: file.name, base64: file.base64 } };
  }
  if (r.route === 'plan' && r.method === 'PUT') {
    let plan;
    try {
      plan = cleanPlan(r.body);
    } catch (e) {
      refuse(400, (e as Error).message);
    }
    const publication = { id: random(), publishedAt: new Date(now).toISOString(), plan };
    h.write('plan', publication);
    return ok(publication);
  }
  if (r.route === 'plan' && r.method === 'DELETE') {
    h.write('plan', null);
    return ok({ ok: true });
  }
  refuse(404, 'Not found.');
}
function cleanInputs(h: Host, value: any) {
  if (!Array.isArray(value?.files) || value.files.length < 1 || value.files.length > 3)
    refuse(400, 'Select the three Excel inputs.');
  const seen = new Set<string>();
  const files = value.files.map((f: any) => {
    if (
      typeof f?.name !== 'string' ||
      !/^[^/\\\u0000-\u001f]{1,180}\.xlsx$/i.test(f.name) ||
      typeof f.base64 !== 'string' ||
      f.base64.length > 7 * 1024 * 1024 ||
      !Array.isArray(f.kinds) ||
      !f.kinds.length ||
      f.kinds.length > 3 ||
      !h.validExcel(f.base64)
    )
      refuse(400, 'Choose .xlsx files smaller than 5 MB each.');
    for (const kind of f.kinds) {
      if (!['members', 'attendance', 'availability'].includes(kind) || seen.has(kind))
        refuse(400, 'Each input must appear once.');
      seen.add(kind);
    }
    return { name: f.name, base64: f.base64, kinds: [...f.kinds] };
  });
  if (seen.size !== 3) refuse(400, 'Save members, attendance, and drivers together.');
  return { savedAt: new Date(h.now()).toISOString(), files };
}
