import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import worker from '../../cloud/pages/worker.ts';
import { handle } from '../../cloud/core.ts';
import { fixture, sign } from '../cloud/host.ts';
const origin = 'http://127.0.0.1:4176',
  upstream = 'https://script.google.com/macros/s/fixture/exec',
  secret = 'd'.repeat(64);
const f = fixture();
// Isolated in-memory Drive adapter. Browser tests never read or change real team files.
globalThis.fetch = async (input, options) => {
  if (String(input) !== upstream) throw new Error('Unexpected fixture upstream');
  const envelope = JSON.parse(String(options?.body));
  if (envelope.signature !== sign(envelope.message, secret)) return Response.json({ status: 403 });
  return Response.json(handle(f.host, JSON.parse(envelope.message)));
};
const assets = resolve('node_modules/.cache/rowing-cloud-browser-test');
const env = {
  APP_ORIGIN: origin,
  APPS_SCRIPT_URL: upstream,
  DRIVE_BRIDGE_SECRET: secret,
  ASSETS: {
    fetch: async (request: Request) => {
      const path = new URL(request.url).pathname;
      const target = resolve(assets, '.' + (path === '/' ? '/index.html' : path));
      if (!target.startsWith(assets + '/')) return new Response('Not found', { status: 404 });
      try {
        return new Response(await readFile(target), {
          headers: {
            'Content-Type':
              (
                {
                  '.html': 'text/html',
                  '.js': 'application/javascript',
                  '.css': 'text/css',
                  '.svg': 'image/svg+xml',
                  '.png': 'image/png',
                } as Record<string, string>
              )[extname(target)] ?? 'text/plain',
          },
        });
      } catch {
        return new Response('Not found', { status: 404 });
      }
    },
  },
};
const server = createServer(async (req, res) => {
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers))
      if (value) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
    const response = await worker.fetch(
      new Request(origin + req.url, {
        method: req.method,
        headers,
        ...(['GET', 'HEAD'].includes(req.method!) ? {} : { body: Buffer.concat(chunks) }),
      }),
      env,
    );
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch {
    res.writeHead(500);
    res.end('Fixture error');
  }
});
server.listen(4176, '127.0.0.1');
for (const signal of ['SIGTERM', 'SIGINT'])
  process.on(signal, () => server.close(() => process.exit(0)));
