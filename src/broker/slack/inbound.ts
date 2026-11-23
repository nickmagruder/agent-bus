import type { App } from '@slack/bolt';
import type { InboundMessage, Inbox } from '../inbox.ts';
import { errorMessage, type Logger } from '../log.ts';
import { ANSWER_ACTION, type ButtonOutcome, type Questions } from '../questions.ts';
import { TASK_ACTION, TASK_CLICK_REPLIES, type TaskSlack } from '../task-slack.ts';

/**
 * Reduces a Slack `message` event to the fields the inbox routes on.
 * Returns undefined for events without a channel or ts.
 */
export function toInboundMessage(event: unknown): InboundMessage | undefined {
  if (typeof event !== 'object' || event === null) return undefined;
  const e = event as Record<string, unknown>;
  const channel = str(e.channel);
  const ts = str(e.ts);
  if (!channel || !ts) return undefined;
  return {
    channel,
    channelType: str(e.channel_type) ?? 'unknown',
    ts,
    threadTs: str(e.thread_ts),
    user: str(e.user),
    botId: str(e.bot_id),
    subtype: str(e.subtype),
    text: str(e.text) ?? '',
    hasFiles: Array.isArray(e.files) && e.files.length > 0,
  };
}

/**
 * Listens for messages in channels the bot is in and in my DM with it.
 * Needs the `message.channels` and `message.im` event subscriptions (and
 * `message.groups` for private channels). Bolt acknowledges each event;
 * routing is synchronous SQLite work, so nothing slow runs before the ack.
 */
export function registerInbound(app: App, inbox: Inbox, log: Logger): void {
  app.event('message', async ({ event }) => {
    const message = toInboundMessage(event);
    if (!message) return;
    try {
      const outcome = inbox.receive(message);
      if (outcome.action === 'routed') {
        log('info', 'Slack reply routed', { session: outcome.sessionId });
      }
    } catch (error) {
      log('error', 'Slack message handling failed', { error: errorMessage(error) });
    }
  });
}

export interface ButtonClick {
  questionId: string;
  optionIndex: number;
  userId: string;
}

/** Reads a question button click from a `block_actions` payload. */
export function toButtonClick(body: unknown, action: unknown): ButtonClick | undefined {
  if (typeof action !== 'object' || action === null) return undefined;
  const a = action as Record<string, unknown>;
  const match = ANSWER_ACTION.exec(str(a.action_id) ?? '');
  const questionId = str(a.block_id);
  const user = (body as { user?: { id?: unknown } } | null)?.user?.id;
  if (a.type !== 'button' || !match || !questionId || typeof user !== 'string') return undefined;
  return { questionId, optionIndex: Number(match[1]), userId: user };
}

/** Feedback for a click that didn't answer, shown only to the clicker. */
export const CLICK_REPLIES: Partial<Record<ButtonOutcome, string>> = {
  closed: 'This question was already answered or has expired.',
  not_human: 'Only Nick can answer agent questions.',
  unknown: 'agent-bus no longer knows this question.',
  invalid: 'That option is not part of this question.',
};

/**
 * Handles question buttons. Needs Interactivity turned on in the Slack app
 * (Socket Mode delivers the clicks). Acks first, then answers.
 */
export function registerActions(app: App, questions: Questions, log: Logger): void {
  app.action(ANSWER_ACTION, async ({ ack, body, action, respond }) => {
    await ack();
    const click = toButtonClick(body, action);
    if (!click) return;
    try {
      const outcome = questions.answerByButton(click.questionId, click.optionIndex, click.userId);
      const reply = CLICK_REPLIES[outcome];
      if (reply)
        await respond({ response_type: 'ephemeral', replace_original: false, text: reply });
      else log('info', 'question answered by button', { question: click.questionId });
    } catch (error) {
      log('error', 'Slack button handling failed', { error: errorMessage(error) });
    }
  });
}

export interface TaskClick {
  taskId: string;
  action: 'approve' | 'cancel';
  userId: string;
}

/** Reads a task Approve or Cancel click from a `block_actions` payload. */
export function toTaskClick(body: unknown, action: unknown): TaskClick | undefined {
  if (typeof action !== 'object' || action === null) return undefined;
  const a = action as Record<string, unknown>;
  const match = TASK_ACTION.exec(str(a.action_id) ?? '');
  const taskId = str(a.block_id);
  const user = (body as { user?: { id?: unknown } } | null)?.user?.id;
  if (a.type !== 'button' || !match || !taskId || typeof user !== 'string') return undefined;
  return { taskId, action: match[1] === 'approve' ? 'approve' : 'cancel', userId: user };
}

/**
 * Handles the Approve and Cancel buttons on task approval DMs (#61). The
 * task comes from the block ID and the decision from the action ID; only
 * Nick's clicks count (T5). Acks first, then decides.
 */
export function registerTaskActions(app: App, taskSlack: TaskSlack, log: Logger): void {
  app.action(TASK_ACTION, async ({ ack, body, action, respond }) => {
    await ack();
    const click = toTaskClick(body, action);
    if (!click) return;
    try {
      const outcome = taskSlack.decideByButton(click.taskId, click.action, click.userId);
      const reply = TASK_CLICK_REPLIES[outcome];
      if (reply)
        await respond({ response_type: 'ephemeral', replace_original: false, text: reply });
      else log('info', `task ${outcome} by button`, { task: click.taskId });
    } catch (error) {
      log('error', 'Slack task button handling failed', { error: errorMessage(error) });
      await respond({
        response_type: 'ephemeral',
        replace_original: false,
        text: 'Something went wrong; the task is unchanged. Try again, or see the broker log.',
      }).catch(() => undefined);
    }
  });
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}
