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

/** Items in one take. */
export const TASK_INBOX_TAKE = 20;

type Row = Record<string, unknown>;

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
    options: { limit?: number; kinds?: readonly TaskInboxKind[]; task?: string } = {},
  ): TaskInboxTake {
    return this.store.transaction(() => {
      if (!options.kinds || options.kinds.includes('offer')) this.offerPoolTasks(session);
      const where = ['session_id = ?', 'delivered_at IS NULL'];
      const values: (string | number)[] = [session.id];
      if (options.kinds) {
        where.push(`kind IN (${options.kinds.map(() => '?').join(', ')})`);
        values.push(...options.kinds);
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
      for (const row of taken) {
        mark.run(at, via, Number(row.id));
        const item = this.toItem(row);
        if (item) items.push(item);
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

  private toItem(row: Row): TaskInboxItem | undefined {
    const task = this.tasks.getTask(String(row.task_id));
    if (!task) return undefined;
    const kind = row.kind as TaskInboxKind;
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
