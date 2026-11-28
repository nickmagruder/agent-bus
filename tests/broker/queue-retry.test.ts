import { WebAPIHTTPError, WebAPIRequestError } from '@slack/web-api';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { silentLogger } from '../../src/broker/log.ts';
import { classifySlackError, SlackSendError } from '../../src/broker/slack/api.ts';
import { ChannelDirectory } from '../../src/broker/slack/directory.ts';
import { PostQueue, QUEUE_RETRY } from '../../src/broker/slack/queue.ts';
import { DM_TARGET, Store } from '../../src/broker/store.ts';
import { FakeSlack, USER_ID } from './fakes.ts';

let store: Store;
let slack: FakeSlack;
let clock: number;
let sleeps: number[];

beforeEach(() => {
  clock = Date.parse('2026-11-27T19:00:00Z');
  store = new Store(':memory:', { now: () => new Date(clock) });
  slack = new FakeSlack();
  sleeps = [];
});

afterEach(() => store.close());

function makeQueue(
  sleep: (ms: number, signal: AbortSignal) => Promise<void> = async (ms) => {
    sleeps.push(ms);
    clock += ms;
  },
): PostQueue {
  return new PostQueue(store, slack, new ChannelDirectory(slack, USER_ID, () => clock), {
    log: silentLogger,
    now: () => clock,
    sleep,
    minIntervalMs: 0,
  });
}

const network = () => new SlackSendError('network', 'fetch failed');

describe('retries through a network outage (#105)', () => {
  it('classifies a call Slack never answered as a network failure', () => {
    expect(classifySlackError(new WebAPIRequestError(new Error('fetch failed'))).kind).toBe(
      'network',
    );
    expect(classifySlackError(new WebAPIHTTPError(503, 'Unavailable', {})).kind).toBe('network');
    expect(classifySlackError(new WebAPIHTTPError(400, 'Bad Request', {})).kind).toBe('transient');
    // A bug or store error isn't the network: a few tries, not a day.
    expect(classifySlackError(new Error('SQLITE_BUSY')).kind).toBe('transient');
  });

  it('keeps a post through a long outage and sends it once Slack is back', async () => {
    const queue = makeQueue();
    // About 2 hours of failures: far past the old 5 tries.
    for (let i = 0; i < 30; i += 1) slack.failures.push(network());
    const post = store.enqueue({ target: 'agents', text: 'reminder' });
    store.enqueue({ target: 'agents', text: 'next' });
    queue.kick();
    await queue.idle();
    expect(store.getPost(post.id)).toMatchObject({ state: 'sent', attempts: 31 });
    expect(slack.posts.map((p) => p.text)).toEqual(['reminder', 'next']);
    // Backoff doubles from 1 s and stops at 5 minutes.
    expect(sleeps.slice(0, 4)).toEqual([1000, 2000, 4000, 8000]);
    expect(Math.max(...sleeps)).toBe(QUEUE_RETRY.maxBackoffMs);
    expect(sleeps.filter((ms) => ms === QUEUE_RETRY.maxBackoffMs).length).toBeGreaterThan(10);
    expect(store.countEvents({ kind: 'post.failed', since: new Date(0) })).toBe(0);
  });

  it('gives up on a post still failing a day after it was queued', async () => {
    const queue = makeQueue();
    const failures = Math.ceil(QUEUE_RETRY.maxAgeMs / QUEUE_RETRY.maxBackoffMs) + 20;
    for (let i = 0; i < failures; i += 1) slack.failures.push(network());
    const post = store.enqueue({ target: 'agents', text: 'stale' });
    queue.kick();
    await queue.idle();
    expect(store.getPost(post.id)).toMatchObject({ state: 'failed', lastError: 'fetch failed' });
    expect(sleeps.reduce((sum, ms) => sum + ms, 0)).toBeGreaterThanOrEqual(QUEUE_RETRY.maxAgeMs);
    expect(store.countEvents({ kind: 'post.failed', since: new Date(0) })).toBe(1);
  });

  it('still gives up after 5 tries when Slack itself keeps answering with an error', async () => {
    const queue = makeQueue();
    for (let i = 0; i < 10; i += 1)
      slack.failures.push(new SlackSendError('transient', 'internal_error'));
    const post = store.enqueue({ target: 'agents', text: 'x' });
    queue.kick();
    await queue.idle();
    expect(store.getPost(post.id)).toMatchObject({ state: 'failed', attempts: 5 });
  });

  it('still fails a permanent error at once', async () => {
    const queue = makeQueue();
    slack.failures.push(new SlackSendError('permanent', 'channel_not_found'));
    const post = store.enqueue({ target: 'agents', text: 'x' });
    queue.kick();
    await queue.idle();
    expect(store.getPost(post.id)).toMatchObject({ state: 'failed', attempts: 1 });
  });

  it('wakes a lane backing off as soon as another lane gets through', async () => {
    let backingOff: (() => void) | undefined;
    const queue = makeQueue(async (ms, signal) => {
      sleeps.push(ms);
      // Hold the backoff until something wakes it (the test never advances it).
      await new Promise<void>((resolve) => {
        backingOff = resolve;
        signal.addEventListener('abort', () => resolve(), { once: true });
      });
    });
    slack.failures.push(network());
    store.enqueue({ target: 'agents', text: 'held back' });
    queue.kick();
    await vi.waitFor(() => {
      expect(backingOff).toBeDefined();
    });
    store.enqueue({ target: DM_TARGET, text: 'got through' });
    queue.kick();
    await queue.idle();
    expect(slack.posts.map((p) => p.text)).toEqual(['got through', 'held back']);
  });
});

describe('edits through the outbox (#105, #97)', () => {
  it('edits a sent message, and keeps the channel and ts on the original', async () => {
    const queue = makeQueue();
    const post = store.enqueue({ target: DM_TARGET, text: 'Approve?' });
    queue.kick();
    await queue.idle();
    const sent = store.getPost(post.id);
    const edit = store.enqueueEdit({
      channel: sent?.slackChannelId ?? '',
      ts: sent?.slackTs ?? '',
      text: 'Approved',
      blocks: [{ type: 'section' }],
    });
    queue.kick();
    await queue.idle();
    expect(slack.updates).toEqual([
      {
        channel: sent?.slackChannelId,
        ts: sent?.slackTs,
        text: 'Approved',
        blocks: [{ type: 'section' }],
      },
    ]);
    expect(store.getPost(edit.id)).toMatchObject({
      state: 'sent',
      slackChannelId: null,
      slackTs: null,
    });
    expect(store.countEvents({ kind: 'post.edited', since: new Date(0) })).toBe(1);
  });

  it('retries an edit through a network outage', async () => {
    const queue = makeQueue();
    for (let i = 0; i < 12; i += 1) slack.failures.push(network());
    const edit = store.enqueueEdit({ channel: 'D1', ts: '1.1', text: 'Expired', blocks: null });
    queue.kick();
    await queue.idle();
    expect(store.getPost(edit.id)).toMatchObject({ state: 'sent', attempts: 13 });
    expect(slack.updates.map((u) => u.text)).toEqual(['Expired']);
  });

  it('fails an edit Slack refuses for good', async () => {
    const queue = makeQueue();
    slack.failures.push(new SlackSendError('permanent', 'message_not_found'));
    const edit = store.enqueueEdit({ channel: 'D1', ts: '1.1', text: 'x', blocks: null });
    queue.kick();
    await queue.idle();
    expect(store.getPost(edit.id)).toMatchObject({
      state: 'failed',
      lastError: 'message_not_found',
    });
    expect(classifySlackError(new SlackSendError('permanent', 'cant_update_message')).kind).toBe(
      'permanent',
    );
  });

  it('keeps only the newest queued edit of a message', async () => {
    const first = store.enqueueEdit({ channel: 'D1', ts: '1.1', text: 'Released', blocks: null });
    const second = store.enqueueEdit({ channel: 'D1', ts: '1.1', text: 'Canceled', blocks: null });
    const other = store.enqueueEdit({ channel: 'D1', ts: '2.2', text: 'Other', blocks: null });
    expect(second.id).toBe(first.id);
    expect(other.id).not.toBe(first.id);
    const queue = makeQueue();
    queue.kick();
    await queue.idle();
    expect(slack.updates.map((u) => [u.ts, u.text])).toEqual([
      ['1.1', 'Canceled'],
      ['2.2', 'Other'],
    ]);
  });

  it('drops an edit whose change rolled back (#97)', () => {
    expect(() => {
      store.transaction(() => {
        store.enqueueEdit({ channel: 'D1', ts: '1.1', text: 'Approved', blocks: null });
        throw new Error('the change failed');
      });
    }).toThrow('the change failed');
    expect(store.queuedTargets()).toEqual([]);
  });

  it('sends edits queued before a restart', async () => {
    store.enqueueEdit({ channel: 'D1', ts: '1.1', text: 'Expired', blocks: null });
    const queue = makeQueue();
    queue.kick();
    await queue.idle();
    expect(slack.updates.map((u) => u.text)).toEqual(['Expired']);
  });
});

describe('review cases (PR 110)', () => {
  it('lets a Slack error after a long outage still have its own tries', async () => {
    const queue = makeQueue();
    for (let i = 0; i < 6; i += 1) slack.failures.push(network());
    slack.failures.push(new SlackSendError('transient', 'internal_error'));
    const post = store.enqueue({ target: 'agents', text: 'x' });
    queue.kick();
    await queue.idle();
    expect(store.getPost(post.id)).toMatchObject({ state: 'sent', attempts: 8 });
  });

  it('sends a newer edit that arrives while an older one is being sent', async () => {
    let first = true;
    const send = slack.updateMessage.bind(slack);
    slack.updateMessage = async (channel, ts, text, blocks) => {
      if (first) {
        first = false;
        store.enqueueEdit({ channel, ts, text: 'NEW', blocks: null });
      }
      await send(channel, ts, text, blocks);
    };
    const edit = store.enqueueEdit({ channel: 'D1', ts: '1.1', text: 'OLD', blocks: null });
    const queue = makeQueue();
    queue.kick();
    await queue.idle();
    expect(slack.updates.map((u) => u.text)).toEqual(['OLD', 'NEW']);
    expect(store.getPost(edit.id)).toMatchObject({ state: 'sent', text: 'NEW' });
    expect(store.countEvents({ kind: 'post.edited', since: new Date(0) })).toBe(1);
  });

  it('fails, rather than posts again, when recording a sent post fails', async () => {
    const markSent = store.markSent.bind(store);
    store.markSent = () => {
      throw new Error('SQLITE_BUSY');
    };
    const post = store.enqueue({ target: 'agents', text: 'once' });
    const queue = makeQueue();
    queue.kick();
    await queue.idle();
    store.markSent = markSent;
    expect(slack.posts.map((p) => p.text)).toEqual(['once']);
    expect(store.getPost(post.id)).toMatchObject({ state: 'failed' });
    expect(store.getPost(post.id)?.lastError).toContain('sent to Slack, but recording it failed');
  });

  it('starts the 24 h clock at the first network failure, not when queued', async () => {
    const post = store.enqueue({ target: 'agents', text: 'before the weekend' });
    // The laptop sleeps for three days; the first send after waking fails once.
    clock += 3 * 24 * 60 * 60_000;
    slack.failures.push(network());
    const queue = makeQueue();
    queue.kick();
    await queue.idle();
    expect(store.getPost(post.id)).toMatchObject({
      state: 'sent',
      failingSince: new Date(clock - 1000).toISOString(),
    });
  });

  it('does not wake a lane backing off after a Slack error', async () => {
    const signals: AbortSignal[] = [];
    const queue = makeQueue(async (ms, signal) => {
      sleeps.push(ms);
      signals.push(signal);
      clock += ms;
    });
    slack.failures.push(new SlackSendError('transient', 'internal_error'));
    store.enqueue({ target: 'agents', text: 'x' });
    queue.kick();
    await queue.idle();
    store.enqueue({ target: DM_TARGET, text: 'y' });
    queue.kick();
    await queue.idle();
    expect(signals[0]?.aborted).toBe(false);
  });
});
