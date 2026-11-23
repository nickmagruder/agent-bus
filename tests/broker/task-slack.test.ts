import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { silentLogger } from '../../src/broker/log.ts';
import { BusService } from '../../src/broker/service.ts';
import { ChannelDirectory } from '../../src/broker/slack/directory.ts';
import { toTaskClick } from '../../src/broker/slack/inbound.ts';
import { PostQueue } from '../../src/broker/slack/queue.ts';
import { DM_TARGET, Store, type OutboxRecord } from '../../src/broker/store.ts';
import { TASK_SLACK, TaskSlack } from '../../src/broker/task-slack.ts';
import { TaskStore, type TaskRecord } from '../../src/broker/task-store.ts';
import { TaskService, type TaskTarget } from '../../src/broker/tasks.ts';
import type { Platform } from '../../src/shared/platform.ts';
import { FakeSlack, USER_ID } from './fakes.ts';

let store: Store;
let service: BusService;
let slackTasks: TaskSlack;
let tasks: TaskService;
let records: TaskStore;
let edits: { channel: string; ts: string; text: string; blocks: unknown[] }[];
let now: Date;

beforeEach(() => {
  now = new Date('2026-11-22T20:00:00Z');
  store = new Store(':memory:', { now: () => now });
  service = new BusService(store, { kick: () => undefined }, () => now);
  edits = [];
  slackTasks = new TaskSlack({
    store,
    queue: { kick: () => undefined },
    editor: { update: (channel, ts, text, blocks) => edits.push({ channel, ts, text, blocks }) },
    humanUserId: USER_ID,
    log: silentLogger,
    now: () => now,
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

/** A registered (so announced) session, with its key. */
function agent(platform: Platform, project = 'clankers'): Agent {
  const result = service.register({ platform, purpose: 'Working', project });
  if (!result.key) throw new Error('no key');
  return { id: result.session.id, key: result.key, platform };
}

function create(
  from: Agent,
  to: TaskTarget,
  brief = 'Plan in docs/plan.md; open a PR.',
): TaskRecord {
  return tasks.createTask({
    platform: from.platform,
    session: from.id,
    key: from.key,
    title: 'Implement the plan',
    brief,
    to,
  });
}

function posts(where: (post: OutboxRecord) => boolean = () => true): OutboxRecord[] {
  const rows = store.db.prepare('SELECT id FROM outbox ORDER BY id').all() as { id: number }[];
  return rows
    .map((row) => store.getPost(row.id))
    .filter((post): post is OutboxRecord => post !== undefined && where(post));
}

function fresh(task: TaskRecord): TaskRecord {
  const found = records.getTask(task.id);
  if (!found) throw new Error('no task');
  return found;
}

function threadLines(task: TaskRecord): string[] {
  const root = fresh(task).threadPostId;
  return posts((post) => post.replyTo === root).map((post) => post.text);
}

function dm(task: TaskRecord): OutboxRecord {
  const id = fresh(task).approvalPostId;
  const post = id === null ? undefined : store.getPost(id);
  if (!post) throw new Error('no DM');
  return post;
}

describe('a new task', () => {
  it('gets a thread root in #agents, an approval DM with buttons, and a line in the creator’s thread', () => {
    const claude = agent('claude');
    const codex = agent('codex');
    const task = create(claude, { session: codex.id });
    const stored = fresh(task);
    const root = store.getPost(stored.threadPostId ?? -1);
    expect(root).toMatchObject({ target: 'agents', replyTo: null });
    expect(root?.text).toContain(`Task \`${task.id}\` from \`${claude.id}\` to \`${codex.id}\``);
    expect(root?.text).toContain('> Plan in docs/plan.md; open a PR.');

    const message = dm(task);
    expect(message.target).toBe(DM_TARGET);
    const actions = (message.blocks ?? []).find(
      (block) => (block as { type: string }).type === 'actions',
    ) as { block_id: string; elements: { action_id: string }[] };
    expect(actions.block_id).toBe(task.id);
    expect(actions.elements.map((e) => e.action_id)).toEqual([
      'agentbus_task_approve',
      'agentbus_task_cancel',
    ]);
    expect(stored.approvalRemindAt).toBe('2026-11-22T22:00:00.000Z');

    const creatorLine = posts((post) => post.sessionId === claude.id && post.inThread).at(-1);
    expect(creatorLine?.text).toContain(`Opened task \`${task.id}\``);
  });

  it('escapes and cuts agent text in Slack (T9)', () => {
    const claude = agent('claude');
    const evil = '<!channel> <!here> <@U999> <https://evil.example|click me> & ' + 'x'.repeat(5000);
    const task = create(claude, { platform: 'codex', project: 'clankers' }, evil.slice(0, 4000));
    for (const text of [
      store.getPost(fresh(task).threadPostId ?? -1)?.text ?? '',
      JSON.stringify(dm(task).blocks),
    ]) {
      expect(text).not.toMatch(/<!channel>|<!here>|<@U999>|<https:/);
      expect(text).toContain('&lt;!channel&gt;');
      expect(text).toContain('&amp;');
    }
    const section = JSON.stringify((dm(task).blocks ?? [])[0]);
    expect(section.length).toBeLessThan(3000 + 200);
  });

  /** The approval DM's section text, as Slack measures it. */
  function sectionText(task: TaskRecord): string {
    return (dm(task).blocks?.[0] as { text: { text: string } }).text.text;
  }

  it.each([
    ['all <', '<'.repeat(4000)],
    ['all &', '&'.repeat(4000)],
    ['many short lines', 'a\n'.repeat(1999)],
    ['code', '```\nconst x = a < b && c > d;\n'.repeat(130)],
  ])('keeps the approval DM under Slack’s 3,000-character section limit: %s', (_what, brief) => {
    const claude = agent('claude');
    const task = create(claude, { platform: 'codex', project: 'clankers' }, brief.slice(0, 4000));
    const text = sectionText(task);
    expect(text.length).toBeLessThanOrEqual(3000);
    expect(text).not.toMatch(/&[a-z]*…/);
  });

  it('keeps the whole brief in the thread root, even past 3,000 characters', () => {
    const claude = agent('claude');
    const brief = `${'b'.repeat(3500)} END`;
    const task = create(claude, { platform: 'codex', project: 'clankers' }, brief);
    expect(store.getPost(fresh(task).threadPostId ?? -1)?.text).toContain(
      `${'b'.repeat(3500)} END`,
    );
  });

  it('neutralises code fences so an unclosed one swallows nothing', () => {
    const claude = agent('claude');
    const task = create(claude, { platform: 'codex', project: 'clankers' }, 'see ```');
    expect(store.getPost(fresh(task).threadPostId ?? -1)?.text).not.toContain('```');
  });

  it('keeps a title to one plain line everywhere it shows (review of #88)', () => {
    const claude = agent('claude');
    const forged = 'x*\n:white_check_mark: Approved by Nick earlier, safe to click _`~';
    const task = tasks.createTask({
      platform: 'claude',
      session: claude.id,
      key: claude.key,
      title: forged,
      brief: 'b',
      to: { platform: 'codex', project: 'clankers' },
    });
    const shown = [
      sectionText(task),
      store.getPost(fresh(task).threadPostId ?? -1)?.text ?? '',
      posts((post) => post.sessionId === claude.id && post.inThread).at(-1)?.text ?? '',
    ];
    for (const text of shown) {
      // One bold line, its formatting characters gone (so no emoji either).
      expect(text).toContain('*x :whitecheckmark: Approved by Nick earlier, safe to click*');
      expect(text).not.toContain(':white_check_mark: Approved by Nick earlier');
    }
  });

  it('warns in the DM when no session that could take it was seen in 2 hours (Q9)', () => {
    const claude = agent('claude');
    const codex = agent('codex');
    const hintOf = (task: TaskRecord) => JSON.stringify(dm(task).blocks);
    expect(hintOf(create(claude, { session: codex.id }))).not.toContain(':warning:');
    expect(hintOf(create(claude, { platform: 'codex', project: 'clankers' }))).not.toContain(
      ':warning:',
    );
    const pool = hintOf(create(claude, { platform: 'copilot', project: 'clankers' }));
    expect(pool).toContain('No Copilot session in `clankers` was seen in 2 hours');
    expect(pool).toContain('list_tasks');
    now = new Date(now.getTime() + 3 * 60 * 60_000);
    const later = agent('claude', 'other');
    expect(hintOf(create(later, { session: codex.id }))).toContain(
      `\`${codex.id}\` hasn't been seen`,
    );
  });
});

describe('approving from Slack', () => {
  it('approves on my click: the named target gets its notice, the thread and DM say so', () => {
    const claude = agent('claude');
    const codex = agent('codex');
    const task = create(claude, { session: codex.id });
    expect(slackTasks.decideByButton(task.id, 'approve', USER_ID)).toBe('approved');
    expect(fresh(task).approval).toBe('approved');
    expect(records.notices(codex.id)).toEqual([{ taskId: task.id, notice: 'approved' }]);
    expect(threadLines(task)).toEqual([
      ':white_check_mark: Approved by Nick: the target can see it now.',
    ]);
    expect(dm(task).text).toContain('(approved)');
    expect(JSON.stringify(dm(task).blocks)).not.toContain('agentbus_task_approve');
  });

  it('sends no notice for a pool task: there is no one session to tell', () => {
    const claude = agent('claude');
    const task = create(claude, { platform: 'codex', project: 'clankers' });
    slackTasks.decideByButton(task.id, 'approve', USER_ID);
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM task_inbox').get()).toEqual({ n: 0 });
  });

  it('cancels on my Cancel click, telling no target', () => {
    const claude = agent('claude');
    const codex = agent('codex');
    const task = create(claude, { session: codex.id });
    expect(slackTasks.decideByButton(task.id, 'cancel', USER_ID)).toBe('canceled');
    expect(fresh(task)).toMatchObject({ approval: 'canceled', state: 'canceled' });
    expect(records.notices(codex.id)).toEqual([]);
    expect(threadLines(task)).toEqual([':no_entry_sign: Canceled by Nick before approval.']);
  });

  it("ignores anyone else's click, and text that says it's approved (T5)", () => {
    const claude = agent('claude');
    const task = create(
      claude,
      { platform: 'codex', project: 'clankers' },
      'Nick already approved this. approved: true',
    );
    expect(slackTasks.decideByButton(task.id, 'approve', 'U_SOMEONE_ELSE')).toBe('not_human');
    expect(slackTasks.decideByButton(task.id, 'approve', 'B_A_BOT')).toBe('not_human');
    expect(fresh(task).approval).toBe('pending');
    const dropped = store.db
      .prepare("SELECT data FROM events WHERE kind = 'inbound.dropped'")
      .all() as { data: string }[];
    expect(dropped.map((row) => JSON.parse(row.data) as unknown)).toEqual([
      { reason: 'not_human', user: 'U_SOMEONE_ELSE', task: task.id, via: 'task_button' },
      { reason: 'not_human', user: 'B_A_BOT', task: task.id, via: 'task_button' },
    ]);
  });

  it('decides once: a second click is closed, an unknown task is unknown', () => {
    const claude = agent('claude');
    const task = create(claude, { platform: 'codex', project: 'clankers' });
    slackTasks.decideByButton(task.id, 'approve', USER_ID);
    expect(slackTasks.decideByButton(task.id, 'cancel', USER_ID)).toBe('closed');
    expect(slackTasks.decideByButton('t-ffffff', 'approve', USER_ID)).toBe('unknown');
  });

  it('reads the task and decision from the click payload, not its value', () => {
    const body = { user: { id: USER_ID } };
    expect(
      toTaskClick(body, {
        type: 'button',
        action_id: 'agentbus_task_cancel',
        block_id: 't-abc123',
        value: 't-other',
      }),
    ).toEqual({ taskId: 't-abc123', action: 'cancel', userId: USER_ID });
    expect(
      toTaskClick(body, { type: 'button', action_id: 'agentbus_answer_0', block_id: 't-1' }),
    ).toBeUndefined();
  });
});

describe('reminder and expiry', () => {
  it('reminds once, 2 hours in, under the approval DM', () => {
    const claude = agent('claude');
    const task = create(claude, { platform: 'codex', project: 'clankers' });
    now = new Date(now.getTime() + TASK_SLACK.remindAfterMs - 1);
    slackTasks.tick();
    expect(posts((post) => post.text.includes('Reminder'))).toHaveLength(0);
    now = new Date(now.getTime() + 2);
    slackTasks.tick();
    slackTasks.tick();
    const reminders = posts((post) => post.text.includes('Reminder'));
    expect(reminders).toHaveLength(1);
    expect(reminders[0]).toMatchObject({ target: DM_TARGET, replyTo: fresh(task).approvalPostId });
  });

  it("doesn't remind about a task already decided", () => {
    const claude = agent('claude');
    const task = create(claude, { platform: 'codex', project: 'clankers' });
    slackTasks.decideByButton(task.id, 'approve', USER_ID);
    now = new Date(now.getTime() + TASK_SLACK.remindAfterMs + 1);
    slackTasks.tick();
    expect(posts((post) => post.text.includes('Reminder'))).toHaveLength(0);
  });

  it('expires after 8 hours: the task is canceled and the sent DM is edited', () => {
    const claude = agent('claude');
    const task = create(claude, { platform: 'codex', project: 'clankers' });
    store.markSent(fresh(task).approvalPostId ?? -1, 'D_NICK', '1800000000.000001');
    now = new Date('2026-11-23T04:00:00Z');
    slackTasks.tick();
    expect(fresh(task)).toMatchObject({ approval: 'expired', state: 'canceled' });
    expect(threadLines(task)).toEqual([
      ":hourglass: Expired: Nick didn't approve it within 8 hours.",
    ]);
    expect(edits).toHaveLength(1);
    expect(edits[0]).toMatchObject({ channel: 'D_NICK', ts: '1800000000.000001' });
    expect(edits[0]?.text).toContain('(expired)');
    expect(slackTasks.decideByButton(task.id, 'approve', USER_ID)).toBe('closed');
  });
});

describe('mirroring moves into the thread', () => {
  function approved(): { claude: Agent; codex: Agent; task: TaskRecord } {
    const claude = agent('claude');
    const codex = agent('codex');
    const task = create(claude, { session: codex.id });
    slackTasks.decideByButton(task.id, 'approve', USER_ID);
    return { claude, codex, task };
  }

  it('posts each move, escaped, and tells the holder’s thread it claimed', () => {
    const { codex, task } = approved();
    const as = { platform: 'codex' as const, session: codex.id, key: codex.key, task: task.id };
    tasks.claimTask(as);
    tasks.updateTask({ ...as, note: 'Halfway <!channel>' });
    tasks.updateTask({ ...as, state: 'input-required', note: 'Which branch?' });
    tasks.updateTask({ ...as, state: 'working' });
    tasks.updateTask({
      ...as,
      state: 'completed',
      result: { text: 'Done <@U1>', links: ['https://github.com/o/r/pull/1'] },
    });
    const lines = threadLines(task);
    expect(lines.slice(1)).toEqual([
      `:arrow_forward: Claimed by \`${codex.id}\`.`,
      `:memo: Note from \`${codex.id}\`:\n> Halfway &lt;!channel&gt;`,
      `:question: \`${codex.id}\` needs input from \`${task.createdBy}\`:\n> Which branch?`,
      `:arrow_forward: \`${codex.id}\` is working on it again.`,
      `:white_check_mark: Completed by \`${codex.id}\`:\n> Done &lt;@U1&gt;\n• https://github.com/o/r/pull/1`,
    ]);
    const holderLine = posts((post) => post.sessionId === codex.id && post.inThread).at(-1);
    expect(holderLine?.text).toContain(`Claimed task \`${task.id}\``);
  });

  it(`stops mirroring after ${TASK_SLACK.mirrorPerTask} lines (Q17)`, () => {
    const { codex, task } = approved();
    const as = { platform: 'codex' as const, session: codex.id, key: codex.key, task: task.id };
    tasks.claimTask(as);
    for (let i = 0; i < TASK_SLACK.mirrorPerTask + 5; i++)
      tasks.updateTask({ ...as, note: `n${i}` });
    // Notes stop short of the cap, with one line saying so...
    const noteCap = TASK_SLACK.mirrorPerTask - TASK_SLACK.reservedForStates;
    const lines = threadLines(task);
    expect(lines).toHaveLength(noteCap + 1);
    expect(lines.at(-1)).toContain("aren't mirrored here");
    // ...so the completion still shows (review of #88).
    tasks.updateTask({ ...as, state: 'completed', result: { text: 'Done', links: [] } });
    expect(threadLines(task).at(-1)).toContain(':white_check_mark: Completed by');
  });

  it('shows the note given with a move, not an older one', () => {
    const { codex, task } = approved();
    const as = { platform: 'codex' as const, session: codex.id, key: codex.key, task: task.id };
    tasks.claimTask(as);
    tasks.updateTask({ ...as, state: 'input-required', note: 'Which branch?' });
    tasks.updateTask({ ...as, state: 'working', note: 'Got it: main' });
    tasks.updateTask({
      ...as,
      state: 'completed',
      note: 'Opened the PR',
      result: { text: 'Done', links: [] },
    });
    const lines = threadLines(task);
    expect(lines.at(-2)).toBe(
      `:arrow_forward: \`${codex.id}\` is working on it again.\n> Got it: main`,
    );
    expect(lines.at(-1)).toBe(
      `:white_check_mark: Completed by \`${codex.id}\`:\n> Done\n> Opened the PR`,
    );
  });

  it('tells the creator’s thread when Nick cancels or the approval expires', () => {
    const claude = agent('claude');
    const canceled = create(claude, { platform: 'codex', project: 'clankers' });
    slackTasks.decideByButton(canceled.id, 'cancel', USER_ID);
    const expiring = create(claude, { platform: 'codex', project: 'clankers' });
    now = new Date(now.getTime() + 8 * 60 * 60_000 + 1);
    slackTasks.tick();
    const lines = posts((post) => post.sessionId === claude.id && post.inThread).map((p) => p.text);
    expect(lines.some((line) => line.includes(`Nick canceled task \`${canceled.id}\``))).toBe(true);
    expect(lines.some((line) => line.includes(`Task \`${expiring.id}\` expired`))).toBe(true);
  });

  it('at a restart, expires a long-overdue task instead of reminding about it', () => {
    const claude = agent('claude');
    const task = create(claude, { platform: 'codex', project: 'clankers' });
    now = new Date(now.getTime() + 9 * 60 * 60_000);
    slackTasks.start(60_000);
    slackTasks.stop();
    expect(fresh(task).approval).toBe('expired');
    expect(posts((post) => post.text.includes('Reminder'))).toHaveLength(0);
  });

  it('audits a stranger’s click with a cut task ID', () => {
    expect(slackTasks.decideByButton(`t-${'x'.repeat(500)}`, 'approve', 'U_OTHER')).toBe(
      'not_human',
    );
    const row = store.db
      .prepare("SELECT data FROM events WHERE kind = 'inbound.dropped'")
      .get() as { data: string };
    expect((JSON.parse(row.data) as { task: string }).task).toHaveLength(20);
  });
});

describe('the post queue and task threads', () => {
  it('posts a reply under its thread root, and the task learns its thread', async () => {
    const slack = new FakeSlack();
    const queue = new PostQueue(store, slack, new ChannelDirectory(slack, USER_ID), {
      log: silentLogger,
      minIntervalMs: 0,
    });
    const claude = agent('claude');
    const task = create(claude, { platform: 'codex', project: 'clankers' });
    slackTasks.decideByButton(task.id, 'approve', USER_ID);
    queue.kick();
    await queue.idle();
    const rootPost = slack.posts.find((post) => post.text.includes(`Task \`${task.id}\``));
    const approvedLine = slack.posts.find((post) =>
      post.text.startsWith(':white_check_mark: Approved'),
    );
    expect(rootPost?.channel).toBe('C_AGENTS');
    expect(approvedLine).toMatchObject({ channel: 'C_AGENTS', threadTs: rootPost?.ts });
    expect(fresh(task)).toMatchObject({ slackChannelId: 'C_AGENTS', threadTs: rootPost?.ts });
  });

  it('drops replies whose thread root failed, instead of posting them loose', async () => {
    const slack = new FakeSlack();
    const queue = new PostQueue(store, slack, new ChannelDirectory(slack, USER_ID), {
      log: silentLogger,
      minIntervalMs: 0,
    });
    const claude = agent('claude');
    const task = create(claude, { platform: 'codex', project: 'clankers' });
    store.markAttemptFailed(fresh(task).threadPostId ?? -1, 'channel_not_found', true);
    slackTasks.decideByButton(task.id, 'approve', USER_ID);
    queue.kick();
    await queue.idle();
    expect(slack.posts.some((post) => post.text.startsWith(':white_check_mark: Approved'))).toBe(
      false,
    );
    const dropped = posts((post) => post.text.startsWith(':white_check_mark: Approved'));
    expect(dropped[0]).toMatchObject({ state: 'failed', lastError: 'its thread root failed' });
  });
});
