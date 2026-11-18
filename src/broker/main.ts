/**
 * agent-bus broker: the single Slack connection plus a local MCP endpoint
 * for Claude Code, Codex and Copilot sessions. Run with `npm run broker`.
 */
import path from 'node:path';
import { defaultDataDir, loadBrokerConfig, type BrokerConfig } from '../shared/config.ts';
import { startHttpServer, type RunningHttpServer } from './http.ts';
import { Inbox } from './inbox.ts';
import { createFileWriter, createLogger, errorMessage, type Logger } from './log.ts';
import { BusService } from './service.ts';
import { createWebSlackApi, type SlackApi } from './slack/api.ts';
import { createSlackConnection, type SlackConnection } from './slack/connection.ts';
import { ChannelDirectory } from './slack/directory.ts';
import { registerInbound } from './slack/inbound.ts';
import { PostQueue } from './slack/queue.ts';
import { Store } from './store.ts';

/**
 * Exit code for problems a restart can't fix (invalid environment, port
 * already taken); `scripts/run-broker.ps1` stops retrying on it. Other
 * failures exit 1 and are retried.
 */
export const EXIT_CONFIG = 78;

export class PortInUseError extends Error {
  constructor(port: number) {
    super(
      `Port ${port} is in use: is the broker already running (login task or another terminal)?`,
    );
    this.name = 'PortInUseError';
  }
}

export interface Broker {
  port: number;
  store: Store;
  queue: PostQueue;
  service: BusService;
  inbox: Inbox;
  stop: () => Promise<void>;
}

export interface BrokerDeps {
  log?: Logger;
  /** Replaced by a fake in tests. */
  slackApi?: SlackApi;
  /** `null` skips the Socket Mode connection (tests). */
  connection?: SlackConnection | null;
  queueOptions?: Partial<ConstructorParameters<typeof PostQueue>[3]>;
}

export async function startBroker(config: BrokerConfig, deps: BrokerDeps = {}): Promise<Broker> {
  const log = deps.log ?? createLogger();
  const store = new Store(path.join(config.dataDir, 'bus.db'));
  const slackApi = deps.slackApi ?? createWebSlackApi(config.slack.botToken);
  const directory = new ChannelDirectory(slackApi, config.slack.userId);
  const queue = new PostQueue(store, slackApi, directory, { log, ...deps.queueOptions });
  const service = new BusService(store, queue, undefined, directory);
  const inbox = new Inbox({
    store,
    queue,
    humanUserId: config.slack.userId,
    reactions: {
      add(channel, ts, name) {
        slackApi.addReaction(channel, ts, name).catch((error: unknown) => {
          log('warn', 'could not add a Slack reaction', { name, error: errorMessage(error) });
        });
      },
    },
  });
  const connection =
    deps.connection === undefined
      ? createSlackConnection({
          botToken: config.slack.botToken,
          appToken: config.slack.appToken,
          store,
          log,
        })
      : deps.connection;
  if (connection) registerInbound(connection.app, inbox, log);

  let http: RunningHttpServer | undefined;
  try {
    http = await startHttpServer({
      port: config.port,
      tokens: config.tokens,
      service,
      inbox,
      log,
      health: () => ({ slack: connection?.state ?? 'disabled' }),
    });
    await connection?.start();
  } catch (error) {
    await http?.close();
    store.close();
    if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE')
      throw new PortInUseError(config.port);
    throw error;
  }

  // Lets new sessions pick #agents up front when their project has no channel.
  directory.refresh().catch((error: unknown) => {
    log('warn', 'could not load the Slack channel list', { error: errorMessage(error) });
  });

  store.appendEvent({ kind: 'broker.started', data: { port: http.port } });
  // Posts queued before a restart go out now.
  queue.kick();
  log('info', 'agent-bus broker listening', { url: `http://127.0.0.1:${http.port}/mcp` });

  const server = http;
  return {
    port: server.port,
    store,
    queue,
    service,
    inbox,
    async stop() {
      await server.close();
      await queue.stop();
      await connection?.stop();
      store.appendEvent({ kind: 'broker.stopped' });
      store.close();
    },
  };
}

if (import.meta.main) {
  // --log-to-file: also write daily files under <data dir>/logs (used by the login task).
  const toFile = process.argv.includes('--log-to-file');
  // Set up before validating the environment, so a bad config is logged too.
  const dataDir = process.env.AGENT_BUS_DATA_DIR ?? defaultDataDir(process.env.LOCALAPPDATA);
  const log = toFile
    ? createLogger((line) => console.log(line), createFileWriter(path.join(dataDir, 'logs')))
    : createLogger();
  let config: BrokerConfig;
  try {
    config = loadBrokerConfig();
  } catch (error) {
    log('error', 'broker failed to start', { error: errorMessage(error) });
    process.exit(EXIT_CONFIG);
  }
  try {
    // Crash loudly: the login launcher restarts the broker after a failed exit.
    process.on('uncaughtException', (error) => {
      log('error', 'uncaught exception', { error: errorMessage(error) });
      process.exit(1);
    });
    process.on('unhandledRejection', (reason) => {
      log('error', 'unhandled rejection', { error: errorMessage(reason) });
      process.exit(1);
    });
    const broker = await startBroker(config, { log });
    const shutdown = (signal: string) => {
      log('info', 'shutting down', { signal });
      broker.stop().then(
        () => process.exit(0),
        (error: unknown) => {
          log('error', 'shutdown failed', { error: errorMessage(error) });
          process.exit(1);
        },
      );
    };
    process.once('SIGINT', () => shutdown('SIGINT'));
    process.once('SIGTERM', () => shutdown('SIGTERM'));
  } catch (error) {
    log('error', 'broker failed to start', { error: errorMessage(error) });
    // Another broker already has the port: restarting won't help.
    process.exit(error instanceof PortInUseError ? EXIT_CONFIG : 1);
  }
}
