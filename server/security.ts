import { randomBytes, scrypt as derive, timingSafeEqual, createHmac } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, chmod } from 'node:fs/promises';
import { join } from 'node:path';

export type Role = 'admin' | 'team';
type Password = { salt: string; hash: string; version: string };
export type Credentials = {
  secret: string;
  admin: Password;
  team: Password;
  // Remember applied file values so a later online rotation is not undone by stale text.
  localKeys?: Partial<Record<Role, Password | null>>;
};
export type Session = { role: Role; version: string; expires: number; nonce: string };
export const randomKey = () => randomBytes(24).toString('base64url');
export function validKey(key: unknown): key is string {
  return typeof key === 'string' && key.length >= 8 && key.length <= 256;
}
async function hash(key: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    derive(key, salt, 64, { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 }, (error, result) =>
      error ? reject(error) : resolve(result),
    ),
  );
}
export async function password(key: string): Promise<Password> {
  if (!validKey(key)) throw new Error('Use an access key between 8 and 256 characters.');
  const salt = randomKey();
  return { salt, hash: (await hash(key, salt)).toString('hex'), version: randomKey() };
}
export async function matches(key: string, record: Password) {
  const expected = Buffer.from(record.hash, 'hex');
  const actual = await hash(key, record.salt);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
export async function atomicJson(directory: string, name: string, data: unknown) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const temporary = join(directory, `.${randomKey()}.tmp`);
  await writeFile(temporary, JSON.stringify(data), { mode: 0o600, flag: 'wx' });
  await rename(temporary, join(directory, name));
}
export async function readJson<T>(directory: string, name: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(join(directory, name), 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
export async function credentials(directory: string): Promise<Credentials> {
  const value = await readJson<Credentials>(directory, 'credentials.json');
  if (!value)
    throw new Error('Access keys are not configured. Run npm run access:init on the server.');
  return value;
}
// The lock also protects against a local CLI rotation racing an online rotation.
export async function credentialLock<T>(directory: string, task: () => Promise<T>): Promise<T> {
  const { open, unlink } = await import('node:fs/promises');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, 'credentials.lock');
  const lock = await open(path, 'wx', 0o600).catch(() => {
    throw new Error('Another access-key change is in progress. Try again shortly.');
  });
  try {
    return await task();
  } finally {
    await lock.close();
    await unlink(path);
  }
}
export async function initialize(directory: string, admin: string, team: string) {
  return credentialLock(directory, async () => {
    if (await readJson(directory, 'credentials.json'))
      throw new Error('Access keys already exist. Use access:rotate.');
    if (admin === team) throw new Error('Admin and team keys must be different.');
    const config: Credentials = {
      secret: randomKey(),
      admin: await password(admin),
      team: await password(team),
    };
    await atomicJson(directory, 'credentials.json', config);
  });
}
export function sign(value: string, secret: string) {
  return createHmac('sha256', secret).update(value).digest('base64url');
}
function equal(a: string, b: string) {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
export function issueSession(role: Role, config: Credentials) {
  const session: Session = {
    role,
    version: config[role].version,
    expires: Date.now() + (role === 'admin' ? 12 : 168) * 3600000,
    nonce: randomKey(),
  };
  const payload = Buffer.from(JSON.stringify(session)).toString('base64url');
  return { session, token: `${payload}.${sign(payload, config.secret)}` };
}
export function verifySession(token: string, config: Credentials): Session | null {
  if (token.length > 1500) return null;
  const [payload, signature, extra] = token.split('.');
  if (!payload || !signature || extra || !equal(signature, sign(payload, config.secret)))
    return null;
  try {
    const s = JSON.parse(Buffer.from(payload, 'base64url').toString()) as Session;
    if (
      (s.role !== 'admin' && s.role !== 'team') ||
      s.version !== config[s.role].version ||
      !Number.isFinite(s.expires) ||
      s.expires <= Date.now() ||
      typeof s.nonce !== 'string'
    )
      return null;
    return s;
  } catch {
    return null;
  }
}
export const csrfToken = (s: Session, c: Credentials) => sign(`csrf:${s.nonce}`, c.secret);
