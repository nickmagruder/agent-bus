import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BusError,
  BusService,
  HOOK_THROTTLE_MS,
  LIMITS,
  type HookInput,
} from '../../src/broker/service.ts';
import { DM_TARGET, Store } from '../../src/broker/store.ts';

let store: Store;
let service: BusService;
let now: Date;

beforeEach(() => {
  now = new Date('2026-11-17T10:00:00Z');
  store = new Store(':memory:', { now: () => now });
  service = new BusService(store, { kick: () => undefined }, () => now);
});

afterEach(() => store.close());

function queued(target: string): string[] {
  const rows = store.db
    .prepare("SELECT text FROM outbox WHERE target = ? AND state = 'queued' ORDER BY id")
    .all(target) as { text: string }[];
  return rows.map((row) => row.text);
}

function advance(ms: number): void {
  now = new Date(now.getTime() + ms);
}

const base: HookInput = {
  event: 'SessionStart',
  appSessionId: 'app-123',
  project: 'clankers',
  branch: 'main',
};

function hook(input: Partial<HookInput>, platform: 'claude' | 'codex' = 'claude') {
  return service.hook(platform, { ...base, ...input });
}

describe('SessionStart', () => {
  it('creates a session and returns its bus ID as context, without posting', () => {
    const result = hook({ source: 'startup' });
    expect(result.action).toBe('context');
    expect(result.session).toMatch(/^claude\/clankers\/[0-9a-f]{4}$/);
    expect(result.context).toContain(result.session);
    expect(store.getSession(result.session)).toMatchObject({
      appSessionId: 'app-123',
      branch: 'main',
      channel: 'proj-clankers',
      announcedAt: null,
    });
    expect(queued('proj-clankers')).toEqual([]);
  });

  it('maps the same app session to the same bus session, per platform', () => {
    const first = hook({});
    expect(hook({ source: 'resume', branch: 'feat/x' }).session).toBe(first.session);
    expect(store.getSession(first.session)?.branch).toBe('feat/x');
    expect(hook({}, 'codex').session).not.toBe(first.session);
  });

  it('uses #agents when there is no project', () => {
    const { session } = hook({ project: undefined });
    expect(store.getSession(session)?.channel).toBe('agents');
  });
});

describe('permission pings', () => {
  it('DMs me with the tool and its command, escaped', () => {
    const result = hook({
      event: 'PermissionRequest',
      toolName: 'PowerShell',
      toolSummary: 'git push <origin> ```x```',
    });
    expect(result.action).toBe('sent');
    const [dm] = queued(DM_TARGET);
    expect(dm).toContain(result.session);
    expect(dm).toContain('*PowerShell*');
    expect(dm).toContain('git push &lt;origin&gt;');
    expect(dm).toContain("'''x'''");
    expect(dm).toContain('Answer in the app');
  });

  it('never returns a decision: there is no allow/deny in the result', () => {
    const result = hook({ event: 'PermissionRequest', toolName: 'Bash' });
    expect(Object.keys(result).sort()).toEqual(['action', 'session']);
  });

  it('throttles a burst, including a Notification for the same prompt', () => {
    hook({ event: 'PermissionRequest', toolName: 'Write' });
    expect(hook({ event: 'PermissionRequest', toolName: 'Write' }).action).toBe('throttled');
    expect(
      hook({ event: 'Notification', notificationType: 'permission_prompt', message: 'needs you' })
        .action,
    ).toBe('throttled');
    advance(HOOK_THROTTLE_MS.permission + 1000);
    expect(hook({ event: 'PermissionRequest', toolName: 'Write' }).action).toBe('sent');
    expect(queued(DM_TARGET)).toHaveLength(2);
  });

  it('pings for a Claude permission_prompt notification on its own', () => {
    const result = hook({
      event: 'Notification',
      notificationType: 'permission_prompt',
      message: 'Claude needs your permission to use Bash',
    });
    expect(result.action).toBe('sent');
    expect(queued(DM_TARGET)[0]).toContain('Claude needs your permission to use Bash');
  });

  it('ignores other notification types', () => {
    expect(hook({ event: 'Notification', notificationType: 'idle_prompt' }).action).toBe('ignored');
    expect(queued(DM_TARGET)).toEqual([]);
  });

  it('stops pinging at the hourly urgent cap without failing the hook', () => {
    const { session } = hook({});
    for (let i = 0; i < LIMITS.urgentPerSession; i++) {
      service.notify({ platform: 'claude', session, text: `u${i}`, urgency: 'urgent' });
    }
    expect(hook({ event: 'PermissionRequest', toolName: 'Bash' }).action).toBe('rate_limited');
  });
});

describe('Stop', () => {
  it('announces the session, then posts the turn-finished snippet in its thread', () => {
    const { session } = hook({ event: 'Stop', lastMessage: 'Done.\nTests pass <3' });
    const [root, stop] = queued('proj-clankers');
    expect(root).toContain('Session started');
    expect(root).toContain(session);
    expect(stop).toContain('waiting for you');
    expect(stop).toContain('> Done.\n> Tests pass &lt;3');
    expect(queued(DM_TARGET)).toEqual([]);
  });

  it('truncates long messages', () => {
    hook({ event: 'Stop', lastMessage: 'x'.repeat(1000) });
    const stop = queued('proj-clankers')[1] ?? '';
    expect(stop.length).toBeLessThan(400);
    expect(stop).toContain('…');
  });

  it('ignores a stop that another Stop hook already continued', () => {
    expect(hook({ event: 'Stop', stopHookActive: true }).action).toBe('ignored');
  });

  it('posts at most once per throttle window', () => {
    hook({ event: 'Stop' });
    expect(hook({ event: 'Stop' }).action).toBe('throttled');
    advance(HOOK_THROTTLE_MS.stop + 1000);
    expect(hook({ event: 'Stop' }).action).toBe('sent');
    // Root + two stop posts; the root is queued only once.
    expect(queued('proj-clankers')).toHaveLength(3);
  });
});

describe('hook sessions and MCP tools', () => {
  it('lets the agent register the hook-minted ID; the root carries the purpose', () => {
    const { session } = hook({});
    service.register({ platform: 'claude', purpose: 'Build PR 2', session });
    const posts = queued('proj-clankers');
    expect(posts).toHaveLength(1);
    expect(posts[0]).toContain('Build PR 2');
  });

  it('accepts notify_human for a hook-minted ID from the same platform only', () => {
    const { session } = hook({});
    expect(service.notify({ platform: 'claude', session, text: 'hi', urgency: 'normal' })).toEqual({
      route: 'thread',
    });
    expect(() =>
      service.notify({ platform: 'codex', session, text: 'x', urgency: 'urgent' }),
    ).toThrow(BusError);
  });

  it('does not count hook-created sessions against the register cap', () => {
    for (let i = 0; i < LIMITS.registerPerPlatform + 5; i++) hook({ appSessionId: `app-${i}` });
    service.register({ platform: 'claude', purpose: 'still allowed' });
  });

  it('audits every hook call', () => {
    hook({});
    hook({ event: 'UserPromptSubmit' });
    expect(store.countEvents({ kind: 'hook', since: new Date(0) })).toBe(2);
    expect(
      store.countEvents({
        kind: 'hook',
        since: new Date(0),
        dataField: { name: 'action', value: 'ignored' },
      }),
    ).toBe(1);
  });
});
