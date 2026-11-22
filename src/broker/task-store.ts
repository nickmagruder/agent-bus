import { randomBytes } from 'node:crypto';
import type { Platform } from '../shared/platform.ts';
import { canMoveTask, TERMINAL_TASK_STATES, type TaskState } from '../shared/task-states.ts';
import type { Store } from './store.ts';

/**
 * Phase 3 records (#57): tasks and task messages, on the broker's SQLite
 * store (migration 8). Every change to a task's state or approval is a
 * compare-and-swap written to the audit log in the same transaction, so two
 * agents racing for one task can't both win and nothing changes unrecorded.
 * Who may make which change (holder, creator, me) is the tools' rule (#59);
 * the store refuses only moves that make no sense (TASK_TRANSITIONS).
 */

export type TaskApproval = 'pending' | 'approved' | 'canceled' | 'expired';

/** A task's result: one A2A artifact with a text part and a URL part per link (grilling Q19). */
export interface TaskResult {
  text: string;
  links: string[];
}

export interface TaskRecord {
  /** `t-` and 6 hex characters. */
  id: string;
  /** A2A `contextId`: the root task's ID, shared by a task and its sub-task. */
  contextId: string;
  parentId: string | null;
  /**
   * 0 for a task, 1 for its sub-task. The store records any depth; the hop
   * limit (D5) and loop refusal (Q18) are create_task's rules (#59).
   */
  hops: number;
  createdBy: string;
  title: string;
  brief: string;
  /** The named target, or null for "any session of targetPlatform in targetProject". */
  targetSession: string | null;
  targetPlatform: Platform;
  targetProject: string;
  /** The session that claimed it, while it's being worked on. */
  holder: string | null;
  state: TaskState;
  /** A2A status message: the last `update_task` note. */
  statusMessage: string | null;
  result: TaskResult | null;
  approval: TaskApproval;
  approvalExpiresAt: string;
  approvedAt: string | null;
  approvalPostId: number | null;
  slackChannelId: string | null;
  threadTs: string | null;
  /** Last sign of life from the holder, for the stuck flag (Q8). */
  holderSeenAt: string | null;
  /** When it was flagged stuck (holder silent > 4 h, Q8). */
  stuckAt: string | null;
  /** When it was flagged as waiting unclaimed (> 24 h, Q23). */
  waitingAt: string | null;
  createdAt: string;
  /** A2A status timestamp: the last change. */
  updatedAt: string;
  closedAt: string | null;
}

export interface NewTask {
  createdBy: string;
  title: string;
  brief: string;
  targetSession: string | null;
  targetPlatform: Platform;
  targetProject: string;
  /** The task the creator holds, set by the broker (Q4), never by the agent. */
  parentId?: string | null;
  approvalExpiresAt: Date;
}

/** Who made a change: a session ID, me, or the broker (expiry, stuck flags). */
export type TaskActor = string;
export const ACTOR = { nick: 'nick', broker: 'agent-bus' } as const;

export interface TaskMove {
  from: TaskState;
  to: TaskState;
  by: TaskActor;
  /** The claiming session, for submitted → working. */
  holder?: string;
  /**
   * For moves out of working or input-required: the holder the caller read.
   * Checked in the same statement as the state, so a holder whose task was
   * released and claimed by another can't close it with a late call (ABA).
   */
  expectedHolder?: string;
  statusMessage?: string | null;
  result?: TaskResult | null;
}

/** States that have a holder: moves out of them check it (TaskMove.expectedHolder). */
const HELD_STATES: ReadonlySet<TaskState> = new Set(['working', 'input-required']);

/**
 * What a move does to the holder: a claim sets it, a release (back to
 * submitted) clears it, anything else keeps it (undefined).
 */
function holderAfter(move: TaskMove): string | null | undefined {
  if (move.to === 'submitted') return null;
  if (move.from === 'submitted' && move.to === 'working') return move.holder ?? null;
  return undefined;
}

export type TaskMessageSender = 'agent' | 'human';

export interface TaskMessageRecord {
  id: number;
  taskId: string;
  sender: TaskMessageSender;
  /** The sending session, stamped by the broker; null for my messages. */
  fromSession: string | null;
  slackUser: string | null;
  /** A2A role: `user` for the side that asked, `agent` for the side doing it. */
  role: 'user' | 'agent';
  body: string;
  slackChannelId: string | null;
  slackTs: string | null;
  createdAt: string;
}

export type NewTaskMessage =
  | { taskId: string; sender: 'agent'; fromSession: string; role: 'user' | 'agent'; body: string }
  | {
      taskId: string;
      sender: 'human';
      slackUser: string;
      role: 'user' | 'agent';
      body: string;
      slackChannelId: string;
      slackTs: string;
    };

export class TaskMoveError extends Error {
  constructor(from: TaskState, to: TaskState) {
    super(`A task can't move from ${from} to ${to}.`);
    this.name = 'TaskMoveError';
  }
}

type Row = Record<string, unknown>;

export class TaskStore {
  private readonly store: Store;
  private readonly now: () => Date;

  constructor(store: Store, now: () => Date = () => new Date()) {
    this.store = store;
    this.now = now;
  }

  /** Records a new task (submitted, awaiting my approval) and audits it. */
  insertTask(task: NewTask): TaskRecord {
    return this.store.transaction(() => {
      const parent = task.parentId ? this.getTask(task.parentId) : undefined;
      if (task.parentId && !parent) throw new Error(`Unknown parent task ${task.parentId}`);
      const id = this.newTaskId();
      const at = this.timestamp();
      this.store.db
        .prepare(
          `INSERT INTO tasks
             (id, context_id, parent_id, hops, created_by, title, brief, target_session,
              target_platform, target_project, approval_expires_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          parent?.contextId ?? id,
          parent?.id ?? null,
          parent ? parent.hops + 1 : 0,
          task.createdBy,
          task.title,
          task.brief,
          task.targetSession,
          task.targetPlatform,
          task.targetProject,
          task.approvalExpiresAt.toISOString(),
          at,
          at,
        );
      this.store.appendEvent({
        kind: 'task.created',
        sessionId: task.createdBy,
        data: {
          task: id,
          target: task.targetSession ?? `${task.targetPlatform}/${task.targetProject}`,
          parent: parent?.id ?? null,
          hops: parent ? parent.hops + 1 : 0,
        },
      });
      return found(this.getTask(id), id);
    });
  }

  getTask(id: string): TaskRecord | undefined {
    const row = this.store.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as
      Row | undefined;
    return row && toTask(row);
  }

  /**
   * Moves a task from `from` to `to` if it's still in `from` (compare and
   * swap); returns the updated task, or undefined when another change got
   * there first. The same statement also checks:
   * - a claim (submitted → working): the task is approved (D2), and sets the holder;
   * - a move out of working or input-required: the holder is still
   *   `expectedHolder`, so a stale holder can't close a re-claimed task.
   * A release (back to submitted) clears the holder; a final state stamps
   * `closedAt` and clears the stuck and waiting flags. Throws TaskMoveError
   * for a move that's never allowed. Audited as `task.state`.
   */
  moveTask(id: string, move: TaskMove): TaskRecord | undefined {
    if (!canMoveTask(move.from, move.to)) throw new TaskMoveError(move.from, move.to);
    const claim = move.from === 'submitted' && move.to === 'working';
    if (claim && !move.holder) throw new Error('Claiming a task needs the holder');
    if (HELD_STATES.has(move.from) && !move.expectedHolder) {
      throw new Error(`Moving a task out of ${move.from} needs the holder it expects`);
    }
    return this.store.transaction(() => {
      const at = this.timestamp();
      const holder = holderAfter(move);
      const sets = ['state = ?', 'updated_at = ?'];
      const values: (string | null)[] = [move.to, at];
      if (holder !== undefined) {
        sets.push('holder = ?', 'holder_seen_at = ?');
        values.push(holder, holder ? at : null);
      }
      if (move.statusMessage !== undefined) {
        sets.push('status_message = ?');
        values.push(move.statusMessage);
      }
      if (move.result !== undefined) {
        sets.push('result = ?');
        values.push(move.result ? JSON.stringify(move.result) : null);
      }
      if (TERMINAL_TASK_STATES.has(move.to)) {
        sets.push('closed_at = ?');
        values.push(at);
      }
      if (
        move.to === 'submitted' ||
        move.from === 'submitted' ||
        TERMINAL_TASK_STATES.has(move.to)
      ) {
        // A claim or release starts the stuck and waiting clocks over; a
        // closed task is neither.
        sets.push('stuck_at = NULL', 'waiting_at = NULL');
      }
      const where = ['id = ?', 'state = ?'];
      const whereValues: string[] = [id, move.from];
      if (claim) where.push("approval = 'approved'");
      if (HELD_STATES.has(move.from)) {
        where.push('holder = ?');
        whereValues.push(move.expectedHolder ?? '');
      }
      const changed = this.store.db
        .prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE ${where.join(' AND ')}`)
        .run(...values, ...whereValues).changes;
      if (changed === 0) return undefined;
      this.store.appendEvent({
        kind: 'task.state',
        sessionId: isSession(move.by) ? move.by : null,
        data: { task: id, from: move.from, to: move.to, by: move.by },
      });
      return found(this.getTask(id), id);
    });
  }

  /**
   * Decides a pending approval (compare and swap on `pending` and on the task
   * still being submitted); undefined when it was already decided or the task
   * moved on. Canceling or expiring the approval cancels the task in the same
   * transaction, so a refused task can never look claimable. Audited as
   * `task.approval` (and `task.state` when the task is canceled).
   */
  decideApproval(
    id: string,
    to: Exclude<TaskApproval, 'pending'>,
    by: TaskActor,
  ): TaskRecord | undefined {
    return this.store.transaction(() => {
      const at = this.timestamp();
      const approved = to === 'approved';
      const changed = this.store.db
        .prepare(
          `UPDATE tasks SET approval = ?, approved_at = ?, updated_at = ?,
             state = ?, closed_at = ?, stuck_at = NULL, waiting_at = NULL
           WHERE id = ? AND approval = 'pending' AND state = 'submitted'`,
        )
        .run(
          to,
          approved ? at : null,
          at,
          approved ? 'submitted' : 'canceled',
          approved ? null : at,
          id,
        ).changes;
      if (changed === 0) return undefined;
      const sessionId = isSession(by) ? by : null;
      this.store.appendEvent({
        kind: 'task.approval',
        sessionId,
        data: { task: id, from: 'pending', to, by },
      });
      if (!approved) {
        this.store.appendEvent({
          kind: 'task.state',
          sessionId,
          data: { task: id, from: 'submitted', to: 'canceled', by },
        });
      }
      return found(this.getTask(id), id);
    });
  }

  /**
   * Adds a message to a task's discussion; audited as `task.message`
   * (without the body). One of my Slack messages is stored once: a Slack
   * retry of the same channel and ts returns the stored message and changes
   * nothing.
   */
  addTaskMessage(message: NewTaskMessage): TaskMessageRecord {
    return this.store.transaction(() => {
      const at = this.timestamp();
      const human = message.sender === 'human';
      if (human) {
        const existing = this.store.db
          .prepare('SELECT * FROM task_messages WHERE slack_channel_id = ? AND slack_ts = ?')
          .get(message.slackChannelId, message.slackTs) as Row | undefined;
        if (existing) return toTaskMessage(existing);
      }
      const result = this.store.db
        .prepare(
          `INSERT INTO task_messages
             (task_id, sender, from_session, slack_user, role, body, slack_channel_id, slack_ts, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          message.taskId,
          message.sender,
          human ? null : message.fromSession,
          human ? message.slackUser : null,
          message.role,
          message.body,
          human ? message.slackChannelId : null,
          human ? message.slackTs : null,
          at,
        );
      const id = Number(result.lastInsertRowid);
      this.store.db.prepare('UPDATE tasks SET updated_at = ? WHERE id = ?').run(at, message.taskId);
      this.store.appendEvent({
        kind: 'task.message',
        sessionId: human ? null : message.fromSession,
        data: { task: message.taskId, message: id, sender: message.sender, role: message.role },
      });
      return found(this.taskMessage(id), String(id));
    });
  }

  /** Tasks a session holds and is still working on (working or input-required), newest first. */
  heldTasks(sessionId: string): TaskRecord[] {
    const rows = this.store.db
      .prepare(
        `SELECT * FROM tasks WHERE holder = ? AND state IN ('working', 'input-required')
         ORDER BY updated_at DESC, id`,
      )
      .all(sessionId) as Row[];
    return rows.map(toTask);
  }

  /** Open (not final) tasks for one target: a named session, or a platform + project pool. */
  countOpenForTarget(
    target: { session: string } | { platform: Platform; project: string },
    creatorPlatform: Platform,
  ): number {
    // Open: not final. A canceled or expired approval already canceled the
    // task (decideApproval), so it doesn't count. Only tasks from the
    // creator's platform count, so one platform can't block another's.
    const open = `tasks.state NOT IN ('completed', 'failed', 'canceled', 'rejected')
      AND sessions.platform = ?`;
    const from = 'FROM tasks JOIN sessions ON sessions.id = tasks.created_by';
    const row =
      'session' in target
        ? this.store.db
            .prepare(`SELECT COUNT(*) AS n ${from} WHERE tasks.target_session = ? AND ${open}`)
            .get(target.session, creatorPlatform)
        : this.store.db
            .prepare(
              `SELECT COUNT(*) AS n ${from} WHERE tasks.target_session IS NULL
               AND tasks.target_platform = ? AND tasks.target_project = ? AND ${open}`,
            )
            .get(target.platform, target.project, creatorPlatform);
    return Number((row as Row).n);
  }

  /** Tasks created by sessions of one platform that still wait for my approval. */
  countAwaitingApproval(creatorPlatform: Platform): number {
    const row = this.store.db
      .prepare(
        `SELECT COUNT(*) AS n FROM tasks JOIN sessions ON sessions.id = tasks.created_by
         WHERE sessions.platform = ? AND tasks.approval = 'pending' AND tasks.state = 'submitted'`,
      )
      .get(creatorPlatform) as Row;
    return Number(row.n);
  }

  /**
   * The tasks a session may see, most recently changed first (#59, T7): ones
   * it created or holds; approved ones named for it; and approved, unclaimed
   * ones in its pool (its platform and project). Nothing else.
   */
  visibleTasks(
    session: { id: string; platform: Platform; project: string },
    limit: number,
  ): TaskRecord[] {
    const rows = this.store.db
      .prepare(
        `SELECT * FROM tasks WHERE created_by = ? OR holder = ?
           OR (approval = 'approved' AND (target_session = ?
             OR (target_session IS NULL AND target_platform = ? AND target_project = ?
                 AND state = 'submitted')))
         ORDER BY updated_at DESC, id LIMIT ?`,
      )
      .all(session.id, session.id, session.id, session.platform, session.project, limit) as Row[];
    return rows.map(toTask);
  }

  /** A task's messages, oldest first. */
  taskMessages(taskId: string): TaskMessageRecord[] {
    const rows = this.store.db
      .prepare('SELECT * FROM task_messages WHERE task_id = ? ORDER BY id')
      .all(taskId) as Row[];
    return rows.map(toTaskMessage);
  }

  private taskMessage(id: number): TaskMessageRecord | undefined {
    const row = this.store.db.prepare('SELECT * FROM task_messages WHERE id = ?').get(id) as
      Row | undefined;
    return row && toTaskMessage(row);
  }

  private newTaskId(): string {
    for (;;) {
      const id = `t-${randomBytes(3).toString('hex')}`;
      if (!this.getTask(id)) return id;
    }
  }

  private timestamp(): string {
    return this.now().toISOString();
  }
}

/** Session IDs have slashes; `nick` and `agent-bus` don't. */
function isSession(actor: TaskActor): boolean {
  return actor.includes('/');
}

function found<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`Missing ${what}`);
  return value;
}

function text(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function toTask(row: Row): TaskRecord {
  const result = text(row.result);
  return {
    id: String(row.id),
    contextId: String(row.context_id),
    parentId: text(row.parent_id),
    hops: Number(row.hops),
    createdBy: String(row.created_by),
    title: String(row.title),
    brief: String(row.brief),
    targetSession: text(row.target_session),
    targetPlatform: row.target_platform as Platform,
    targetProject: String(row.target_project),
    holder: text(row.holder),
    state: row.state as TaskState,
    statusMessage: text(row.status_message),
    result: result ? (JSON.parse(result) as TaskResult) : null,
    approval: row.approval as TaskApproval,
    approvalExpiresAt: String(row.approval_expires_at),
    approvedAt: text(row.approved_at),
    approvalPostId: row.approval_post_id === null ? null : Number(row.approval_post_id),
    slackChannelId: text(row.slack_channel_id),
    threadTs: text(row.thread_ts),
    holderSeenAt: text(row.holder_seen_at),
    stuckAt: text(row.stuck_at),
    waitingAt: text(row.waiting_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    closedAt: text(row.closed_at),
  };
}

function toTaskMessage(row: Row): TaskMessageRecord {
  return {
    id: Number(row.id),
    taskId: String(row.task_id),
    sender: row.sender as TaskMessageSender,
    fromSession: text(row.from_session),
    slackUser: text(row.slack_user),
    role: row.role as 'user' | 'agent',
    body: String(row.body),
    slackChannelId: text(row.slack_channel_id),
    slackTs: text(row.slack_ts),
    createdAt: String(row.created_at),
  };
}
