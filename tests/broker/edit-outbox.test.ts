import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { silentLogger } from '../../src/broker/log.ts';
import { startBroker } from '../../src/broker/main.ts';
import { SlackSendError } from '../../src/broker/slack/api.ts';
import { FakeSlack, TOKENS, USER_ID } from './fakes.ts';

let dir: string;
let stopBroker: (() => Promise<void>) | undefined;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'agent-bus-edits-'));
});

afterEach(async () => {
  await stopBroker?.();
  stopBroker = undefined;
  await rm(dir, { recursive: true, force: true });
});

it('sends a DM outcome edit through the outbox, retrying a network failure (#105)', async () => {
  const slack = new FakeSlack();
  const broker = await startBroker(
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
      queueOptions: { minIntervalMs: 0, backoffMs: 1 },
      digest: null,
    },
  );
  stopBroker = () => broker.stop();
  const { session } = broker.service.register({
    platform: 'claude',
    purpose: 'Edits',
    project: 'clankers',
  });
  const question = broker.service.ask({
    platform: 'claude',
    session: session.id,
    question: 'Push or open a PR?',
    options: ['Push', 'Open a PR'],
    defaultAnswer: 'Open a PR',
  });
  await broker.queue.idle();
  const dm = broker.store.getPost(question.postId ?? -1);
  expect(dm?.state).toBe('sent');

  // The network drops just as I answer: the edit is queued and retried.
  slack.failures.push(new SlackSendError('network', 'fetch failed'));
  expect(broker.questions.answerByButton(question.id, 1, USER_ID)).toBe('answered');
  await vi.waitFor(() => {
    expect(slack.updates).toHaveLength(1);
  });
  expect(slack.updates[0]).toMatchObject({ channel: dm?.slackChannelId, ts: dm?.slackTs });
  expect(JSON.stringify(slack.updates[0]?.blocks)).toContain('Answered (button): *Open a PR*');
  expect(broker.store.countEvents({ kind: 'post.edited', since: new Date(0) })).toBe(1);
});
