import { appendFileSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type Logger = (level: LogLevel, message: string, data?: Record<string, unknown>) => void;

/**
 * JSON-lines operational log. The audit trail lives in SQLite; this is for
 * "is the broker healthy". Never pass token values in `data`.
 */
export function createLogger(...writers: ((line: string) => void)[]): Logger {
  const sinks = writers.length > 0 ? writers : [(line: string) => console.log(line)];
  return (level, message, data) => {
    const line = JSON.stringify({ at: new Date().toISOString(), level, message, ...data });
    for (const write of sinks) write(line);
  };
}

export const silentLogger: Logger = () => {};

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Local calendar date (the machine's time zone), YYYY-MM-DD. */
export function localDate(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * A writer that appends to `<dir>/broker-YYYY-MM-DD.log` (one file per local
 * day) and deletes files older than `keepDays`. Used when the broker runs at
 * login with no console to read.
 */
export function createFileWriter(
  dir: string,
  options: { keepDays?: number; now?: () => Date } = {},
): (line: string) => void {
  const now = options.now ?? (() => new Date());
  mkdirSync(dir, { recursive: true });
  pruneLogs(dir, options.keepDays ?? 14, now());
  return (line) => {
    try {
      appendFileSync(path.join(dir, `broker-${localDate(now())}.log`), `${line}\n`, 'utf8');
    } catch {
      // A full disk or locked file must not take the broker down.
    }
  };
}

function pruneLogs(dir: string, keepDays: number, now: Date): void {
  const cutoff = now.getTime() - keepDays * 24 * 60 * 60_000;
  for (const name of readdirSync(dir)) {
    if (!/^broker-\d{4}-\d{2}-\d{2}\.log$/.test(name)) continue;
    const file = path.join(dir, name);
    try {
      if (statSync(file).mtimeMs < cutoff) rmSync(file);
    } catch {
      // Skip files we can't stat or remove.
    }
  }
}
