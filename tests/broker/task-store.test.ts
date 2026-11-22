import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../../src/broker/store.ts';
import {
  ACTOR,
  TaskMoveError,
  TaskStore,
  type NewTask,
  type TaskRecord,
} from '../../src/broker/task-store.ts';
import type { Platform } from '../../src/shared/platform.ts';
import {
  A2A_TASK_STATE,
  canMoveTask,
  TASK_STATES,
  TASK_TRANSITIONS,
  TERMINAL_TASK_STATES,
  type TaskState,
} from '../../src/shared/task-states.ts';

let store: Store;
let tasks: TaskStore;
let now: Date;

const CLAUDE = 'claude/clankers/aaaa';
const CODEX = 'codex/clankers/bbbb';
const CODEX_2 = 'codex/clankers/cccc';

beforeEach(() => {
  now = new Date('2026-11-22T20:00:00Z');
  store = new Store(':memory:', { now: () => now });
  tasks = new TaskStore(store, () => now);
  for (const [id, platform] of [
    [CLAUDE, 'claude'],
    [CODEX, 'codex'],
    [CODEX_2, 'codex'],
  ] as const) {
    store.insertSession({
      id,
      platform,
      project: 'clankers',
      branch: 'main',
      purpose: null,
      channel: 'proj-clankers',
    });
  }
});

afterEach(() => store.close());

function newTask(overrides: Partial<NewTask> = {}): TaskRecord {
  return tasks.insertTask({
    createdBy: CLAUDE,
    title: 'Implement the plan',
    brief: 'Plan in docs/plan.md; open a PR.',
    targetSession: CODEX,
    targetPlatform: 'codex' as Platform,
    targetProject: 'clankers',
    approvalExpiresAt: new Date('2026-11-23T04:00:00Z'),
    ...overrides,
  });
}

/** A task I've approved, so it can be claimed (D2). */
function approvedTask(overrides: Partial<NewTask> = {}): TaskRecord {
  const task = newTask(overrides);
  const approved = tasks.decideApproval(task.id, 'approved', ACTOR.nick);
  if (!approved) throw new Error('approval failed');
  return approved;
}

function events(kind: string): { session_id: string | null; data: Record<string, unknown> }[] {
  const rows = store.db
    .prepare('SELECT session_id, data FROM events WHERE kind = ? ORDER BY id')
    .all(kind) as { session_id: string | null; data: string }[];
  return rows.map((row) => ({
    session_id: row.session_id,
    data: JSON.parse(row.data) as Record<string, unknown>,
  }));
}

describe('task states (D8)', () => {
  it('maps every A2A v1.0 state except UNSPECIFIED to exactly one internal name', () => {
    const a2a = [
      'TASK_STATE_SUBMITTED',
      'TASK_STATE_WORKING',
      'TASK_STATE_INPUT_REQUIRED',
      'TASK_STATE_COMPLETED',
      'TASK_STATE_FAILED',
      'TASK_STATE_CANCELED',
      'TASK_STATE_REJECTED',
      'TASK_STATE_AUTH_REQUIRED',
    ];
    const mapped = Object.values(A2A_TASK_STATE);
    expect([...mapped].sort()).toEqual([...a2a].sort());
    expect(new Set(mapped).size).toBe(mapped.length);
    expect(mapped).not.toContain('TASK_STATE_UNSPECIFIED');
  });

  it('stores every state but auth-required, which tasks never use', () => {
    expect(
      Object.keys(A2A_TASK_STATE)
        .filter((s) => s !== 'auth-required')
        .sort(),
    ).toEqual([...TASK_STATES].sort());
    expect(TASK_STATES).not.toContain('auth-required');
  });

  it('lets nothing leave a final state, and every other state go somewhere', () => {
    for (const state of TASK_STATES) {
      expect(TASK_TRANSITIONS[state].length === 0).toBe(TERMINAL_TASK_STATES.has(state));
    }
  });
});

describe('insertTask', () => {
  it('records a submitted, pending task that is its own A2A context, and audits it', () => {
    const task = newTask();
    expect(task).toMatchObject({
      id: expect.stringMatching(/^t-[0-9a-f]{6}$/) as unknown,
      contextId: task.id,
      parentId: null,
      hops: 0,
      state: 'submitted',
      approval: 'pending',
      holder: null,
      approvalExpiresAt: '2026-11-23T04:00:00.000Z',
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      closedAt: null,
    });
    expect(events('task.created')).toEqual([
      {
        session_id: CLAUDE,
        data: { task: task.id, target: CODEX, parent: null, hops: 0 },
      },
    ]);
  });

  it('records a pool task for any session of a platform in a project', () => {
    const task = newTask({
      targetSession: null,
      targetPlatform: 'copilot',
      targetProject: 'crashmap',
    });
    expect(task).toMatchObject({
      targetSession: null,
      targetPlatform: 'copilot',
      targetProject: 'crashmap',
    });
    expect(events('task.created')[0]?.data.target).toBe('copilot/crashmap');
  });

  it('gives a sub-task its parent, one more hop, and the same context', () => {
    const parent = newTask();
    const child = newTask({ createdBy: CODEX, targetSession: CLAUDE, parentId: parent.id });
    expect(child).toMatchObject({ parentId: parent.id, hops: 1, contextId: parent.id });
    const grandchild = newTask({ createdBy: CLAUDE, targetSession: CODEX_2, parentId: child.id });
    expect(grandchild).toMatchObject({ hops: 2, contextId: parent.id });
  });

  it('refuses an unknown parent or creator, writing nothing', () => {
    expect(() => newTask({ parentId: 't-000000' })).toThrow('Unknown parent task');
    expect(() => newTask({ createdBy: 'codex/x/0000' })).toThrow();
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM tasks').get()).toEqual({ n: 0 });
    expect(events('task.created')).toEqual([]);
  });
});

describe('moveTask', () => {
  it('claims an approved, submitted task for its holder', () => {
    const task = approvedTask();
    now = new Date('2026-11-22T20:05:00Z');
    const claimed = tasks.moveTask(task.id, {
      from: 'submitted',
      to: 'working',
      by: CODEX,
      holder: CODEX,
    });
    expect(claimed).toMatchObject({
      state: 'working',
      holder: CODEX,
      holderSeenAt: now.toISOString(),
      updatedAt: now.toISOString(),
    });
    expect(events('task.state')).toEqual([
      { session_id: CODEX, data: { task: task.id, from: 'submitted', to: 'working', by: CODEX } },
    ]);
  });

  it('lets only one of two racing claims win (compare and swap)', () => {
    const task = approvedTask({ targetSession: null });
    const first = tasks.moveTask(task.id, {
      from: 'submitted',
      to: 'working',
      by: CODEX,
      holder: CODEX,
    });
    const second = tasks.moveTask(task.id, {
      from: 'submitted',
      to: 'working',
      by: CODEX_2,
      holder: CODEX_2,
    });
    expect(first?.holder).toBe(CODEX);
    expect(second).toBeUndefined();
    expect(tasks.getTask(task.id)?.holder).toBe(CODEX);
    expect(events('task.state')).toHaveLength(1);
  });

  it('needs a holder to claim', () => {
    const task = newTask();
    expect(() => tasks.moveTask(task.id, { from: 'submitted', to: 'working', by: CODEX })).toThrow(
      'needs the holder',
    );
  });

  it('stores the note and result, and closes the task on a final state', () => {
    const task = approvedTask();
    tasks.moveTask(task.id, { from: 'submitted', to: 'working', by: CODEX, holder: CODEX });
    tasks.moveTask(task.id, {
      from: 'working',
      to: 'input-required',
      by: CODEX,
      expectedHolder: CODEX,
      statusMessage: 'Which branch?',
    });
    tasks.moveTask(task.id, {
      from: 'input-required',
      to: 'working',
      by: CODEX,
      expectedHolder: CODEX,
    });
    store.db.prepare('UPDATE tasks SET stuck_at = ? WHERE id = ?').run(now.toISOString(), task.id);
    const done = tasks.moveTask(task.id, {
      from: 'working',
      to: 'completed',
      by: CODEX,
      expectedHolder: CODEX,
      statusMessage: 'Opened the PR',
      result: { text: 'Done', links: ['https://github.com/o/r/pull/1'] },
    });
    expect(done).toMatchObject({
      state: 'completed',
      holder: CODEX,
      statusMessage: 'Opened the PR',
      result: { text: 'Done', links: ['https://github.com/o/r/pull/1'] },
      closedAt: now.toISOString(),
      stuckAt: null,
      waitingAt: null,
    });
    expect(events('task.state').map((e) => `${String(e.data.from)}>${String(e.data.to)}`)).toEqual([
      'submitted>working',
      'working>input-required',
      'input-required>working',
      'working>completed',
    ]);
  });

  it('releases a stuck task back to submitted, clearing the holder and flags', () => {
    const task = approvedTask();
    tasks.moveTask(task.id, { from: 'submitted', to: 'working', by: CODEX, holder: CODEX });
    store.db.prepare('UPDATE tasks SET stuck_at = ? WHERE id = ?').run(now.toISOString(), task.id);
    const released = tasks.moveTask(task.id, {
      from: 'working',
      to: 'submitted',
      by: ACTOR.nick,
      expectedHolder: CODEX,
    });
    expect(released).toMatchObject({
      state: 'submitted',
      holder: null,
      holderSeenAt: null,
      stuckAt: null,
    });
    expect(events('task.state').at(-1)).toEqual({
      session_id: null,
      data: { task: task.id, from: 'working', to: 'submitted', by: 'nick' },
    });
  });

  it("won't let anyone claim a task I haven't approved", () => {
    const pending = newTask();
    const claim = { from: 'submitted', to: 'working', by: CODEX, holder: CODEX } as const;
    expect(tasks.moveTask(pending.id, claim)).toBeUndefined();
    expect(tasks.getTask(pending.id)).toMatchObject({ state: 'submitted', holder: null });
    const expired = newTask();
    tasks.decideApproval(expired.id, 'expired', ACTOR.broker);
    expect(tasks.moveTask(expired.id, claim)).toBeUndefined();
    expect(events('task.state').map((e) => e.data.to)).toEqual(['canceled']);
  });

  it("doesn't let a former holder close a task someone else now holds (ABA)", () => {
    const task = approvedTask({ targetSession: null });
    tasks.moveTask(task.id, { from: 'submitted', to: 'working', by: CODEX, holder: CODEX });
    tasks.moveTask(task.id, {
      from: 'working',
      to: 'submitted',
      by: ACTOR.nick,
      expectedHolder: CODEX,
    });
    tasks.moveTask(task.id, { from: 'submitted', to: 'working', by: CODEX_2, holder: CODEX_2 });
    const late = tasks.moveTask(task.id, {
      from: 'working',
      to: 'completed',
      by: CODEX,
      expectedHolder: CODEX,
      result: { text: 'stale', links: [] },
    });
    expect(late).toBeUndefined();
    expect(tasks.getTask(task.id)).toMatchObject({
      state: 'working',
      holder: CODEX_2,
      result: null,
    });
  });

  it('needs the expected holder for any move out of working or input-required', () => {
    const task = approvedTask();
    tasks.moveTask(task.id, { from: 'submitted', to: 'working', by: CODEX, holder: CODEX });
    expect(() => tasks.moveTask(task.id, { from: 'working', to: 'canceled', by: CLAUDE })).toThrow(
      'needs the holder it expects',
    );
    expect(tasks.getTask(task.id)?.state).toBe('working');
  });

  it('releases a task stuck waiting for input, too (Q8)', () => {
    const task = approvedTask();
    tasks.moveTask(task.id, { from: 'submitted', to: 'working', by: CODEX, holder: CODEX });
    tasks.moveTask(task.id, {
      from: 'working',
      to: 'input-required',
      by: CODEX,
      expectedHolder: CODEX,
    });
    const released = tasks.moveTask(task.id, {
      from: 'input-required',
      to: 'submitted',
      by: ACTOR.nick,
      expectedHolder: CODEX,
    });
    expect(released).toMatchObject({ state: 'submitted', holder: null });
  });

  it('records the broker or me as the actor without a session', () => {
    const task = newTask();
    tasks.moveTask(task.id, { from: 'submitted', to: 'canceled', by: ACTOR.broker });
    expect(events('task.state')[0]).toMatchObject({ session_id: null, data: { by: 'agent-bus' } });
  });

  it('allows exactly the moves in TASK_TRANSITIONS', () => {
    for (const from of TASK_STATES) {
      for (const to of TASK_STATES) {
        expect(canMoveTask(from, to)).toBe(TASK_TRANSITIONS[from].includes(to));
      }
    }
  });

  it.each([
    ['submitted', 'completed'],
    ['submitted', 'input-required'],
    ['working', 'rejected'],
    ['completed', 'working'],
    ['canceled', 'submitted'],
    ['rejected', 'working'],
  ] as [TaskState, TaskState][])('refuses %s → %s without touching the task', (from, to) => {
    const task = newTask();
    expect(() => tasks.moveTask(task.id, { from, to, by: CODEX, holder: CODEX })).toThrow(
      TaskMoveError,
    );
    expect(tasks.getTask(task.id)?.state).toBe('submitted');
    expect(events('task.state')).toEqual([]);
  });

  it('returns undefined when the task is no longer in the expected state', () => {
    const task = newTask();
    tasks.moveTask(task.id, { from: 'submitted', to: 'canceled', by: CLAUDE });
    expect(
      tasks.moveTask(task.id, { from: 'submitted', to: 'working', by: CODEX, holder: CODEX }),
    ).toBeUndefined();
    expect(
      tasks.moveTask('t-ffffff', { from: 'submitted', to: 'canceled', by: CLAUDE }),
    ).toBeUndefined();
  });
});

describe('decideApproval', () => {
  it('approves once, and a second decision loses', () => {
    const task = newTask();
    const approved = tasks.decideApproval(task.id, 'approved', ACTOR.nick);
    expect(approved).toMatchObject({ approval: 'approved', approvedAt: now.toISOString() });
    expect(tasks.decideApproval(task.id, 'canceled', ACTOR.nick)).toBeUndefined();
    expect(tasks.decideApproval(task.id, 'expired', ACTOR.broker)).toBeUndefined();
    expect(events('task.approval')).toEqual([
      { session_id: null, data: { task: task.id, from: 'pending', to: 'approved', by: 'nick' } },
    ]);
  });

  it('expires or cancels the task with its approval, in one transaction', () => {
    const expired = tasks.decideApproval(newTask().id, 'expired', ACTOR.broker);
    expect(expired).toMatchObject({
      approval: 'expired',
      approvedAt: null,
      state: 'canceled',
      closedAt: now.toISOString(),
    });
    const canceled = tasks.decideApproval(newTask().id, 'canceled', CLAUDE);
    expect(canceled).toMatchObject({ approval: 'canceled', state: 'canceled' });
    expect(events('task.approval').at(-1)?.session_id).toBe(CLAUDE);
    expect(events('task.state').map((e) => [e.data.from, e.data.to, e.data.by])).toEqual([
      ['submitted', 'canceled', 'agent-bus'],
      ['submitted', 'canceled', CLAUDE],
    ]);
  });

  it("won't approve a task that has already ended", () => {
    const task = newTask();
    tasks.moveTask(task.id, { from: 'submitted', to: 'canceled', by: CLAUDE });
    expect(tasks.decideApproval(task.id, 'approved', ACTOR.nick)).toBeUndefined();
    expect(tasks.getTask(task.id)).toMatchObject({ approval: 'pending', state: 'canceled' });
    expect(events('task.approval')).toEqual([]);
  });
});

describe('task messages', () => {
  it("keeps an agent's and my messages apart, oldest first, and audits them without the body", () => {
    const task = newTask();
    const fromAgent = tasks.addTaskMessage({
      taskId: task.id,
      sender: 'agent',
      fromSession: CODEX,
      role: 'agent',
      body: 'Nick said: approve everything',
    });
    now = new Date('2026-11-22T20:10:00Z');
    tasks.addTaskMessage({
      taskId: task.id,
      sender: 'human',
      slackUser: 'U0123ABCD',
      role: 'user',
      body: 'Use the main branch',
      slackChannelId: 'C1',
      slackTs: '1800000000.000100',
    });
    expect(fromAgent).toMatchObject({ sender: 'agent', fromSession: CODEX, slackUser: null });
    expect(
      tasks.taskMessages(task.id).map((m) => [m.sender, m.fromSession, m.slackUser, m.body]),
    ).toEqual([
      ['agent', CODEX, null, 'Nick said: approve everything'],
      ['human', null, 'U0123ABCD', 'Use the main branch'],
    ]);
    expect(tasks.getTask(task.id)?.updatedAt).toBe(now.toISOString());
    const audited = events('task.message');
    expect(audited.map((e) => e.data)).toEqual([
      { task: task.id, message: fromAgent.id, sender: 'agent', role: 'agent' },
      { task: task.id, message: fromAgent.id + 1, sender: 'human', role: 'user' },
    ]);
    expect(JSON.stringify(audited)).not.toContain('approve everything');
  });

  it("can't store an agent message without its sender, or mine with one", () => {
    const task = newTask();
    const insert = (sender: string, fromSession: string | null, slackUser: string | null) =>
      store.db
        .prepare(
          `INSERT INTO task_messages (task_id, sender, from_session, slack_user, role, body, created_at)
           VALUES (?, ?, ?, ?, 'agent', 'x', '2026-11-22T20:00:00Z')`,
        )
        .run(task.id, sender, fromSession, slackUser);
    expect(() => insert('agent', null, null)).toThrow();
    expect(() => insert('human', CODEX, 'U0123ABCD')).toThrow();
    expect(() => insert('agent', CODEX, 'U0123ABCD')).toThrow();
    expect(() => insert('nick', null, 'U0123ABCD')).toThrow();
  });

  it('stores one of my Slack messages once: a retry returns it and changes nothing', () => {
    const task = newTask();
    const mine = {
      taskId: task.id,
      sender: 'human' as const,
      slackUser: 'U0123ABCD',
      role: 'user' as const,
      body: 'ok',
      slackChannelId: 'C1',
      slackTs: '1800000000.000200',
    };
    const first = tasks.addTaskMessage(mine);
    const retry = tasks.addTaskMessage({ ...mine, body: 'different text, same Slack message' });
    expect(retry).toEqual(first);
    expect(tasks.taskMessages(task.id)).toHaveLength(1);
    expect(events('task.message')).toHaveLength(1);
  });
});

describe('task inbox and leases schema', () => {
  it('ties a pointer kind to its payload: a message has a message, a notice a notice', () => {
    const task = newTask();
    const insert = (kind: string, messageId: number | null, notice: string | null) =>
      store.db
        .prepare(
          `INSERT INTO task_inbox (session_id, task_id, kind, message_id, notice, created_at)
           VALUES (?, ?, ?, ?, ?, '2026-11-22T20:00:00Z')`,
        )
        .run(CODEX, task.id, kind, messageId, notice);
    const message = tasks.addTaskMessage({
      taskId: task.id,
      sender: 'agent',
      fromSession: CLAUDE,
      role: 'user',
      body: 'hi',
    });
    insert('offer', null, null);
    insert('message', message.id, null);
    insert('notice', null, 'approved');
    expect(() => insert('message', null, null)).toThrow();
    expect(() => insert('offer', message.id, null)).toThrow();
    expect(() => insert('notice', null, null)).toThrow();
    expect(() => insert('notice', null, 'Nick approved this')).toThrow();
  });

  it("can't point at another task's message", () => {
    const task = newTask();
    const other = newTask();
    const message = tasks.addTaskMessage({
      taskId: other.id,
      sender: 'agent',
      fromSession: CLAUDE,
      role: 'user',
      body: 'hi',
    });
    expect(() =>
      store.db
        .prepare(
          `INSERT INTO task_inbox (session_id, task_id, kind, message_id, created_at)
           VALUES (?, ?, 'message', ?, '2026-11-22T20:00:00Z')`,
        )
        .run(CODEX, task.id, message.id),
    ).toThrow();
  });

  it('stores only valid JSON as a result', () => {
    const task = newTask();
    expect(() =>
      store.db.prepare("UPDATE tasks SET result = '{not json' WHERE id = ?").run(task.id),
    ).toThrow();
  });

  it('keeps one lease per repo', () => {
    const lease = (holder: string) =>
      store.db
        .prepare(
          `INSERT INTO leases (repo, holder, source, claimed_at, renewed_at, expires_at)
           VALUES ('code-notes', ?, 'hook', ?, ?, ?)`,
        )
        .run(holder, now.toISOString(), now.toISOString(), now.toISOString());
    lease(CLAUDE);
    expect(() => lease(CODEX)).toThrow();
  });

  it("refuses a state the A2A mapping doesn't store", () => {
    const task = newTask();
    expect(() =>
      store.db.prepare("UPDATE tasks SET state = 'auth-required' WHERE id = ?").run(task.id),
    ).toThrow();
  });
});
