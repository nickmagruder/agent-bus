import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { silentLogger } from '../../src/broker/log.ts';
import { startBroker } from '../../src/broker/main.ts';
import { FakeSlack, TOKENS, USER_ID } from './fakes.ts';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'agent-bus-held-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const start = (slack: FakeSlack) =>
  startBroker(
    {
      port: 0,
      dataDir: dir,
      tokens: TOKENS,
      slack: { botToken: 'xoxb-test', appToken: 'xapp-test', userId: USER_ID },
    },
    {
      log: silentLogger,
      slackApi: slack,
      connection: null,
      queueOptions: { minIntervalMs: 0 },
      digest: null,
    },
  );

it('sends an approval DM held across a broker restart once its time is up, at start', async () => {
  const first = await start(new FakeSlack());
  first.service.hook('claude', {
    event: 'PermissionRequest',
    appSessionId: 'app-1',
    project: 'agent-bus',
    toolName: 'Bash',
    toolSummary: 'npm publish',
  });
  expect(first.service.flushHeldPings()).toBe(0); // still in its grace period
  await first.stop();

  // While the broker was down, the grace period ran out (but not by so much it's stale).
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path.join(dir, 'bus.db'));
  db.prepare('UPDATE held_pings SET due_at = ?').run(new Date(Date.now() - 1000).toISOString());
  db.close();

  const slack = new FakeSlack();
  const second = await start(slack);
  try {
    await second.queue.idle();
    const dm = slack.posts.find((post) => post.channel === `D_${USER_ID}`);
    expect(dm?.text).toContain('npm publish');
  } finally {
    await second.stop();
  }
});
