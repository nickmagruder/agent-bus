import { App, LogLevel, SocketModeReceiver } from '@slack/bolt';
import type { Logger } from '../log.ts';
import type { Store } from '../store.ts';

export type ConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'disconnected';

export interface SlackConnection {
  readonly state: ConnectionState;
  /** The Bolt app; Phase 2 registers message and action handlers on it. */
  readonly app: App;
  start(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * The broker's single Socket Mode connection. Slack sends each event to any
 * one of an app's connections, so there must only ever be one. The client
 * reconnects by itself (Socket Mode URLs refresh every few hours); state
 * changes go to the log and the audit trail.
 */
export function createSlackConnection(options: {
  botToken: string;
  appToken: string;
  store: Store;
  log: Logger;
}): SlackConnection {
  const logger = boltLogger(options.log);
  const receiver = new SocketModeReceiver({ appToken: options.appToken, logger });
  const app = new App({ token: options.botToken, receiver, logger });
  let state: ConnectionState = 'disconnected';

  const track = (next: ConnectionState) => () => {
    if (next === state) return;
    state = next;
    // Connecting (startup) and connected are normal; reconnects and drops are worth a look.
    const level = next === 'reconnecting' || next === 'disconnected' ? 'warn' : 'info';
    options.log(level, `Slack ${next}`);
    options.store.appendEvent({ kind: 'slack.connection', data: { state: next } });
  };
  receiver.client.on('connecting', track('connecting'));
  receiver.client.on('connected', track('connected'));
  receiver.client.on('reconnecting', track('reconnecting'));
  receiver.client.on('disconnected', track('disconnected'));

  return {
    get state() {
      return state;
    },
    app,
    async start() {
      await app.start();
    },
    async stop() {
      await app.stop();
    },
  };
}

/**
 * Routes Bolt's and the Socket Mode client's own messages into the broker
 * log (and so the log file), at warn and above.
 */
export function boltLogger(log: Logger) {
  let name = 'slack';
  const send =
    (level: 'warn' | 'error') =>
    (...parts: unknown[]) =>
      log(level, `${name}: ${parts.map(formatPart).join(' ')}`);
  return {
    debug: ignore,
    info: ignore,
    warn: send('warn'),
    error: send('error'),
    setLevel: () => undefined,
    getLevel: () => LogLevel.WARN,
    setName: (next: string) => {
      name = next;
    },
  };
}

function ignore(...parts: unknown[]): void {
  void parts;
}

function formatPart(part: unknown): string {
  if (part instanceof Error) return part.message;
  return typeof part === 'string' ? part : JSON.stringify(part);
}
