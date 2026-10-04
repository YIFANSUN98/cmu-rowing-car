import type { FileKind } from '../domain/validation';
import { inputKinds, inputLabels } from '../importers/friendlySchema';

export type UploadChange = 'added' | 'updated' | 'unchanged';

const changeLabels: Record<UploadChange, string> = {
  added: 'Added',
  updated: 'Updated',
  unchanged: 'No changes',
};

export function UploadStatus({
  files,
  changes,
}: {
  files: Record<FileKind, string>;
  changes: Partial<Record<FileKind, UploadChange>>;
}) {
  const loaded = inputKinds.filter((kind) => files[kind]).length;
  const announcement = inputKinds
    .filter((kind) => changes[kind])
    .map((kind) => `${inputLabels[kind]}: ${changeLabels[changes[kind]!]}.`)
    .join(' ');

  return (
    <div className="upload-overview">
      <div className="upload-progress-heading">
        <b>Your weekly files</b>
        <span>
          <strong>{loaded}</strong> / 3 sheets loaded
        </span>
      </div>
      <div
        className="upload-progress"
        role="progressbar"
        aria-label="Sheets loaded"
        aria-valuemin={0}
        aria-valuemax={3}
        aria-valuenow={loaded}
        aria-valuetext={`${loaded} of 3 sheets loaded`}
      >
        {inputKinds.map((kind) => (
          <span
            key={kind}
            className={files[kind] ? (changes[kind] === 'updated' ? 'updated' : 'complete') : ''}
          />
        ))}
      </div>
      <div className="upload-status" role="list" aria-label="Detected files">
        {inputKinds.map((kind) => {
          const change = changes[kind];
          const state = files[kind] ? (change ? changeLabels[change] : 'Loaded') : 'Waiting';
          return (
            <div
              key={kind}
              role="listitem"
              className={`${files[kind] ? 'loaded' : 'waiting'} ${change ?? ''}`}
            >
              <div className="upload-file-heading">
                <span className="upload-file-icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
                    {change === 'updated' ? (
                      <>
                        <path d="M19 9a7 7 0 1 0 0 6" />
                        <path d="M19 4v5h-5" />
                      </>
                    ) : files[kind] ? (
                      <path d="m5 12 4 4L19 6" />
                    ) : (
                      <>
                        <path d="M13 3H6v18h12V8l-5-5Z" />
                        <path d="M13 3v5h5M9 13h6M9 17h6" />
                      </>
                    )}
                  </svg>
                </span>
                <b>{inputLabels[kind]}</b>
                <span className="upload-file-badge">{state}</span>
              </div>
              <span className="upload-file-name" title={files[kind]}>
                {files[kind] || 'No file selected'}
              </span>
            </div>
          );
        })}
      </div>
      <div className="sr-only" role="status" aria-atomic="true">
        {announcement}
      </div>
    </div>
  );
}
