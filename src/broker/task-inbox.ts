import type { DeliveryVia, SessionRecord, Store } from './store.ts';
import {
  TaskStore,
  type TaskMessageRecord,
  type TaskNotice,
  type TaskRecord,
} from './task-store.ts';

/**
 * Getting task work to agents (#60). Agents can't be pushed to, so each
 * session has a task inbox of pointers (`task_inbox`, Q12): an offer of a
 * task it may claim, a message on a task it's part of, or one of the fixed
 * broker notices (D3, Q21). Tasks stay the record; a pointer only says
 * "look at this". Taking marks pointers delivered; a held call that's
 * cancelled, or a Stop-hook block that never reached the agent, puts them
 * back.
 */

export type TaskInboxKind = 'offer' | 'message' | 'notice';

export interface TaskInboxItem {
  /** The pointer's ID. */
  id: number;
  kind: TaskInboxKind;
  task: TaskRecord;
  /** For a message. */
  message?: TaskMessageRecord;
  /** For a notice. */
  notice?: TaskNotice;
  createdAt: string;
}

export interface TaskInboxTake {
  items: TaskInboxItem[];
  /** Pointers still waiting after this take. */
  remaining: number;
}

/** Items in one take: other agents' text, so kept small (review of #89). */
export const TASK_INBOX_TAKE = 10;

/** Brief characters in an offer; the whole brief is one list_tasks call away. */
export const OFFER_BRIEF_CHARS = 300;

type Row = Record<string, unknown>;

/** A task item that is my own reply in the task's Slack thread: my words, not an agent's. */
export function isNickReply(item: TaskInboxItem): boolean {
  return item.kind === 'message' && item.message?.sender === 'human';
}

/**
 * Who hears my reply in a task's thread: its creator, and whoever holds it,
 * or (before a claim) its named target once I've approved it. A pool task
 * nobody has claimed has no other side yet.
 */
export function replyRecipients(task: TaskRecord): string[] {
  const other = task.holder ?? (task.approval === 'approved' ? task.targetSession : null);
  return other && other !== task.createdBy ? [task.createdBy, other] : [task.createdBy];
}

export class TaskInbox {
  private readonly store: Store;
  private readonly tasks: TaskStore;
  private readonly now: () => Date;

  constructor(store: Store, now: () => Date = () => new Date()) {
    this.store = store;
    this.tasks = new TaskStore(store, now);
    this.now = now;
  }

  /**
   * Takes a session's undelivered pointers, oldest first, marking them
   * delivered via `via`. First it offers the session, once each, the
   * approved and unclaimed pool tasks for its platform and project (D7, Q13):
   * a pool has no session to address until one checks in. `kinds` limits
   * what's taken (the Stop hook takes notices only, D3); `task` limits it to
   * one task (wait_for_reply's `task`).
   */
  take(
    session: SessionRecord,
    via: DeliveryVia,
    options: { limit?: number; stopSafe?: boolean; task?: string } = {},
  ): TaskInboxTake {
    return this.store.transaction(() => {
      // A narrowed take (one task, or the Stop hook's) creates no offers:
      // they'd wait undelivered and could go stale.
      if (!options.task && !options.stopSafe) this.offerPoolTasks(session);
      const where = ['session_id = ?', 'delivered_at IS NULL'];
      const values: (string | number)[] = [session.id];
      if (options.stopSafe) {
        // Only what may ride the Stop hook (D3): the broker's fixed notices
        // and my own replies in task threads, never agent text.
        where.push(
          `(kind = 'notice' OR (kind = 'message' AND EXISTS (SELECT 1 FROM task_messages m
             WHERE m.id = task_inbox.message_id AND m.sender = 'human')))`,
        );
      }
      if (options.task !== undefined) {
        where.push('task_id = ?');
        values.push(options.task);
      }
      const rows = this.store.db
        .prepare(`SELECT * FROM task_inbox WHERE ${where.join(' AND ')} ORDER BY id`)
        .all(...values) as Row[];
      const limit = options.limit ?? TASK_INBOX_TAKE;
      const taken = rows.slice(0, limit);
      const at = this.now().toISOString();
      const mark = this.store.db.prepare(
        'UPDATE task_inbox SET delivered_at = ?, delivered_via = ? WHERE id = ?',
      );
      const items: TaskInboxItem[] = [];
      const dropped: number[] = [];
      for (const row of taken) {
        mark.run(at, via, Number(row.id));
        const item = this.toItem(row, session);
        if (item) items.push(item);
        else dropped.push(Number(row.id));
      }
      if (dropped.length > 0) {
        // An offer for a task that's no longer open to this session (claimed,
        // canceled), or a pointer whose task or message is gone: handled, not shown.
        this.store.appendEvent({
          kind: 'task_inbox.dropped',
          platform: session.platform,
          sessionId: session.id,
          data: { via, ids: dropped },
        });
      }
      if (items.length > 0) {
        this.store.appendEvent({
          kind: 'task_inbox.delivered',
          platform: session.platform,
          sessionId: session.id,
          data: { via, ids: items.map((item) => item.id) },
        });
      }
      return { items, remaining: rows.length - taken.length };
    });
  }

  /**
   * My reply in a task's Slack thread (#61): stored once as my message on
   * the task and pointed at each side, the creator and whoever holds it (or
   * the named target of an approved task before a claim). Undefined when the
   * thread isn't a task's. A Slack retry of a stored reply changes nothing
   * (`inserted: false`).
   */
  routeNickReply(reply: {
    slackChannelId: string;
    threadTs: string;
    slackTs: string;
    slackUser: string;
    body: string;
  }): { task: TaskRecord; recipients: string[]; inserted: boolean } | undefined {
    return this.store.transaction(() => {
      const task = this.tasks.findByThread(reply.slackChannelId, reply.threadTs);
      if (!task) return undefined;
      const recipients = replyRecipients(task);
      if (this.tasks.findSlackMessage(reply.slackChannelId, reply.slackTs)) {
        return { task, recipients, inserted: false };
      }
      const message = this.tasks.addTaskMessage({
        taskId: task.id,
        sender: 'human',
        slackUser: reply.slackUser,
        role: 'user',
        body: reply.body,
        slackChannelId: reply.slackChannelId,
        slackTs: reply.slackTs,
      });
      for (const sessionId of recipients) {
        this.tasks.addMessagePointer(sessionId, task.id, message.id);
      }
      this.store.appendEvent({
        kind: 'inbound.routed',
        sessionId: task.createdBy,
        data: {
          task: task.id,
          message: message.id,
          recipients,
          channel: reply.slackChannelId,
          ts: reply.slackTs,
        },
      });
      return { task, recipients, inserted: true };
    });
  }

  /** My replies among these items that every recipient now has (each earns its ✅). */
  fullyDeliveredReplies(items: readonly TaskInboxItem[]): TaskMessageRecord[] {
    return this.tasks.fullyDeliveredReplies(
      items.filter(isNickReply).map((item) => item.message?.id ?? -1),
    );
  }

  /** `fullyDeliveredReplies` for pointer IDs (a confirmed Stop-hook offer). */
  fullyDeliveredRepliesByPointer(pointerIds: readonly number[]): TaskMessageRecord[] {
    if (pointerIds.length === 0) return [];
    const rows = this.store.db
      .prepare(
        `SELECT message_id FROM task_inbox
         WHERE id IN (${pointerIds.map(() => '?').join(', ')}) AND message_id IS NOT NULL`,
      )
      .all(...pointerIds) as Row[];
    return this.tasks.fullyDeliveredReplies(rows.map((row) => Number(row.message_id)));
  }

  /** Puts pointers back as undelivered; only ones delivered via `via` (a cancelled call or block). */
  untakeIds(session: SessionRecord, ids: readonly number[], via: DeliveryVia): void {
    if (ids.length === 0) return;
    this.store.transaction(() => {
      const put = this.store.db.prepare(
        `UPDATE task_inbox SET delivered_at = NULL, delivered_via = NULL
         WHERE id = ? AND session_id = ? AND delivered_via = ?`,
      );
      let n = 0;
      for (const id of ids) n += Number(put.run(id, session.id, via).changes);
      if (n > 0) {
        this.store.appendEvent({
          kind: 'task_inbox.undelivered',
          platform: session.platform,
          sessionId: session.id,
          data: { via, ids: [...ids] },
        });
      }
    });
  }

  /** Runs work in one transaction with the task inbox (so a take of Nick's replies and of task items commit together). */
  together<T>(work: () => T): T {
    return this.store.transaction(work);
  }

  /** Undelivered pointers for a session (for the hint when check_inbox has no key). */
  countWaiting(sessionId: string): number {
    const row = this.store.db
      .prepare('SELECT COUNT(*) AS n FROM task_inbox WHERE session_id = ? AND delivered_at IS NULL')
      .get(sessionId) as Row;
    return Number(row.n);
  }

  private offerPoolTasks(session: SessionRecord): void {
    const rows = this.store.db
      .prepare(
        `SELECT id FROM tasks
         WHERE target_session IS NULL AND target_platform = ? AND target_project = ?
           AND approval = 'approved' AND state = 'submitted' AND created_by != ?
           AND NOT EXISTS (SELECT 1 FROM task_inbox
                           WHERE task_inbox.task_id = tasks.id AND task_inbox.session_id = ?
                             AND task_inbox.kind = 'offer')
         ORDER BY created_at, id`,
      )
      .all(session.platform, session.project, session.id, session.id) as Row[];
    const at = this.now().toISOString();
    const insert = this.store.db.prepare(
      `INSERT INTO task_inbox (session_id, task_id, kind, created_at) VALUES (?, ?, 'offer', ?)`,
    );
    for (const row of rows) insert.run(session.id, String(row.id), at);
  }

  /**
   * A pointer as an item, or undefined when there's nothing to hand over. An
   * offer is re-checked when it's handed over, not only when it was made: a
   * pool task claimed or canceled meanwhile is no longer open (T7).
   */
  private toItem(row: Row, session: SessionRecord): TaskInboxItem | undefined {
    const task = this.tasks.getTask(String(row.task_id));
    if (!task) return undefined;
    const kind = row.kind as TaskInboxKind;
    if (kind === 'offer') {
      const open =
        task.approval === 'approved' &&
        task.state === 'submitted' &&
        task.targetSession === null &&
        task.targetPlatform === session.platform &&
        task.targetProject === session.project;
      if (!open) return undefined;
    }
    const base = { id: Number(row.id), kind, task, createdAt: String(row.created_at) };
    if (kind === 'message') {
      const message = this.tasks
        .taskMessages(task.id)
        .find((candidate) => candidate.id === Number(row.message_id));
      return message ? { ...base, message } : undefined;
    }
    if (kind === 'notice') return { ...base, notice: row.notice as TaskNotice };
    return base;
  }
}
