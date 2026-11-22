import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS, SCHEMA_VERSION, Store } from '../../src/broker/store.ts';

const open: Store[] = [];
function memoryStore(now?: () => Date): Store {
  const store = new Store(':memory:', now ? { now } : {});
  open.push(store);
  return store;
}

afterEach(() => {
  for (const store of open.splice(0)) store.close();
});

describe('Store migrations', () => {
  it('creates the schema at the current version', () => {
    expect(memoryStore().schemaVersion).toBe(SCHEMA_VERSION);
  });

  it('upgrades a v1 database, treating existing sessions as announced', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'agent-bus-store-'));
    try {
      const file = path.join(dir, 'bus.db');
      const v1 = new DatabaseSync(file);
      v1.exec(MIGRATIONS[0] ?? '');
      v1.exec('PRAGMA user_version = 1');
      v1.exec(
        `INSERT INTO sessions (id, platform, project, channel, created_at, last_seen_at)
         VALUES ('claude/x/abcd', 'claude', 'x', 'proj-x', '2026-11-17T10:00:00.000Z', '2026-11-17T10:00:00.000Z')`,
      );
      v1.close();

      const store = new Store(file);
      expect(store.schemaVersion).toBe(SCHEMA_VERSION);
      expect(store.getSession('claude/x/abcd')).toMatchObject({
        appSessionId: null,
        announcedAt: '2026-11-17T10:00:00.000Z',
      });
      store.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('keeps one bus session per app session and platform', () => {
    const store = memoryStore();
    const base = {
      platform: 'claude' as const,
      project: 'x',
      branch: null,
      purpose: null,
      channel: 'proj-x',
    };
    store.insertSession({ ...base, id: 'claude/x/0001', appSessionId: 'app-1' });
    expect(() =>
      store.insertSession({ ...base, id: 'claude/x/0002', appSessionId: 'app-1' }),
    ).toThrow();
    store.insertSession({ ...base, platform: 'codex', id: 'codex/x/0001', appSessionId: 'app-1' });
    expect(store.findByAppSession('claude', 'app-1')?.id).toBe('claude/x/0001');
    expect(store.findByAppSession('codex', 'app-1')?.id).toBe('codex/x/0001');
    expect(store.findByAppSession('claude', 'app-2')).toBeUndefined();
  });

  it.each([2, 3, 4, 5, 6])('upgrades a v%i database, keeping its posts', async (from) => {
    const dir = await mkdtemp(path.join(tmpdir(), 'agent-bus-store-'));
    try {
      const file = path.join(dir, 'bus.db');
      const old = new DatabaseSync(file);
      for (const migration of MIGRATIONS.slice(0, from)) old.exec(migration);
      old.exec(`PRAGMA user_version = ${from}`);
      old.exec(
        "INSERT INTO outbox (target, text, created_at) VALUES ('agents', 'hi', '2026-11-18T10:00:00.000Z')",
      );
      old.close();

      const store = new Store(file);
      expect(store.schemaVersion).toBe(SCHEMA_VERSION);
      expect(store.getPost(1)).toMatchObject({ text: 'hi', blocks: null });
      expect(store.db.prepare('SELECT COUNT(*) AS n FROM inbox').get()).toEqual({ n: 0 });
      expect(store.db.prepare('SELECT COUNT(*) AS n FROM questions').get()).toEqual({ n: 0 });
      expect(store.db.prepare('SELECT COUNT(*) AS n FROM digest_items').get()).toEqual({ n: 0 });
      expect(store.db.prepare('SELECT COUNT(*) AS n FROM held_pings').get()).toEqual({ n: 0 });
      expect(store.sessionKeyHash('claude/x/0001')).toBeUndefined();
      store.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('joins a nested transaction to the outer one', () => {
    const store = memoryStore();
    expect(() =>
      store.transaction(() => {
        store.transaction(() => store.appendEvent({ kind: 'inner' }));
        throw new Error('outer fails');
      }),
    ).toThrow('outer fails');
    expect(store.countEvents({ kind: 'inner', since: new Date(0) })).toBe(0);
    expect(store.transaction(() => store.transaction(() => 42))).toBe(42);
  });

  it('reopens an existing file without re-running migrations', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'agent-bus-store-'));
    try {
      const file = path.join(dir, 'nested', 'bus.db');
      const first = new Store(file);
      first.appendEvent({ kind: 'x' });
      first.close();
      const second = new Store(file);
      expect(second.schemaVersion).toBe(SCHEMA_VERSION);
      expect(second.countEvents({ kind: 'x', since: new Date(0) })).toBe(1);
      second.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('refuses a database from a newer broker', () => {
    const store = memoryStore();
    store.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    // Re-running migrate on the same handle simulates opening it with an older broker.
    expect(() => (store as unknown as { migrate(): void }).migrate()).toThrow('newer');
  });
});

describe('audit log', () => {
  it('is append-only', () => {
    const store = memoryStore();
    store.appendEvent({ kind: 'notify', data: { urgency: 'urgent' } });
    expect(() => store.db.exec("UPDATE events SET kind = 'x'")).toThrow('append-only');
    expect(() => store.db.exec('DELETE FROM events')).toThrow('append-only');
  });

  it('counts events by kind, session, platform, time and data field', () => {
    let now = new Date('2026-11-17T10:00:00Z');
    const store = memoryStore(() => now);
    store.appendEvent({
      kind: 'notify',
      platform: 'claude',
      sessionId: 's1',
      data: { urgency: 'urgent' },
    });
    store.appendEvent({
      kind: 'notify',
      platform: 'claude',
      sessionId: 's1',
      data: { urgency: 'normal' },
    });
    store.appendEvent({
      kind: 'notify',
      platform: 'codex',
      sessionId: 's2',
      data: { urgency: 'urgent' },
    });
    now = new Date('2026-11-17T12:00:00Z');
    store.appendEvent({
      kind: 'notify',
      platform: 'claude',
      sessionId: 's1',
      data: { urgency: 'urgent' },
    });

    const since = new Date('2026-11-17T11:00:00Z');
    expect(store.countEvents({ kind: 'notify', since: new Date(0) })).toBe(4);
    expect(store.countEvents({ kind: 'notify', since })).toBe(1);
    expect(store.countEvents({ kind: 'notify', since: new Date(0), sessionId: 's1' })).toBe(3);
    expect(store.countEvents({ kind: 'notify', since: new Date(0), platform: 'codex' })).toBe(1);
    expect(
      store.countEvents({
        kind: 'notify',
        since: new Date(0),
        sessionId: 's1',
        dataField: { name: 'urgency', value: 'urgent' },
      }),
    ).toBe(2);
  });
});

describe('outbox', () => {
  it('returns the existing post for a repeated idempotency key', () => {
    const store = memoryStore();
    const first = store.enqueue({ target: 'agents', text: 'a', idemKey: 'k1' });
    const again = store.enqueue({ target: 'agents', text: 'different', idemKey: 'k1' });
    expect(again.id).toBe(first.id);
    expect(store.queuedTargets()).toEqual(['agents']);
  });

  it('hands out queued posts per target in order', () => {
    const store = memoryStore();
    const a1 = store.enqueue({ target: 'a', text: '1' });
    store.enqueue({ target: 'b', text: '2' });
    store.enqueue({ target: 'a', text: '3' });
    expect(store.nextQueued('a')?.id).toBe(a1.id);
    store.markSent(a1.id, 'C1', '1.1');
    expect(store.nextQueued('a')?.text).toBe('3');
    expect(store.queuedTargets().sort()).toEqual(['a', 'b']);
  });

  it('marks failed attempts and gives up when final', () => {
    const store = memoryStore();
    const post = store.enqueue({ target: 'a', text: 'x' });
    store.markAttemptFailed(post.id, 'boom', false);
    expect(store.getPost(post.id)).toMatchObject({
      state: 'queued',
      attempts: 1,
      lastError: 'boom',
    });
    store.markAttemptFailed(post.id, 'boom', true);
    expect(store.getPost(post.id)).toMatchObject({ state: 'failed', attempts: 2 });
    expect(store.nextQueued('a')).toBeUndefined();
  });

  it('rolls back a failed transaction', () => {
    const store = memoryStore();
    expect(() =>
      store.transaction(() => {
        store.enqueue({ target: 'a', text: 'x' });
        throw new Error('nope');
      }),
    ).toThrow('nope');
    expect(store.queuedTargets()).toEqual([]);
  });
});

describe('sessions', () => {
  it('inserts, touches and records the thread', () => {
    let now = new Date('2026-11-17T10:00:00Z');
    const store = memoryStore(() => now);
    store.insertSession({
      id: 'claude/x/abcd',
      platform: 'claude',
      project: 'x',
      branch: null,
      purpose: 'first',
      channel: 'proj-x',
    });
    now = new Date('2026-11-17T11:00:00Z');
    store.touchSession('claude/x/abcd', { branch: 'main' });
    store.setThread('claude/x/abcd', 'C1', '1.5');
    expect(store.getSession('claude/x/abcd')).toMatchObject({
      purpose: 'first',
      branch: 'main',
      slackChannelId: 'C1',
      threadTs: '1.5',
      createdAt: '2026-11-17T10:00:00.000Z',
      lastSeenAt: '2026-11-17T11:00:00.000Z',
    });
  });
});
