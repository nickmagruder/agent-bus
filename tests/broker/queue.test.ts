import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { silentLogger } from '../../src/broker/log.ts';
import { SlackSendError } from '../../src/broker/slack/api.ts';
import { ChannelDirectory } from '../../src/broker/slack/directory.ts';
import { PostQueue } from '../../src/broker/slack/queue.ts';
import { DM_TARGET, Store } from '../../src/broker/store.ts';
import { FakeSlack, USER_ID } from './fakes.ts';

let store: Store;
let slack: FakeSlack;
let clock: number;
let sleeps: number[];

function makeQueue(options: { maxAttempts?: number } = {}): PostQueue {
  return new PostQueue(store, slack, new ChannelDirectory(slack, USER_ID, () => clock), {
    log: silentLogger,
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    minIntervalMs: 1100,
    backoffMs: 1000,
    ...options,
  });
}

function addSession(id = 'claude/clankers/abcd', channel = 'proj-clankers') {
  store.insertSession({
    id,
    platform: 'claude',
    project: 'clankers',
    branch: null,
    purpose: null,
    channel,
  });
  return id;
}

beforeEach(() => {
  store = new Store(':memory:');
  slack = new FakeSlack();
  clock = 1_000_000;
  sleeps = [];
});

afterEach(() => store.close());

describe('PostQueue', () => {
  it('sends posts to one channel in order, at most one per interval', async () => {
    const queue = makeQueue();
    for (const text of ['one', 'two', 'three']) store.enqueue({ target: 'agents', text });
    queue.kick();
    await queue.idle();
    expect(slack.posts.map((p) => p.text)).toEqual(['one', 'two', 'three']);
    expect(slack.posts.every((p) => p.channel === 'C_AGENTS')).toBe(true);
    expect(sleeps).toEqual([1100, 1100]);
  });

  it('starts a thread with the first threaded post and replies in it', async () => {
    const queue = makeQueue();
    const id = addSession();
    store.enqueue({ target: 'proj-clankers', sessionId: id, inThread: true, text: 'root' });
    store.enqueue({ target: 'proj-clankers', sessionId: id, inThread: true, text: 'reply' });
    queue.kick();
    await queue.idle();
    const [root, reply] = slack.posts;
    expect(root).toMatchObject({ channel: 'C_CLANKERS', text: 'root' });
    expect(root?.threadTs).toBeUndefined();
    expect(reply).toMatchObject({ channel: 'C_CLANKERS', threadTs: root?.ts });
    expect(store.getSession(id)).toMatchObject({
      slackChannelId: 'C_CLANKERS',
      threadTs: root?.ts,
    });
  });

  it('falls back to #agents when the project channel is missing', async () => {
    const queue = makeQueue();
    const id = addSession('claude/nochannel/abcd', 'proj-nochannel');
    store.enqueue({ target: 'proj-nochannel', sessionId: id, inThread: true, text: 'hi' });
    queue.kick();
    await queue.idle();
    expect(slack.posts[0]?.channel).toBe('C_AGENTS');
  });

  it('sends DMs to my DM channel', async () => {
    const queue = makeQueue();
    store.enqueue({ target: DM_TARGET, text: 'urgent' });
    queue.kick();
    await queue.idle();
    expect(slack.posts[0]?.channel).toBe(`D_${USER_ID}`);
  });

  it('waits Retry-After on a rate limit, then retries the same post', async () => {
    const queue = makeQueue();
    slack.failures.push(new SlackSendError('rate_limited', 'rate_limited', 30_000));
    const post = store.enqueue({ target: 'agents', text: 'x' });
    queue.kick();
    await queue.idle();
    expect(sleeps).toContain(30_000);
    expect(store.getPost(post.id)).toMatchObject({ state: 'sent', attempts: 2 });
    expect(store.countEvents({ kind: 'post.rate_limited', since: new Date(0) })).toBe(1);
  });

  it('backs off on transient errors and gives up after maxAttempts', async () => {
    const queue = makeQueue({ maxAttempts: 3 });
    for (let i = 0; i < 3; i++)
      slack.failures.push(new SlackSendError('transient', 'fetch failed'));
    const post = store.enqueue({ target: 'agents', text: 'x' });
    const next = store.enqueue({ target: 'agents', text: 'next' });
    queue.kick();
    await queue.idle();
    expect(store.getPost(post.id)).toMatchObject({ state: 'failed', attempts: 3 });
    expect(store.getPost(next.id)?.state).toBe('sent');
    expect(sleeps.slice(0, 4)).toEqual([1000, 1100, 2000, 1100]);
    expect(store.countEvents({ kind: 'post.failed', since: new Date(0) })).toBe(1);
  });

  it('gives up at once on a permanent error and moves on', async () => {
    const queue = makeQueue();
    slack.failures.push(new SlackSendError('permanent', 'msg_too_long'));
    const bad = store.enqueue({ target: 'agents', text: 'x' });
    store.enqueue({ target: 'agents', text: 'ok' });
    queue.kick();
    await queue.idle();
    expect(store.getPost(bad.id)).toMatchObject({ state: 'failed', lastError: 'msg_too_long' });
    expect(slack.posts.map((p) => p.text)).toEqual(['ok']);
  });

  it('fails posts when the bot is in neither the project channel nor #agents', async () => {
    slack.channels = new Map();
    const queue = makeQueue();
    const post = store.enqueue({ target: 'proj-x', text: 'x' });
    queue.kick();
    await queue.idle();
    expect(store.getPost(post.id)?.state).toBe('failed');
    expect(store.getPost(post.id)?.lastError).toContain('/invite');
  });

  it('sends posts queued before a restart', async () => {
    store.enqueue({ target: 'agents', text: 'left over' });
    const queue = makeQueue();
    queue.kick();
    await queue.idle();
    expect(slack.posts.map((p) => p.text)).toEqual(['left over']);
  });

  it('picks up posts queued while a lane is busy', async () => {
    const queue = makeQueue();
    store.enqueue({ target: 'agents', text: 'a' });
    queue.kick();
    store.enqueue({ target: 'agents', text: 'b' });
    queue.kick();
    await queue.idle();
    expect(slack.posts.map((p) => p.text)).toEqual(['a', 'b']);
  });

  it('caches the channel list between posts', async () => {
    const queue = makeQueue();
    store.enqueue({ target: 'agents', text: 'a' });
    store.enqueue({ target: 'agents', text: 'b' });
    queue.kick();
    await queue.idle();
    expect(slack.memberChannelCalls).toBe(1);
  });

  it('stops without sending more', async () => {
    const queue = makeQueue();
    await queue.stop();
    store.enqueue({ target: 'agents', text: 'a' });
    queue.kick();
    await queue.idle();
    expect(slack.posts).toEqual([]);
  });
});
