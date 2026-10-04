import { useEffect, useState } from 'react';
import type { FileKind } from '../domain/validation';
import { api, apiUrl, cached, remember, accessGeneration } from './api';
export type SourceFiles = Partial<Record<FileKind, File>>;
export type RestoredFile = { file: File; kinds: FileKind[] };
interface SavedInputs {
  savedAt: string;
  files: { name: string; base64: string; kinds: FileKind[] }[];
}
type InputMetadata = { savedAt: string; files: Omit<SavedInputs['files'][number], 'base64'>[] };
const encodedFiles = new WeakMap<File, Promise<string>>();
const signature = async (files: SavedInputs['files']) => {
  const canonical = files
    .map((f) => ({ name: f.name, kinds: [...f.kinds].sort(), base64: f.base64 }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify(canonical)),
  );
  return Array.from(new Uint8Array(digest), (v) => v.toString(16).padStart(2, '0')).join('');
};
async function rememberInputs(value: SavedInputs, epoch: number) {
  const hash = await signature(value.files);
  if (epoch === accessGeneration()) {
    remember('saved-inputs', { hash, savedAt: value.savedAt });
    remember('inputs?metadata=1', {
      savedAt: value.savedAt,
      files: value.files.map(({ name, kinds }) => ({ name, kinds })),
    });
  }
}
export async function saveInputs(files: SourceFiles, force = false) {
  const epoch = accessGeneration();
  if (!files.members || !files.attendance || !files.availability)
    throw new Error('Upload all three Excel inputs before saving.');
  const unique = [...new Set(Object.values(files))];
  const payload = await Promise.all(
    unique.map(async (file) => ({
      name: file.name,
      kinds: Object.entries(files)
        .filter(([, f]) => f === file)
        .map(([kind]) => kind),
      base64: await (() => {
        if (encodedFiles.has(file)) return encodedFiles.get(file)!;
        const task = new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onerror = () => reject(new Error('Could not read your Excel file.'));
          reader.onload = () => resolve(String(reader.result).split(',')[1]);
          reader.readAsDataURL(file);
        });
        encodedFiles.set(file, task);
        void task.catch(() => encodedFiles.delete(file));
        return task;
      })(),
    })),
  );
  const hash = await signature(payload as SavedInputs['files']);
  const previous = cached<{ hash: string; savedAt: string }>('saved-inputs');
  if (epoch !== accessGeneration()) throw new Error('The access session changed.');
  if (
    !force &&
    previous?.hash === hash &&
    previous.savedAt === cached<InputMetadata>('inputs?metadata=1')?.savedAt
  )
    return { savedAt: previous.savedAt };
  const result = await api<{ savedAt: string }>('inputs', 'PUT', { files: payload });
  await rememberInputs({ ...result, files: payload as SavedInputs['files'] }, epoch);
  return result;
}
export function PrivateFiles({
  sources,
  changed,
  disabled,
  onRestore,
}: {
  sources: SourceFiles;
  changed: number;
  disabled: boolean;
  onRestore: (files: RestoredFile[]) => void;
}) {
  const [saved, setSaved] = useState<InputMetadata | null>(
      () => cached<InputMetadata | null>('inputs?metadata=1') ?? null,
    ),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!open) return;
    let active = true;
    const recent = cached<InputMetadata | null>('inputs?metadata=1');
    if (recent !== undefined) setSaved(recent);
    setLoading(true);
    void api<InputMetadata | null>('inputs?metadata=1')
      .then((value) => {
        if (active) {
          setSaved(value);
          setError('');
        }
      })
      .catch((e) => {
        if (active) setError(e.message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [changed, open]);
  return (
    <details className="private-files" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>Private Excel files · admin only</summary>
      <p>
        Planning saves your current files privately. You can also save them here before planning.
      </p>
      <div className="button-row">
        <button
          disabled={
            busy || disabled || !sources.members || !sources.attendance || !sources.availability
          }
          onClick={async () => {
            setBusy(true);
            setError('');
            try {
              await saveInputs(sources, true);
              setSaved(cached<InputMetadata>('inputs?metadata=1') ?? null);
            } catch (error) {
              setError((error as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? 'Saving…' : 'Save Excel files'}
        </button>
        {saved && (
          <button
            disabled={disabled || busy || loading}
            onClick={async () => {
              setBusy(true);
              setError('');
              const epoch = accessGeneration();
              try {
                const current = await api<SavedInputs | null>('inputs');
                if (!current) throw new Error('No saved Excel files are available.');
                await rememberInputs(current, epoch);
                onRestore(
                  current.files.map((entry) => {
                    const bytes = Uint8Array.from(atob(entry.base64), (c) => c.charCodeAt(0));
                    return {
                      file: new File([bytes], entry.name, {
                        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                      }),
                      kinds: entry.kinds,
                    };
                  }),
                );
              } catch (error) {
                setError((error as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            Load saved files
          </button>
        )}
      </div>
      {loading && <p role="status">Checking saved files…</p>}
      {saved && (
        <>
          <p className="tiny">
            Saved{' '}
            {new Intl.DateTimeFormat('en-US', {
              timeZone: 'America/New_York',
              dateStyle: 'medium',
              timeStyle: 'short',
            }).format(new Date(saved.savedAt))}{' '}
            ET
          </p>
          <ul>
            {saved.files.map((f, i) => (
              <li key={i}>
                <a href={apiUrl(`inputs/${i}`)}>{f.name} ↓</a>
              </li>
            ))}
          </ul>
        </>
      )}
      {error && (
        <p role="alert" className="notice warning">
          {error}
        </p>
      )}
    </details>
  );
}
