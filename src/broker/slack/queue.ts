import { setTimeout as delay } from 'node:timers/promises';
import { errorMessage, type Logger } from '../log.ts';
import type { OutboxRecord, Store } from '../store.ts';
import { classifySlackError, type SlackApi } from './api.ts';
import type { ChannelDirectory } from './directory.ts';

export interface PostQueueOptions {
  /** Gap between posts to one target; Slack allows about 1 message/s per channel. */
  minIntervalMs?: number;
  /** Attempts before a post that keeps failing transiently is given up. */
  maxAttempts?: number;
  /** First retry delay after a transient failure; doubles each time. */
  backoffMs?: number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  now?: () => number;
  log: Logger;
}

const defaultSleep = (ms: number, signal: AbortSignal) =>
  delay(ms, undefined, { signal }).catch(() => undefined);

/**
 * Sends outbox posts to Slack: one lane per target, in order, paced and
 * retried. The outbox is in SQLite, so queued posts survive a restart
 * (delivery is at-least-once: a crash between send and mark can repeat one).
 */
export class PostQueue {
  private readonly lanes = new Map<string, Promise<void>>();
  private readonly lastSent = new Map<string, number>();
  private readonly abort = new AbortController();
  private readonly minIntervalMs: number;
  private readonly maxAttempts: number;
  private readonly backoffMs: number;
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
    this.maxAttempts = options.maxAttempts ?? 5;
    this.backoffMs = options.backoffMs ?? 1000;
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
    let transientFailures = 0;
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
        transientFailures++;
        const final = error.kind === 'permanent' || transientFailures >= this.maxAttempts;
        this.store.markAttemptFailed(post.id, error.message, final);
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
        } else {
          await this.sleep(this.backoffMs * 2 ** (transientFailures - 1), this.abort.signal);
        }
      } finally {
        this.lastSent.set(target, this.now());
      }
    }
  }

  private async deliver(post: OutboxRecord): Promise<void> {
    const session = post.sessionId ? this.store.getSession(post.sessionId) : undefined;
    const sessionThread = post.inThread && session?.threadTs ? session : undefined;
    // A reply under another post (a task's thread); top-level if that post never went out.
    const parent = post.replyTo ? this.store.getPost(post.replyTo) : undefined;
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

    this.store.transaction(() => {
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
