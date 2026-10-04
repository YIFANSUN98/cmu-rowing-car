import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';
import {
  atomicJson,
  credentials as storedCredentials,
  credentialLock,
  csrfToken,
  issueSession,
  matches,
  password,
  randomKey,
  readJson,
  validKey,
  verifySession,
  type Role,
} from './security.ts';
import { activeCredentials as credentials } from './local-keys.ts';
import { cleanPlan, type Publication } from '../src/sharing/schema.ts';

export const BASE = '/cmu-rowing-car/';
export const API = BASE + 'api/';
export interface ServerOptions {
  directory: string;
  origin: string;
  dist?: string;
}
type StoredFile = { name: string; base64: string; kinds: string[] };
type StoredInputs = { savedAt: string; files: StoredFile[] };
class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
const refuse = (status: number, message: string): never => {
  throw new HttpError(status, message);
};
const kinds = ['members', 'attendance', 'availability'];
function cleanInputs(value: any): StoredInputs {
  if (!Array.isArray(value?.files) || !value.files.length || value.files.length > 3)
    refuse(400, 'Select the three Excel inputs.');
  const seen = new Set<string>();
  const files = value.files.map((f: any): StoredFile => {
    if (
      typeof f?.name !== 'string' ||
      !/^[^/\\\u0000-\u001f]{1,180}\.xlsx$/i.test(f.name) ||
      typeof f.base64 !== 'string' ||
      f.base64.length > 7 * 1024 * 1024 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(f.base64) ||
      !Array.isArray(f.kinds) ||
      !f.kinds.length ||
      f.kinds.length > 3
    )
      refuse(400, 'Invalid Excel upload.');
    const bytes = Buffer.from(f.base64, 'base64');
    if (
      bytes.length > 5 * 1024 * 1024 ||
      bytes.length < 4 ||
      bytes[0] !== 0x50 ||
      bytes[1] !== 0x4b ||
      bytes.toString('base64') !== f.base64
    )
      refuse(400, 'Choose .xlsx files smaller than 5 MB each.');
    for (const kind of f.kinds) {
      if (!kinds.includes(kind) || seen.has(kind)) refuse(400, 'Each input must appear once.');
      seen.add(kind);
    }
    return { name: f.name, base64: f.base64, kinds: [...f.kinds] };
  });
  if (seen.size !== 3) refuse(400, 'Save members, attendance, and drivers together.');
  return { savedAt: new Date().toISOString(), files };
}
async function body(req: IncomingMessage, limit: number): Promise<any> {
  if (req.headers['content-type']?.split(';')[0] !== 'application/json')
    refuse(415, 'Use JSON requests.');
  if (Number(req.headers['content-length']) > limit) refuse(413, 'This upload is too large.');
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0,
      failed = false;
    req.on('data', (chunk: Buffer) => {
      if (failed) return;
      size += chunk.length;
      if (size > limit) {
        failed = true;
        reject(new HttpError(413, 'This upload is too large.'));
      } else chunks.push(chunk);
    });
    req.on('error', reject);
    req.on('end', () => {
      if (failed) return;
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new HttpError(400, 'Invalid request.'));
      }
    });
  });
}
export function createApp(options: ServerOptions) {
  const origin = new URL(options.origin);
  if (
    origin.origin !== options.origin ||
    (origin.protocol !== 'https:' &&
      !(
        origin.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname)
      ))
  )
    throw new Error('APP_ORIGIN must be an HTTPS origin, or HTTP on localhost for development.');
  if (
    options.dist &&
    (resolve(options.directory).startsWith(resolve(options.dist) + sep) ||
      resolve(options.directory) === resolve(options.dist))
  )
    throw new Error('Private storage must be outside the public build directory.');
  const secure = origin.protocol === 'https:';
  const cookieName = secure ? '__Secure-rowing_session' : 'rowing_session';
  const cookie = (token: string, seconds: number) =>
    `${cookieName}=${token}; Path=${BASE}; HttpOnly; SameSite=Strict; Max-Age=${seconds}${secure ? '; Secure' : ''}`;
  const failures = new Map<string, { count: number; until: number }>();
  let activeHashes = 0,
    globalAttempts = 0,
    globalReset = 0;
  let mutations: Promise<unknown> = Promise.resolve();
  const serialize = <T>(task: () => Promise<T>) => {
    const next = mutations.then(task);
    mutations = next.catch(() => {});
    return next;
  };
  const send = (res: ServerResponse, status: number, value: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(value));
  };
  const sessionFor = async (req: IncomingMessage) => {
    const config = await credentials(options.directory);
    const token =
      (req.headers.cookie ?? '')
        .split(';')
        .map((v) => v.trim())
        .find((v) => v.startsWith(cookieName + '='))
        ?.slice(cookieName.length + 1) ?? '';
    const session = verifySession(token, config);
    const revoked =
      (await readJson<Record<string, number>>(options.directory, 'revoked.json')) ?? {};
    if (!session || revoked[session.nonce])
      return refuse(401, 'Please sign in with the current access key.');
    return { config, session };
  };
  const authenticateKey = async <T>(req: IncomingMessage, work: () => Promise<T>): Promise<T> => {
    const now = Date.now();
    for (const [ip, state] of failures) if (state.until <= now) failures.delete(ip);
    // Ignore untrusted forwarded headers. A reverse proxy may additionally limit by client IP.
    const ip = req.socket.remoteAddress ?? 'unknown',
      state = failures.get(ip);
    if (globalReset <= now) {
      globalReset = now + 60000;
      globalAttempts = 0;
    }
    if (
      (state?.count ?? 0) >= 10 ||
      globalAttempts >= 120 ||
      activeHashes >= 2 ||
      failures.size > 10000
    )
      return refuse(429, 'Too many attempts. Wait a few minutes before trying again.');
    globalAttempts++;
    activeHashes++;
    try {
      const result = await work();
      failures.delete(ip);
      return result;
    } catch (error) {
      if (error instanceof HttpError && error.status === 401)
        failures.set(ip, {
          count: (state?.count ?? 0) + 1,
          until: state?.until ?? now + 15 * 60000,
        });
      throw error;
    } finally {
      activeHashes--;
    }
  };
  return createServer(
    { requestTimeout: 30000, headersTimeout: 10000, maxHeaderSize: 16384 },
    async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.setHeader('X-Frame-Options', 'DENY');
      res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
      if (secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
      try {
        if (req.headers.host !== origin.host) refuse(403, 'Unexpected website address.');
        const url = new URL(req.url ?? '/', origin);
        if (url.origin !== origin.origin) refuse(403, 'Unexpected website address.');
        if (url.pathname.startsWith(API)) {
          const route = url.pathname.slice(API.length),
            method = req.method;
          if (req.headers.origin && req.headers.origin !== origin.origin)
            refuse(403, 'Use this website to make changes.');
          if (req.headers['sec-fetch-site'] === 'cross-site')
            refuse(403, 'Use this website to access the plan.');
          if (method !== 'GET' && req.headers.origin !== origin.origin)
            refuse(403, 'Use this website to make changes.');
          if (route === 'login' && method === 'POST') {
            const input = await body(req, 4096);
            return await authenticateKey(req, async () => {
              if (!validKey(input?.key)) refuse(401, 'That access key was not recognized.');
              const config = await credentials(options.directory);
              const isAdmin = await matches(input.key, config.admin),
                isTeam = await matches(input.key, config.team);
              const role: Role = isAdmin
                ? 'admin'
                : isTeam
                  ? 'team'
                  : refuse(401, 'That access key was not recognized.');
              const latest = await credentials(options.directory);
              if (latest[role].version !== config[role].version)
                refuse(401, 'The key changed. Sign in again.');
              const { token, session } = issueSession(role, config);
              res.setHeader(
                'Set-Cookie',
                cookie(token, Math.floor((session.expires - Date.now()) / 1000)),
              );
              send(res, 200, {
                role,
                csrf: csrfToken(session, config),
                ...(input.includePlan
                  ? { publication: await readJson<Publication>(options.directory, 'plan.json') }
                  : {}),
              });
            });
          }
          const { config, session } = await sessionFor(req);
          if (method !== 'GET' && req.headers['x-csrf-token'] !== csrfToken(session, config))
            refuse(403, 'Refresh the page before making changes.');
          if (route === 'session' && method === 'GET')
            return send(res, 200, {
              role: session.role,
              csrf: csrfToken(session, config),
              ...(url.searchParams.get('includePlan') === '1'
                ? { publication: await readJson<Publication>(options.directory, 'plan.json') }
                : {}),
            });
          if (route === 'logout' && method === 'POST') {
            await body(req, 4096);
            await serialize(async () => {
              const revoked =
                (await readJson<Record<string, number>>(options.directory, 'revoked.json')) ?? {};
              const active = Object.fromEntries(
                Object.entries(revoked).filter(([, expiry]) => expiry > Date.now()),
              );
              active[session.nonce] = session.expires;
              await atomicJson(options.directory, 'revoked.json', active);
            });
            res.setHeader('Set-Cookie', cookie('', 0));
            return send(res, 200, { ok: true });
          }
          if (route === 'plan' && method === 'GET') {
            const publication = await readJson<Publication>(options.directory, 'plan.json');
            return send(
              res,
              200,
              publication && publication.id === url.searchParams.get('version')
                ? { unchanged: true }
                : publication,
            );
          }
          if (session.role !== 'admin')
            refuse(403, 'Only an admin can access files or change this website.');
          if (route === 'password' && method === 'POST') {
            const input = await body(req, 4096);
            if ((input.role !== 'admin' && input.role !== 'team') || !validKey(input.newKey))
              refuse(400, 'Choose a role and a key of 8–256 characters.');
            await authenticateKey(req, () =>
              credentialLock(options.directory, async () => {
                const latest = await storedCredentials(options.directory);
                if (
                  latest.admin.version !== session.version ||
                  !validKey(input.currentKey) ||
                  !(await matches(input.currentKey, latest.admin))
                )
                  refuse(401, 'Enter the current admin key.');
                if (
                  (await matches(input.newKey, latest.admin)) ||
                  (await matches(input.newKey, latest.team))
                )
                  refuse(400, 'Choose a new key, different from both current keys.');
                latest[input.role as Role] = await password(input.newKey);
                await atomicJson(options.directory, 'credentials.json', latest);
              }),
            );
            if (input.role === 'admin') res.setHeader('Set-Cookie', cookie('', 0));
            return send(res, 200, { ok: true });
          }
          if (route === 'inputs' && method === 'GET') {
            const inputs = await readJson<StoredInputs>(options.directory, 'inputs.json');
            return send(
              res,
              200,
              inputs && url.searchParams.get('metadata') === '1'
                ? {
                    savedAt: inputs.savedAt,
                    files: inputs.files.map(({ name, kinds }) => ({ name, kinds })),
                  }
                : inputs,
            );
          }
          if (route === 'inputs' && method === 'PUT') {
            const input = cleanInputs(await body(req, 22 * 1024 * 1024));
            await serialize(async () => {
              await sessionFor(req);
              await atomicJson(options.directory, 'inputs.json', input);
            });
            return send(res, 200, { savedAt: input.savedAt });
          }
          if (/^inputs\/[0-2]$/.test(route) && method === 'GET') {
            const inputs = await readJson<StoredInputs>(options.directory, 'inputs.json');
            const file = inputs?.files[Number(route.split('/')[1])];
            if (!file) refuse(404, 'File not found.');
            res.writeHead(200, {
              'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
              'Content-Disposition': `attachment; filename="input.xlsx"; filename*=UTF-8''${encodeURIComponent(file!.name)}`,
            });
            return res.end(Buffer.from(file!.base64, 'base64'));
          }
          if (route === 'plan' && method === 'PUT') {
            let plan;
            try {
              plan = cleanPlan(await body(req, 6 * 1024 * 1024));
            } catch (error) {
              if (error instanceof HttpError) throw error;
              refuse(400, (error as Error).message);
            }
            const publication = { id: randomKey(), publishedAt: new Date().toISOString(), plan };
            await serialize(async () => {
              await sessionFor(req);
              await atomicJson(options.directory, 'plan.json', publication);
            });
            return send(res, 200, publication);
          }
          if (route === 'plan' && method === 'DELETE') {
            await body(req, 4096);
            await serialize(async () => {
              await sessionFor(req);
              await atomicJson(options.directory, 'plan.json', null);
            });
            return send(res, 200, { ok: true });
          }
          return refuse(404, 'Not found.');
        }
        if (req.method !== 'GET' && req.method !== 'HEAD') refuse(405, 'Method not allowed.');
        if (url.pathname === '/' || url.pathname === BASE.slice(0, -1)) {
          res.writeHead(302, { Location: BASE });
          return res.end();
        }
        if (!options.dist || !url.pathname.startsWith(BASE)) refuse(404, 'Not found.');
        const relative = decodeURIComponent(url.pathname.slice(BASE.length)) || 'index.html';
        // Only serve actual build assets. No SPA fallback to private paths or source files.
        if (
          relative.split(/[\\/]/).some((part) => part.startsWith('.')) ||
          relative.includes('\\') ||
          !/\.(html|js|css|svg|png|webp|ico|woff2?|txt)$/.test(relative)
        )
          refuse(404, 'Not found.');
        const root = await realpath(options.dist!),
          path = await realpath(resolve(root, relative)).catch(() => '');
        if (!path.startsWith(root + sep) || !(await stat(path)).isFile()) refuse(404, 'Not found.');
        res.setHeader(
          'Content-Security-Policy',
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://api.tomtom.com; connect-src 'self' https://api.tomtom.com https://api.weather.gov https://api.waterdata.usgs.gov; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
        );
        const mime: Record<string, string> = {
          '.html': 'text/html',
          '.js': 'text/javascript',
          '.css': 'text/css',
          '.svg': 'image/svg+xml',
          '.png': 'image/png',
          '.webp': 'image/webp',
          '.ico': 'image/x-icon',
          '.woff': 'font/woff',
          '.woff2': 'font/woff2',
          '.txt': 'text/plain',
        };
        res.setHeader(
          'Content-Type',
          mime[extname(path)] +
            (['.html', '.js', '.css', '.svg', '.txt'].includes(extname(path))
              ? '; charset=utf-8'
              : ''),
        );
        return res.end(req.method === 'HEAD' ? undefined : await readFile(path));
      } catch (error) {
        if (!req.complete) {
          res.setHeader('Connection', 'close');
          req.resume();
        }
        const status = error instanceof HttpError ? error.status : 503;
        if (status === 429) res.setHeader('Retry-After', '900');
        send(res, status, {
          error:
            error instanceof HttpError
              ? error.message
              : 'The private server is unavailable. Check its setup and storage, then try again.',
        });
      }
    },
  );
}
