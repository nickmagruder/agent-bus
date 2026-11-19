import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Digest, DIGEST, digestSlot, localTime } from '../../src/broker/digest.ts';
import { silentLogger } from '../../src/broker/log.ts';
import { BusService } from '../../src/broker/service.ts';
import { Store } from '../../src/broker/store.ts';

const TZ = 'America/Los_Angeles';
/** 2026-11-18 is in PST (UTC−8): 08:00 local is 16:00Z. */
const at = (iso: string) => new Date(iso);

let store: Store;
let service: BusService;
let digest: Digest;
let now: Date;
let kicks: number;

beforeEach(() => {
  now = at('2026-11-18T15:00:00Z'); // 07:00 local
  kicks = 0;
  store = new Store(':memory:', { now: () => now });
  const queue = { kick: () => kicks++ };
  service = new BusService(store, queue, () => now);
  digest = new Digest({ store, queue, log: silentLogger, now: () => now, timeZone: TZ });
});

afterEach(() => {
  digest.stop();
  store.close();
});

function posts(): string[] {
  const rows = store.db
    .prepare("SELECT text FROM outbox WHERE target = 'agents' ORDER BY id")
    .all() as { text: string }[];
  return rows.map((row) => row.text).filter((text) => text.includes('Agent digest'));
}

function register(purpose: string, project = 'clankers'): string {
  return service.register({ platform: 'claude', purpose, project }).session.id;
}

function fyi(session: string, text: string): void {
  service.notify({ platform: 'claude', session, text, urgency: 'fyi' });
}

/** Marks today's 08:00 slot done, so tests start from a known last digest. */
function digestedAt(iso: string): void {
  now = at(iso);
  digest.tick();
}

describe('digestSlot', () => {
  it('is yesterday before the digest hour and today from it, in local time', () => {
    expect(localTime(at('2026-11-18T15:59:00Z'), TZ)).toEqual({ day: '2026-11-18', hour: 7 });
    expect(digestSlot(at('2026-11-18T15:59:00Z'), TZ)).toBe('2026-11-17');
    expect(digestSlot(at('2026-11-18T16:00:00Z'), TZ)).toBe('2026-11-18');
    // 01:00Z on the 19th is still the 18th, 17:00, in Seattle.
    expect(digestSlot(at('2026-11-19T01:00:00Z'), TZ)).toBe('2026-11-18');
  });

  it('follows daylight saving time', () => {
    // July: PDT (UTC−7), so 08:00 local is 15:00Z.
    expect(digestSlot(at('2026-07-01T14:59:00Z'), TZ)).toBe('2026-06-30');
    expect(digestSlot(at('2026-07-01T15:00:00Z'), TZ)).toBe('2026-07-01');
  });
});

describe('Digest.tick', () => {
  it('stores fyi notifications for the digest instead of posting them', () => {
    const session = register('Refactor the queue');
    fyi(session, 'Merged the refactor');
    expect(store.pendingDigestItems()).toEqual([
      expect.objectContaining({ sessionId: session, text: 'Merged the refactor' }),
    ]);
    expect(posts()).toEqual([]);
  });

  it('posts once a day at 08:00 local, then not again that day', () => {
    digestedAt('2026-11-17T16:00:00Z'); // yesterday 08:00
    const session = register('Refactor the queue');
    fyi(session, 'Merged the refactor');
    now = at('2026-11-18T15:59:00Z'); // 07:59
    expect(digest.tick()).toBe('not_due');
    now = at('2026-11-18T16:00:00Z'); // 08:00
    const before = kicks;
    expect(digest.tick()).toBe('sent');
    expect(kicks).toBe(before + 1);
    now = at('2026-11-18T23:00:00Z');
    fyi(session, 'Another one');
    expect(digest.tick()).toBe('not_due');
    expect(posts()).toHaveLength(1);
    // The next morning covers only what's new.
    now = at('2026-11-19T16:05:00Z');
    expect(digest.tick()).toBe('sent');
    const [first, second] = posts();
    expect(first).toContain('Merged the refactor');
    expect(second).toContain('Another one');
    expect(second).not.toContain('Merged the refactor');
  });

  it('nothing to report: no post, and the slot is still done', () => {
    digestedAt('2026-11-17T16:00:00Z');
    now = at('2026-11-18T16:00:00Z');
    expect(digest.tick()).toBe('empty');
    expect(posts()).toEqual([]);
    expect(digest.tick()).toBe('not_due');
  });

  it('catches up once at start after a missed slot, never twice for one slot', () => {
    digestedAt('2026-11-16T16:00:00Z'); // two days ago
    const session = register('Long task');
    now = at('2026-11-17T20:00:00Z');
    fyi(session, 'Done while the broker was off at 08:00');
    // The broker starts at 07:00 today: yesterday's slot was missed.
    now = at('2026-11-18T15:00:00Z');
    expect(digest.tick()).toBe('sent');
    expect(digest.tick()).toBe('not_due');
    expect(posts()).toHaveLength(1);
    // Today's slot at 08:00 has nothing new to say.
    now = at('2026-11-18T16:00:00Z');
    expect(digest.tick()).toBe('empty');
    expect(posts()).toHaveLength(1);
  });

  it('the first digest ever covers the last 24 hours', () => {
    now = at('2026-11-16T12:00:00Z');
    register('Old session');
    now = at('2026-11-18T10:00:00Z');
    const recent = register('Recent session');
    now = at('2026-11-18T16:00:00Z');
    expect(digest.tick()).toBe('sent');
    const [post] = posts();
    expect(post).toContain(recent);
    expect(post).toContain('Recent session');
    expect(post).not.toContain('Old session');
  });

  it('runs a tick at start (the catch-up) and keeps checking', () => {
    const session = register('Started');
    fyi(session, 'Hello');
    now = at('2026-11-18T16:00:00Z');
    digest.start(60_000);
    expect(posts()).toHaveLength(1);
  });
});

describe('digest content', () => {
  beforeEach(() => digestedAt('2026-11-17T16:00:00Z'));

  it('groups fyi items by session, with its purpose, and lists sessions seen', () => {
    const a = register('Refactor the queue');
    const b = register('Write docs', 'agent-bus');
    fyi(a, 'One');
    fyi(b, 'Two');
    fyi(a, 'Three');
    now = at('2026-11-18T16:00:00Z');
    digest.tick();
    const [post] = posts();
    expect(post).toContain(':newspaper: *Agent digest* since Tue 17 Nov 08:00');
    expect(post).toContain('*FYI* (3)');
    expect(post).toMatch(new RegExp(`\`${a}\` Refactor the queue\n• One\n• Three`));
    expect(post).toMatch(new RegExp(`\`${b}\` Write docs\n• Two`));
    expect(post).toContain('*Sessions seen* (2)');
  });

  it('escapes agent text and shortens long items', () => {
    const session = register('Escape <b> & co');
    fyi(session, `<!channel> ${'x'.repeat(500)}`);
    fyi(session, 'line one\nline two\nline three');
    now = at('2026-11-18T16:00:00Z');
    digest.tick();
    const [post = ''] = posts();
    expect(post).not.toContain('<!channel>');
    expect(post).toContain('&lt;!channel&gt;');
    expect(post).toContain('Escape &lt;b&gt; &amp; co');
    expect(post).toContain('…');
    expect(post).toContain('• line one line two …');
  });

  it('lists open questions and those that expired since the last digest', () => {
    const session = register('Asking');
    now = at('2026-11-17T12:00:00Z');
    const old = service.ask({
      platform: 'claude',
      session,
      question: 'Old?',
      defaultAnswer: 'skip',
    });
    store.closeQuestion(old.id, { state: 'expired' }); // before the last digest
    now = at('2026-11-18T10:00:00Z');
    const expired = service.ask({
      platform: 'claude',
      session,
      question: 'Rename it?',
      defaultAnswer: 'keep the name',
    });
    store.closeQuestion(expired.id, { state: 'expired' });
    const open = service.ask({
      platform: 'claude',
      session,
      question: 'Ship <it>?',
      defaultAnswer: 'wait',
    });
    now = at('2026-11-18T16:00:00Z');
    digest.tick();
    const [post = ''] = posts();
    expect(post).toContain('*Questions* (2)');
    expect(post).toContain(
      `:hourglass: \`${expired.id}\` (\`${session}\`) "Rename it?": expired, went with: keep the name`,
    );
    expect(post).toContain(
      `:question: \`${open.id}\` (\`${session}\`) "Ship &lt;it&gt;?": still open`,
    );
    expect(post).not.toContain('Old?');
  });

  it('keeps the post short and says how much was left out', () => {
    const session = register('Chatty');
    for (let i = 0; i < 60; i++) fyi(session, `note ${i} ${'y'.repeat(100)}`);
    now = at('2026-11-18T16:00:00Z');
    digest.tick();
    const [post = ''] = posts();
    expect(post.length).toBeLessThan(DIGEST.maxChars + 100);
    expect(post).toMatch(/_…\d+ more lines not shown_$/);
    // Every item counts as digested, shown or not: none roll into tomorrow.
    expect(store.pendingDigestItems()).toEqual([]);
  });

  it('records each digest in the audit log without its text', () => {
    const session = register('Audit');
    fyi(session, 'secret-ish detail');
    now = at('2026-11-18T16:00:00Z');
    digest.tick();
    const rows = store.db.prepare("SELECT data FROM events WHERE kind = 'digest.done'").all() as {
      data: string;
    }[];
    expect(JSON.parse(rows.at(-1)?.data ?? '{}')).toMatchObject({
      slot: '2026-11-18',
      posted: true,
      items: 1,
    });
    expect(JSON.stringify(rows)).not.toContain('secret-ish');
  });
});
