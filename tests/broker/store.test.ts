import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SCHEMA_VERSION, Store } from '../../src/broker/store.ts';

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
