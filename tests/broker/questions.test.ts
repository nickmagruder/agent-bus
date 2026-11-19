import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Inbox, REACTION, type InboundMessage } from '../../src/broker/inbox.ts';
import { silentLogger } from '../../src/broker/log.ts';
import {
  Notifier,
  outcomeText,
  QUESTION_LIMITS,
  questionMessage,
  Questions,
  questionTimes,
} from '../../src/broker/questions.ts';
import { BusError, BusService, LIMITS } from '../../src/broker/service.ts';
import { toButtonClick } from '../../src/broker/slack/inbound.ts';
import {
  DM_TARGET,
  Store,
  type QuestionRecord,
  type SessionRecord,
} from '../../src/broker/store.ts';

const ME = 'U0NICK';
const CHANNEL = 'C_CLANKERS';
const ROOT_TS = '1700000000.000001';
const DM = 'D_NICK';
const MINUTE = 60_000;

let store: Store;
let service: BusService;
let questions: Questions;
let inbox: Inbox;
let notifier: Notifier;
let now: Date;
let session: SessionRecord;
let edits: { channel: string; ts: string; text: string; blocks: unknown[] }[];
let reactions: { ts: string; name: string }[];
let nextTs: number;

beforeEach(() => {
  now = new Date('2026-11-18T10:00:00Z');
  store = new Store(':memory:', { now: () => now });
  edits = [];
  reactions = [];
  nextTs = 100;
  const queue = { kick: () => undefined };
  notifier = new Notifier();
  service = new BusService(store, queue, () => now);
  questions = new Questions({
    store,
    queue,
    notifier,
    humanUserId: ME,
    log: silentLogger,
    now: () => now,
    editor: { update: (channel, ts, text, blocks) => edits.push({ channel, ts, text, blocks }) },
  });
  inbox = new Inbox({
    store,
    queue,
    questions,
    notifier,
    humanUserId: ME,
    reactions: { add: (_channel, ts, name) => reactions.push({ ts, name }) },
    now: () => now,
  });
  session = service.register({ platform: 'claude', purpose: 'Q', project: 'clankers' }).session;
  store.setThread(session.id, CHANNEL, ROOT_TS);
});

afterEach(() => store.close());

function ask(overrides: Partial<Parameters<BusService['ask']>[0]> = {}): QuestionRecord {
  return service.ask({
    platform: 'claude',
    session: session.id,
    question: 'Push to **main** or open a PR?',
    options: ['Push', 'Open a PR'],
    defaultAnswer: 'Open a PR',
    ...overrides,
  });
}

/** Marks a question's DM as sent and returns its Slack ts. */
function sendDm(question: QuestionRecord): string {
  const ts = `1700000002.${String(nextTs++).padStart(6, '0')}`;
  store.markSent(question.postId ?? -1, DM, ts);
  return ts;
}

function reply(overrides: Partial<InboundMessage>): InboundMessage {
  return {
    channel: CHANNEL,
    channelType: 'channel',
    ts: `1700000003.${String(nextTs++).padStart(6, '0')}`,
    threadTs: ROOT_TS,
    user: ME,
    text: 'push it',
    hasFiles: false,
    ...overrides,
  };
}

function expectBusError(work: () => unknown, code: BusError['code']): void {
  try {
    work();
    expect.unreachable();
  } catch (error) {
    expect(error).toBeInstanceOf(BusError);
    expect((error as BusError).code).toBe(code);
  }
}

function reload(question: QuestionRecord): QuestionRecord {
  const found = store.getQuestion(question.id);
  if (!found) throw new Error('question gone');
  return found;
}

describe('asking', () => {
  it('queues a DM with buttons and a pointer in the session thread', () => {
    const question = ask();
    expect(question).toMatchObject({ state: 'open', options: ['Push', 'Open a PR'] });
    expect(question.id).toMatch(/^q-[0-9a-f]{6}$/);

    const dm = store.getPost(question.postId ?? -1);
    expect(dm?.target).toBe(DM_TARGET);
    const actions = (
      dm?.blocks as { type: string; block_id?: string; elements?: unknown[] }[]
    ).find((b) => b.type === 'actions');
    expect(actions?.block_id).toBe(question.id);
    expect(actions?.elements).toEqual([
      expect.objectContaining({ action_id: 'agentbus_answer_0', value: '0' }),
      expect.objectContaining({ action_id: 'agentbus_answer_1', value: '1' }),
    ]);
    expect(JSON.stringify(dm?.blocks)).toContain('*main*'); // Markdown → mrkdwn

    const pointer = store.db
      .prepare(
        "SELECT text FROM outbox WHERE target = 'proj-clankers' AND text LIKE '%Asked Nick%'",
      )
      .get() as { text: string } | undefined;
    expect(pointer?.text).toContain(question.id);
    expect(
      store.countEvents({
        kind: 'notify',
        since: new Date(0),
        dataField: { name: 'urgency', value: 'urgent' },
      }),
    ).toBe(1);
  });

  it('asks without buttons when there are no options', () => {
    const question = ask({ options: undefined });
    const blocks = store.getPost(question.postId ?? -1)?.blocks as { type: string }[];
    expect(blocks.map((b) => b.type)).toEqual(['section', 'context']);
  });

  it('reminds at 15 minutes and expires at the timeout, clamped', () => {
    expect(questionTimes(now)).toEqual({
      remindAt: new Date(now.getTime() + 15 * MINUTE),
      expiresAt: new Date(now.getTime() + 60 * MINUTE),
    });
    expect(questionTimes(now, 10)).toEqual({
      remindAt: new Date(now.getTime() + 5 * MINUTE),
      expiresAt: new Date(now.getTime() + 10 * MINUTE),
    });
    expect(questionTimes(now, 1).expiresAt).toEqual(new Date(now.getTime() + 5 * MINUTE));
    expect(questionTimes(now, 100_000).expiresAt).toEqual(
      new Date(now.getTime() + QUESTION_LIMITS.maxTimeoutMinutes * MINUTE),
    );
  });

  it("refuses another platform's session", () => {
    expectBusError(() => ask({ platform: 'codex' }), 'wrong_platform');
  });

  it('limits open questions per session', () => {
    for (let i = 0; i < QUESTION_LIMITS.openPerSession; i++) ask({ question: `q${i}` });
    expectBusError(() => ask(), 'too_many_questions');
  });

  it('counts against the urgent cap', () => {
    for (let i = 0; i < LIMITS.urgentPerSession; i++) {
      service.notify({ platform: 'claude', session: session.id, text: 'x', urgency: 'urgent' });
    }
    expectBusError(() => ask(), 'rate_limited');
  });
});

describe('buttons', () => {
  it('answers with the stored option; the first click wins', () => {
    const question = ask();
    const ts = sendDm(question);
    expect(questions.answerByButton(question.id, 1, ME)).toBe('answered');
    expect(reload(question)).toMatchObject({
      state: 'answered',
      answer: 'Open a PR',
      answerSource: 'button',
      answeredBy: ME,
    });
    expect(questions.answerByButton(question.id, 0, ME)).toBe('closed');
    expect(reload(question).answer).toBe('Open a PR');

    expect(edits).toHaveLength(1);
    expect(edits[0]).toMatchObject({ channel: DM, ts });
    expect(JSON.stringify(edits[0]?.blocks)).not.toContain('agentbus_answer');
    expect(JSON.stringify(edits[0]?.blocks)).toContain('Answered (button)');
  });

  it("ignores other people's clicks and audits them", () => {
    const question = ask();
    expect(questions.answerByButton(question.id, 0, 'U0SOMEONE')).toBe('not_human');
    expect(reload(question).state).toBe('open');
    expect(store.countEvents({ kind: 'inbound.dropped', since: new Date(0) })).toBe(1);
  });

  it('rejects unknown questions and options', () => {
    const question = ask();
    expect(questions.answerByButton('q-000000', 0, ME)).toBe('unknown');
    expect(questions.answerByButton(question.id, 7, ME)).toBe('invalid');
    expect(questions.answerByButton(question.id, -1, ME)).toBe('invalid');
  });

  it('rewrites a question DM that has not been sent yet', () => {
    const question = ask();
    questions.answerByButton(question.id, 0, ME);
    expect(edits).toEqual([]);
    expect(JSON.stringify(store.getPost(question.postId ?? -1)?.blocks)).toContain('Answered');
  });

  it('wakes a waiting call', async () => {
    const question = ask();
    const waiting = notifier.wait(session.id, 5000);
    questions.answerByButton(question.id, 0, ME);
    await expect(waiting).resolves.toBe('notified');
  });

  it('parses a block_actions click', () => {
    expect(
      toButtonClick(
        { user: { id: ME } },
        { type: 'button', action_id: 'agentbus_answer_1', block_id: 'q-abcdef', value: '1' },
      ),
    ).toEqual({ questionId: 'q-abcdef', optionIndex: 1, userId: ME });
    expect(
      toButtonClick({ user: { id: ME } }, { type: 'button', action_id: 'other', block_id: 'q' }),
    ).toBeUndefined();
    expect(
      toButtonClick({}, { type: 'button', action_id: 'agentbus_answer_0', block_id: 'q' }),
    ).toBeUndefined();
  });
});

describe('replies', () => {
  it('a reply under the question DM answers it and is delivered with the outcome', () => {
    const question = ask();
    const ts = sendDm(question);
    const message = reply({
      channel: DM,
      channelType: 'im',
      threadTs: ts,
      text: 'Push, tests are green',
    });
    expect(inbox.receive(message)).toMatchObject({ action: 'routed', questionId: question.id });
    expect(reload(question)).toMatchObject({
      state: 'answered',
      answerSource: 'reply',
      answer: 'Push, tests are green',
    });

    const taken = inbox.take(session);
    expect(taken.messages).toEqual([]);
    expect(taken.outcomes.map((q) => q.id)).toEqual([question.id]);
    expect(reactions).toContainEqual({ ts: message.ts, name: REACTION.delivered });
    expect(inbox.take(session).outcomes).toEqual([]);
  });

  it("a reply in the session thread answers the session's only open question", () => {
    const question = ask();
    inbox.receive(reply({}));
    expect(reload(question).state).toBe('answered');
  });

  it('with two open questions a thread reply is just a message', () => {
    const first = ask({ question: 'one' });
    const second = ask({ question: 'two' });
    inbox.receive(reply({ text: 'hello' }));
    expect(reload(first).state).toBe('open');
    expect(reload(second).state).toBe('open');
    expect(inbox.take(session).messages.map((m) => m.body)).toEqual(['hello']);
  });

  it('a reply after the question closed is a plain message', () => {
    const question = ask();
    const ts = sendDm(question);
    questions.answerByButton(question.id, 0, ME);
    const outcome = inbox.receive(
      reply({ channel: DM, channelType: 'im', threadTs: ts, text: 'also: thanks' }),
    );
    expect(outcome).toMatchObject({ action: 'routed' });
    expect(outcome).not.toHaveProperty('questionId');
    const taken = inbox.take(session);
    expect(taken.messages.map((m) => m.body)).toEqual(['also: thanks']);
    expect(taken.outcomes.map((q) => q.answer)).toEqual(['Push']);
  });

  it("a Slack retry of an answering reply doesn't answer twice", () => {
    const question = ask();
    const message = reply({});
    inbox.receive(message);
    expect(inbox.receive(message)).toMatchObject({ action: 'duplicate' });
    expect(store.countEvents({ kind: 'question.answered', since: new Date(0) })).toBe(1);
    expect(reload(question).answer).toBe('push it');
  });

  it("another user's reply never answers", () => {
    const question = ask();
    inbox.receive(reply({ user: 'U0SOMEONE' }));
    expect(reload(question).state).toBe('open');
  });
});

describe('reminders and expiry', () => {
  it('reminds once, then expires to the default', () => {
    const question = ask();
    questions.tick();
    expect(reload(question).remindedAt).toBeNull();

    now = new Date(now.getTime() + 15 * MINUTE);
    questions.tick();
    questions.tick();
    const reminders = store.db
      .prepare(
        "SELECT text, username, icon FROM outbox WHERE target = ? AND text LIKE '%Reminder%'",
      )
      .all(DM_TARGET) as { text: string; username: string | null; icon: string | null }[];
    expect(reminders).toHaveLength(1);
    // The session's name and icon, the same as its question DM.
    const questionDm = store.db
      .prepare('SELECT username, icon FROM outbox WHERE id = ?')
      .get(reload(question).postId) as { username: string | null; icon: string | null };
    expect(questionDm.username).toMatch(/^Claude Code · /);
    expect(reminders[0]).toMatchObject({ username: questionDm.username, icon: questionDm.icon });
    expect(reminders[0]?.text).toContain(question.id);
    expect(reload(question).reminderPostId).not.toBeNull();

    const ts = sendDm(question);
    now = new Date(now.getTime() + 45 * MINUTE);
    questions.tick();
    const expired = reload(question);
    expect(expired.state).toBe('expired');
    expect(edits.at(-1)).toMatchObject({ channel: DM, ts });
    expect(JSON.stringify(edits.at(-1)?.blocks)).toContain('Expired');
    expect(outcomeText(expired)).toContain('Go with your stated default: Open a PR');
    expect(questions.takeOutcome(question.id, 'wait_for_reply')?.state).toBe('expired');
    expect(inbox.take(session).outcomes).toEqual([]);
  });

  it('a reply under the reminder answers the question', () => {
    const question = ask({ options: undefined });
    now = new Date(now.getTime() + 15 * MINUTE);
    questions.tick();
    const reminder = reload(question).reminderPostId ?? -1;
    store.markSent(reminder, DM, '1700000009.000001');
    inbox.receive(reply({ channel: DM, channelType: 'im', threadTs: '1700000009.000001' }));
    expect(reload(question).state).toBe('answered');
  });

  it('a button after expiry does nothing', () => {
    const question = ask();
    now = new Date(now.getTime() + 61 * MINUTE);
    questions.tick();
    expect(questions.answerByButton(question.id, 0, ME)).toBe('closed');
  });
});

describe('outcomes', () => {
  it('takeOutcome is undefined while open, then returns the outcome', () => {
    const question = ask();
    expect(questions.takeOutcome(question.id, 'ask_human')).toBeUndefined();
    questions.answerByButton(question.id, 0, ME);
    expect(questions.takeOutcome(question.id, 'ask_human')).toMatchObject({ answer: 'Push' });
    expect(reload(question).deliveredVia).toBe('ask_human');
  });

  it('labels answers as mine and keeps the outcome in the closed DM', () => {
    const question = ask();
    questions.answerByButton(question.id, 0, ME);
    const answered = reload(question);
    expect(outcomeText(answered)).toContain('Nick chose on');
    expect(outcomeText(answered)).toContain('verified by agent-bus');
    expect(questionMessage(session, answered).text).toContain('(answered)');
  });
});
