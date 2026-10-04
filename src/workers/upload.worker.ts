import { normalizeSelectedUploads } from '../importers/uploadBatch';
import type { UploadBatch } from '../importers/uploadBatch';
import type { FileKind } from '../domain/validation';
self.onmessage = async (
  event: MessageEvent<{ files: File[]; restored?: { file: File; kinds: FileKind[] }[] }>,
) => {
  try {
    if (event.data.restored) {
      const inputs: UploadBatch = {};
      for (const entry of event.data.restored) {
        const detected = await normalizeSelectedUploads([entry.file]);
        for (const kind of entry.kinds) {
          if (!detected[kind])
            throw new Error('A saved table is missing. Upload fresh Excel files.');
          inputs[kind] = detected[kind];
        }
      }
      self.postMessage({ inputs });
      return;
    }
    self.postMessage({ inputs: await normalizeSelectedUploads(event.data.files) });
  } catch (error) {
    self.postMessage({ error: (error as Error).message });
  }
};
