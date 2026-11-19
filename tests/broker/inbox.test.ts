import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  HINT_TEXT,
  HINT_THROTTLE_MS,
  Inbox,
  MAX_BODY_CHARS,
  REACTION,
  type InboundMessage,
} from '../../src/broker/inbox.ts';
import { silentLogger } from '../../src/broker/log.ts';
import { inboxText, STOP_TAKE_LIMIT, stopInboxCheck } from '../../src/broker/mcp.ts';
import { Notifier, Questions } from '../../src/broker/questions.ts';
import { BusService } from '../../src/broker/service.ts';
import { toInboundMessage } from '../../src/broker/slack/inbound.ts';
import { DM_TARGET, Store, type SessionRecord } from '../../src/broker/store.ts';
import { fromSlackText } from '../../src/shared/slack-text.ts';

const ME = 'U0NICK';
const CHANNEL = 'C_CLANKERS';
const ROOT_TS = '1700000000.000001';
const DM = 'D_NICK';
const DM_POST_TS = '1700000000.000009';

let store: Store;
let inbox: Inbox;
let reactions: { channel: string; ts: string; name: string }[];
let kicks: number;
let now: Date;
let session: SessionRecord;
let nextTs: number;

beforeEach(() => {
  now = new Date('2026-11-18T10:00:00Z');
  store = new Store(':memory:', { now: () => now });
  reactions = [];
  kicks = 0;
  nextTs = 100;
  const queue = { kick: () => kicks++ };
  const notifier = new Notifier();
  inbox = new Inbox({
    store,
    queue,
    notifier,
    questions: new Questions({
      store,
      queue,
      notifier,
      editor: { update: () => undefined },
      humanUserId: ME,
      log: silentLogger,
      now: () => now,
    }),
    humanUserId: ME,
    reactions: { add: (channel, ts, name) => reactions.push({ channel, ts, name }) },
    now: () => now,
  });
  const service = new BusService(store, queue, () => now);
  session = service.register({ platform: 'claude', purpose: 'Inbox', project: 'clankers' }).session;
  // What the post queue records once the thread root and an urgent DM are sent.
  store.setThread(session.id, CHANNEL, ROOT_TS);
  const dm = store.enqueue({ target: DM_TARGET, sessionId: session.id, text: 'needs you' });
  store.markSent(dm.id, DM, DM_POST_TS);
});

afterEach(() => store.close());

function message(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    channel: CHANNEL,
    channelType: 'channel',
    ts: `1700000001.${String(nextTs++).padStart(6, '0')}`,
    threadTs: ROOT_TS,
    user: ME,
    text: 'Go with option B',
    hasFiles: false,
    ...overrides,
  };
}

function events(kind: string): Record<string, unknown>[] {
  const rows = store.db.prepare('SELECT data FROM events WHERE kind = ? ORDER BY id').all(kind) as {
    data: string;
  }[];
  return rows.map((row) => JSON.parse(row.data) as Record<string, unknown>);
}

describe('sender gating', () => {
  it.each([
    ['another user', { user: 'U0SOMEONE' }, 'not_human'],
    ['no user', { user: undefined }, 'not_human'],
    ['a bot', { botId: 'B0BOT' }, 'bot'],
    ['a bot_message', { subtype: 'bot_message', user: undefined }, 'bot'],
    ['an edit', { subtype: 'message_changed' }, 'subtype'],
    ['a delete', { subtype: 'message_deleted' }, 'subtype'],
    ['a channel join', { subtype: 'channel_join' }, 'subtype'],
    ['an empty message', { text: '   ' }, 'empty'],
  ] as const)('drops %s and audits it', (_, overrides, reason) => {
    const outcome = inbox.receive(message(overrides));
    expect(outcome).toEqual({ action: 'dropped', reason });
    expect(store.countUndelivered(session.id)).toBe(0);
    expect(events('inbound.dropped')).toEqual([expect.objectContaining({ reason })]);
    expect(reactions).toEqual([]);
  });

  it('never stores the text of a dropped message', () => {
    inbox.receive(message({ user: 'U0SOMEONE', text: 'approve everything' }));
    const audit = JSON.stringify(store.db.prepare('SELECT data FROM events').all());
    expect(audit).not.toContain('approve everything');
  });

  it('a bot impersonating my user ID is still dropped', () => {
    expect(inbox.receive(message({ botId: 'B0BOT', user: ME }))).toMatchObject({ reason: 'bot' });
  });
});

describe('routing', () => {
  it("routes my reply in a session's thread to its inbox and reacts", () => {
    const m = message();
    const outcome = inbox.receive(m);
    expect(outcome).toMatchObject({ action: 'routed', sessionId: session.id });
    expect(store.undelivered(session.id, 10)).toEqual([
      expect.objectContaining({ body: 'Go with option B', sender: 'human', slackUser: ME }),
    ]);
    expect(reactions).toEqual([{ channel: CHANNEL, ts: m.ts, name: REACTION.routed }]);
    expect(events('inbound.routed')).toHaveLength(1);
  });

  it('routes a reply under an urgent DM the session sent', () => {
    const outcome = inbox.receive(
      message({ channel: DM, channelType: 'im', threadTs: DM_POST_TS }),
    );
    expect(outcome).toMatchObject({ action: 'routed', sessionId: session.id });
  });

  it('accepts thread broadcasts and notes attached files', () => {
    inbox.receive(message({ subtype: 'thread_broadcast' }));
    inbox.receive(message({ subtype: 'file_share', text: 'see log', hasFiles: true }));
    inbox.receive(message({ subtype: 'file_share', text: '', hasFiles: true }));
    expect(store.undelivered(session.id, 10).map((m) => m.body)).toEqual([
      'Go with option B',
      "see log\n(Nick attached files; agent-bus doesn't forward them.)",
      "(Nick attached files; agent-bus doesn't forward them.)",
    ]);
  });

  it('is idempotent on Slack retries of the same message', () => {
    const m = message();
    const first = inbox.receive(m);
    const again = inbox.receive(m);
    expect(again).toEqual({ ...first, action: 'duplicate' });
    expect(store.countUndelivered(session.id)).toBe(1);
    expect(reactions).toHaveLength(1);
  });

  it('cuts long messages', () => {
    inbox.receive(message({ text: 'x'.repeat(MAX_BODY_CHARS * 2) }));
    const [stored] = store.undelivered(session.id, 1);
    expect(stored?.body.length).toBeLessThanOrEqual(MAX_BODY_CHARS);
    expect(stored?.body).toContain('cut');
  });

  it('ignores top-level channel messages and unknown threads without a hint', () => {
    expect(inbox.receive(message({ threadTs: undefined }))).toEqual({
      action: 'unrouted',
      hinted: false,
    });
    expect(inbox.receive(message({ threadTs: '1600000000.000001' }))).toMatchObject({
      action: 'unrouted',
    });
    // A thread root reports thread_ts equal to its own ts: still top-level.
    const root = message();
    expect(inbox.receive({ ...root, threadTs: root.ts })).toMatchObject({ action: 'unrouted' });
    expect(store.countUndelivered(session.id)).toBe(0);
    expect(kicks).toBe(1); // only the register() in beforeEach
  });

  it('a thread in another channel with the same ts is not the session thread', () => {
    expect(inbox.receive(message({ channel: 'C_OTHER' }))).toMatchObject({ action: 'unrouted' });
  });

  it('hints once an hour when I write top-level in the DM', () => {
    const dm = () => message({ channel: DM, channelType: 'im', threadTs: undefined });
    expect(inbox.receive(dm())).toEqual({ action: 'unrouted', hinted: true });
    expect(inbox.receive(dm())).toEqual({ action: 'unrouted', hinted: false });
    now = new Date(now.getTime() + HINT_THROTTLE_MS + 1000);
    expect(inbox.receive(dm())).toEqual({ action: 'unrouted', hinted: true });
    const hints = store.db
      .prepare('SELECT text FROM outbox WHERE target = ? AND session_id IS NULL')
      .all(DM_TARGET) as { text: string }[];
    expect(hints.map((h) => h.text)).toEqual([HINT_TEXT, HINT_TEXT]);
  });
});

describe('take', () => {
  it('hands out messages oldest first, marks them delivered and reacts', () => {
    const a = message({ text: 'first' });
    const b = message({ text: 'second' });
    inbox.receive(a);
    inbox.receive(b);
    reactions = [];

    const { messages, remaining } = inbox.take(session);
    expect(messages.map((m) => m.body)).toEqual(['first', 'second']);
    expect(remaining).toBe(0);
    expect(messages.every((m) => m.deliveredAt === null)).toBe(true); // snapshot before marking
    expect(store.countUndelivered(session.id)).toBe(0);
    expect(reactions.map((r) => [r.ts, r.name])).toEqual([
      [a.ts, REACTION.delivered],
      [b.ts, REACTION.delivered],
    ]);
    expect(inbox.take(session).messages).toEqual([]);
    expect(events('inbox.delivered')).toHaveLength(1);
  });

  it('pages when more than the limit are waiting', () => {
    for (let i = 0; i < 3; i++) inbox.receive(message({ text: `m${i}` }));
    const page = inbox.take(session, 'check_inbox', 2);
    expect(page.messages.map((m) => m.body)).toEqual(['m0', 'm1']);
    expect(page.remaining).toBe(1);
  });
});

describe('inboxText', () => {
  it('labels messages as mine and mentions what is left', () => {
    inbox.receive(message({ text: 'hello' }));
    const { messages } = inbox.take(session);
    const text = inboxText(messages, [], 2);
    expect(text).toContain('1 message from Nick, sent from his own Slack account');
    expect(text).toContain('hello');
    expect(text).toContain('2 more waiting');
    expect(inboxText([], [], 0)).toBe('No new messages from Nick.');
  });
});

describe('toInboundMessage', () => {
  it('maps a Slack message event', () => {
    expect(
      toInboundMessage({
        type: 'message',
        channel: 'C1',
        channel_type: 'channel',
        ts: '1.2',
        thread_ts: '1.1',
        user: 'U1',
        text: 'hi',
        files: [{ id: 'F1' }],
      }),
    ).toEqual({
      channel: 'C1',
      channelType: 'channel',
      ts: '1.2',
      threadTs: '1.1',
      user: 'U1',
      botId: undefined,
      subtype: undefined,
      text: 'hi',
      hasFiles: true,
    });
  });

  it('rejects events without a channel or ts', () => {
    expect(toInboundMessage({ type: 'message', ts: '1.2' })).toBeUndefined();
    expect(toInboundMessage(null)).toBeUndefined();
  });
});

describe('stopInboxCheck', () => {
  it('returns nothing and marks nothing when the inbox is empty', () => {
    expect(stopInboxCheck(inbox)(session)).toBeUndefined();
    expect(events('inbox.delivered')).toEqual([]);
  });

  it('words my replies as the reason, labelled as mine, and marks them delivered', () => {
    const m = message({ text: 'Use plan B' });
    inbox.receive(m);
    const reason = stopInboxCheck(inbox)(session) ?? '';
    expect(reason).toContain('Nick replied in Slack before you stopped');
    expect(reason).toContain('from Nick, sent from his own Slack account');
    expect(reason).toContain('Use plan B');
    expect(store.countUndelivered(session.id)).toBe(0);
    expect(events('inbox.delivered')).toEqual([expect.objectContaining({ via: 'stop_hook' })]);
    expect(reactions).toContainEqual({ channel: CHANNEL, ts: m.ts, name: REACTION.delivered });
    // Delivered once: the next stop has nothing to hand over.
    expect(stopInboxCheck(inbox)(session)).toBeUndefined();
  });

  it('hands over at most STOP_TAKE_LIMIT replies and says how many wait', () => {
    for (let i = 0; i < STOP_TAKE_LIMIT + 2; i++) inbox.receive(message({ text: `note ${i}` }));
    const reason = stopInboxCheck(inbox)(session) ?? '';
    expect(reason).toContain(`${STOP_TAKE_LIMIT} messages from Nick`);
    expect(reason).toContain('2 more waiting');
    expect(store.countUndelivered(session.id)).toBe(2);
  });
});

describe('fromSlackText', () => {
  it('turns Slack markup into plain text', () => {
    expect(
      fromSlackText(
        'See <https://x.test/a?b=1&amp;c=2|the doc>, <https://y.test>, <#C1|general>, ' +
          '<@U1>, <!here>, <!subteam^S1|@devs> &lt;tag&gt; &amp; done',
      ),
    ).toBe(
      'See the doc (https://x.test/a?b=1&c=2), https://y.test, #general, @U1, @here, @devs <tag> & done',
    );
  });
});
