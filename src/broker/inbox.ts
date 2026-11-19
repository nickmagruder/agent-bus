import { fromSlackText } from '../shared/slack-text.ts';
import type { Notifier, Questions } from './questions.ts';
import {
  DM_TARGET,
  type DeliveryVia,
  type InboxRecord,
  type QuestionRecord,
  type SessionRecord,
  type Store,
} from './store.ts';

/** A Slack `message` event, reduced to what routing needs (see slack/inbound.ts). */
export interface InboundMessage {
  channel: string;
  /** `im` for my DM with the bot. */
  channelType: string;
  ts: string;
  /** Set for replies in a thread (and on a thread's root, where it equals `ts`). */
  threadTs?: string | undefined;
  user?: string | undefined;
  botId?: string | undefined;
  subtype?: string | undefined;
  text: string;
  hasFiles: boolean;
}

export type DropReason = 'bot' | 'subtype' | 'not_human' | 'empty';

export type InboundOutcome =
  | { action: 'routed' | 'duplicate'; sessionId: string; inboxId: number; questionId?: string }
  | { action: 'dropped'; reason: DropReason }
  | { action: 'unrouted'; hinted: boolean };

/** Adds an emoji reaction; fire-and-forget (failures are only logged). */
export interface Reactions {
  add(channel: string, ts: string, name: string): void;
}

/** Reactions on my message: routed to a session's inbox, then read by the agent. */
export const REACTION = { routed: 'inbox_tray', delivered: 'white_check_mark' } as const;

/** Longer messages are cut, with a note, before an agent sees them. */
export const MAX_BODY_CHARS = 4000;
/** Messages handed out per check_inbox call. */
export const TAKE_LIMIT = 20;
/** At most one "reply in a thread" hint per hour. */
export const HINT_THROTTLE_MS = 60 * 60_000;

/** Subtypes that are still a person typing a message. Edits, deletes, joins etc. are dropped. */
const MESSAGE_SUBTYPES = new Set([undefined, 'thread_broadcast', 'file_share']);

export const HINT_TEXT =
  ':information_source: I only pass on replies in a thread. To reach an agent, reply under ' +
  "its session's post in the channel, or under the DM it sent you.";

/**
 * Routes my Slack messages to session inboxes. Only messages from
 * `humanUserId` count; everything else is dropped and audited. Only text I
 * typed ever enters an inbox, so agents can treat inbox messages as mine.
 */
/** What one take handed over, and how many messages still wait. */
export interface InboxTake {
  messages: InboxRecord[];
  outcomes: QuestionRecord[];
  remaining: number;
}

export class Inbox {
  private readonly store: Store;
  private readonly queue: { kick(): void };
  private readonly humanUserId: string;
  private readonly reactions: Reactions;
  private readonly now: () => Date;

  private readonly questions: Questions;
  private readonly notifier: Notifier;

  constructor(options: {
    store: Store;
    queue: { kick(): void };
    humanUserId: string;
    reactions: Reactions;
    questions: Questions;
    notifier: Notifier;
    now?: () => Date;
  }) {
    this.store = options.store;
    this.queue = options.queue;
    this.questions = options.questions;
    this.notifier = options.notifier;
    this.humanUserId = options.humanUserId;
    this.reactions = options.reactions;
    this.now = options.now ?? (() => new Date());
  }

  receive(message: InboundMessage): InboundOutcome {
    const reason = this.dropReason(message);
    if (reason) {
      this.store.appendEvent({
        kind: 'inbound.dropped',
        data: {
          reason,
          channel: message.channel,
          ts: message.ts,
          ...(message.subtype ? { subtype: message.subtype } : {}),
          ...(reason === 'not_human' && message.user ? { user: message.user } : {}),
        },
      });
      return { action: 'dropped', reason };
    }

    const session = this.sessionFor(message);
    if (!session) return this.unrouted(message);

    const body = messageBody(message);
    const { record, inserted, questionId } = this.store.transaction(() => {
      // A Slack retry of a message already stored must not answer anything again.
      const existing = this.store.findInbox(message.channel, message.ts);
      if (existing) return { record: existing, inserted: false, questionId: undefined };

      const threadTs = message.threadTs ?? message.ts;
      const question = this.questions.matchReply(session, message.channel, threadTs);
      const answered =
        question && this.questions.closeWithAnswer(question, body, 'reply')
          ? question.id
          : undefined;
      const added = this.store.addToInbox({
        sessionId: session.id,
        slackUser: this.humanUserId,
        body,
        slackChannelId: message.channel,
        slackTs: message.ts,
        questionId: answered ?? null,
      });
      this.store.appendEvent({
        kind: 'inbound.routed',
        platform: session.platform,
        sessionId: session.id,
        data: {
          inboxId: added.record.id,
          channel: message.channel,
          ts: message.ts,
          ...(answered ? { questionId: answered } : {}),
        },
      });
      return { record: added.record, inserted: added.inserted, questionId: answered };
    });
    if (!inserted) return { action: 'duplicate', sessionId: session.id, inboxId: record.id };
    this.reactions.add(message.channel, message.ts, REACTION.routed);
    this.notifier.notify(session.id);
    if (questionId) this.questions.afterClose(questionId);
    return {
      action: 'routed',
      sessionId: session.id,
      inboxId: record.id,
      ...(questionId ? { questionId } : {}),
    };
  }

  /**
   * Hands a session its undelivered messages (oldest first, at most `limit`)
   * and question outcomes, and marks them delivered. The caller has already
   * checked ownership. With `react: false` the ✅ reactions wait for
   * `confirm` (the Stop hook adds them once its response is written).
   */
  take(
    session: SessionRecord,
    via: DeliveryVia = 'check_inbox',
    limit = TAKE_LIMIT,
    options: { react?: boolean } = {},
  ): InboxTake {
    const result = this.store.transaction(() => {
      const outcomes = this.questions.takeOutcomes(session.id, via);
      const messages = this.store.undelivered(session.id, limit);
      if (messages.length > 0) {
        this.store.markDelivered(
          messages.map((m) => m.id),
          via,
        );
        this.store.appendEvent({
          kind: 'inbox.delivered',
          platform: session.platform,
          sessionId: session.id,
          data: { via, ids: messages.map((m) => m.id) },
        });
      }
      return { messages, outcomes, remaining: this.store.countUndelivered(session.id) };
    });
    if (options.react ?? true) this.confirm(result);
    return result;
  }

  /** ✅ on everything a take handed over: the agent has it now. */
  confirm(taken: InboxTake): void {
    this.reactDelivered(taken.messages);
    for (const outcome of taken.outcomes)
      this.reactDelivered(this.store.questionReplies(outcome.id));
  }

  /**
   * Puts a take back: the agent never received it (a Stop hook's response
   * didn't reach the app), so the next stop or check_inbox hands it over
   * again. The delivery events stay in the append-only audit log; this adds
   * an `inbox.undelivered` event after them.
   */
  untake(session: SessionRecord, taken: InboxTake, via: DeliveryVia): void {
    this.untakeIds(
      session,
      taken.messages.map((m) => m.id),
      taken.outcomes.map((q) => q.id),
      via,
    );
  }

  /** `untake` by IDs (only rows still delivered via `via` change). */
  untakeIds(
    session: SessionRecord,
    messageIds: readonly number[],
    questionIds: readonly string[],
    via: DeliveryVia,
  ): void {
    if (messageIds.length === 0 && questionIds.length === 0) return;
    this.store.transaction(() => {
      this.store.markUndelivered(messageIds, via);
      for (const id of questionIds) this.store.markQuestionUndelivered(id, via);
      this.store.appendEvent({
        kind: 'inbox.undelivered',
        platform: session.platform,
        sessionId: session.id,
        data: { via, ids: messageIds, questionIds },
      });
    });
    this.notifier.notify(session.id);
  }

  /** ✅ on the replies with these IDs, and on those that answered these questions. */
  confirmIds(messageIds: readonly number[], questionIds: readonly string[]): void {
    this.reactDelivered(this.store.inboxByIds(messageIds));
    for (const id of questionIds) this.reactDelivered(this.store.questionReplies(id));
  }

  /** ✅ on my messages the agent has now read. */
  reactDelivered(messages: readonly InboxRecord[]): void {
    for (const message of messages) {
      this.reactions.add(message.slackChannelId, message.slackTs, REACTION.delivered);
    }
  }

  private dropReason(message: InboundMessage): DropReason | undefined {
    if (message.botId || message.subtype === 'bot_message') return 'bot';
    if (!MESSAGE_SUBTYPES.has(message.subtype)) return 'subtype';
    if (message.user !== this.humanUserId) return 'not_human';
    if (!message.text.trim() && !message.hasFiles) return 'empty';
    return undefined;
  }

  /** A reply in a session's thread, or in the thread of a post a session sent (e.g. an urgent DM). */
  private sessionFor(message: InboundMessage): SessionRecord | undefined {
    const { threadTs, channel, ts } = message;
    if (!threadTs || threadTs === ts) return undefined;
    return this.store.findByThread(channel, threadTs) ?? this.store.findByPost(channel, threadTs);
  }

  /** Top-level messages and unknown threads aren't routed; in my DM I get a (throttled) hint. */
  private unrouted(message: InboundMessage): InboundOutcome {
    const hint = message.channelType === 'im' && this.hintDue();
    this.store.transaction(() => {
      this.store.appendEvent({
        kind: 'inbound.unrouted',
        data: {
          channel: message.channel,
          ts: message.ts,
          channelType: message.channelType,
          threaded: Boolean(message.threadTs && message.threadTs !== message.ts),
          hinted: hint,
        },
      });
      if (hint) {
        this.store.appendEvent({ kind: 'inbound.hint', data: { channel: message.channel } });
        this.store.enqueue({ target: DM_TARGET, text: HINT_TEXT });
      }
    });
    if (hint) this.queue.kick();
    return { action: 'unrouted', hinted: hint };
  }

  private hintDue(): boolean {
    const since = new Date(this.now().getTime() - HINT_THROTTLE_MS);
    return this.store.countEvents({ kind: 'inbound.hint', since }) === 0;
  }
}

function messageBody(message: InboundMessage): string {
  let body = fromSlackText(message.text).trim();
  if (message.hasFiles) {
    body = `${body}${body ? '\n' : ''}(Nick attached files; agent-bus doesn't forward them.)`;
  }
  if (body.length > MAX_BODY_CHARS) {
    body = `${body.slice(0, MAX_BODY_CHARS - 40).trimEnd()}\n… (cut: the message was too long)`;
  }
  return body;
}
