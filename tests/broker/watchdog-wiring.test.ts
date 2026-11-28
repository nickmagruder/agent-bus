import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { App } from '@slack/bolt';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { silentLogger } from '../../src/broker/log.ts';
import { startBroker } from '../../src/broker/main.ts';
import type { ConnectionState, SlackConnection } from '../../src/broker/slack/connection.ts';
import { FakeSlack, TOKENS, USER_ID } from './fakes.ts';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'agent-bus-watchdog-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** A Socket Mode connection that never gets past `state`; handlers are accepted and ignored. */
function fakeConnection(state: ConnectionState): SlackConnection {
  const app = { action: () => undefined, event: () => undefined } as unknown as App;
  return {
    state,
    app,
    start: () => Promise.resolve(),
    stop: () => Promise.resolve(),
  };
}

const start = (connection: SlackConnection | null, onSlackStuck: () => void) =>
  startBroker(
    {
      port: 0,
      dataDir: dir,
      tokens: TOKENS,
      slack: { botToken: 'xoxb-test', appToken: 'xapp-test', userId: USER_ID },
    },
    {
      log: silentLogger,
      slackApi: new FakeSlack(),
      connection,
      queueOptions: { minIntervalMs: 0 },
      digest: null,
      onSlackStuck,
      watchdog: { tickMs: 10, stuckAfterMs: 30 },
    },
  );

it('asks the entry point to restart when Socket Mode stays off connected (#106)', async () => {
  const onStuck = vi.fn();
  const broker = await start(fakeConnection('reconnecting'), onStuck);
  await vi.waitFor(() => {
    expect(onStuck).toHaveBeenCalledTimes(1);
  });
  const [outage] = broker.store.db
    .prepare("SELECT data FROM events WHERE kind = 'slack.outage'")
    .all() as { data: string }[];
  expect(JSON.parse(outage?.data ?? '{}')).toMatchObject({ state: 'down' });
  await broker.stop();
});

it('stops the watchdog with the broker', async () => {
  const onStuck = vi.fn();
  const broker = await start(fakeConnection('reconnecting'), onStuck);
  await broker.stop();
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(onStuck).not.toHaveBeenCalled();
});

it('leaves a connected broker alone', async () => {
  const onStuck = vi.fn();
  const broker = await start(fakeConnection('connected'), onStuck);
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(onStuck).not.toHaveBeenCalled();
  await broker.stop();
});

it('runs no watchdog without a Slack connection', async () => {
  const onStuck = vi.fn();
  const broker = await start(null, onStuck);
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(onStuck).not.toHaveBeenCalled();
  await broker.stop();
});
