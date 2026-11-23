import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { digestText } from '../../src/broker/digest.ts';
import { silentLogger } from '../../src/broker/log.ts';
import { BusError, BusService } from '../../src/broker/service.ts';
import { toFlagClick } from '../../src/broker/slack/inbound.ts';
import { DM_TARGET, Store, type OutboxRecord } from '../../src/broker/store.ts';
import { TaskInbox } from '../../src/broker/task-inbox.ts';
import { TASK_SLACK, TaskSlack } from '../../src/broker/task-slack.ts';
import { TaskStore, type TaskRecord } from '../../src/broker/task-store.ts';
import { TaskService, type TaskTarget } from '../../src/broker/tasks.ts';
import type { Platform } from '../../src/shared/platform.ts';
import { USER_ID } from './fakes.ts';

/** #61 part 2b: stuck (Q8) and unclaimed (Q23) flags, with Cancel and Release on a DM. */

const HOUR = 60 * 60_000;
let store: Store;
let service: BusService;
let slackTasks: TaskSlack;
let tasks: TaskService;
let records: TaskStore;
let edits: { ts: string; text: string; blocks: unknown[] }[];
let woken: string[];
let now: Date;

beforeEach(() => {
  now = new Date('2026-11-23T20:00:00Z');
  store = new Store(':memory:', { now: () => now });
  service = new BusService(store, { kick: () => undefined }, () => now);
  edits = [];
  woken = [];
  slackTasks = new TaskSlack({
    store,
    queue: { kick: () => undefined },
    editor: { update: (_channel, ts, text, blocks) => edits.push({ ts, text, blocks }) },
    humanUserId: USER_ID,
    log: silentLogger,
    now: () => now,
    wake: (id) => woken.push(id),
  });
  tasks = new TaskService(store, service, () => now, slackTasks);
  records = new TaskStore(store, () => now);
});

afterEach(() => store.close());

interface Agent {
  id: string;
  key: string;
  platform: Platform;
}

function agent(platform: Platform, project = 'clankers'): Agent {
  const result = service.register({ platform, purpose: 'Working', project });
  if (!result.key) throw new Error('no key');
  return { id: result.session.id, key: result.key, platform };
}

function approved(from: Agent, to: TaskTarget): TaskRecord {
  const task = tasks.createTask({
    platform: from.platform,
    session: from.id,
    key: from.key,
    title: 'Implement the plan',
    brief: 'Plan in docs/plan.md.',
    to,
  });
  slackTasks.decideByButton(task.id, 'approve', USER_ID);
  return fresh(task);
}

function claimed(from: Agent, by: Agent): TaskRecord {
  const task = approved(from, { session: by.id });
  tasks.claimTask({ platform: by.platform, session: by.id, key: by.key, task: task.id });
  return fresh(task);
}

function fresh(task: TaskRecord): TaskRecord {
  const found = records.getTask(task.id);
  if (!found) throw new Error('no task');
  return found;
}

/** Moves the clock on; sessions keep the last-seen time they had. */
function later(ms: number): void {
  now = new Date(now.getTime() + ms);
}

/** A tool call or hook from the session now. */
function touch(who: Agent): void {
  store.db
    .prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?')
    .run(now.toISOString(), who.id);
}

function flagDm(task: TaskRecord): OutboxRecord {
  const id = fresh(task).flagPostId;
  const post = id === null ? undefined : store.getPost(id);
  if (!post) throw new Error('no flag DM');
  return post;
}

function buttons(post: { blocks?: unknown[] | null }): string[] {
  const actions = (post.blocks ?? []).find(
    (block) => (block as { type: string }).type === 'actions',
  ) as { elements: { action_id: string }[] } | undefined;
  return actions?.elements.map((element) => element.action_id) ?? [];
}

function blockText(post: { blocks?: unknown[] | null }): string {
  return JSON.stringify(post.blocks ?? []);
}

function threadLines(task: TaskRecord): string[] {
  const root = fresh(task).threadPostId;
  const rows = store.db.prepare('SELECT id FROM outbox ORDER BY id').all() as { id: number }[];
  return rows
    .map((row) => store.getPost(row.id))
    .filter((post) => post?.replyTo === root)
    .map((post) => post?.text ?? '');
}

function events(kind: string): Record<string, unknown>[] {
  const rows = store.db.prepare('SELECT data FROM events WHERE kind = ? ORDER BY id').all(kind) as {
    data: string;
  }[];
  return rows.map((row) => JSON.parse(row.data) as Record<string, unknown>);
}

function noticesFor(who: Agent) {
  return records.notices(who.id).map((n) => [n.taskId, n.notice]);
}

describe('the stuck flag (Q8)', () => {
  it('flags a held task once its holder is silent for 4 h: a DM with Cancel and Release, a thread line', () => {
    const claude = agent('claude');
    const codex = agent('codex');
    const task = claimed(claude, codex);
    later(TASK_SLACK.stuckAfterMs - 60_000);
    touch(claude); // the creator's activity doesn't count
    slackTasks.tick();
    expect(fresh(task).stuckAt).toBeNull();

    later(2 * 60_000);
    slackTasks.tick();
    expect(fresh(task)).toMatchObject({ flagKind: 'stuck', stuckAt: now.toISOString() });
    const message = flagDm(task);
    expect(message.target).toBe(DM_TARGET);
    // Sent to codex by name: only that session could take it again, so no Release.
    expect(buttons(message)).toEqual(['agentbus_flag_cancel']);
    expect(blockText(message)).toContain('No Release: it was sent to');
    expect(blockText(message)).toContain(`held by \`${codex.id}\`, looks stuck`);
    expect(threadLines(task).at(-1)).toContain(':warning: Flagged as stuck');
    expect(events('task.flagged')).toEqual([{ task: task.id, flag: 'stuck' }]);

    // Once per flag.
    later(HOUR);
    slackTasks.tick();
    expect(events('task.flagged')).toHaveLength(1);
  });

  it('counts the holder’s session activity, not only its task activity', () => {
    const claude = agent('claude');
    const codex = agent('codex');
    const task = claimed(claude, codex);
    later(3 * HOUR);
    touch(codex); // busy coding, no notes
    later(2 * HOUR);
    slackTasks.tick();
    expect(fresh(task).stuckAt).toBeNull();
  });

  it('counts a note as a sign of life', () => {
    const claude = agent('claude');
    const codex = agent('codex');
    const task = claimed(claude, codex);
    later(3 * HOUR);
    tasks.updateTask({
      platform: 'codex',
      session: codex.id,
      key: codex.key,
      task: task.id,
      note: 'Halfway',
    });
    store.db // the call itself touched the session: undo that, keep the note
      .prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?')
      .run(new Date(now.getTime() - 3 * HOUR).toISOString(), codex.id);
    later(2 * HOUR);
    slackTasks.tick();
    expect(fresh(task).stuckAt).toBeNull();
  });

  it('drops the flag when the holder comes back, and the DM says so', () => {
    const claude = agent('claude');
    const codex = agent('codex');
    const task = claimed(claude, codex);
    later(5 * HOUR);
    slackTasks.tick();
    expect(fresh(task).stuckAt).not.toBeNull();
    touch(codex);
    slackTasks.tick();
    expect(fresh(task).stuckAt).toBeNull();
    expect(buttons(flagDm(task))).toEqual([]);
    expect(blockText(flagDm(task))).toContain('is active again: nothing to do');
    expect(threadLines(task).at(-1)).toContain('is active again');
    expect(events('task.unflagged')).toEqual([{ task: task.id, flag: 'stuck' }]);
  });

  it('Release takes a pool task from the holder and opens it to the pool again', () => {
    const claude = agent('claude');
    const first = agent('codex');
    const second = agent('codex');
    const task = approved(claude, { platform: 'codex', project: 'clankers' });
    tasks.claimTask({ platform: 'codex', session: first.id, key: first.key, task: task.id });
    later(5 * HOUR);
    slackTasks.tick();
    expect(buttons(flagDm(task))).toEqual(['agentbus_flag_cancel', 'agentbus_flag_release']);
    expect(slackTasks.flagByButton(task.id, 'release', USER_ID)).toBe('released');
    expect(fresh(task)).toMatchObject({
      state: 'submitted',
      holder: null,
      stuckAt: null,
      openSince: now.toISOString(),
    });
    expect(blockText(flagDm(task))).toContain('Released: open to claim again');
    expect(threadLines(task).at(-1)).toContain('Given back by `nick`');
    expect(events('task.state').at(-1)).toMatchObject({
      from: 'working',
      to: 'submitted',
      by: 'nick',
    });
    // The old holder's late call can't close it (ABA).
    expectBusError(
      () =>
        tasks.updateTask({
          platform: 'codex',
          session: first.id,
          key: first.key,
          task: task.id,
          state: 'completed',
          result: { text: 'done', links: [] },
        }),
      'not_allowed',
    );
    // Another session in the pool takes it.
    tasks.claimTask({ platform: 'codex', session: second.id, key: second.key, task: task.id });
    expect(fresh(task)).toMatchObject({ state: 'working', holder: second.id });
  });

  it('offers no Release on a task sent to one session by name, and refuses a forged click', () => {
    const claude = agent('claude');
    const codex = agent('codex');
    const task = claimed(claude, codex);
    later(5 * HOUR);
    slackTasks.tick();
    expect(slackTasks.flagByButton(task.id, 'release', USER_ID)).toBe('unflagged');
    expect(fresh(task)).toMatchObject({ state: 'working', holder: codex.id });
  });

  it('won’t release a holder that came back before the tick noticed', () => {
    const claude = agent('claude');
    const codex = agent('codex');
    const task = approved(claude, { platform: 'codex', project: 'clankers' });
    tasks.claimTask({ platform: 'codex', session: codex.id, key: codex.key, task: task.id });
    later(5 * HOUR);
    slackTasks.tick();
    touch(codex); // back, and no tick since
    expect(slackTasks.flagByButton(task.id, 'release', USER_ID)).toBe('unflagged');
    expect(fresh(task)).toMatchObject({ state: 'working', holder: codex.id, stuckAt: null });
    expect(blockText(flagDm(task))).toContain('is active again: nothing to do');
  });

  it('flags again, with a new DM, if a revived holder goes quiet again', () => {
    const claude = agent('claude');
    const codex = agent('codex');
    const task = claimed(claude, codex);
    later(5 * HOUR);
    slackTasks.tick();
    const firstDm = flagDm(task);
    touch(codex);
    slackTasks.tick();
    later(5 * HOUR);
    slackTasks.tick();
    const secondDm = flagDm(task);
    expect(secondDm.id).not.toBe(firstDm.id);
    expect(buttons(secondDm)).toEqual(['agentbus_flag_cancel']);
    expect(blockText(store.getPost(firstDm.id) ?? {})).toContain('is active again');
    expect(events('task.flagged')).toHaveLength(2);
  });

  it('Cancel ends it for both sides, with the fixed notice to each', () => {
    const claude = agent('claude');
    const codex = agent('codex');
    const task = claimed(claude, codex);
    later(5 * HOUR);
    slackTasks.tick();
    expect(slackTasks.flagByButton(task.id, 'cancel', USER_ID)).toBe('canceled');
    expect(fresh(task)).toMatchObject({ state: 'canceled', stuckAt: null });
    expect(noticesFor(claude)).toEqual([[task.id, 'canceled']]);
    expect(noticesFor(codex)).toEqual([
      [task.id, 'approved'],
      [task.id, 'canceled'],
    ]);
    expect(woken.slice(-2).sort()).toEqual([claude.id, codex.id].sort());
    expect(blockText(flagDm(task))).toContain('Canceled.');
    expect(buttons(flagDm(task))).toEqual([]);
  });
});

describe('the waiting flag (Q23)', () => {
  it('flags an approved task nobody claimed in 24 h: a DM with Cancel only', () => {
    const claude = agent('claude');
    const task = approved(claude, { platform: 'copilot', project: 'clankers' });
    later(TASK_SLACK.waitingAfterMs - 60_000);
    slackTasks.tick();
    expect(fresh(task).waitingAt).toBeNull();
    later(2 * 60_000);
    slackTasks.tick();
    expect(fresh(task)).toMatchObject({ flagKind: 'waiting' });
    expect(buttons(flagDm(task))).toEqual(['agentbus_flag_cancel']);
    expect(blockText(flagDm(task))).toContain('nobody has claimed it');
    expect(threadLines(task).at(-1)).toContain(':hourglass: Flagged');
  });

  it('runs the clock from approval: messages and my replies don’t reset it', () => {
    const claude = agent('claude');
    const task = approved(claude, { platform: 'copilot', project: 'clankers' });
    const openedAt = fresh(task).openSince;
    later(20 * HOUR);
    records.addTaskMessage({
      taskId: task.id,
      sender: 'human',
      slackUser: USER_ID,
      role: 'user',
      body: 'Anyone?',
      slackChannelId: 'C1',
      slackTs: '1800000000.000001',
    });
    later(5 * HOUR);
    slackTasks.tick();
    expect(fresh(task).flagKind).toBe('waiting');
    expect(fresh(task).openSince).toBe(openedAt);
    expect(blockText(flagDm(task))).toContain('has been open to claim since');
  });

  it('shows as flagged in the digest', () => {
    const claude = agent('claude');
    const task = approved(claude, { platform: 'copilot', project: 'clankers' });
    later(25 * HOUR);
    slackTasks.tick();
    const text =
      digestText({
        since: new Date(0),
        timeZone: 'America/Los_Angeles',
        items: [],
        questions: [],
        sessions: [],
        tasks: [fresh(task)],
        sessionById: () => undefined,
      }) ?? '';
    expect(text).toContain(`\`${task.id}\``);
    expect(text).toContain('flagged, unclaimed since');
  });

  it('never flags a task still awaiting my approval (that one expires instead)', () => {
    const claude = agent('claude');
    const codex = agent('codex');
    const task = tasks.createTask({
      platform: 'claude',
      session: claude.id,
      key: claude.key,
      title: 't',
      brief: 'b',
      to: { session: codex.id },
    });
    later(TASK_SLACK.waitingAfterMs + HOUR);
    slackTasks.tick();
    expect(fresh(task)).toMatchObject({ waitingAt: null, approval: 'expired' });
  });

  it('a claim ends the flag, and its DM shows who claimed it', () => {
    const claude = agent('claude');
    const codex = agent('codex');
    const task = approved(claude, { session: codex.id });
    later(25 * HOUR);
    slackTasks.tick();
    tasks.claimTask({ platform: 'codex', session: codex.id, key: codex.key, task: task.id });
    expect(fresh(task).waitingAt).toBeNull();
    expect(blockText(flagDm(task))).toContain(`Claimed by \`${codex.id}\``);
    expect(slackTasks.flagByButton(task.id, 'cancel', USER_ID)).toBe('unflagged');
    expect(fresh(task).state).toBe('working');
  });

  it('Cancel tells the creator and a named target; Release does nothing here', () => {
    const claude = agent('claude');
    const codex = agent('codex');
    const task = approved(claude, { session: codex.id });
    later(25 * HOUR);
    slackTasks.tick();
    expect(slackTasks.flagByButton(task.id, 'release', USER_ID)).toBe('unflagged');
    expect(fresh(task).state).toBe('submitted');
    expect(slackTasks.flagByButton(task.id, 'cancel', USER_ID)).toBe('canceled');
    expect(noticesFor(claude)).toEqual([[task.id, 'canceled']]);
    expect(noticesFor(codex)).toEqual([
      [task.id, 'approved'],
      [task.id, 'canceled'],
    ]);
  });
});

describe('flag clicks', () => {
  it('only count when I click: another user’s or a bot’s is dropped and audited (T5)', () => {
    const claude = agent('claude');
    const codex = agent('codex');
    const task = claimed(claude, codex);
    later(5 * HOUR);
    slackTasks.tick();
    expect(slackTasks.flagByButton(task.id, 'cancel', 'U_OTHER')).toBe('not_human');
    expect(slackTasks.flagByButton(task.id, 'release', 'B_BOT')).toBe('not_human');
    expect(fresh(task).state).toBe('working');
    expect(events('inbound.dropped')).toEqual([
      { reason: 'not_human', user: 'U_OTHER', task: task.id, via: 'flag_button' },
      { reason: 'not_human', user: 'B_BOT', task: task.id, via: 'flag_button' },
    ]);
  });

  it('change nothing once the task closed, or on a task never flagged', () => {
    const claude = agent('claude');
    const codex = agent('codex');
    const task = claimed(claude, codex);
    expect(slackTasks.flagByButton(task.id, 'cancel', USER_ID)).toBe('unflagged');
    expect(slackTasks.flagByButton('t-000000', 'cancel', USER_ID)).toBe('unknown');
    later(5 * HOUR);
    slackTasks.tick();
    tasks.updateTask({
      platform: 'codex',
      session: codex.id,
      key: codex.key,
      task: task.id,
      state: 'completed',
      result: { text: 'done', links: [] },
    });
    expect(slackTasks.flagByButton(task.id, 'release', USER_ID)).toBe('unflagged');
    expect(fresh(task).state).toBe('completed');
    expect(blockText(flagDm(task))).toContain('Now completed: nothing to do');
  });

  it('edit a flag DM already sent to Slack', () => {
    const claude = agent('claude');
    const codex = agent('codex');
    const task = claimed(claude, codex);
    later(5 * HOUR);
    slackTasks.tick();
    const post = flagDm(task);
    store.markSent(post.id, 'D_NICK', '1800000000.000100');
    slackTasks.flagByButton(task.id, 'cancel', USER_ID);
    expect(edits.at(-1)).toMatchObject({ ts: '1800000000.000100' });
    expect(JSON.stringify(edits.at(-1)?.blocks)).toContain('Canceled.');
  });

  it('read the task from the block ID and the action from the action ID', () => {
    const body = { user: { id: USER_ID } };
    expect(
      toFlagClick(body, {
        type: 'button',
        action_id: 'agentbus_flag_release',
        block_id: 't-abc123',
      }),
    ).toEqual({ taskId: 't-abc123', action: 'release', userId: USER_ID });
    expect(
      toFlagClick(body, {
        type: 'button',
        action_id: 'agentbus_flag_cancel',
        block_id: 't-abc123',
        value: 'release',
      }),
    ).toMatchObject({ action: 'cancel' });
    expect(
      toFlagClick(body, { type: 'button', action_id: 'agentbus_task_approve', block_id: 't-1' }),
    ).toBeUndefined();
    expect(
      toFlagClick({}, { type: 'button', action_id: 'agentbus_flag_cancel', block_id: 't-1' }),
    ).toBeUndefined();
  });
});

function expectBusError(work: () => unknown, code: BusError['code']): void {
  try {
    work();
  } catch (error) {
    expect(error).toBeInstanceOf(BusError);
    expect((error as BusError).code).toBe(code);
    return;
  }
  expect.unreachable();
}

describe('a released pool task', () => {
  it('is open to the pool again', () => {
    const claude = agent('claude');
    const first = agent('codex');
    const second = agent('codex');
    const task = approved(claude, { platform: 'codex', project: 'clankers' });
    tasks.claimTask({ platform: 'codex', session: first.id, key: first.key, task: task.id });
    later(5 * HOUR);
    slackTasks.tick();
    slackTasks.flagByButton(task.id, 'release', USER_ID);
    const session = store.getSession(second.id);
    if (!session) throw new Error('no session');
    const offers = new TaskInbox(store, () => now).take(session, 'check_inbox').items;
    expect(offers.map((i) => [i.kind, i.task.id])).toEqual([['offer', task.id]]);
  });
});
