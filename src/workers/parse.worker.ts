import { parseUploads } from '../importers/friendly';
import type { FileKind } from '../domain/validation';
import type { InputSource } from '../importers/spreadsheet';
self.onmessage = (
  e: MessageEvent<{
    texts: Record<FileKind, string>;
    sources: Partial<Record<FileKind, InputSource>>;
  }>,
) => {
  try {
    const result = parseUploads(e.data.texts, e.data.sources);
    self.postMessage(result);
  } catch (error) {
    self.postMessage({ error: (error as Error).message });
  }
};
