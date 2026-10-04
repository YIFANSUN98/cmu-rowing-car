import { expect, test } from 'vitest';
import { build } from 'esbuild';
import vm from 'node:vm';
import { createHmac } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { fixture, adminKey, sampleInputs, samplePlan } from './cloud/host.ts';

test('Apps Script bundle runs without Node or WebCrypto and stores real Excel files privately', async () => {
  const built = await build({
    entryPoints: ['cloud/apps-script/main.ts'],
    bundle: true,
    format: 'iife',
    globalName: 'Rowing',
    platform: 'neutral',
    target: 'es2020',
    write: false,
  });
  const f = fixture(),
    bridgeSecret = 'c'.repeat(64);
  const values = new Map<string, string>();
  const files = new Map<string, any>();
  const cacheRecords = new Map<string, string>();
  let counter = 0,
    reads = 0,
    lockAttempts = 0,
    isLocked = false,
    shared = false,
    failWrite = false,
    failCache = false;
  const blob = (value: any, mime = 'text/plain', name = '') => {
    const b = typeof value === 'string' ? Buffer.from(value) : Buffer.from(value);
    return {
      getBytes: () => [...b].map((v) => (v > 127 ? v - 256 : v)),
      getDataAsString: () => b.toString('utf8'),
      name,
      mime,
    };
  };
  const properties = {
    getProperty: (k: string) => values.get(k) ?? null,
    setProperty: (k: string, v: string) => {
      values.set(k, v);
    },
    deleteProperty: (k: string) => values.delete(k),
    getKeys: () => [...values.keys()],
    getProperties: () => Object.fromEntries(values),
  };
  const folder = {
    getId: () => 'f'.repeat(30),
    getUrl: () => 'https://drive.google.com/drive/folders/fixture',
    getSharingAccess: () => (shared ? 'ANYONE' : 'PRIVATE'),
    getEditors: () => [],
    getViewers: () => [],
    createFile: (b: any) => {
      if (failWrite && b.mime === 'application/json') throw new Error('Simulated Drive failure');
      const id = String(++counter);
      const file = {
        id,
        b,
        trashed: false,
        getId: () => id,
        getBlob: () => {
          reads++;
          return b;
        },
        setTrashed: (v: boolean) => {
          file.trashed = v;
        },
      };
      files.set(id, file);
      return file;
    },
  };
  const context = vm.createContext({
    ROWING_SETUP: {
      folderId: '',
      bridgeSecret,
      credentials: f.host.get('credentials'),
    },
    console: { log: () => {} },
    PropertiesService: { getScriptProperties: () => properties },
    CacheService: {
      getScriptCache: (() => {
        const cache = cacheRecords;
        return () => ({
          get: (key: string) => {
            if (failCache) throw new Error('Cache unavailable');
            return cache.get(key) ?? null;
          },
          getAll: (keys: string[]) => {
            if (failCache) throw new Error('Cache unavailable');
            return Object.fromEntries(
              keys.filter((key) => cache.has(key)).map((key) => [key, cache.get(key)]),
            );
          },
          putAll: (values: Record<string, string>) => {
            if (failCache) throw new Error('Cache unavailable');
            for (const [key, value] of Object.entries(values)) cache.set(key, value);
          },
          put: (key: string, value: string) => {
            if (failCache) throw new Error('Cache unavailable');
            cache.set(key, value);
          },
        });
      })(),
    },
    LockService: {
      getScriptLock: () => ({
        waitLock: () => {
          isLocked = true;
        },
        tryLock: () => {
          lockAttempts++;
          isLocked = true;
          return true;
        },
        hasLock: () => isLocked,
        releaseLock: () => {
          isLocked = false;
        },
      }),
    },
    DriveApp: {
      createFolder: () => folder,
      Access: { PRIVATE: 'PRIVATE' },
      getFolderById: () => folder,
      getFileById: (id: string) => {
        const file = files.get(id);
        if (!file || file.trashed) throw new Error('File not found');
        return file;
      },
    },
    Utilities: {
      Charset: { UTF_8: 'UTF-8' },
      newBlob: blob,
      gzip: (b: any) => blob(gzipSync(Buffer.from(b.getBytes()))),
      ungzip: (b: any) => blob(gunzipSync(Buffer.from(b.getBytes()))),
      base64Encode: (v: any) => Buffer.from(v).toString('base64'),
      base64EncodeWebSafe: (v: any) => Buffer.from(v).toString('base64url'),
      base64Decode: (v: string) => [...Buffer.from(v, 'base64')],
      base64DecodeWebSafe: (v: string) => [...Buffer.from(v, 'base64url')],
      computeHmacSha256Signature: (v: string, key: string) => [
        ...createHmac('sha256', key).update(v).digest(),
      ],
    },
    ContentService: {
      MimeType: { JSON: 'JSON' },
      createTextOutput: (v: string) => ({ setMimeType: () => JSON.parse(v) }),
    },
    HtmlService: {
      createHtmlOutput: (v: string) => {
        const encoded = /ROWING_RESULT_BEGIN_([A-Za-z0-9_-]+)_ROWING_RESULT_END/.exec(v)![1];
        return JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
      },
    },
  });
  vm.runInContext(built.outputFiles[0].text, context);
  vm.runInContext('Rowing.setup()', context);
  const call = (data: any, invalid = false) => {
    const message = JSON.stringify(f.request(data));
    context.event = {
      postData: {
        contents: JSON.stringify({
          message,
          signature: invalid
            ? 'invalid'
            : createHmac('sha256', bridgeSecret).update(message).digest('base64url'),
        }),
      },
    };
    return vm.runInContext('Rowing.doPost(event)', context);
  };
  expect(call({ route: 'session' }, true).status).toBe(403);
  const login = call({ route: 'login', method: 'POST', body: { key: adminKey } });
  expect(login.status).toBe(200); // Verifies noble scrypt agrees with the existing Node hashes.
  const auth = { token: login.cookie.value, csrf: login.body.csrf };
  expect(call({ ...auth, route: 'inputs', method: 'PUT', body: sampleInputs }).status).toBe(200);
  expect(
    [...files.values()].filter((f) => f.b.mime.includes('spreadsheetml') && !f.trashed),
  ).toHaveLength(3);
  expect(call({ ...auth, route: 'inputs' }).body.files).toEqual(sampleInputs.files);
  const previousReads = reads,
    previousLocks = lockAttempts;
  const metadata = call({ ...auth, route: 'inputs', metadataOnly: true });
  expect(metadata.status).toBe(200);
  expect(metadata.body.files).toEqual(
    sampleInputs.files.map(({ name, kinds }) => ({ name, kinds })),
  );
  expect(reads).toBe(previousReads); // Cached manifest; no Excel downloads.
  expect(lockAttempts).toBe(previousLocks);
  failWrite = true;
  expect(call({ ...auth, route: 'inputs', method: 'PUT', body: sampleInputs }).status).toBe(503);
  expect(call({ ...auth, route: 'inputs' }).body.files).toEqual(sampleInputs.files); // failed replacement preserves previous set
  failWrite = false;
  expect(call({ ...auth, route: 'plan', method: 'PUT', body: samplePlan }).status).toBe(200);
  const beforeFirstRead = reads;
  const publication = call({ ...auth, route: 'plan' }).body;
  expect(reads).toBe(beforeFirstRead); // Publish warms the cache before the first viewer arrives.
  const planReads = reads;
  expect(call({ ...auth, route: 'plan', knownPlanId: publication.id }).body).toEqual({
    unchanged: true,
  });
  expect(reads).toBe(planReads);
  failCache = true;
  expect(call({ ...auth, route: 'plan' }).body).toEqual(publication);
  expect(reads).toBe(planReads + 1); // Cache failure still reads the authoritative file.
  failCache = false;
  const largePlan = structuredClone(samplePlan) as any;
  largePlan.days[0].routes[0].geometry = Array.from({ length: 14000 }, (_, index) => ({
    lat: Math.sin(index * 123.456) * 89,
    lng: Math.cos(index * 654.321) * 179,
  }));
  const largePublication = call({ ...auth, route: 'plan', method: 'PUT', body: largePlan });
  expect(largePublication.status).toBe(200);
  const beforeLargeRead = reads;
  expect(call({ ...auth, route: 'plan' }).body).toEqual(largePublication.body);
  expect(reads).toBe(beforeLargeRead);
  const chunkKeys = [...cacheRecords.keys()].filter((key) => key.includes(':chunk:'));
  expect(chunkKeys.length).toBeGreaterThan(1);
  cacheRecords.delete(chunkKeys[0]);
  expect(call({ ...auth, route: 'plan' }).body).toEqual(largePublication.body);
  expect(reads).toBe(beforeLargeRead + 1); // Evicted chunks fall back to a complete Drive file.
  expect(call({ ...auth, route: 'plan', method: 'DELETE' }).status).toBe(200);
  expect(call({ ...auth, route: 'plan' }).body).toBeNull();
  shared = true;
  expect(call({ ...auth, route: 'plan' }).status).toBe(503);
  expect(isLocked).toBe(false);
}, 30000);
