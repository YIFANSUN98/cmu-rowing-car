import type { Reply, RequestData } from '../core.ts';
export interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
  APP_ORIGIN: string;
  APPS_SCRIPT_URL: string;
  DRIVE_BRIDGE_SECRET: string;
  COMBINED_PLAN_STARTUP?: string;
  SESSION_SIGNING_SECRET?: string;
}
const encoder = new TextEncoder();
const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (v) => v.toString(16).padStart(2, '0')).join('');
const random = () => hex(crypto.getRandomValues(new Uint8Array(32)));
async function hmac(value: string, secret: string, asHex = false) {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const data = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(value)));
  return asHex
    ? hex(data)
    : btoa(String.fromCharCode(...data))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
}
// Call only after the backend has accepted this token. The plan endpoint checks
// credential versions, expiry, revocation, and Drive privacy on every request.
async function authenticatedSession(token: string, secret: string) {
  try {
    const [payload, signature, extra] = token.split('.');
    if (!payload || !signature || extra || token.length > 1500) return;
    if ((await hmac(payload, secret)) !== signature) return;
    const session = JSON.parse(
      new TextDecoder().decode(
        Uint8Array.from(atob(payload.replace(/-/g, '+').replace(/_/g, '/')), (c) =>
          c.charCodeAt(0),
        ),
      ),
    );
    if (
      (session.role !== 'admin' && session.role !== 'team') ||
      !Number.isFinite(session.expires) ||
      session.expires <= Date.now() ||
      typeof session.nonce !== 'string' ||
      !/^[A-Za-z0-9_-]{32}$/.test(session.nonce)
    )
      return;
    return { role: session.role, csrf: await hmac(`csrf:${session.nonce}`, secret) };
  } catch {
    /* A changed signing configuration falls back to the backend session endpoint. */
  }
}
const routes: Record<string, string[]> = {
  login: ['POST'],
  session: ['GET'],
  logout: ['POST'],
  password: ['POST'],
  inputs: ['GET', 'PUT'],
  'inputs/0': ['GET'],
  'inputs/1': ['GET'],
  'inputs/2': ['GET'],
  plan: ['GET', 'PUT', 'DELETE'],
};
const headers = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Strict-Transport-Security': 'max-age=31536000',
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://api.tomtom.com; connect-src 'self' https://api.tomtom.com https://api.weather.gov https://api.waterdata.usgs.gov; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
};
function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...headers,
      'Content-Type': 'application/json; charset=utf-8',
      ...(status === 429 ? { 'Retry-After': '900' } : {}),
    },
  });
}
async function readBody(request: Request, limit: number) {
  if (request.headers.get('content-type')?.split(';')[0] !== 'application/json')
    throw new Error('content');
  if (Number(request.headers.get('content-length')) > limit) throw new Error('size');
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader)
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) {
        await reader.cancel();
        throw new Error('size');
      }
      chunks.push(value);
    }
  const data = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.length;
  }
  return JSON.parse(new TextDecoder().decode(data));
}
// Follow only Google's documented response redirect, never redirect a signed POST or keys.
export async function callScript(
  url: string,
  secret: string,
  data: RequestData,
  fetcher: typeof fetch = fetch,
): Promise<Reply> {
  if (!/^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(url))
    throw new Error('bridge_bad_endpoint');
  const message = JSON.stringify(data);
  const signature = await hmac(message, secret);
  // Use one deadline across the POST, redirects, and response body. Read-only
  // failures may be retried; writes keep their longer deadline and are never replayed.
  const signal = AbortSignal.timeout(data.method === 'GET' ? 8000 : 90000);
  let response = await fetcher(url, {
    method: 'POST',
    mode: 'no-cors',
    redirect: 'manual',
    signal,
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'CMU-Rowing/1.0' },
    body: JSON.stringify({ message, signature }),
  }).catch(() => {
    throw new Error('bridge_post_failed');
  });
  let currentUrl = url;
  for (let redirects = 0; [301, 302, 303, 307, 308].includes(response.status); redirects++) {
    if (redirects >= 4) throw new Error('bridge_redirect_limit');
    const location = new URL(response.headers.get('location') ?? '', currentUrl);
    if (
      location.protocol !== 'https:' ||
      location.hostname !== 'script.googleusercontent.com' ||
      location.username ||
      location.password
    )
      throw new Error(
        location.hostname === 'script.google.com'
          ? 'bridge_redirect_script_host'
          : location.hostname === 'accounts.google.com'
            ? 'bridge_redirect_login_host'
            : 'bridge_redirect_rejected',
      );
    currentUrl = location.href;
    const readRedirect = () =>
      fetcher(location, {
        mode: 'no-cors',
        redirect: 'manual',
        signal,
        headers: { 'User-Agent': 'CMU-Rowing/1.0' },
      }).catch(() => {
        throw new Error('bridge_redirect_failed');
      });
    response = await readRedirect();
    // Google's result URL has intermittently returned 404 in live checks.
    // Retry only reading that response; never repeat the original signed operation.
    for (let retry = 0; response.status === 404 && retry < 2; retry++) {
      await response.body?.cancel();
      await new Promise((resolve) => setTimeout(resolve, 300 * (retry + 1)));
      response = await readRedirect();
    }
  }
  if (!response.ok) throw new Error(`bridge_http_${response.status}`);
  const text = await response.text();
  let reply: Reply;
  try {
    // Backward compatible with the original JSON endpoint during backend updates.
    const encoded = /ROWING_RESULT_BEGIN_([A-Za-z0-9_-]+)_ROWING_RESULT_END/.exec(text)?.[1];
    const json = encoded
      ? new TextDecoder().decode(
          Uint8Array.from(atob(encoded.replace(/-/g, '+').replace(/_/g, '/')), (c) =>
            c.charCodeAt(0),
          ),
        )
      : text;
    reply = JSON.parse(json) as Reply;
  } catch {
    throw new Error('bridge_invalid_json');
  }
  if (![200, 400, 401, 403, 404, 405, 409, 413, 415, 429, 503].includes(reply?.status))
    throw new Error('bridge_invalid_reply');
  return reply;
}
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) {
      if (request.method !== 'GET' && request.method !== 'HEAD')
        return json(405, { error: 'Method not allowed.' });
      // Only real public build assets. Pages' usual SPA fallback must not serve source/private paths.
      if (
        url.pathname !== '/' &&
        !/^\/(?:assets\/[A-Za-z0-9_.-]+\.(?:js|css)|[A-Za-z0-9_./-]+\.(?:html|svg|png|jpg|webp|ico|woff2?|txt))$/.test(
          url.pathname,
        )
      )
        return json(404, { error: 'Not found.' });
      if (url.pathname.includes('..') || url.pathname.includes('/.'))
        return json(404, { error: 'Not found.' });
      const result = await env.ASSETS.fetch(request);
      const response = new Response(result.body, result);
      for (const [key, value] of Object.entries(headers)) response.headers.set(key, value);
      if (url.pathname.startsWith('/assets/'))
        response.headers.set('Cache-Control', 'public, max-age=31536000, immutable');
      return response;
    }
    const route = url.pathname.slice(5),
      method = request.method;
    if (!routes[route]?.includes(method)) return json(404, { error: 'Not found.' });
    if (
      !env.APP_ORIGIN ||
      !env.APPS_SCRIPT_URL ||
      !/^[a-f0-9]{64}$/.test(env.DRIVE_BRIDGE_SECRET ?? '')
    )
      return json(503, { error: 'Private storage is not connected yet.' });
    if (
      url.origin !== env.APP_ORIGIN ||
      request.headers.get('sec-fetch-site') === 'cross-site' ||
      (request.headers.has('origin') && request.headers.get('origin') !== env.APP_ORIGIN) ||
      (method !== 'GET' && request.headers.get('origin') !== env.APP_ORIGIN)
    )
      return json(403, { error: 'Use the club website to access the plan.' });
    // Local Wrangler preview uses an unprefixed cookie; production requires the secure prefix.
    const secure = url.protocol === 'https:',
      cookieName = secure ? '__Host-rowing_session' : 'rowing_session';
    const token =
      (request.headers.get('cookie') ?? '')
        .split(';')
        .map((v) => v.trim())
        .find((v) => v.startsWith(cookieName + '='))
        ?.slice(cookieName.length + 1) ?? '';
    if (route !== 'login' && !token)
      return json(401, { error: 'Please sign in with the current access key.' });
    let body: unknown;
    if (method !== 'GET')
      try {
        body = await readBody(
          request,
          method === 'PUT' ? (route === 'inputs' ? 22 : 6) * 1024 * 1024 : 4096,
        );
      } catch (e) {
        return json((e as Error).message === 'size' ? 413 : 400, {
          error: 'Invalid request or upload too large.',
        });
      }
    try {
      const data: RequestData = {
        timestamp: Date.now(),
        requestId: random(),
        entropy: random(),
        client: await hmac(
          request.headers.get('CF-Connecting-IP') ?? 'local',
          env.DRIVE_BRIDGE_SECRET,
          true,
        ),
        route,
        method,
        token,
        csrf: request.headers.get('x-csrf-token') ?? '',
        body,
        maintenance: false,
        knownPlanId: (url.searchParams.get('version') ?? '').slice(0, 100),
        metadataOnly: url.searchParams.get('metadata') === '1',
        includePlan: url.searchParams.get('includePlan') === '1',
      };
      let reply: Reply;
      const legacyStartup =
        route === 'session' &&
        method === 'GET' &&
        data.includePlan &&
        env.COMBINED_PLAN_STARTUP !== '1';
      if (legacyStartup && env.SESSION_SIGNING_SECRET) {
        const plan = await callScript(env.APPS_SCRIPT_URL, env.DRIVE_BRIDGE_SECRET, {
          ...data,
          route: 'plan',
          includePlan: false,
          knownPlanId: '',
        });
        reply = plan;
        if (plan.status === 200) {
          const session = await authenticatedSession(token, env.SESSION_SIGNING_SECRET);
          if (session) reply = { status: 200, body: { ...session, publication: plan.body } };
          else {
            // If the backend signing key changes, preserve correct CSRF values.
            reply = await callScript(env.APPS_SCRIPT_URL, env.DRIVE_BRIDGE_SECRET, {
              ...data,
              requestId: random(),
              includePlan: false,
            });
            if (reply.status === 200)
              reply = { ...reply, body: { ...(reply.body as object), publication: plan.body } };
          }
        }
      } else if (legacyStartup) {
        // Older backends ignore includePlan. Start both authenticated reads together
        // instead of making the browser wait for two sequential Google executions.
        const [session, plan] = await Promise.allSettled([
          callScript(env.APPS_SCRIPT_URL, env.DRIVE_BRIDGE_SECRET, { ...data, includePlan: false }),
          callScript(env.APPS_SCRIPT_URL, env.DRIVE_BRIDGE_SECRET, {
            ...data,
            route: 'plan',
            knownPlanId: '',
            requestId: random(),
            includePlan: false,
          }),
        ]);
        if (session.status === 'rejected') throw session.reason;
        reply = session.value;
        if (reply.status === 200 && plan.status === 'fulfilled') {
          if (plan.value.status === 200) {
            reply = { ...reply, body: { ...(reply.body as object), publication: plan.value.body } };
          } else if (plan.value.status === 401 || plan.value.status === 403) reply = plan.value;
        }
      } else reply = await callScript(env.APPS_SCRIPT_URL, env.DRIVE_BRIDGE_SECRET, data);
      let response: Response;
      if (reply.download && reply.status === 200) {
        const { name, base64 } = reply.download;
        response = new Response(
          Uint8Array.from(atob(base64), (v) => v.charCodeAt(0)),
          {
            headers: {
              ...headers,
              'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
              'Content-Disposition': `attachment; filename="input.xlsx"; filename*=UTF-8''${encodeURIComponent(name)}`,
            },
          },
        );
      } else response = json(reply.status, reply.body);
      if (reply.cookie) {
        if (
          !/^[A-Za-z0-9_.-]*$/.test(reply.cookie.value) ||
          !Number.isInteger(reply.cookie.seconds) ||
          reply.cookie.seconds < 0 ||
          reply.cookie.seconds > 604800
        )
          throw new Error('bridge_bad_cookie');
        response.headers.set(
          'Set-Cookie',
          `${cookieName}=${reply.cookie.value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${reply.cookie.seconds}${secure ? '; Secure' : ''}`,
        );
      }
      return response;
    } catch (error) {
      // Log status codes only, never keys, cookies, body data, or one-time redirect URLs.
      const code =
        error instanceof Error && /^bridge_[a-z0-9_]+$/.test(error.message)
          ? error.message
          : 'bridge_unavailable';
      console.error(code);
      return json(503, {
        error: 'Private storage is temporarily unavailable. Please try again shortly.',
      });
    }
  },
};
