/// <reference types="google-apps-script" />
import { scrypt } from '@noble/hashes/scrypt.js';
import { equal, handle, type Host, type RequestData } from '../core.ts';

// Generated only into ignored data/private/cloud/apps-script/Setup.js.
declare const ROWING_SETUP: { folderId: string; bridgeSecret: string; credentials: unknown };
const props = () => PropertiesService.getScriptProperties();
const sign = (value: string, secret: string) =>
  Utilities.base64EncodeWebSafe(
    Utilities.computeHmacSha256Signature(value, secret, Utilities.Charset.UTF_8),
  ).replace(/=+$/, '');
const bytes = (value: string) =>
  Uint8Array.from(Utilities.newBlob(value).getBytes(), (v) => v & 255);
function configuration() {
  const raw = props().getProperty('configuration');
  if (!raw) throw new Error('Run setup once in the Apps Script editor.');
  return JSON.parse(raw) as { folderId: string; bridgeSecret: string };
}
function privateFolder() {
  const folder = DriveApp.getFolderById(configuration().folderId);
  // Do not silently continue after the backend folder has been shared with others.
  if (
    folder.getSharingAccess() !== DriveApp.Access.PRIVATE ||
    folder.getEditors().length ||
    folder.getViewers().length
  )
    throw new Error('Keep the website storage folder private to its owner.');
  return folder;
}
function readPointer(name: string): string | null {
  return props().getProperty('file:' + name);
}
function cacheJson(id: string, text: string) {
  try {
    const encoded = Utilities.base64Encode(Utilities.gzip(Utilities.newBlob(text)).getBytes());
    const cache = CacheService.getScriptCache();
    const key = 'json:' + id;
    if (encoded.length <= 95000) cache.put(key, encoded, 21600);
    else {
      const count = Math.ceil(encoded.length / 95000);
      if (count > 32) return;
      const chunks: Record<string, string> = {};
      for (let index = 0; index < count; index++)
        chunks[`${key}:chunk:${index}`] = encoded.slice(index * 95000, (index + 1) * 95000);
      cache.putAll(chunks, 21600);
      // Commit the manifest after the chunks; partial entries never become a plan.
      cache.put(key, `chunks:${count}`, 21600);
    }
  } catch {
    /* Caching is optional; Drive remains authoritative. */
  }
}
function readJson(name: string) {
  const id = readPointer(name);
  if (!id) return null;
  // Immutable file IDs make long-lived entries safe across publishes and deletes.
  // Authentication and folder privacy are still checked on every request.
  try {
    const cache = CacheService.getScriptCache();
    const key = 'json:' + id;
    let cached = cache.get(key);
    if (cached?.startsWith('chunks:')) {
      const count = Number(cached.slice(7));
      if (!Number.isInteger(count) || count < 1 || count > 32) throw new Error('Cache miss');
      const keys = Array.from({ length: count }, (_, index) => `${key}:chunk:${index}`);
      const chunks = cache.getAll(keys);
      if (keys.some((key) => typeof chunks[key] !== 'string')) throw new Error('Cache miss');
      cached = keys.map((key) => chunks[key]).join('');
    }
    if (cached)
      return JSON.parse(
        Utilities.ungzip(
          Utilities.newBlob(Utilities.base64Decode(cached), 'application/gzip'),
        ).getDataAsString('UTF-8'),
      );
  } catch {
    /* A cache miss or failure falls back to private Drive storage. */
  }
  let file;
  try {
    file = DriveApp.getFileById(id).getBlob();
  } catch (error) {
    if (readPointer(name) !== id) return readJson(name);
    throw error;
  }
  const text = file.getDataAsString('UTF-8');
  const value = JSON.parse(text);
  cacheJson(id, text);
  return value;
}
function trash(id: string | null) {
  if (!id) return;
  try {
    DriveApp.getFileById(id).setTrashed(true);
  } catch {
    /* Committed writes remain successful. */
  }
}
function read(name: 'inputs' | 'plan', metadataOnly = false) {
  privateFolder();
  const data = readJson(name);
  if (name !== 'inputs' || !data) return data;
  return {
    savedAt: data.savedAt,
    files: data.files.map((f: any) => ({
      name: f.name,
      kinds: f.kinds,
      ...(metadataOnly
        ? {}
        : { base64: Utilities.base64Encode(DriveApp.getFileById(f.id).getBlob().getBytes()) }),
    })),
  };
}
function write(name: 'inputs' | 'plan', value: any) {
  const folder = privateFolder(),
    previousId = readPointer(name);
  const previous = name === 'inputs' ? readJson(name) : null;
  const created: string[] = [];
  try {
    let stored = value;
    if (name === 'inputs' && value)
      stored = {
        savedAt: value.savedAt,
        files: value.files.map((f: any) => {
          const file = folder.createFile(
            Utilities.newBlob(
              Utilities.base64Decode(f.base64),
              'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
              f.name,
            ),
          );
          created.push(file.getId());
          return { name: f.name, kinds: f.kinds, id: file.getId() };
        }),
      };
    const text = JSON.stringify(stored);
    const file = folder.createFile(Utilities.newBlob(text, 'application/json', name + '.json'));
    created.push(file.getId());
    // Commit the new pointer only once every new file has been written successfully.
    props().setProperty('file:' + name, file.getId());
    cacheJson(file.getId(), text);
  } catch (error) {
    created.forEach(trash);
    throw error;
  }
  trash(previousId);
  if (previous) previous.files.forEach((f: any) => trash(f.id));
}
function host(): Host {
  // One service call per request instead of one per credential/rate/revocation record.
  const properties = props(),
    values = properties.getProperties();
  return {
    now: () => Date.now(),
    get: (key) => {
      const v = values[key];
      return v === undefined ? null : JSON.parse(v);
    },
    put: (key, value) => {
      values[key] = JSON.stringify(value);
      properties.setProperty(key, values[key]);
    },
    remove: (key) => {
      delete values[key];
      properties.deleteProperty(key);
    },
    keys: () => Object.keys(values),
    read,
    write,
    sign,
    encode: (value) =>
      Utilities.base64EncodeWebSafe(value, Utilities.Charset.UTF_8).replace(/=+$/, ''),
    decode: (value) =>
      Utilities.newBlob(Utilities.base64DecodeWebSafe(value)).getDataAsString('UTF-8'),
    // Exactly the existing Node scrypt parameters; no weaker cloud-only password hash.
    hash: (key, salt) =>
      Array.from(
        scrypt(bytes(key), bytes(salt), {
          N: 32768,
          r: 8,
          p: 3,
          dkLen: 64,
          maxmem: 64 * 1024 * 1024,
        }),
      )
        .map((v) => v.toString(16).padStart(2, '0'))
        .join(''),
    validExcel: (value) => {
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return false;
      try {
        const data = Utilities.base64Decode(value);
        return (
          data.length >= 4 &&
          data.length <= 5 * 1024 * 1024 &&
          data[0] === 80 &&
          data[1] === 75 &&
          Utilities.base64Encode(data) === value
        );
      } catch {
        return false;
      }
    },
  };
}
export function setup() {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    if (!props().getProperty('configuration')) {
      if (
        (ROWING_SETUP.folderId !== '' && !/^[A-Za-z0-9_-]{20,}$/.test(ROWING_SETUP.folderId)) ||
        !/^[a-f0-9]{64}$/.test(ROWING_SETUP.bridgeSecret)
      )
        throw new Error('Invalid private setup.');
      props().setProperty(
        'configuration',
        JSON.stringify({
          folderId:
            ROWING_SETUP.folderId ||
            DriveApp.createFolder('CMU Rowing — Private Website Storage').getId(),
          bridgeSecret: ROWING_SETUP.bridgeSecret,
        }),
      );
    }
    privateFolder();
    if (!props().getProperty('credentials')) {
      props().setProperty('credentials', JSON.stringify(ROWING_SETUP.credentials));
      const c = ROWING_SETUP.credentials as { admin: unknown; team: unknown };
      props().setProperty('last-local-keys', JSON.stringify({ admin: c.admin, team: c.team }));
    }
    console.log('Private storage and access keys are configured.');
    console.log('Private storage folder: ' + privateFolder().getUrl());
  } finally {
    lock.releaseLock();
  }
}
export function doGet() {
  return ContentService.createTextOutput(
    JSON.stringify({ status: 405, body: { error: 'Use the club website.' } }),
  ).setMimeType(ContentService.MimeType.JSON);
}
export function doPost(event: GoogleAppsScript.Events.DoPost) {
  let result: unknown = { status: 403, body: { error: 'Invalid request.' } };
  const lock = LockService.getScriptLock();
  try {
    const raw = event.postData?.contents;
    if (!raw || raw.length > 24 * 1024 * 1024) throw new Error('Invalid request.');
    const envelope = JSON.parse(raw);
    const config = configuration();
    if (
      typeof envelope.message !== 'string' ||
      typeof envelope.signature !== 'string' ||
      !equal(envelope.signature, sign(envelope.message, config.bridgeSecret))
    )
      throw new Error('Invalid request.');
    const request = JSON.parse(envelope.message) as RequestData;
    if (request.method === 'GET' && !request.maintenance) result = handle(host(), request);
    else if (!lock.tryLock(20000))
      result = {
        status: 503,
        body: { error: 'Another update is in progress. Try again shortly.' },
      };
    else result = handle(host(), request);
  } catch {
    /* Never return keys, Drive contents, exception stacks, or Google authorization URLs. */
  } finally {
    if (lock.hasLock()) lock.releaseLock();
  }
  // ContentService's anonymous POST redirect intermittently returns 404. HtmlService
  // carries an inert encoded reply directly; only our server-side gateway decodes it.
  // The reply is never executed or rendered by the club frontend.
  const encoded = Utilities.base64EncodeWebSafe(
    JSON.stringify(result),
    Utilities.Charset.UTF_8,
  ).replace(/=+$/, '');
  return HtmlService.createHtmlOutput(
    '<!doctype html><meta charset="utf-8"><pre>ROWING_RESULT_BEGIN_' +
      encoded +
      '_ROWING_RESULT_END</pre>',
  );
}
