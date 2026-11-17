import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

export type Logger = (kind: string, record: Record<string, unknown>) => Promise<void>;

/** Appends one JSON object per line, so logs from all platforms can be diffed and grepped. */
export function jsonlLogger(dir: string, file: string): Logger {
  return async (kind, record) => {
    await mkdir(dir, { recursive: true });
    const line = JSON.stringify({ ts: new Date().toISOString(), kind, ...record });
    await appendFile(path.join(dir, file), `${line}\n`, 'utf8');
  };
}
