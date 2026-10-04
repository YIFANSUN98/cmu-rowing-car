import { chmod, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  atomicJson,
  credentialLock,
  credentials,
  matches,
  password,
  randomKey,
  sign,
  validKey,
  type Credentials,
  type Role,
} from './security.ts';

export const LOCAL_KEYS_FILE = 'access-keys.txt';
const roles: Role[] = ['admin', 'team'];
type LocalKeys = Record<Role, string>;

export async function createLocalKeyFile(directory: string, keys: LocalKeys) {
  const file = join(directory, LOCAL_KEYS_FILE);
  await writeFile(
    file,
    '# CMU Rowing login keys — private, never publish this file.\n' +
      '# Edit either value and save. The next website request applies the change.\n' +
      '# Use different keys of 8–256 characters. Blank means keep the current key.\n' +
      '# After an online key change, unchanged values here are ignored.\n\n' +
      `Admin: ${keys.admin}\nTeam: ${keys.team}\n`,
    { mode: 0o600, flag: 'wx' },
  );
  return file;
}

async function readLocalKeys(directory: string): Promise<LocalKeys | null> {
  let text: string;
  const path = join(directory, LOCAL_KEYS_FILE);
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(`Cannot read ${LOCAL_KEYS_FILE}. Check its permissions.`);
  }
  if (Buffer.byteLength(text) > 4096)
    throw new Error(`${LOCAL_KEYS_FILE} must be smaller than 4 KiB.`);
  const keys: Partial<LocalKeys> = {};
  for (const raw of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const field = /^(Admin|Team):\s*(.*)$/i.exec(line);
    if (!field) throw new Error(`Use only Admin: and Team: lines in ${LOCAL_KEYS_FILE}.`);
    const role = field[1].toLowerCase() as Role;
    if (role in keys) throw new Error(`${LOCAL_KEYS_FILE} has a duplicate ${role} line.`);
    keys[role] = field[2].trim();
    if (keys[role] && !validKey(keys[role]))
      throw new Error(`The ${role} key in ${LOCAL_KEYS_FILE} must have 8–256 characters.`);
  }
  if (!roles.every((role) => role in keys))
    throw new Error(`${LOCAL_KEYS_FILE} needs both Admin: and Team: lines; either can be blank.`);
  // Editors can replace a file with broader permissions when saving.
  await chmod(path, 0o600);
  return keys as LocalKeys;
}

async function editedRoles(config: Credentials, keys: LocalKeys) {
  const edited: Role[] = [];
  for (const role of roles) {
    const applied = config.localKeys?.[role];
    if (keys[role] ? !applied || !(await matches(keys[role], applied)) : applied !== null)
      edited.push(role);
  }
  return edited;
}

// Caller holds the credentials lock. Validation completes before any credential is replaced.
async function apply(directory: string) {
  const config = await credentials(directory),
    keys = await readLocalKeys(directory);
  if (!keys) return { config, keys, changed: [] as Role[] };
  const edited = await editedRoles(config, keys);
  if (!edited.length) return { config, keys, changed: [] as Role[] };
  const replacements = edited.filter((role) => keys[role]);
  const both = replacements.length === 2;
  if (
    (both && keys.admin === keys.team) ||
    (!both &&
      replacements.length === 1 &&
      (await matches(
        keys[replacements[0]],
        config[replacements[0] === 'admin' ? 'team' : 'admin'],
      )))
  )
    throw new Error('Admin and team keys must be different. Neither key was changed.');
  const changed: Role[] = [];
  for (const role of replacements) {
    if (!(await matches(keys[role], config[role]))) {
      config[role] = await password(keys[role]);
      changed.push(role);
    }
  }
  config.localKeys = { ...config.localKeys };
  // Persist only slow salted hashes, never a fast digest that could bypass scrypt.
  for (const role of edited) config.localKeys[role] = keys[role] ? config[role] : null;
  await atomicJson(directory, 'credentials.json', config);
  return { config, keys, changed };
}

export async function applyLocalKeys(directory: string) {
  return credentialLock(directory, () => apply(directory));
}

const pending = new Map<string, Promise<Credentials>>();
const warnings = new Map<string, string>();
const seen = new Map<string, string>();
const cacheSecret = randomKey();
// This fast cache is ephemeral. Its secret and digests are never stored on disk.
const stamp = (config: Credentials, keys: LocalKeys | null) =>
  sign(JSON.stringify([config.localKeys, keys]), cacheSecret);

// Read on requests rather than watching inodes: ordinary saves and atomic editor saves work.
// A malformed or half-written file leaves the last valid keys in service.
export async function activeCredentials(directory: string): Promise<Credentials> {
  const path = resolve(directory);
  const previous = pending.get(path);
  if (previous) return previous;
  const work = (async () => {
    const config = await credentials(path);
    try {
      const keys = await readLocalKeys(path);
      let current = config;
      if (keys && seen.get(path) !== stamp(config, keys)) {
        const applied = await applyLocalKeys(path);
        current = applied.config;
        seen.set(path, stamp(current, applied.keys));
      } else if (!keys) seen.delete(path);
      warnings.delete(path);
      return current;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Cannot apply local keys.';
      if (warnings.get(path) !== message) {
        console.error(
          `Local access keys were not applied: ${message} Existing keys remain active.`,
        );
        warnings.set(path, message);
      }
      return credentials(path);
    }
  })();
  pending.set(path, work);
  try {
    return await work;
  } finally {
    if (pending.get(path) === work) pending.delete(path);
  }
}
