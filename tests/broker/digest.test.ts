import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  Digest,
  DIGEST,
  digestSlot,
  itemPreview,
  localTime,
  previousDay,
} from '../../src/broker/digest.ts';
import type { GitHubApi, MergedPr } from '../../src/broker/github.ts';
import { silentLogger } from '../../src/broker/log.ts';
import { startBroker } from '../../src/broker/main.ts';
import { FakeSlack, TOKENS, USER_ID } from './fakes.ts';
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
async function digestedAt(iso: string): Promise<void> {
  now = at(iso);
  await digest.tick();
}

describe('digestSlot', () => {
  it('is yesterday before the digest hour and today from it, in local time', async () => {
    expect(localTime(at('2026-11-18T15:59:00Z'), TZ)).toEqual({ day: '2026-11-18', hour: 7 });
    expect(digestSlot(at('2026-11-18T15:59:00Z'), TZ)).toBe('2026-11-17');
    expect(digestSlot(at('2026-11-18T16:00:00Z'), TZ)).toBe('2026-11-18');
    // 01:00Z on the 19th is still the 18th, 17:00, in Seattle.
    expect(digestSlot(at('2026-11-19T01:00:00Z'), TZ)).toBe('2026-11-18');
  });

  it('follows daylight saving time', async () => {
    // July: PDT (UTC−7), so 08:00 local is 15:00Z.
    expect(digestSlot(at('2026-07-01T14:59:00Z'), TZ)).toBe('2026-06-30');
    expect(digestSlot(at('2026-07-01T15:00:00Z'), TZ)).toBe('2026-07-01');
    // 00:30 on the day after spring forward: 24 h earlier is the 7th, the slot is the 8th.
    expect(digestSlot(at('2026-03-09T07:30:00Z'), TZ)).toBe('2026-03-08');
    // 23:30 on the 25-hour fall-back day.
    expect(digestSlot(at('2026-11-02T07:30:00Z'), TZ)).toBe('2026-11-01');
  });
});

describe('Digest.tick', () => {
  it('stores fyi notifications for the digest instead of posting them', async () => {
    const session = register('Refactor the queue');
    fyi(session, 'Merged the refactor');
    expect(store.pendingDigestItems()).toEqual([
      expect.objectContaining({ sessionId: session, text: 'Merged the refactor' }),
    ]);
    expect(posts()).toEqual([]);
  });

  it('posts once a day at 08:00 local, then not again that day', async () => {
    await digestedAt('2026-11-17T16:00:00Z'); // yesterday 08:00
    const session = register('Refactor the queue');
    fyi(session, 'Merged the refactor');
    now = at('2026-11-18T15:59:00Z'); // 07:59
    expect(await digest.tick()).toBe('not_due');
    now = at('2026-11-18T16:00:00Z'); // 08:00
    const before = kicks;
    expect(await digest.tick()).toBe('sent');
    expect(kicks).toBe(before + 1);
    now = at('2026-11-18T23:00:00Z');
    fyi(session, 'Another one');
    expect(await digest.tick()).toBe('not_due');
    expect(posts()).toHaveLength(1);
    // The next morning covers only what's new.
    now = at('2026-11-19T16:05:00Z');
    expect(await digest.tick()).toBe('sent');
    const [first, second] = posts();
    expect(first).toContain('Merged the refactor');
    expect(second).toContain('Another one');
    expect(second).not.toContain('Merged the refactor');
  });

  it('nothing to report: no post, and the slot is still done', async () => {
    await digestedAt('2026-11-17T16:00:00Z');
    now = at('2026-11-18T16:00:00Z');
    expect(await digest.tick()).toBe('empty');
    expect(posts()).toEqual([]);
    expect(await digest.tick()).toBe('not_due');
  });

  it('catches up once at start after a missed slot, never twice for one slot', async () => {
    await digestedAt('2026-11-16T16:00:00Z'); // two days ago
    const session = register('Long task');
    now = at('2026-11-17T20:00:00Z');
    fyi(session, 'Done while the broker was off at 08:00');
    // The broker starts at 07:00 today: yesterday's slot was missed.
    now = at('2026-11-18T15:00:00Z');
    expect(await digest.tick()).toBe('sent');
    expect(await digest.tick()).toBe('not_due');
    expect(posts()).toHaveLength(1);
    // Today's slot at 08:00 has nothing new to say.
    now = at('2026-11-18T16:00:00Z');
    expect(await digest.tick()).toBe('empty');
    expect(posts()).toHaveLength(1);
  });

  it('the first digest ever covers the last 24 hours', async () => {
    now = at('2026-11-16T12:00:00Z');
    register('Old session');
    now = at('2026-11-18T10:00:00Z');
    const recent = register('Recent session');
    now = at('2026-11-18T16:00:00Z');
    expect(await digest.tick()).toBe('sent');
    const [post] = posts();
    expect(post).toContain(recent);
    expect(post).toContain('Recent session');
    expect(post).not.toContain('Old session');
  });

  it('runs a tick at start (the catch-up) and keeps checking on its timer', async () => {
    vi.useFakeTimers();
    try {
      const session = register('Started');
      fyi(session, 'Hello');
      now = at('2026-11-18T16:00:00Z');
      digest.start(60_000);
      await vi.advanceTimersByTimeAsync(0);
      expect(posts()).toHaveLength(1);
      now = at('2026-11-19T16:00:00Z');
      fyi(session, 'Next day');
      await vi.advanceTimersByTimeAsync(59_000);
      expect(posts()).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1000);
      expect(posts()).toHaveLength(2);
      digest.stop();
      now = at('2026-11-20T16:00:00Z');
      fyi(session, 'After stop');
      await vi.advanceTimersByTimeAsync(120_000);
      expect(posts()).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('logs a failing tick instead of throwing out of the timer', async () => {
    const logs: string[] = [];
    const failing = new Digest({
      store,
      queue: { kick: () => undefined },
      log: (_level, message) => logs.push(message),
      now: () => now,
      timeZone: TZ,
    });
    store.close();
    expect(() => failing.start(60_000)).not.toThrow();
    failing.stop();
    await expect.poll(() => logs).toEqual(['digest tick failed']);
    store = new Store(':memory:', { now: () => now }); // for afterEach
  });

  describe('daylight saving time', () => {
    it('posts each morning once across spring forward, never at night', async () => {
      // 2026-03-08 02:00 PST → 03:00 PDT; that day is 23 hours long.
      const session = register('DST');
      await digestedAt('2026-03-08T15:00:00Z'); // 08:00 PDT on the 8th
      for (const iso of [
        '2026-03-09T07:30:00Z', // 00:30 PDT on the 9th
        '2026-03-09T08:00:00Z', // 01:00
        '2026-03-09T14:59:00Z', // 07:59
      ]) {
        now = at(iso);
        fyi(session, `at ${iso}`);
        expect(await digest.tick(), iso).toBe('not_due');
      }
      now = at('2026-03-09T15:00:00Z'); // 08:00 PDT
      expect(await digest.tick()).toBe('sent');
    });

    it('posts each morning once across fall back', async () => {
      // 2026-11-01 02:00 PDT → 01:00 PST; that day is 25 hours long.
      const session = register('DST');
      await digestedAt('2026-11-01T16:00:00Z'); // 08:00 PST on the 1st, after the change
      for (const iso of ['2026-11-02T07:30:00Z', '2026-11-02T08:30:00Z', '2026-11-02T15:59:00Z']) {
        now = at(iso);
        fyi(session, `at ${iso}`);
        expect(await digest.tick(), iso).toBe('not_due');
      }
      now = at('2026-11-02T16:00:00Z'); // 08:00 PST
      expect(await digest.tick()).toBe('sent');
    });
  });

  it('never goes back to an older slot (clock set back, or a zone further east)', async () => {
    await digestedAt('2026-11-18T16:00:00Z');
    const session = register('Clock');
    fyi(session, 'news');
    now = at('2026-11-16T16:00:00Z');
    expect(await digest.tick()).toBe('not_due');
    expect(posts()).toEqual([]);
  });
});

describe('previousDay', () => {
  it.each([
    ['2026-11-18', '2026-11-17'],
    ['2026-03-01', '2026-02-28'],
    ['2028-03-01', '2028-02-29'],
    ['2027-01-01', '2026-12-31'],
    ['2026-03-09', '2026-03-08'],
  ])('%s → %s', (day, before) => {
    expect(previousDay(day)).toBe(before);
  });
});

describe('itemPreview', () => {
  it('drops code fences so a preview never leaves code formatting open', async () => {
    expect(itemPreview('```npm test``` passed')).toBe('npm test passed');
    expect(itemPreview('```\nconst x = 1;\nmore\n```')).toBe('const x = 1; more');
  });

  it('removes a lone backtick left by clipping', async () => {
    const text = `${'a'.repeat(DIGEST.itemChars - 10)} \`some code that runs long\``;
    const preview = itemPreview(text);
    expect(preview.split('`').length - 1).toBe(0);
    expect(preview.endsWith('…')).toBe(true);
  });

  it('keeps balanced backticks', async () => {
    expect(itemPreview('ran `npm test`')).toBe('ran `npm test`');
  });

  it('never splits an entity when clipping', async () => {
    const text = `${'a'.repeat(DIGEST.itemChars - 4)} &amp; more`;
    const preview = itemPreview(text);
    expect(preview).not.toMatch(/&[a-z]*…$/);
    expect(preview.endsWith('…')).toBe(true);
  });

  it('shows the first two non-empty lines', async () => {
    expect(itemPreview('one\n\ntwo\nthree')).toBe('one two …');
  });
});

describe('broker wiring', () => {
  it('starts with the broker (catch-up at start), and can be turned off', async () => {
    for (const digestOption of [{ timeZone: TZ, now: () => at('2026-11-18T16:00:00Z') }, null]) {
      const dir = await mkdtemp(path.join(tmpdir(), 'agent-bus-digest-'));
      const broker = await startBroker(
        {
          port: 0,
          dataDir: dir,
          tokens: TOKENS,
          slack: { botToken: 'xoxb-test', appToken: 'xapp-test', userId: USER_ID },
        },
        { log: silentLogger, slackApi: new FakeSlack(), connection: null, digest: digestOption },
      );
      try {
        const done = () => broker.store.latestEventOfKind('digest.done');
        if (digestOption) {
          await expect
            .poll(() => done()?.data)
            .toMatchObject({ slot: '2026-11-18', posted: false });
        } else {
          await new Promise((resolve) => setTimeout(resolve, 50));
          expect(done()).toBeUndefined();
        }
      } finally {
        await broker.stop();
        await rm(dir, { recursive: true, force: true });
      }
    }
  });
});

describe('merged PRs', () => {
  const pr = (n: number, fields: Partial<MergedPr> = {}): MergedPr => ({
    repo: 'octo/clankers',
    number: n,
    title: `Change ${n}`,
    url: `https://github.com/octo/clankers/pull/${n}`,
    author: 'nickm',
    agent: 'Claude Code',
    mergedAt: '2026-11-18T10:00:00Z',
    ...fields,
  });

  /** A fake GitHub: answers per repo, or throws; records the `since` it was asked for. */
  function fakeGitHub(answers: Record<string, MergedPr[] | Error>) {
    const asked: { repo: string; since: string }[] = [];
    const github: GitHubApi = {
      async mergedPullRequests(repo, since) {
        asked.push({ repo, since: since.toISOString() });
        const answer = answers[repo];
        if (answer instanceof Error) throw answer;
        return answer ?? [];
      },
    };
    return { github, asked };
  }

  function digestWith(github: GitHubApi, repos: string[], logs: string[] = []): Digest {
    return new Digest({
      store,
      queue: { kick: () => kicks++ },
      log: (_level, message, data) => logs.push(`${message} ${JSON.stringify(data)}`),
      now: () => now,
      timeZone: TZ,
      repos,
      github,
    });
  }

  it('lists PRs merged since the last digest, right after questions', async () => {
    const { github, asked } = fakeGitHub({
      'octo/clankers': [pr(11), pr(12, { agent: undefined, author: 'someone' })],
    });
    const d = digestWith(github, ['octo/clankers']);
    now = at('2026-11-17T16:00:00Z');
    await d.tick();
    const session = register('Busy');
    fyi(session, 'note');
    now = at('2026-11-18T16:00:00Z');
    expect(await d.tick()).toBe('sent');
    expect(asked.at(-1)).toEqual({ repo: 'octo/clankers', since: '2026-11-17T16:00:00.000Z' });
    const post = posts().at(-1) ?? '';
    expect(post).toContain('*Merged PRs* (2)');
    expect(post).toContain(
      '• <https://github.com/octo/clankers/pull/11|octo/clankers#11 Change 11> by nickm (Claude Code)',
    );
    expect(post).toContain(
      '• <https://github.com/octo/clankers/pull/12|octo/clankers#12 Change 12> by someone',
    );
    expect(post.indexOf('*Merged PRs*')).toBeLessThan(post.indexOf('*FYI*'));
  });

  it('posts a digest that only has merged PRs', async () => {
    const { github } = fakeGitHub({ 'octo/clankers': [pr(1)] });
    const d = digestWith(github, ['octo/clankers']);
    now = at('2026-11-18T16:00:00Z');
    expect(await d.tick()).toBe('sent');
    expect(posts()[0]).toContain('*Merged PRs* (1)');
  });

  it('escapes titles and authors from GitHub', async () => {
    const { github } = fakeGitHub({
      'octo/clankers': [pr(7, { title: '<!channel> a|b & c', author: '<@U0BAD>' })],
    });
    const d = digestWith(github, ['octo/clankers']);
    now = at('2026-11-18T16:00:00Z');
    await d.tick();
    const [post = ''] = posts();
    expect(post).not.toContain('<!channel>');
    expect(post).not.toContain('<@U0BAD>');
    expect(post).toContain('#7 &lt;!channel&gt; a¦b &amp; c> by &lt;@U0BAD&gt;');
  });

  it("skips a repo GitHub can't serve, logs it, and still lists the others", async () => {
    const logs: string[] = [];
    const { github } = fakeGitHub({
      'octo/clankers': new Error('GitHub answered 503 for octo/clankers'),
      'octo/agent-bus': [pr(4, { repo: 'octo/agent-bus' })],
    });
    const d = digestWith(github, ['octo/clankers', 'octo/agent-bus'], logs);
    now = at('2026-11-18T16:00:00Z');
    expect(await d.tick()).toBe('sent');
    expect(posts()[0]).toContain('octo/agent-bus#4');
    expect(logs).toEqual([expect.stringContaining('digest skipped merged PRs for a repo')]);
    expect(logs[0]).toContain('octo/clankers');
  });

  it('with GitHub down and nothing else to say, posts nothing', async () => {
    const { github } = fakeGitHub({ 'octo/clankers': new Error('offline') });
    const d = digestWith(github, ['octo/clankers']);
    now = at('2026-11-18T16:00:00Z');
    expect(await d.tick()).toBe('empty');
    expect(posts()).toEqual([]);
  });

  it("doesn't ask GitHub when no repos are configured, or when no digest is due", async () => {
    const none = fakeGitHub({});
    now = at('2026-11-18T16:00:00Z');
    await digestWith(none.github, []).tick();
    expect(none.asked).toEqual([]);
    const some = fakeGitHub({});
    const d = digestWith(some.github, ['octo/clankers']);
    expect(await d.tick()).toBe('not_due'); // the slot was just done above
    expect(some.asked).toEqual([]);
  });

  it('never posts one slot twice while GitHub is slow', async () => {
    let release: () => void = () => undefined;
    const github: GitHubApi = {
      mergedPullRequests: () =>
        new Promise((resolve) => {
          release = () => resolve([pr(1)]);
        }),
    };
    const d = digestWith(github, ['octo/clankers']);
    now = at('2026-11-18T16:00:00Z');
    const first = d.tick();
    expect(await d.tick()).toBe('not_due');
    release();
    expect(await first).toBe('sent');
    expect(await d.tick()).toBe('not_due');
    expect(posts()).toHaveLength(1);
  });

  it('counts merged PRs the length cap left out', async () => {
    const many = Array.from({ length: 80 }, (_, i) => pr(i, { title: 'x'.repeat(100) }));
    const { github } = fakeGitHub({ 'octo/clankers': many });
    const d = digestWith(github, ['octo/clankers']);
    now = at('2026-11-18T16:00:00Z');
    await d.tick();
    expect(posts()[0]).toMatch(/_…not shown: \d+ merged PRs_$/);
  });
});

describe('digest content', () => {
  beforeEach(async () => {
    await digestedAt('2026-11-17T16:00:00Z');
  });

  it('groups fyi items by session, with its purpose, and lists sessions seen', async () => {
    const a = register('Refactor the queue');
    const b = register('Write docs', 'agent-bus');
    fyi(a, 'One');
    fyi(b, 'Two');
    fyi(a, 'Three');
    now = at('2026-11-18T16:00:00Z');
    await digest.tick();
    const [post] = posts();
    expect(post).toContain(':newspaper: *Agent digest* since Tue 17 Nov 08:00');
    expect(post).toContain('*FYI* (3)');
    expect(post).toMatch(new RegExp(`\`${a}\` Refactor the queue\n• One\n• Three`));
    expect(post).toMatch(new RegExp(`\`${b}\` Write docs\n• Two`));
    expect(post).toContain('*Sessions seen* (2)');
  });

  it('escapes agent text and shortens long items', async () => {
    const session = register('Escape <b> & co');
    fyi(session, `<!channel> ${'x'.repeat(500)}`);
    fyi(session, 'line one\nline two\nline three');
    now = at('2026-11-18T16:00:00Z');
    await digest.tick();
    const [post = ''] = posts();
    expect(post).not.toContain('<!channel>');
    expect(post).toContain('&lt;!channel&gt;');
    expect(post).toContain('Escape &lt;b&gt; &amp; co');
    expect(post).toContain('…');
    expect(post).toContain('• line one line two …');
  });

  it('lists open questions and those that expired since the last digest', async () => {
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
    await digest.tick();
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

  it('keeps the post short and says how much was left out', async () => {
    const session = register('Chatty');
    for (let i = 0; i < 60; i++) fyi(session, `note ${i} ${'y'.repeat(100)}`);
    now = at('2026-11-18T16:00:00Z');
    await digest.tick();
    const [post = ''] = posts();
    expect(post.length).toBeLessThanOrEqual(DIGEST.maxChars);
    expect(post).toMatch(/\n_…not shown: \d+ fyi items, 1 session_$/);
    // Shown items are contiguous: note 0, 1, 2, … with no gaps.
    const shown = [...post.matchAll(/• note (\d+) /g)].map((m) => Number(m[1]));
    expect(shown).toEqual(shown.map((_, i) => i));
    // Every item counts as digested, shown or not: none roll into tomorrow.
    expect(store.pendingDigestItems()).toEqual([]);
  });

  it('puts questions first, so a chatty fyi section never pushes them out', async () => {
    const session = register('Chatty');
    for (let i = 0; i < 40; i++) fyi(session, i % 2 ? 'short' : `long ${'z'.repeat(290)}`);
    const open = service.ask({
      platform: 'claude',
      session,
      question: 'Ship it?',
      defaultAnswer: 'wait',
    });
    now = at('2026-11-18T16:00:00Z');
    await digest.tick();
    const [post = ''] = posts();
    expect(post.indexOf('*Questions* (1)')).toBeLessThan(post.indexOf('*FYI*'));
    expect(post).toContain(`\`${open.id}\``);
    // The cut never leaves a heading or blank line without its body.
    const beforeFooter = post.split('\n').at(-2) ?? '';
    expect(beforeFooter.startsWith('•')).toBe(true);
    expect(post).toMatch(/_…not shown: \d+ fyi items, 1 session_$/);
  });

  it('records each digest in the audit log without its text', async () => {
    const session = register('Audit');
    fyi(session, 'secret-ish detail');
    now = at('2026-11-18T16:00:00Z');
    await digest.tick();
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
