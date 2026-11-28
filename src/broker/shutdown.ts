import { errorMessage, type Logger } from './log.ts';

/** How long a shutdown may take before the process exits regardless. */
export const SHUTDOWN_TIMEOUT_MS = 15_000;

export interface ShutdownOptions {
  /** Stops the broker (HTTP, timers, queue, Slack, store). */
  stop: () => Promise<void>;
  exit: (code: number) => void;
  /** Sets the code Node exits with if the event loop empties first (`process.exitCode`). */
  setExitCode: (code: number) => void;
  log: Logger;
  timeoutMs?: number;
}

/**
 * The broker's one way out. Exit 0 stops the login launcher
 * (`scripts/run-broker.ps1`); 1 makes it restart the broker. Only the first
 * call counts. Every path out exits with the code asked for (1 if stopping
 * failed), even when stopping never finishes: the forced exit keeps the
 * process alive until it fires, and the exit code is set up front in case
 * the event loop empties first (#106: a stuck Socket Mode client).
 */
export function makeShutdown(options: ShutdownOptions): (reason: string, code?: 0 | 1) => void {
  let stopping = false;
  return (reason, code = 0) => {
    if (stopping) return;
    stopping = true;
    options.setExitCode(code);
    options.log('info', 'shutting down', { reason });
    const timer = setTimeout(() => {
      options.log('warn', 'shutdown timed out; exiting anyway', { reason });
      options.exit(code);
    }, options.timeoutMs ?? SHUTDOWN_TIMEOUT_MS);
    options.stop().then(
      () => {
        clearTimeout(timer);
        options.exit(code);
      },
      (error: unknown) => {
        clearTimeout(timer);
        options.log('error', 'shutdown failed', { error: errorMessage(error) });
        options.exit(1);
      },
    );
  };
}
