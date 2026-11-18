import type { ServerNotification } from '@modelcontextprotocol/sdk/types.js';

/** The parts of an MCP tool call's `extra` argument the heartbeat needs. */
export interface HeartbeatTarget {
  _meta?: { progressToken?: string | number } | undefined;
  sendNotification: (notification: ServerNotification) => Promise<void>;
}

/** Below every client's tool-call idle limit (Copilot: 180 s; Claude, Codex: 300 s). */
export const HEARTBEAT_MS = 60_000;

/**
 * Keeps a long tool call alive by sending a notification every `intervalMs`.
 *
 * Phase 0 showed Claude Code's 300 s limit is an idle timer that progress
 * notifications reset. Without a progress token, a log message is sent
 * instead. Returns a function that stops the heartbeat.
 */
export function startHeartbeat(
  extra: HeartbeatTarget,
  message: string,
  intervalMs = HEARTBEAT_MS,
): () => void {
  const started = Date.now();
  const progressToken = extra._meta?.progressToken;
  const timer = setInterval(() => {
    const elapsed = Math.round((Date.now() - started) / 1000);
    const notification: ServerNotification =
      progressToken === undefined
        ? {
            method: 'notifications/message',
            params: { level: 'info', data: `${message} (${elapsed}s)` },
          }
        : {
            method: 'notifications/progress',
            params: { progressToken, progress: elapsed, message },
          };
    extra.sendNotification(notification).catch(() => undefined);
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
