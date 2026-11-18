export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type Logger = (level: LogLevel, message: string, data?: Record<string, unknown>) => void;

/**
 * JSON-lines operational log (stdout). The audit trail lives in SQLite; this
 * is for "is the broker healthy". Never pass token values in `data`.
 */
export function createLogger(write: (line: string) => void = console.log): Logger {
  return (level, message, data) => {
    write(JSON.stringify({ at: new Date().toISOString(), level, message, ...data }));
  };
}

export const silentLogger: Logger = () => {};

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
