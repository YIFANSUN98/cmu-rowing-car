import { resolve, join } from 'node:path';
import { writeFile, unlink } from 'node:fs/promises';
import {
  credentials,
  credentialLock,
  initialize,
  password,
  randomKey,
  atomicJson,
  type Role,
} from './security.ts';
import {
  activeCredentials,
  applyLocalKeys,
  createLocalKeyFile,
  LOCAL_KEYS_FILE,
} from './local-keys.ts';
const directory = resolve(process.env.PRIVATE_DATA_DIR ?? 'data/private/server');
const [command, role] = process.argv.slice(2);
try {
  if (command === 'init') {
    const admin = randomKey(),
      team = randomKey();
    await initialize(directory, admin, team);
    const file = await createLocalKeyFile(directory, { admin, team });
    await applyLocalKeys(directory);
    console.log(`Access configured. Open the private key file: ${file}`);
  } else if (command === 'apply') {
    const { changed } = await applyLocalKeys(directory);
    console.log(
      changed.length
        ? `Applied local ${changed.join(' and ')} keys and revoked their sessions.`
        : `No access keys changed. Edit ${join(directory, LOCAL_KEYS_FILE)} and save.`,
    );
  } else if (command === 'rotate' && (role === 'admin' || role === 'team')) {
    // Generate a strong key locally; never pass passwords through command arguments or logs.
    const key = randomKey(),
      file = join(directory, `${role}-replacement-key.txt`);
    await activeCredentials(directory);
    await credentialLock(directory, async () => {
      const config = await credentials(directory);
      await writeFile(
        file,
        `New ${role} key: ${key}\n\nStore this in your password manager, then delete this file.\n`,
        { mode: 0o600 },
      );
      config[role as Role] = await password(key);
      await atomicJson(directory, 'credentials.json', config);
    });
    // The initial file may contain revoked keys. Never present it as current after rotation.
    await unlink(join(directory, 'initial-access-keys.txt')).catch(() => {});
    console.log(`Changed the ${role} key and revoked its sessions. Open: ${file}`);
  } else
    throw new Error(
      'Use npm run access:init, npm run access:apply, or npm run access:rotate -- admin|team.',
    );
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
}
