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
import { inboxText } from '../../src/broker/mcp.ts';
import { StopDelivery } from '../../src/broker/stop-hook.ts';
import { Notifier, Questions } from '../../src/broker/questions.ts';
import { BusService, LIMITS } from '../../src/broker/service.ts';
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
let service: BusService;
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
  service = new BusService(store, queue, () => now);
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

describe('StopDelivery', () => {
  const delivered = (ts: string) => ({ channel: CHANNEL, ts, name: REACTION.delivered });

  it('returns nothing and marks nothing when the inbox is empty', () => {
    const delivery = new StopDelivery(inbox, store);
    expect(delivery.check(session)).toBeUndefined();
    delivery.settle(false);
    expect(events('inbox.delivered')).toEqual([]);
    expect(events('inbox.undelivered')).toEqual([]);
  });

  it('words my replies as the reason, labelled as mine; ✅ only once the app confirms', () => {
    const m = message({ text: 'Use plan B' });
    inbox.receive(m);
    const delivery = new StopDelivery(inbox, store);
    const reason = delivery.check(session) ?? '';
    expect(reason).toContain('Nick replied in Slack before you stopped');
    expect(reason).toContain('from Nick, sent from his own Slack account');
    expect(reason).toContain('Use plan B');
    expect(store.countUndelivered(session.id)).toBe(0);
    expect(events('inbox.delivered')).toEqual([expect.objectContaining({ via: 'stop_hook' })]);
    expect(events('stop.offered')).toEqual([
      expect.objectContaining({ messageIds: [expect.any(Number)], questionIds: [] }),
    ]);
    // Written isn't read: no ✅ yet.
    delivery.settle(true);
    expect(reactions).not.toContainEqual(delivered(m.ts));
    // In flight: check_inbox and the next stop don't hand it over a second time.
    expect(inbox.take(session, 'check_inbox').messages).toEqual([]);
    // The next stop_hook_active Stop confirms it.
    new StopDelivery(inbox, store).confirm(session);
    expect(reactions).toContainEqual(delivered(m.ts));
    expect(events('stop.confirmed')).toHaveLength(1);
    // Confirmed once: a later prompt doesn't put it back.
    new StopDelivery(inbox, store).putBack(session, 'UserPromptSubmit');
    expect(store.countUndelivered(session.id)).toBe(0);
    expect(new StopDelivery(inbox, store).check(session)).toBeUndefined();
  });

  it('puts an unconfirmed offer back when the next turn event shows the block was not read', () => {
    const m = message({ text: 'Use plan B' });
    inbox.receive(m);
    const delivery = new StopDelivery(inbox, store);
    delivery.check(session);
    delivery.settle(true);
    // e.g. a Stop without stop_hook_active: the agent stopped without our reason.
    new StopDelivery(inbox, store).putBack(session, 'Stop');
    expect(store.countUndelivered(session.id)).toBe(1);
    expect(reactions).not.toContainEqual(delivered(m.ts));
    expect(events('stop.returned')).toEqual([{ reason: 'Stop' }]);
    // Handed over again by the next stop, and confirming twice is harmless.
    const again = new StopDelivery(inbox, store);
    expect(again.check(session)).toContain('Use plan B');
    again.confirm(session);
    again.confirm(session);
    expect(reactions.filter((r) => r.name === REACTION.delivered)).toHaveLength(1);
  });

  it('putBack and confirm with no open offer change nothing', () => {
    inbox.receive(message({ text: 'one' }));
    inbox.take(session, 'check_inbox');
    const delivery = new StopDelivery(inbox, store);
    delivery.putBack(session, 'Stop');
    delivery.confirm(session);
    expect(store.countUndelivered(session.id)).toBe(0);
    expect(events('stop.returned')).toEqual([]);
    expect(events('stop.confirmed')).toEqual([]);
  });

  it('putting an offer back leaves alone a reply check_inbox took meanwhile', () => {
    inbox.receive(message({ text: 'one' }));
    const delivery = new StopDelivery(inbox, store);
    delivery.check(session);
    // Simulate check_inbox having taken it for real (delivered by another route).
    store.db.prepare("UPDATE inbox SET delivered_via = 'check_inbox'").run();
    delivery.putBack(session, 'UserPromptSubmit');
    expect(store.countUndelivered(session.id)).toBe(0);
  });

  it('puts the replies back when the response never reached the hook', () => {
    const m = message({ text: 'Use plan B' });
    inbox.receive(m);
    const lost = new StopDelivery(inbox, store);
    lost.check(session);
    lost.settle(false);
    lost.settle(true); // settles once: a late call changes nothing
    expect(store.countUndelivered(session.id)).toBe(1);
    expect(reactions).not.toContainEqual(delivered(m.ts));
    expect(events('inbox.undelivered')).toEqual([
      expect.objectContaining({ via: 'stop_hook', questionIds: [] }),
    ]);
    // The next stop (or check_inbox) hands them over again.
    expect(new StopDelivery(inbox, store).check(session)).toContain('Use plan B');
  });

  it('puts back a question outcome and the reply that answered it', () => {
    service.ask({
      platform: 'claude',
      session: session.id,
      question: 'A or B?',
      defaultAnswer: 'A',
    });
    inbox.receive(message({ text: 'B' }));
    const lost = new StopDelivery(inbox, store);
    expect(lost.check(session)).toContain('B');
    lost.settle(false);
    const again = new StopDelivery(inbox, store).check(session) ?? '';
    expect(again).toMatch(/Nick replied on q-[0-9a-f]+ \("A or B\?"\)/);
    expect(store.countUndelivered(session.id)).toBe(0);
  });

  it('never un-delivers what check_inbox delivered', () => {
    inbox.receive(message({ text: 'one' }));
    const stop = new StopDelivery(inbox, store);
    stop.check(session);
    // check_inbox got there first for this one; settle must leave it alone.
    const other = message({ text: 'two' });
    inbox.receive(other);
    inbox.take(session, 'check_inbox');
    stop.settle(false);
    expect(store.undelivered(session.id, 10).map((r) => r.body)).toEqual(['one']);
  });

  it('records no undelivery when nothing was actually put back', () => {
    inbox.receive(message({ text: 'one' }));
    const taken = inbox.take(session, 'check_inbox');
    // Undoing a "wait_for_reply" delivery of a row check_inbox delivered: no change.
    inbox.untake(session, taken, 'wait_for_reply');
    expect(store.countUndelivered(session.id)).toBe(0);
    expect(events('inbox.undelivered')).toEqual([]);
  });

  it('hands over at most stopTakePerBlock replies and says how many wait', () => {
    const limit = LIMITS.stopTakePerBlock;
    for (let i = 0; i < limit + 2; i++) inbox.receive(message({ text: `note ${i}` }));
    const reason = new StopDelivery(inbox, store).check(session) ?? '';
    expect(reason).toContain(`${limit} messages from Nick`);
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
