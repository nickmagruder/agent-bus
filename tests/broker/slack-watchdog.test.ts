import { beforeEach, describe, expect, it } from 'vitest';
import { silentLogger, type Logger } from '../../src/broker/log.ts';
import { SOCKET_MODE, type ConnectionState } from '../../src/broker/slack/connection.ts';
import { OUTAGE_EVENT, SLACK_WATCHDOG, SlackWatchdog } from '../../src/broker/slack/watchdog.ts';
import { DM_TARGET, Store } from '../../src/broker/store.ts';

const MINUTE = 60_000;

let store: Store;
let now: Date;
let connection: { state: ConnectionState };
let stuckCalls: number;
let kicks: number;

beforeEach(() => {
  now = new Date('2026-11-27T19:00:00Z');
  store = new Store(':memory:', { now: () => now });
  connection = { state: 'connecting' };
  stuckCalls = 0;
  kicks = 0;
});

function watchdog(log: Logger = silentLogger): SlackWatchdog {
  return new SlackWatchdog({
    connection,
    store,
    kick: () => {
      kicks += 1;
    },
    log,
    onStuck: () => {
      stuckCalls += 1;
    },
    now: () => now,
  });
}

function advance(ms: number): void {
  now = new Date(now.getTime() + ms);
}

function dms(): string[] {
  const rows = store.db
    .prepare('SELECT text FROM outbox WHERE target = ? ORDER BY id')
    .all(DM_TARGET) as { text: string }[];
  return rows.map((row) => row.text);
}

function outages(): Record<string, unknown>[] {
  const rows = store.db
    .prepare('SELECT data FROM events WHERE kind = ? ORDER BY id')
    .all(OUTAGE_EVENT) as { data: string }[];
  return rows.map((row) => JSON.parse(row.data) as Record<string, unknown>);
}

function stuckEvents(): number {
  const row = store.db
    .prepare("SELECT COUNT(*) AS n FROM events WHERE kind = 'slack.stuck'")
    .get() as { n: number };
  return Number(row.n);
}

describe('Slack watchdog (#106)', () => {
  it('raises the client ping timeout above Slack’s 5 s default', () => {
    expect(SOCKET_MODE.clientPingTimeoutMs).toBe(15_000);
  });

  it('does nothing while the link is connected', () => {
    const dog = watchdog();
    connection.state = 'connected';
    for (let i = 0; i < 20; i += 1) {
      advance(MINUTE);
      dog.tick();
    }
    expect(dms()).toEqual([]);
    expect(stuckCalls).toBe(0);
    expect(kicks).toBe(0);
  });

  it('lets a reconnect shorter than the limit pass', () => {
    const dog = watchdog();
    connection.state = 'connected';
    dog.tick();
    connection.state = 'reconnecting';
    advance(4 * MINUTE);
    dog.tick();
    connection.state = 'connected';
    advance(10_000);
    dog.tick();
    // A second short drop starts its own clock.
    connection.state = 'reconnecting';
    advance(4 * MINUTE);
    dog.tick();
    expect(dms()).toEqual([]);
    expect(stuckCalls).toBe(0);
    expect(outages()).toEqual([]);
  });

  it('DMs me once and asks for a restart when stuck reconnecting', () => {
    const warnings: string[] = [];
    const dog = watchdog((level, message) => {
      if (level === 'warn') warnings.push(message);
    });
    connection.state = 'connected';
    dog.tick();
    const droppedAt = new Date(now.getTime() + MINUTE);
    advance(MINUTE);
    connection.state = 'reconnecting';
    dog.tick();
    advance(SLACK_WATCHDOG.stuckAfterMs - 1);
    dog.tick();
    expect(stuckCalls).toBe(0);
    advance(1);
    dog.tick();
    expect(stuckCalls).toBe(1);
    expect(stuckEvents()).toBe(1);
    expect(kicks).toBe(1);
    const [dm] = dms();
    expect(dms()).toHaveLength(1);
    expect(dm).toContain('no Slack link for clicks and replies');
    expect(dm).toContain('Restarting the broker');
    expect(outages()).toEqual([
      { state: 'down', since: droppedAt.toISOString(), slack: 'reconnecting' },
    ]);
    expect(warnings).toContain('Slack link stuck; restarting the broker');
    // Still stuck: no second DM or restart request from this process.
    advance(10 * MINUTE);
    dog.tick();
    expect(stuckCalls).toBe(1);
    expect(dms()).toHaveLength(1);
  });

  it('counts a link that never connects after start as stuck', () => {
    const dog = watchdog();
    advance(SLACK_WATCHDOG.stuckAfterMs);
    dog.tick();
    expect(stuckCalls).toBe(1);
    expect(dms()).toHaveLength(1);
    expect(outages()[0]).toMatchObject({ state: 'down', slack: 'connecting' });
  });

  it('DMs once per outage across restarts, and says when it is back', () => {
    const first = watchdog();
    const startedAt = now.toISOString();
    advance(SLACK_WATCHDOG.stuckAfterMs);
    first.tick();
    expect(dms()).toHaveLength(1);
    // The restarted broker is still cut off: it restarts again without a new DM.
    const second = watchdog();
    advance(SLACK_WATCHDOG.stuckAfterMs);
    second.tick();
    expect(stuckCalls).toBe(2);
    expect(stuckEvents()).toBe(2);
    expect(dms()).toHaveLength(1);
    // The third connects: one "back" DM covering the whole outage.
    const third = watchdog();
    connection.state = 'connected';
    advance(20_000);
    third.tick();
    const [, back] = dms();
    expect(dms()).toHaveLength(2);
    expect(back).toContain('Slack link is back');
    expect(back).toContain('Clicks and replies from that time were lost');
    expect(outages()[1]).toEqual({ state: 'back', since: startedAt, until: now.toISOString() });
    third.tick();
    expect(dms()).toHaveLength(2);
    expect(stuckCalls).toBe(2);
  });

  it('DMs again for a new outage after one has ended', () => {
    const dog = watchdog();
    advance(SLACK_WATCHDOG.stuckAfterMs);
    dog.tick();
    connection.state = 'connected';
    dog.tick();
    connection.state = 'reconnecting';
    dog.tick();
    advance(SLACK_WATCHDOG.stuckAfterMs);
    dog.tick();
    expect(stuckCalls).toBe(2);
    expect(outages().map((event) => event.state)).toEqual(['down', 'back', 'down']);
    expect(dms()).toHaveLength(3);
  });

  it('only logs when no restart hook is given', () => {
    const dog = new SlackWatchdog({
      connection,
      store,
      kick: () => undefined,
      log: silentLogger,
      now: () => now,
    });
    advance(SLACK_WATCHDOG.stuckAfterMs);
    expect(() => {
      dog.tick();
    }).not.toThrow();
    expect(dms()).toHaveLength(1);
  });
});
