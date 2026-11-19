import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { postStyle } from '../shared/platform.ts';
import { escapeSlackText, toSlackMrkdwn } from '../shared/slack-text.ts';
import { errorMessage, type Logger } from './log.ts';
import {
  DM_TARGET,
  type AnswerSource,
  type DeliveryVia,
  type QuestionRecord,
  type SessionRecord,
  type Store,
} from './store.ts';

export const QUESTION_LIMITS = {
  /** How long ask_human / wait_for_reply hold a call before returning "pending" (Copilot's limit is 180 s). */
  holdMs: 150_000,
  defaultTimeoutMinutes: 60,
  minTimeoutMinutes: 5,
  maxTimeoutMinutes: 8 * 60,
  /** One reminder DM, at most this long after asking (half the timeout when that is shorter). */
  remindAfterMs: 15 * 60_000,
  openPerSession: 3,
  maxOptions: 5,
  /** Slack's button label limit. */
  optionChars: 75,
  questionChars: 2000,
  /** How often reminders and expiries are checked. */
  tickMs: 30_000,
} as const;

/** Button `action_id`s: `agentbus_answer_<option index>`; the block ID is the question ID. */
export const ANSWER_ACTION = /^agentbus_answer_(\d+)$/;

export function newQuestionId(): string {
  return `q-${randomBytes(3).toString('hex')}`;
}

/** When to remind and expire a question asked now. */
export function questionTimes(
  now: Date,
  timeoutMinutes: number = QUESTION_LIMITS.defaultTimeoutMinutes,
): { remindAt: Date | null; expiresAt: Date } {
  const minutes = Math.min(
    Math.max(Math.round(timeoutMinutes), QUESTION_LIMITS.minTimeoutMinutes),
    QUESTION_LIMITS.maxTimeoutMinutes,
  );
  const timeoutMs = minutes * 60_000;
  const remindMs = Math.min(QUESTION_LIMITS.remindAfterMs, timeoutMs / 2);
  return {
    remindAt: new Date(now.getTime() + remindMs),
    expiresAt: new Date(now.getTime() + timeoutMs),
  };
}

/** Wakes held tool calls when something arrives for their session. */
export class Notifier {
  private readonly emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(0);
  }

  notify(sessionId: string): void {
    this.emitter.emit(sessionId);
  }

  /** Resolves on the next notify for the session, after `ms`, or when `signal` aborts. */
  wait(
    sessionId: string,
    ms: number,
    signal?: AbortSignal,
  ): Promise<'notified' | 'timeout' | 'aborted'> {
    return new Promise((resolve) => {
      if (signal?.aborted) return resolve('aborted');
      const done = (result: 'notified' | 'timeout' | 'aborted') => {
        clearTimeout(timer);
        this.emitter.off(sessionId, onNotify);
        signal?.removeEventListener('abort', onAbort);
        resolve(result);
      };
      const onNotify = () => done('notified');
      const onAbort = () => done('aborted');
      const timer = setTimeout(() => done('timeout'), Math.max(0, ms));
      this.emitter.once(sessionId, onNotify);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }
}

/** Updates a message the bot already sent; fire-and-forget like reactions. */
export interface MessageEditor {
  update(channel: string, ts: string, text: string, blocks: unknown[]): void;
}

export type ButtonOutcome = 'answered' | 'closed' | 'not_human' | 'unknown' | 'invalid';

/**
 * Questions after they're asked: answers by button or reply (first one
 * wins), one reminder, expiry to the agent's own default, and handing the
 * outcome to the agent exactly once. Asking lives in BusService (ownership
 * and caps).
 */
export class Questions {
  private readonly store: Store;
  private readonly queue: { kick(): void };
  private readonly notifier: Notifier;
  private readonly editor: MessageEditor;
  private readonly humanUserId: string;
  private readonly now: () => Date;
  private readonly log: Logger;
  private timer: NodeJS.Timeout | undefined;

  constructor(options: {
    store: Store;
    queue: { kick(): void };
    notifier: Notifier;
    editor: MessageEditor;
    humanUserId: string;
    log: Logger;
    now?: () => Date;
  }) {
    this.store = options.store;
    this.queue = options.queue;
    this.notifier = options.notifier;
    this.editor = options.editor;
    this.humanUserId = options.humanUserId;
    this.log = options.log;
    this.now = options.now ?? (() => new Date());
  }

  /** Runs a tick now (reminders and expiries missed while the broker was off) and then every `tickMs`. */
  start(tickMs: number = QUESTION_LIMITS.tickMs): void {
    this.safeTick();
    this.timer = setInterval(() => this.safeTick(), tickMs);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** A button click. Only my clicks count; the option comes from the stored question, not the payload. */
  answerByButton(questionId: string, optionIndex: number, userId: string): ButtonOutcome {
    const question = this.store.getQuestion(questionId);
    if (userId !== this.humanUserId) {
      this.store.appendEvent({
        kind: 'inbound.dropped',
        sessionId: question?.sessionId ?? null,
        data: { reason: 'not_human', user: userId, questionId, via: 'button' },
      });
      return 'not_human';
    }
    if (!question) return 'unknown';
    const answer = question.options[optionIndex];
    if (!Number.isInteger(optionIndex) || answer === undefined) return 'invalid';
    return this.answer(question, answer, 'button') ? 'answered' : 'closed';
  }

  /**
   * The open question a reply answers: one whose DM (or reminder) I replied
   * under, or the session's only open question when I reply in its thread.
   */
  matchReply(
    session: SessionRecord,
    channel: string,
    threadTs: string,
  ): QuestionRecord | undefined {
    const byPost = this.store.questionByPost(channel, threadTs);
    if (byPost)
      return byPost.sessionId === session.id && byPost.state === 'open' ? byPost : undefined;
    if (session.slackChannelId === channel && session.threadTs === threadTs) {
      const open = this.store.openQuestions(session.id);
      return open.length === 1 ? open[0] : undefined;
    }
    return undefined;
  }

  /** Closes a question with my answer. Must run inside the caller's transaction for replies. */
  closeWithAnswer(question: QuestionRecord, answer: string, source: AnswerSource): boolean {
    const closed = this.store.closeQuestion(question.id, {
      state: 'answered',
      answer,
      answeredBy: this.humanUserId,
      source,
    });
    if (closed) {
      this.store.appendEvent({
        kind: 'question.answered',
        sessionId: question.sessionId,
        data: { questionId: question.id, source },
      });
    }
    return closed;
  }

  /** After a question closed: wake waiting calls and update its DM. */
  afterClose(questionId: string): void {
    const question = this.store.getQuestion(questionId);
    if (!question) return;
    this.notifier.notify(question.sessionId);
    this.refreshMessage(question);
  }

  /** Checks one held call: the question's outcome (marked delivered) or undefined while it's open. */
  takeOutcome(questionId: string, via: DeliveryVia): QuestionRecord | undefined {
    const question = this.store.getQuestion(questionId);
    if (!question || question.state === 'open') return undefined;
    this.deliver(question, via);
    return question;
  }

  /** All closed, undelivered outcomes for a session, marked delivered. */
  takeOutcomes(sessionId: string, via: DeliveryVia): QuestionRecord[] {
    const outcomes = this.store.undeliveredOutcomes(sessionId);
    for (const question of outcomes) this.deliver(question, via);
    return outcomes;
  }

  tick(): void {
    const now = this.now();
    for (const question of this.store.dueExpiries(now)) {
      const expired = this.store.transaction(() => {
        const closed = this.store.closeQuestion(question.id, { state: 'expired' });
        if (closed) {
          this.store.appendEvent({
            kind: 'question.expired',
            sessionId: question.sessionId,
            data: { questionId: question.id },
          });
        }
        return closed;
      });
      if (expired) this.afterClose(question.id);
    }
    let reminded = false;
    for (const question of this.store.dueReminders(now)) {
      const session = this.store.getSession(question.sessionId);
      if (!session) continue;
      this.store.transaction(() => {
        const post = this.store.enqueue({
          target: DM_TARGET,
          sessionId: session.id,
          text: reminderText(session, question),
          // Like the question DM: the session's name and icon, not the bot's.
          ...postStyle(session.platform, session.project),
        });
        this.store.setQuestionPost(question.id, 'reminder', post.id);
        this.store.appendEvent({
          kind: 'question.reminded',
          sessionId: session.id,
          data: { questionId: question.id },
        });
      });
      reminded = true;
    }
    if (reminded) this.queue.kick();
  }

  private answer(question: QuestionRecord, answer: string, source: AnswerSource): boolean {
    const closed = this.store.transaction(() => this.closeWithAnswer(question, answer, source));
    if (closed) this.afterClose(question.id);
    return closed;
  }

  private deliver(question: QuestionRecord, via: DeliveryVia): void {
    if (question.deliveredAt) return;
    this.store.transaction(() => {
      this.store.markQuestionDelivered(question.id, via);
      this.store.appendEvent({
        kind: 'question.delivered',
        sessionId: question.sessionId,
        data: { questionId: question.id, via, state: question.state },
      });
    });
  }

  /** Shows the outcome on the question's DM: edits it in Slack, or rewrites it if still queued. */
  private refreshMessage(question: QuestionRecord): void {
    const session = this.store.getSession(question.sessionId);
    if (!session || question.postId === null) return;
    const message = questionMessage(session, question);
    if (this.store.updateQueuedPost(question.postId, message.text, message.blocks)) return;
    const post = this.store.getPost(question.postId);
    if (post?.state === 'sent' && post.slackChannelId && post.slackTs) {
      this.editor.update(post.slackChannelId, post.slackTs, message.text, message.blocks);
    }
  }

  private safeTick(): void {
    try {
      this.tick();
    } catch (error) {
      this.log('error', 'question tick failed', { error: errorMessage(error) });
    }
  }
}

// Rendering

function localTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

function snippet(text: string, max: number): string {
  const trimmed = text.trim().replace(/\s+/g, ' ');
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

/** The question DM: buttons while open, the outcome once closed. */
export function questionMessage(
  session: SessionRecord,
  question: QuestionRecord,
): { text: string; blocks: unknown[] } {
  const header = `:question: \`${session.id}\` asks (\`${question.id}\`):`;
  const section = {
    type: 'section',
    text: { type: 'mrkdwn', text: `${header}\n${toSlackMrkdwn(question.text)}` },
  };
  const fallback = `:question: ${session.id} asks: ${escapeSlackText(snippet(question.text, 200))}`;
  const defaultText = escapeSlackText(snippet(question.defaultAnswer, 300));

  if (question.state === 'open') {
    const blocks: unknown[] = [section];
    if (question.options.length > 0) {
      blocks.push({
        type: 'actions',
        block_id: question.id,
        elements: question.options.map((option, index) => ({
          type: 'button',
          action_id: `agentbus_answer_${index}`,
          text: { type: 'plain_text', text: option, emoji: false },
          value: String(index),
        })),
      });
    }
    blocks.push({
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text:
            `${question.options.length > 0 ? 'Or reply' : 'Reply'} in this thread. ` +
            `No answer by ${localTime(question.expiresAt)}: the agent goes with _${defaultText}_`,
        },
      ],
    });
    return { text: fallback, blocks };
  }

  const outcome =
    question.state === 'answered'
      ? `:white_check_mark: Answered${question.answerSource === 'button' ? ' (button)' : ''}: *${escapeSlackText(snippet(question.answer ?? '', 300))}*`
      : `:hourglass: Expired at ${localTime(question.expiresAt)}: the agent went with _${defaultText}_`;
  return {
    text: `${fallback} (${question.state})`,
    blocks: [section, { type: 'context', elements: [{ type: 'mrkdwn', text: outcome }] }],
  };
}

/** The one-line pointer in the session's thread. */
export function questionPointer(question: QuestionRecord): string {
  return `:question: Asked Nick in DM (\`${question.id}\`): ${escapeSlackText(snippet(question.text, 200))}`;
}

export function reminderText(session: SessionRecord, question: QuestionRecord): string {
  return (
    `:alarm_clock: Reminder: \`${session.id}\` is still waiting on \`${question.id}\`: ` +
    `${escapeSlackText(snippet(question.text, 200))}\n` +
    `Answer with the buttons above or reply here. Expires at ${localTime(question.expiresAt)}.`
  );
}

/** A question's outcome, for the agent. */
export function outcomeText(question: QuestionRecord): string {
  const about = `"${snippet(question.text, 120)}"`;
  if (question.state === 'answered') {
    const how = question.answerSource === 'button' ? 'chose' : 'replied';
    return (
      `Nick ${how} on ${question.id} (${about}), from his own Slack account (verified by agent-bus):\n` +
      (question.answer ?? '')
    );
  }
  if (question.state === 'expired') {
    return (
      `${question.id} (${about}) got no answer before it expired. ` +
      `Go with your stated default: ${question.defaultAnswer}`
    );
  }
  return `${question.id} (${about}) is still open.`;
}
