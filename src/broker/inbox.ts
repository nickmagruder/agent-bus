import { fromSlackText } from '../shared/slack-text.ts';
import { DM_TARGET, type InboxRecord, type SessionRecord, type Store } from './store.ts';

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
  | { action: 'routed' | 'duplicate'; sessionId: string; inboxId: number }
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
export class Inbox {
  private readonly store: Store;
  private readonly queue: { kick(): void };
  private readonly humanUserId: string;
  private readonly reactions: Reactions;
  private readonly now: () => Date;

  constructor(options: {
    store: Store;
    queue: { kick(): void };
    humanUserId: string;
    reactions: Reactions;
    now?: () => Date;
  }) {
    this.store = options.store;
    this.queue = options.queue;
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

    const { record, inserted } = this.store.transaction(() => {
      const added = this.store.addToInbox({
        sessionId: session.id,
        slackUser: this.humanUserId,
        body: messageBody(message),
        slackChannelId: message.channel,
        slackTs: message.ts,
      });
      if (added.inserted) {
        this.store.appendEvent({
          kind: 'inbound.routed',
          platform: session.platform,
          sessionId: session.id,
          data: { inboxId: added.record.id, channel: message.channel, ts: message.ts },
        });
      }
      return added;
    });
    if (!inserted) return { action: 'duplicate', sessionId: session.id, inboxId: record.id };
    this.reactions.add(message.channel, message.ts, REACTION.routed);
    return { action: 'routed', sessionId: session.id, inboxId: record.id };
  }

  /**
   * Hands a session its undelivered messages (oldest first, at most `limit`)
   * and marks them delivered. The caller has already checked ownership.
   */
  take(session: SessionRecord, limit = TAKE_LIMIT): { messages: InboxRecord[]; remaining: number } {
    const result = this.store.transaction(() => {
      const messages = this.store.undelivered(session.id, limit);
      if (messages.length > 0) {
        this.store.markDelivered(
          messages.map((m) => m.id),
          'check_inbox',
        );
        this.store.appendEvent({
          kind: 'inbox.delivered',
          platform: session.platform,
          sessionId: session.id,
          data: { via: 'check_inbox', ids: messages.map((m) => m.id) },
        });
      }
      return { messages, remaining: this.store.countUndelivered(session.id) };
    });
    for (const message of result.messages) {
      this.reactions.add(message.slackChannelId, message.slackTs, REACTION.delivered);
    }
    return result;
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
