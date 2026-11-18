import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BusError, BusService, LIMITS } from '../../src/broker/service.ts';
import { DM_TARGET, Store } from '../../src/broker/store.ts';
import type { Platform } from '../../src/shared/platform.ts';

let store: Store;
let service: BusService;
let kicks: number;
let now: Date;

beforeEach(() => {
  now = new Date('2026-11-17T10:00:00Z');
  store = new Store(':memory:', { now: () => now });
  kicks = 0;
  service = new BusService(store, { kick: () => kicks++ }, () => now);
});

afterEach(() => store.close());

function queued(target: string): string[] {
  const rows = store.db
    .prepare("SELECT text FROM outbox WHERE target = ? AND state = 'queued' ORDER BY id")
    .all(target) as { text: string }[];
  return rows.map((row) => row.text);
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

function register(platform: Platform = 'claude', project?: string) {
  return service.register({ platform, purpose: 'Phase 1 broker', project, branch: 'main' }).session;
}

describe('register', () => {
  it('creates a session in the project channel and queues the thread root', () => {
    const session = register('codex', 'Clankers');
    expect(session.id).toMatch(/^codex\/clankers\/[0-9a-f]{4}$/);
    expect(session.channel).toBe('proj-clankers');
    const [root] = queued('proj-clankers');
    expect(root).toContain('Session started');
    expect(root).toContain(session.id);
    expect(root).toContain('Phase 1 broker');
    expect(kicks).toBe(1);
    expect(store.countEvents({ kind: 'session.created', since: new Date(0) })).toBe(1);
  });

  it('uses #agents when no project is given', () => {
    const session = register('copilot');
    expect(session).toMatchObject({ project: 'misc', channel: 'agents' });
  });

  it('escapes the purpose', () => {
    service.register({ platform: 'claude', purpose: '<!channel> look' });
    expect(queued('agents')[0]).toContain('&lt;!channel&gt;');
  });

  it('re-registers an existing session and posts a changed purpose', () => {
    const session = register('claude', 'clankers');
    const again = service.register({
      platform: 'claude',
      purpose: 'New purpose',
      session: session.id,
    });
    expect(again).toMatchObject({
      created: false,
      session: { id: session.id, purpose: 'New purpose' },
    });
    expect(queued('proj-clankers')).toHaveLength(2);
  });

  it('refuses a session ID it never issued', () => {
    expectBusError(
      () => service.register({ platform: 'claude', purpose: 'x', session: 'claude/x/abcd' }),
      'unknown_session',
    );
  });

  it("refuses another platform's session and audits it", () => {
    const session = register('claude', 'clankers');
    expectBusError(
      () => service.register({ platform: 'codex', purpose: 'hijack', session: session.id }),
      'wrong_platform',
    );
    expect(store.getSession(session.id)?.purpose).toBe('Phase 1 broker');
    expect(store.countEvents({ kind: 'denied', platform: 'codex', since: new Date(0) })).toBe(1);
  });

  it('caps new sessions per platform per hour', () => {
    for (let i = 0; i < LIMITS.registerPerPlatform; i++) register('codex');
    expectBusError(() => register('codex'), 'rate_limited');
    register('claude');
    now = new Date(now.getTime() + 61 * 60_000);
    register('codex');
  });
});

describe('notify', () => {
  it('routes urgent to my DM, normal to the thread, fyi nowhere', () => {
    const session = register('claude', 'clankers');
    expect(
      service.notify({
        platform: 'claude',
        session: session.id,
        text: 'Blocked on you',
        urgency: 'urgent',
      }),
    ).toEqual({ route: 'dm' });
    expect(
      service.notify({
        platform: 'claude',
        session: session.id,
        text: 'Step 2 done',
        urgency: 'normal',
      }),
    ).toEqual({ route: 'thread' });
    expect(
      service.notify({ platform: 'claude', session: session.id, text: 'trivia', urgency: 'fyi' }),
    ).toEqual({ route: 'digest' });

    const [dm] = queued(DM_TARGET);
    expect(dm).toContain(session.id);
    expect(dm).toContain('Blocked on you');
    expect(queued('proj-clankers')).toEqual([
      expect.stringContaining('Session started'),
      'Step 2 done',
    ]);
    expect(store.countEvents({ kind: 'notify', since: new Date(0), sessionId: session.id })).toBe(
      3,
    );
  });

  it('posts with the platform name and icon', () => {
    const session = register('codex', 'clankers');
    service.notify({ platform: 'codex', session: session.id, text: 'hi', urgency: 'normal' });
    const row = store.db.prepare("SELECT username, icon FROM outbox WHERE text = 'hi'").get() as {
      username: string;
      icon: string;
    };
    expect(row).toEqual({ username: 'Codex · clankers', icon: ':white_circle:' });
  });

  it('escapes Slack control sequences', () => {
    const session = register('claude', 'clankers');
    service.notify({
      platform: 'claude',
      session: session.id,
      text: '<!here> <@U999>',
      urgency: 'urgent',
    });
    expect(queued(DM_TARGET)[0]).toContain('&lt;!here&gt; &lt;@U999&gt;');
  });

  it("refuses to notify for another platform's session", () => {
    const session = register('claude', 'clankers');
    expectBusError(
      () =>
        service.notify({ platform: 'copilot', session: session.id, text: 'x', urgency: 'urgent' }),
      'wrong_platform',
    );
    expect(queued(DM_TARGET)).toEqual([]);
  });

  it('refuses an unknown session', () => {
    expectBusError(
      () =>
        service.notify({
          platform: 'claude',
          session: 'claude/x/0000',
          text: 'x',
          urgency: 'normal',
        }),
      'unknown_session',
    );
  });

  it('caps urgent DMs per session per hour', () => {
    const session = register('claude', 'clankers');
    for (let i = 0; i < LIMITS.urgentPerSession; i++) {
      service.notify({ platform: 'claude', session: session.id, text: `u${i}`, urgency: 'urgent' });
    }
    expectBusError(
      () =>
        service.notify({
          platform: 'claude',
          session: session.id,
          text: 'more',
          urgency: 'urgent',
        }),
      'rate_limited',
    );
    // Normal updates still go through until the overall cap.
    service.notify({ platform: 'claude', session: session.id, text: 'status', urgency: 'normal' });
  });

  it('caps all notifications per session per hour, then resets', () => {
    const session = register('claude', 'clankers');
    for (let i = 0; i < LIMITS.notifyPerSession; i++) {
      service.notify({ platform: 'claude', session: session.id, text: `n${i}`, urgency: 'fyi' });
    }
    expectBusError(
      () =>
        service.notify({ platform: 'claude', session: session.id, text: 'x', urgency: 'normal' }),
      'rate_limited',
    );
    now = new Date(now.getTime() + 61 * 60_000);
    service.notify({ platform: 'claude', session: session.id, text: 'x', urgency: 'normal' });
  });
});
