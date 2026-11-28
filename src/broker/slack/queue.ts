import { setTimeout as delay } from 'node:timers/promises';
import { errorMessage, type Logger } from '../log.ts';
import type { OutboxRecord, Store } from '../store.ts';
import { classifySlackError, SlackSendError, type SlackApi } from './api.ts';
import type { ChannelDirectory } from './directory.ts';

export interface PostQueueOptions {
  /** Gap between posts to one target; Slack allows about 1 message/s per channel. */
  minIntervalMs?: number;
  /** Attempts before a post Slack keeps answering with a transient error is given up. */
  maxAttempts?: number;
  /** First retry delay after a failure; doubles each time. */
  backoffMs?: number;
  /** The longest retry delay (#105). */
  maxBackoffMs?: number;
  /**
   * A post still unsent this long after it was queued is given up when the
   * network fails again (#105): a day-old reminder confuses more than it helps.
   */
  maxAgeMs?: number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  now?: () => number;
  log: Logger;
}

const defaultSleep = (ms: number, signal: AbortSignal) =>
  delay(ms, undefined, { signal }).catch(() => undefined);

/** Retry limits (#105). */
export const QUEUE_RETRY = {
  maxAttempts: 5,
  backoffMs: 1000,
  maxBackoffMs: 5 * 60_000,
  maxAgeMs: 24 * 60 * 60_000,
};

/**
 * Sends outbox posts and edits to Slack: one lane per target, in order,
 * paced and retried. The outbox is in SQLite, so queued posts survive a
 * restart (delivery is at-least-once: a crash between send and mark can
 * repeat one).
 *
 * Failures (#105): a permanent Slack error fails the post at once; one Slack
 * answers with but may pass is tried `maxAttempts` times; a network failure
 * (no answer) is retried with a capped backoff until the post is `maxAgeMs`
 * old. A lane backing off wakes early when any other lane gets through.
 */
export class PostQueue {
  private readonly lanes = new Map<string, Promise<void>>();
  private readonly lastSent = new Map<string, number>();
  private readonly abort = new AbortController();
  /** Aborted (and replaced) when a send succeeds, to wake lanes backing off. */
  private wake = new AbortController();
  private readonly minIntervalMs: number;
  private readonly maxAttempts: number;
  private readonly backoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly maxAgeMs: number;
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  private readonly now: () => number;
  private readonly log: Logger;
  private readonly store: Store;
  private readonly api: SlackApi;
  private readonly directory: ChannelDirectory;

  constructor(store: Store, api: SlackApi, directory: ChannelDirectory, options: PostQueueOptions) {
    this.store = store;
    this.api = api;
    this.directory = directory;
    this.minIntervalMs = options.minIntervalMs ?? 1100;
    this.maxAttempts = options.maxAttempts ?? QUEUE_RETRY.maxAttempts;
    this.backoffMs = options.backoffMs ?? QUEUE_RETRY.backoffMs;
    this.maxBackoffMs = options.maxBackoffMs ?? QUEUE_RETRY.maxBackoffMs;
    this.maxAgeMs = options.maxAgeMs ?? QUEUE_RETRY.maxAgeMs;
    this.sleep = options.sleep ?? defaultSleep;
    this.now = options.now ?? Date.now;
    this.log = options.log;
  }

  /** Starts a lane for every target with queued posts. Cheap; call after each enqueue. */
  kick(): void {
    if (this.abort.signal.aborted) return;
    for (const target of this.store.queuedTargets()) {
      if (!this.lanes.has(target)) this.startLane(target);
    }
  }

  /** Resolves once every lane has drained (or the queue is stopped). */
  async idle(): Promise<void> {
    while (this.lanes.size > 0) {
      await Promise.all(this.lanes.values());
    }
  }

  async stop(): Promise<void> {
    this.abort.abort();
    await this.idle();
  }

  private startLane(target: string): void {
    const lane = this.runLane(target)
      .catch((error: unknown) => {
        this.log('error', 'post lane crashed', { target, error: errorMessage(error) });
      })
      .finally(() => {
        this.lanes.delete(target);
        // A post may have been queued after the lane's last check.
        if (!this.abort.signal.aborted && this.store.nextQueued(target)) this.startLane(target);
      });
    this.lanes.set(target, lane);
  }

  private async runLane(target: string): Promise<void> {
    // For the post at the head of the lane: Slack-answered errors (capped),
    // and all failures (for the backoff).
    let transientFailures = 0;
    let failures = 0;
    for (;;) {
      if (this.abort.signal.aborted) return;
      const post = this.store.nextQueued(target);
      if (!post) return;

      const wait = (this.lastSent.get(target) ?? Number.NEGATIVE_INFINITY) + this.minIntervalMs;
      if (wait > this.now()) await this.sleep(wait - this.now(), this.abort.signal);
      if (this.abort.signal.aborted) return;

      try {
        await this.deliver(post);
        transientFailures = 0;
        failures = 0;
        // Slack is reachable: lanes backing off after network failures try again now.
        this.wake.abort();
        this.wake = new AbortController();
      } catch (raw) {
        const error = classifySlackError(raw);
        if (error.kind === 'rate_limited') {
          this.store.markAttemptFailed(post.id, 'rate_limited', false);
          this.store.appendEvent({
            kind: 'post.rate_limited',
            sessionId: post.sessionId,
            data: { postId: post.id, target, retryAfterMs: error.retryAfterMs },
          });
          this.log('warn', 'Slack rate limit', { target, retryAfterMs: error.retryAfterMs });
          await this.sleep(Math.max(error.retryAfterMs, this.minIntervalMs), this.abort.signal);
          continue;
        }
        const network = error.kind === 'network';
        failures++;
        if (error.kind === 'transient') transientFailures++;
        const final =
          error.kind === 'permanent' ||
          (error.kind === 'transient' && transientFailures >= this.maxAttempts) ||
          (network && this.outageTooLong(post));
        this.store.markAttemptFailed(post.id, error.message, final, network);
        this.log(final ? 'error' : 'warn', 'Slack post failed', {
          target,
          postId: post.id,
          error: error.message,
          final,
        });
        if (final) {
          this.store.appendEvent({
            kind: 'post.failed',
            sessionId: post.sessionId,
            data: { postId: post.id, target, error: error.message },
          });
          transientFailures = 0;
          failures = 0;
        } else {
          const backoff = Math.min(
            this.backoffMs * 2 ** Math.min(failures - 1, 30),
            this.maxBackoffMs,
          );
          // Only a network wait ends early when another lane gets through.
          const signal = network
            ? AbortSignal.any([this.abort.signal, this.wake.signal])
            : this.abort.signal;
          await this.sleep(backoff, signal);
        }
      } finally {
        this.lastSent.set(target, this.now());
      }
    }
  }

  /** Failing on the network for `maxAgeMs` (time asleep before the first failure doesn't count). */
  private outageTooLong(post: OutboxRecord): boolean {
    if (post.failingSince === null) return false;
    return this.now() - Date.parse(post.failingSince) >= this.maxAgeMs;
  }

  /**
   * Store work after Slack accepted the call. If it throws, the post must not
   * be retried (that would post it again): it fails with a clear error.
   */
  private record(work: () => void): void {
    try {
      this.store.transaction(work);
    } catch (error) {
      throw new SlackSendError(
        'permanent',
        `sent to Slack, but recording it failed: ${errorMessage(error)}`,
      );
    }
  }

  private async deliver(post: OutboxRecord): Promise<void> {
    if (post.editTs !== null) {
      await this.api.updateMessage(post.target, post.editTs, post.text, post.blocks ?? undefined);
      this.record(() => {
        // A newer edit replaced the text mid-send: leave it queued to go next.
        if (!this.store.markEdited(post.id, post)) return;
        this.store.appendEvent({
          kind: 'post.edited',
          data: { postId: post.id, channel: post.target, ts: post.editTs },
        });
      });
      return;
    }
    const session = post.sessionId ? this.store.getSession(post.sessionId) : undefined;
    const sessionThread = post.inThread && session?.threadTs ? session : undefined;
    // A reply under another post (a task's thread). If that post failed for
    // good, the reply is dropped rather than posted loose in the channel.
    const parent = post.replyTo ? this.store.getPost(post.replyTo) : undefined;
    if (parent?.state === 'failed') {
      this.store.transaction(() => {
        this.store.markAttemptFailed(post.id, 'its thread root failed', true);
        this.store.appendEvent({
          kind: 'post.dropped',
          sessionId: post.sessionId,
          data: { postId: post.id, replyTo: parent.id },
        });
      });
      return;
    }
    const thread =
      parent?.state === 'sent' && parent.slackChannelId && parent.slackTs
        ? { slackChannelId: parent.slackChannelId, threadTs: parent.slackTs }
        : sessionThread;
    // Once a thread exists, replies follow it even if channel membership changed.
    const channel = thread?.slackChannelId ?? (await this.directory.resolve(post.target));

    const result = await this.api.postMessage({
      channel,
      text: post.text,
      ...(thread?.threadTs ? { threadTs: thread.threadTs } : {}),
      ...(post.username ? { username: post.username } : {}),
      ...(post.icon ? { icon: post.icon } : {}),
      ...(post.blocks ? { blocks: post.blocks } : {}),
    });

    this.record(() => {
      this.store.markSent(post.id, result.channel, result.ts);
      this.store.linkTaskThread(post.id, result.channel, result.ts);
      if (post.inThread && session && !session.threadTs) {
        // The session's first threaded post becomes the thread root.
        this.store.setThread(session.id, result.channel, result.ts);
      }
      this.store.appendEvent({
        kind: 'post.sent',
        sessionId: post.sessionId,
        data: { postId: post.id, target: post.target, channel: result.channel, ts: result.ts },
      });
    });
  }
}
