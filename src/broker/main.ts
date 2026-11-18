/**
 * agent-bus broker: the single Slack connection plus a local MCP endpoint
 * for Claude Code, Codex and Copilot sessions. Run with `npm run broker`.
 */
import path from 'node:path';
import { loadBrokerConfig, type BrokerConfig } from '../shared/config.ts';
import { startHttpServer, type RunningHttpServer } from './http.ts';
import { createLogger, errorMessage, type Logger } from './log.ts';
import { BusService } from './service.ts';
import { createWebSlackApi, type SlackApi } from './slack/api.ts';
import { createSlackConnection, type SlackConnection } from './slack/connection.ts';
import { ChannelDirectory } from './slack/directory.ts';
import { PostQueue } from './slack/queue.ts';
import { Store } from './store.ts';

export interface Broker {
  port: number;
  store: Store;
  queue: PostQueue;
  service: BusService;
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
  const service = new BusService(store, queue);
  const connection =
    deps.connection === undefined
      ? createSlackConnection({
          botToken: config.slack.botToken,
          appToken: config.slack.appToken,
          store,
          log,
        })
      : deps.connection;

  let http: RunningHttpServer | undefined;
  try {
    http = await startHttpServer({
      port: config.port,
      tokens: config.tokens,
      service,
      log,
      health: () => ({ slack: connection?.state ?? 'disabled' }),
    });
    await connection?.start();
  } catch (error) {
    await http?.close();
    store.close();
    throw error;
  }

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
  const log = createLogger();
  try {
    const broker = await startBroker(loadBrokerConfig(), { log });
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
    process.exit(1);
  }
}
