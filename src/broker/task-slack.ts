import type { Platform } from '../shared/platform.ts';
import { postStyle } from '../shared/platform.ts';
import { escapeSlackText } from '../shared/slack-text.ts';
import type { TaskState } from '../shared/task-states.ts';
import { errorMessage, type Logger } from './log.ts';
import type { MessageEditor } from './questions.ts';
import { AGENT_CARDS } from './service.ts';
import { FALLBACK_CHANNEL } from './slack/directory.ts';
import { DM_TARGET, type Store } from './store.ts';
import { ACTOR, TaskStore, type TaskRecord } from './task-store.ts';
import { TASK_LIMITS } from './tasks.ts';

/**
 * Tasks in Slack (#61, part 1). Each new task gets a thread in #agents
 * (Q16) and an approval DM to me with Approve and Cancel (D2, Q15): one
 * reminder, then it expires after 8 h. Only my clicks count (T5). Every
 * move is mirrored into the thread, with agent text escaped and cut (T9)
 * and a cap per task (Q17). Approve means "deliver this", not "Nick
 * endorses it" (Q5).
 */
export const TASK_SLACK = {
  /** The one approval reminder, this long after the task was created. */
  remindAfterMs: 2 * 60 * 60_000,
  /** A Block Kit section's text limit; the approval DM's brief is cut to fit it once rendered. */
  sectionChars: 3000,
  /** Lines mirrored into one task's thread, after its root (Q17). */
  mirrorPerTask: 40,
  /** Of those, the last ones are kept for state changes: notes and messages stop earlier. */
  reservedForStates: 4,
  /** How often reminders and expiries are checked. */
  tickMs: 30_000,
} as const;

/** Button `action_id`s on the approval DM; the block ID is the task ID. */
export const TASK_ACTION = /^agentbus_task_(approve|cancel)$/;

export type TaskClickOutcome = 'approved' | 'canceled' | 'closed' | 'not_human' | 'unknown';

/** What the task rules tell Slack about, inside the same transaction as the change. */
export interface TaskEvents {
  created(task: TaskRecord): void;
  /** `note`: the note given with this move, if any (the task keeps older ones). */
  moved(task: TaskRecord, from: TaskState, by: string, note?: string): void;
  noted(task: TaskRecord, by: string): void;
}

const PLATFORM_NAMES: Record<Platform, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  copilot: 'Copilot',
};

export class TaskSlack implements TaskEvents {
  private readonly store: Store;
  private readonly tasks: TaskStore;
  private readonly queue: { kick(): void };
  private readonly editor: MessageEditor;
  private readonly humanUserId: string;
  private readonly log: Logger;
  private readonly now: () => Date;
  private timer: NodeJS.Timeout | undefined;

  constructor(options: {
    store: Store;
    queue: { kick(): void };
    editor: MessageEditor;
    humanUserId: string;
    log: Logger;
    now?: () => Date;
  }) {
    this.store = options.store;
    this.queue = options.queue;
    this.editor = options.editor;
    this.humanUserId = options.humanUserId;
    this.log = options.log;
    this.now = options.now ?? (() => new Date());
    this.tasks = new TaskStore(options.store, this.now);
  }

  /** Runs a tick now (reminders and expiries missed while the broker was off) and then every `tickMs`. */
  start(tickMs: number = TASK_SLACK.tickMs): void {
    this.safeTick();
    this.timer = setInterval(() => this.safeTick(), tickMs);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** A new task: its thread root in #agents, my approval DM, and a line in the creator's thread. */
  created(task: TaskRecord): void {
    this.store.transaction(() => {
      const root = this.store.enqueue({ target: FALLBACK_CHANNEL, text: threadRootText(task) });
      const message = approvalMessage(task, this.noSessionHint(task));
      const dm = this.store.enqueue({
        target: DM_TARGET,
        text: message.text,
        blocks: message.blocks,
      });
      this.tasks.setSlackPosts(task.id, {
        threadPostId: root.id,
        approvalPostId: dm.id,
        approvalRemindAt: new Date(new Date(task.createdAt).getTime() + TASK_SLACK.remindAfterMs),
      });
      this.sessionLine(
        task.createdBy,
        `:outbox_tray: Opened task \`${task.id}\` for \`${targetName(task)}\`: ` +
          `*${title(task)}*. It waits for Nick's approval; its thread is in #${FALLBACK_CHANNEL}.`,
      );
    });
    this.kickAfterCommit();
  }

  /** A state change, mirrored into the task's thread (and the holder's thread when it claims). */
  moved(task: TaskRecord, from: TaskState, by: string, note?: string): void {
    this.mirror(task, moveLine(task, from, by, note), 'state');
    if (from === 'submitted' && task.state === 'working' && task.holder) {
      this.sessionLine(
        task.holder,
        `:inbox_tray: Claimed task \`${task.id}\` from \`${task.createdBy}\`: ` +
          `*${title(task)}*. Its thread is in #${FALLBACK_CHANNEL}.`,
      );
    }
    this.kickAfterCommit();
  }

  /** A progress note, mirrored into the task's thread. */
  noted(task: TaskRecord, by: string): void {
    this.mirror(task, `:memo: Note from \`${by}\`:${agentText(task.statusMessage ?? '')}`, 'note');
    this.kickAfterCommit();
  }

  /**
   * An Approve or Cancel click on the approval DM. Only my clicks count; any
   * other user's (or a bot's) is dropped and audited (T5). Approving tells a
   * named target (its fixed notice, D3); canceling cancels the task.
   */
  decideByButton(taskId: string, action: 'approve' | 'cancel', userId: string): TaskClickOutcome {
    const task = this.tasks.getTask(taskId);
    if (userId !== this.humanUserId) {
      this.store.appendEvent({
        kind: 'inbound.dropped',
        sessionId: task?.createdBy ?? null,
        // The block ID comes from the clicker's payload: audit a real task or a cut string.
        data: {
          reason: 'not_human',
          user: userId.slice(0, 40),
          task: task?.id ?? taskId.slice(0, 20),
          via: 'task_button',
        },
      });
      return 'not_human';
    }
    if (!task) return 'unknown';
    const decided = this.store.transaction(() => {
      const after = this.tasks.decideApproval(
        task.id,
        action === 'approve' ? 'approved' : 'canceled',
        ACTOR.nick,
      );
      if (!after) return undefined;
      if (after.approval === 'approved') {
        if (after.targetSession) this.tasks.addNotice(after.targetSession, after.id, 'approved');
        this.mirror(
          after,
          ':white_check_mark: Approved by Nick: the target can see it now.',
          'state',
        );
      } else {
        this.mirror(after, ':no_entry_sign: Canceled by Nick before approval.', 'state');
        this.sessionLine(
          after.createdBy,
          `:no_entry_sign: Nick canceled task \`${after.id}\` before approving it: *${title(after)}*.`,
        );
      }
      return after;
    });
    if (!decided) return 'closed';
    this.refreshApproval(decided);
    this.queue.kick();
    return decided.approval === 'approved' ? 'approved' : 'canceled';
  }

  tick(): void {
    const now = this.now();
    for (const task of this.tasks.dueApprovalExpiries(now)) {
      const expired = this.store.transaction(() => {
        const after = this.tasks.decideApproval(task.id, 'expired', ACTOR.broker);
        if (after) {
          const hours = TASK_LIMITS.approvalTtlMs / 3_600_000;
          this.mirror(
            after,
            `:hourglass: Expired: Nick didn't approve it within ${hours} hours.`,
            'state',
          );
          this.sessionLine(
            after.createdBy,
            `:hourglass: Task \`${after.id}\` expired before Nick approved it: *${title(after)}*.`,
          );
        }
        return after;
      });
      if (expired) this.refreshApproval(expired);
    }
    for (const task of this.tasks.dueApprovalReminders(now)) {
      this.store.transaction(() => {
        if (!this.tasks.markApprovalReminded(task.id)) return;
        this.store.enqueue({
          target: DM_TARGET,
          text:
            `:alarm_clock: Reminder: task \`${task.id}\` from \`${task.createdBy}\` still waits ` +
            `for your approval: *${title(task)}*. ` +
            `It expires ${localTime(task.approvalExpiresAt)}.`,
          replyTo: task.approvalPostId,
        });
        this.store.appendEvent({
          kind: 'task.reminded',
          sessionId: task.createdBy,
          data: { task: task.id },
        });
      });
    }
    this.queue.kick();
  }

  /**
   * One line in a task's thread, within the cap (Q17). Notes and messages
   * stop short of it, so the last lines stay free for state changes
   * (completed, failed, canceled); the first one turned away says so.
   */
  private mirror(task: TaskRecord, text: string, kind: 'state' | 'note'): void {
    if (task.threadPostId === null) return;
    const noteCap = TASK_SLACK.mirrorPerTask - TASK_SLACK.reservedForStates;
    const cap = kind === 'state' ? TASK_SLACK.mirrorPerTask : noteCap;
    let line = text;
    if (!this.tasks.countMirrored(task.id, cap)) {
      if (kind === 'state' || !this.tasks.countMirroredAt(task.id, noteCap)) return;
      line = ":information_source: Further notes and messages on this task aren't mirrored here.";
    }
    this.store.enqueue({ target: FALLBACK_CHANNEL, text: line, replyTo: task.threadPostId });
  }

  /**
   * Kicks the post queue once the caller's transaction has committed: the
   * hooks run inside the task change's transaction, and a rollback must not
   * leave a kick for posts that never existed.
   */
  private kickAfterCommit(): void {
    queueMicrotask(() => this.queue.kick());
  }

  /** A link line in a session's own thread, when that thread exists (announced sessions only). */
  private sessionLine(sessionId: string, text: string): void {
    const session = this.store.getSession(sessionId);
    if (!session?.announcedAt) return;
    this.store.enqueue({
      target: session.channel,
      sessionId: session.id,
      inThread: true,
      text,
      ...postStyle(session.platform, session.project),
    });
  }

  /**
   * Q9: when no session that could take the task was seen in the last
   * 2 hours, the approval DM says so and how to start one.
   */
  private noSessionHint(task: TaskRecord): string | undefined {
    const since = new Date(this.now().getTime() - AGENT_CARDS.seenWithinMs);
    const app = PLATFORM_NAMES[task.targetPlatform];
    const start =
      `Start ${app} in \`${task.targetProject}\` and ask it to call \`list_tasks\` ` +
      'with its session key.';
    if (task.targetSession) {
      const target = this.store.getSession(task.targetSession);
      if (target && target.lastSeenAt >= since.toISOString()) return undefined;
      return `:warning: \`${task.targetSession}\` hasn't been seen in 2 hours. ${start}`;
    }
    const pool = this.store.sessionsSeenFiltered({
      since,
      excludeId: '',
      project: task.targetProject,
      platform: task.targetPlatform,
      limit: 1,
    });
    if (pool.length > 0) return undefined;
    return `:warning: No ${app} session in \`${task.targetProject}\` was seen in 2 hours. ${start}`;
  }

  /** Shows the decision on the approval DM: rewrites it if still queued, or edits it in Slack. */
  private refreshApproval(task: TaskRecord): void {
    if (task.approvalPostId === null) return;
    const message = approvalMessage(task, undefined);
    if (this.store.updateQueuedPost(task.approvalPostId, message.text, message.blocks)) return;
    const post = this.store.getPost(task.approvalPostId);
    if (post?.state === 'sent' && post.slackChannelId && post.slackTs) {
      this.editor.update(post.slackChannelId, post.slackTs, message.text, message.blocks);
    }
  }

  private safeTick(): void {
    try {
      this.tick();
    } catch (error) {
      this.log('error', 'task tick failed', { error: errorMessage(error) });
    }
  }
}

// Rendering. Agent text goes through agentText (escaped, quoted, cut once
// rendered) and titles through title() (one line, no formatting): no
// @channel, user mentions, disguised links or forged lines (T9).

function cut(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

/** Cuts rendered Slack text to `max` characters, never inside an escape (`&amp;`). */
function fitRendered(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).replace(/&[a-z]*$/, '')}…`;
}

/**
 * Agent-written text for Slack: code fences neutralised (an unclosed one
 * would swallow what follows), escaped, every line quoted so none can pass
 * as a heading or a broker line, and then cut to `max` rendered characters.
 * Escaping grows text (`&` becomes `&amp;`), so the cut comes last.
 */
export function agentText(text: string, max: number = Number.POSITIVE_INFINITY): string {
  const quoted = escapeSlackText(text.trim().replaceAll('```', "'''"))
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
  return `\n${fitRendered(quoted, max)}`;
}

/**
 * A task's title for Slack: one line (newlines and runs of spaces become
 * one space), without the characters that format (`*`, `_`, `~`, backtick),
 * cut and escaped. Shown bold, so it must not end the bold or start a line.
 */
export function title(task: TaskRecord): string {
  const plain = task.title.replace(/\s+/g, ' ').replace(/[*_~`]/g, '');
  return escapeSlackText(cut(plain, 120));
}

/** A day and time ("Mon 3:05 AM"): an 8 h wait can end past midnight. */
function localTime(iso: string): string {
  return `on ${new Date(iso).toLocaleString('en-US', {
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit',
  })}`;
}

function targetName(task: TaskRecord): string {
  return task.targetSession ?? `any ${task.targetPlatform} session in ${task.targetProject}`;
}

function threadRootText(task: TaskRecord): string {
  const parent = task.parentId ? ` (sub-task of \`${task.parentId}\`)` : '';
  return (
    `:clipboard: Task \`${task.id}\` from \`${task.createdBy}\` to \`${targetName(task)}\`${parent}: ` +
    `*${title(task)}*\nBrief (the agent's words, whole):${agentText(task.brief)}`
  );
}

function moveLine(task: TaskRecord, from: TaskState, by: string, given?: string): string {
  // Only the note given with this move: the task keeps older notes.
  const note = given ? agentText(given) : '';
  switch (task.state) {
    case 'working':
      return from === 'submitted'
        ? `:arrow_forward: Claimed by \`${by}\`.`
        : `:arrow_forward: \`${by}\` is working on it again.${note}`;
    case 'input-required':
      return `:question: \`${by}\` needs input from \`${task.createdBy}\`:${note}`;
    case 'completed': {
      // Links stay unquoted so Slack makes them clickable: they are https only,
      // checked and parsed by update_task (T12), and escaped here.
      const links = (task.result?.links ?? []).map((link) => `\n• ${escapeSlackText(link)}`);
      return (
        `:white_check_mark: Completed by \`${by}\`:` +
        `${agentText(task.result?.text ?? '')}${links.join('')}${note}`
      );
    }
    case 'failed':
      return `:x: Failed (\`${by}\`):${note}`;
    case 'canceled':
      return `:no_entry_sign: Canceled by \`${by}\`.${note}`;
    case 'rejected':
      return `:leftwards_arrow_with_hook: Rejected by \`${by}\`:${note}`;
    case 'submitted':
      // Only a give-back (from working or input-required) reaches submitted.
      return `:arrows_counterclockwise: Given back by \`${by}\`; open to claim again.${note}`;
  }
}

/** My approval DM: Approve and Cancel while pending, the decision once made. */
export function approvalMessage(
  task: TaskRecord,
  hint: string | undefined,
): { text: string; blocks: unknown[] } {
  const head =
    `:inbox_tray: Task \`${task.id}\` from \`${task.createdBy}\` to \`${targetName(task)}\`` +
    `${task.parentId ? ` (sub-task of \`${task.parentId}\`)` : ''}:\n*${title(task)}*`;
  // The brief gets what's left of the section's limit once rendered; the
  // thread has it whole.
  const room = TASK_SLACK.sectionChars - head.length - 1;
  const section = {
    type: 'section',
    text: { type: 'mrkdwn', text: `${head}${agentText(task.brief, room)}` },
  };
  const fallback = `:inbox_tray: Task ${task.id} from ${task.createdBy} waits for your approval`;
  if (task.approval === 'pending') {
    const context = [
      `Approve delivers it to the target; it doesn't mean you endorse it. ` +
        `No answer by ${localTime(task.approvalExpiresAt).slice(3)}: it expires.`,
      ...(hint ? [hint] : []),
    ].join('\n');
    return {
      text: fallback,
      blocks: [
        section,
        {
          type: 'actions',
          block_id: task.id,
          elements: [
            {
              type: 'button',
              action_id: 'agentbus_task_approve',
              style: 'primary',
              text: { type: 'plain_text', text: 'Approve', emoji: false },
              value: task.id,
            },
            {
              type: 'button',
              action_id: 'agentbus_task_cancel',
              style: 'danger',
              text: { type: 'plain_text', text: 'Cancel', emoji: false },
              value: task.id,
            },
          ],
        },
        { type: 'context', elements: [{ type: 'mrkdwn', text: context }] },
      ],
    };
  }
  const outcome = {
    approved: ':white_check_mark: Approved: the target can see it now.',
    canceled: ':no_entry_sign: Canceled.',
    expired: `:hourglass: Expired ${localTime(task.approvalExpiresAt)}.`,
  }[task.approval];
  return {
    text: `${fallback} (${task.approval})`,
    blocks: [section, { type: 'context', elements: [{ type: 'mrkdwn', text: outcome }] }],
  };
}

/** Feedback for a click that didn't decide anything, shown only to the clicker. */
export const TASK_CLICK_REPLIES: Partial<Record<TaskClickOutcome, string>> = {
  closed: 'This task was already decided or has expired.',
  not_human: 'Only Nick can approve or cancel agent tasks.',
  unknown: 'agent-bus no longer knows this task.',
};
