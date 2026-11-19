import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BusError,
  APPROVAL,
  BusService,
  HOOK_THROTTLE_MS,
  LIMITS,
  stopText,
  type HookInput,
  type StopInboxCheck,
} from '../../src/broker/service.ts';
import type { Platform } from '../../src/shared/platform.ts';
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

function hook(
  input: Partial<HookInput>,
  platform: Platform = 'claude',
  stopInbox?: StopInboxCheck,
) {
  return service.hook(platform, { ...base, ...input }, stopInbox);
}

/** A fake inbox check: hands out the queued replies once each, counting calls. */
function fakeInbox(replies: string[] = []): StopInboxCheck & { calls: number } {
  const check = Object.assign(
    (): string | undefined => {
      check.calls++;
      return replies.shift();
    },
    { calls: 0 },
  );
  return check;
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

/** Lets the grace period run out and runs the broker's flush, like its timer would. */
function elapse(ms: number = APPROVAL.graceMs): number {
  advance(ms);
  return service.flushHeldPings();
}

function pingStates(): string[] {
  const rows = store.db.prepare('SELECT state FROM held_pings ORDER BY id').all() as {
    state: string;
  }[];
  return rows.map((row) => row.state);
}

describe('permission pings', () => {
  it('holds the DM for the grace period, then DMs me the tool and command, escaped', () => {
    const result = hook({
      event: 'PermissionRequest',
      toolName: 'PowerShell',
      toolSummary: 'git push <origin> ```x```',
    });
    expect(result.action).toBe('held');
    expect(queued(DM_TARGET)).toEqual([]);
    expect(elapse(APPROVAL.graceMs - 1000)).toBe(0);
    expect(queued(DM_TARGET)).toEqual([]);
    expect(elapse(1000)).toBe(1);
    const [dm] = queued(DM_TARGET);
    expect(dm).toContain(result.session);
    expect(dm).toContain('*PowerShell*');
    expect(dm).toContain('git push &lt;origin&gt;');
    expect(dm).toContain("'''x'''");
    expect(dm).toContain('Answer in the app');
    expect(pingStates()).toEqual(['sent']);
    // Sent once.
    expect(elapse()).toBe(0);
  });

  it('never returns a decision: there is no allow/deny in the result', () => {
    const result = hook({ event: 'PermissionRequest', toolName: 'Bash' });
    expect(Object.keys(result).sort()).toEqual(['action', 'session']);
  });

  it.each(['PostToolUse', 'PreToolUse', 'Stop', 'UserPromptSubmit', 'SessionStart'])(
    'drops the DM when %s shows I answered in the app',
    (event) => {
      hook({ event: 'PermissionRequest', toolName: 'Bash' });
      advance(5000);
      hook({ event });
      expect(elapse()).toBe(0);
      expect(queued(DM_TARGET)).toEqual([]);
      expect(pingStates()).toEqual(['cancelled']);
      const [cancelled] = store.db
        .prepare("SELECT data FROM events WHERE kind = 'ping.cancelled'")
        .all() as { data: string }[];
      expect(JSON.parse(cancelled?.data ?? '{}')).toMatchObject({ reason: event });
    },
  );

  it('drops the DM when the session calls an agent-bus tool (it was answered)', () => {
    const { session } = hook({ event: 'PermissionRequest', toolName: 'Bash' });
    service.notify({ platform: 'claude', session, text: 'carrying on', urgency: 'fyi' });
    expect(elapse()).toBe(0);
    expect(pingStates()).toEqual(['cancelled']);
  });

  it("keeps the DM for Claude's Notification about the same prompt", () => {
    hook({ event: 'PermissionRequest', toolName: 'Write' });
    const again = hook({
      event: 'Notification',
      notificationType: 'permission_prompt',
      message: 'needs you',
    });
    expect(again.action).toBe('held');
    hook({ event: 'Notification', notificationType: 'idle_prompt' });
    expect(elapse()).toBe(1);
    expect(queued(DM_TARGET)).toHaveLength(1);
    expect(queued(DM_TARGET)[0]).toContain('*Write*');
  });

  it('a new prompt replaces the held one: the earlier was answered', () => {
    hook({ event: 'PermissionRequest', toolName: 'Write' });
    advance(30_000);
    hook({ event: 'PermissionRequest', toolName: 'Edit' });
    expect(elapse(30_000)).toBe(0); // the first one's time is up, but it was replaced
    expect(elapse(30_000)).toBe(1);
    expect(queued(DM_TARGET)).toEqual([expect.stringContaining('*Edit*')]);
    expect(pingStates()).toEqual(['cancelled', 'sent']);
  });

  it('keeps the 2-minute throttle between DMs that do go out', () => {
    hook({ event: 'PermissionRequest', toolName: 'Write' });
    expect(elapse()).toBe(1);
    hook({ event: 'PermissionRequest', toolName: 'Write' });
    expect(elapse()).toBe(0);
    expect(pingStates()).toEqual(['sent', 'throttled']);
    advance(HOOK_THROTTLE_MS.permission);
    hook({ event: 'PermissionRequest', toolName: 'Write' });
    expect(elapse()).toBe(1);
    expect(queued(DM_TARGET)).toHaveLength(2);
  });

  it('DMs for a Claude permission_prompt notification on its own', () => {
    const result = hook({
      event: 'Notification',
      notificationType: 'permission_prompt',
      message: 'Claude needs your permission to use Bash',
    });
    expect(result.action).toBe('held');
    elapse();
    expect(queued(DM_TARGET)[0]).toContain('Claude needs your permission to use Bash');
  });

  it('ignores other notification types', () => {
    expect(hook({ event: 'Notification', notificationType: 'idle_prompt' }).action).toBe('ignored');
    expect(elapse()).toBe(0);
    expect(queued(DM_TARGET)).toEqual([]);
  });

  it('stops DMing at the hourly urgent cap without failing anything', () => {
    const { session } = hook({});
    for (let i = 0; i < LIMITS.urgentPerSession; i++) {
      service.notify({ platform: 'claude', session, text: `u${i}`, urgency: 'urgent' });
    }
    // notify_human above was an agent-bus call, so the hold below starts clean.
    expect(hook({ event: 'PermissionRequest', toolName: 'Bash' }).action).toBe('held');
    expect(elapse()).toBe(0);
    expect(pingStates()).toEqual(['throttled']);
  });

  it("drops a held DM that's long stale (the broker was down), instead of sending it late", () => {
    hook({ event: 'PermissionRequest', toolName: 'Bash' });
    expect(elapse(APPROVAL.staleMs + 1000)).toBe(0);
    expect(queued(DM_TARGET)).toEqual([]);
    expect(pingStates()).toEqual(['stale']);
  });

  it("one session moving on doesn't drop another session's DM", () => {
    hook({ event: 'PermissionRequest', toolName: 'Bash' });
    hook({ event: 'PostToolUse', appSessionId: 'app-other' });
    expect(elapse()).toBe(1);
  });

  it("audits holds without the command's text", () => {
    hook({ event: 'PermissionRequest', toolName: 'Bash', toolSummary: 'rm -rf secret-dir' });
    elapse();
    const audit = JSON.stringify(
      store.db.prepare("SELECT data FROM events WHERE kind LIKE 'ping.%'").all(),
    );
    expect(audit).toContain('pingId');
    expect(audit).not.toContain('secret-dir');
  });
});

describe("approval prompts for agent-bus's own tools", () => {
  it.each([
    ['Claude', 'mcp__agent-bus__register'],
    ['Codex', 'mcp__agent_bus__notify_human'],
  ])('sends no DM for %s naming (%s)', (_, toolName) => {
    expect(hook({ event: 'PermissionRequest', toolName }).action).toBe('own_tool');
    expect(queued(DM_TARGET)).toEqual([]);
  });

  it("recognises Claude's permission_prompt notification by its message", () => {
    expect(
      hook({
        event: 'Notification',
        notificationType: 'permission_prompt',
        message: 'Claude needs your permission to use mcp__agent-bus__notify_human',
      }).action,
    ).toBe('own_tool');
    expect(queued(DM_TARGET)).toEqual([]);
  });

  it("doesn't use up the throttle, so the next real prompt still DMs", () => {
    hook({ event: 'PermissionRequest', toolName: 'mcp__agent-bus__register' });
    expect(hook({ event: 'PermissionRequest', toolName: 'PowerShell' }).action).toBe('held');
    expect(elapse()).toBe(1);
  });

  it.each(['mcp__agent-busy__x', 'mcp__other__agent-bus', 'agent-bus', 'mcp__slack__post'])(
    'still DMs for other tools such as %s',
    (toolName) => {
      expect(hook({ event: 'PermissionRequest', toolName }).action).toBe('held');
      expect(elapse()).toBe(1);
    },
  );

  it('audits the skipped prompt', () => {
    hook({ event: 'PermissionRequest', toolName: 'mcp__agent_bus__register' });
    expect(
      store.countEvents({
        kind: 'hook',
        since: new Date(0),
        dataField: { name: 'action', value: 'own_tool' },
      }),
    ).toBe(1);
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
    expect(hook({ event: 'Stop', stopHookActive: true }, 'claude', fakeInbox()).action).toBe(
      'ignored',
    );
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

describe('UserPromptSubmit', () => {
  const prompt = (platform: Platform = 'claude') => hook({ event: 'UserPromptSubmit' }, platform);

  it('hands over the bus ID when SessionStart never reached the broker', () => {
    const result = prompt();
    expect(result.action).toBe('context');
    expect(result.session).toMatch(/^claude\/clankers\/[0-9a-f]{4}$/);
    expect(result.context).toContain(result.session);
    // It creates the session like SessionStart would, without posting.
    expect(store.getSession(result.session)).toMatchObject({ appSessionId: 'app-123' });
    expect(queued('proj-clankers')).toEqual([]);
    expect(queued(DM_TARGET)).toEqual([]);
  });

  it("hands it over when SessionStart's response never reached the hook", () => {
    const start = hook({ event: 'SessionStart' });
    expect(start.action).toBe('context');
    // No markContextDelivered: the hook timed out before reading it.
    expect(prompt()).toMatchObject({ action: 'context', session: start.session });
  });

  const FAST = 20;
  const SLOW = LIMITS.contextConfirmMs + 1;

  it('stays quiet once SessionStart delivered it quickly', () => {
    const start = hook({ event: 'SessionStart' });
    service.markContextDelivered('claude', start.session, 'SessionStart', FAST);
    const result = prompt();
    expect(result.action).toBe('ignored');
    expect(result.context).toBeUndefined();
  });

  it('hands it over once: later prompts stay quiet', () => {
    const first = prompt();
    service.markContextDelivered('claude', first.session, 'UserPromptSubmit', FAST);
    expect(prompt().action).toBe('ignored');
    expect(prompt().action).toBe('ignored');
  });

  it('keeps offering it on each prompt until one gets through', () => {
    expect(prompt().action).toBe('context');
    expect(prompt().action).toBe('context');
  });

  it("re-sends after a slow response: written isn't read (the hook may have timed out)", () => {
    const start = hook({ event: 'SessionStart' });
    service.markContextDelivered('claude', start.session, 'SessionStart', SLOW);
    expect(prompt().action).toBe('context');
    expect(store.countEvents({ kind: 'hook.context_delivered', since: new Date(0) })).toBe(1);
  });

  it('stops re-sending after enough slow responses', () => {
    const { session } = prompt();
    for (let i = 0; i < LIMITS.contextSlowDeliveries - 1; i++) {
      service.markContextDelivered('claude', session, 'UserPromptSubmit', SLOW);
      expect(prompt().action).toBe('context');
    }
    service.markContextDelivered('claude', session, 'UserPromptSubmit', SLOW);
    expect(prompt().action).toBe('ignored');
  });

  it('stays quiet once the agent used the ID in an MCP call', () => {
    const { session } = prompt();
    service.markContextDelivered('claude', session, 'UserPromptSubmit', SLOW);
    service.notify({ platform: 'claude', session, text: 'hi', urgency: 'fyi' });
    expect(prompt().action).toBe('ignored');
    // Recorded once, not on every call.
    service.notify({ platform: 'claude', session, text: 'again', urgency: 'fyi' });
    expect(store.countEvents({ kind: 'session.used', since: new Date(0) })).toBe(1);
  });

  it("doesn't count a call another platform made with the ID", () => {
    const { session } = prompt();
    expect(() =>
      service.notify({ platform: 'codex', session, text: 'hi', urgency: 'fyi' }),
    ).toThrow(BusError);
    expect(prompt().action).toBe('context');
  });

  it('starts over at each SessionStart (after /clear or compaction the agent lost it)', () => {
    const { session } = prompt();
    service.notify({ platform: 'claude', session, text: 'hi', urgency: 'fyi' });
    expect(prompt().action).toBe('ignored');
    // SessionStart (compact) reaches the broker, but its response is slow.
    hook({ event: 'SessionStart', source: 'compact' });
    service.markContextDelivered('claude', session, 'SessionStart', SLOW);
    expect(prompt().action).toBe('context');
    service.notify({ platform: 'claude', session, text: 'hi', urgency: 'fyi' });
    expect(prompt().action).toBe('ignored');
  });

  it('works the same on Codex, per app session', () => {
    const codex = prompt('codex');
    expect(codex.session).toMatch(/^codex\//);
    service.markContextDelivered('codex', codex.session, 'UserPromptSubmit', FAST);
    expect(prompt('codex').action).toBe('ignored');
    // Another app session still needs its own ID.
    const other = hook({ event: 'UserPromptSubmit', appSessionId: 'app-456' }, 'codex');
    expect(other.action).toBe('context');
    expect(other.session).not.toBe(codex.session);
  });

  it("doesn't record a delivery for Copilot, whose hooks can't print context", () => {
    const { session } = hook({ event: 'SessionStart' }, 'copilot');
    service.markContextDelivered('copilot', session, 'SessionStart', FAST);
    expect(store.countEvents({ kind: 'hook.context_delivered', since: new Date(0) })).toBe(0);
  });

  it('SessionStart always hands it over (after /clear or compaction the agent lost it)', () => {
    const start = hook({ event: 'SessionStart' });
    service.markContextDelivered('claude', start.session, 'SessionStart', FAST);
    expect(hook({ event: 'SessionStart', source: 'compact' }).action).toBe('context');
  });
});

describe('Stop with Slack replies waiting', () => {
  it('blocks with the replies as the reason and posts nothing', () => {
    const inbox = fakeInbox(['From Nick: use plan B']);
    const result = hook({ event: 'Stop', lastMessage: 'Done.' }, 'claude', inbox);
    expect(result).toMatchObject({ action: 'blocked', reason: 'From Nick: use plan B' });
    expect(inbox.calls).toBe(1);
    expect(queued('proj-clankers')).toEqual([]);
    expect(queued(DM_TARGET)).toEqual([]);
  });

  it('blocks on Codex too', () => {
    expect(hook({ event: 'Stop' }, 'codex', fakeInbox(['reply'])).action).toBe('blocked');
  });

  it("never takes Copilot's replies: its Stop hook can't deliver them", () => {
    const inbox = fakeInbox(['reply']);
    expect(hook({ event: 'Stop' }, 'copilot', inbox).action).toBe('sent');
    expect(inbox.calls).toBe(0);
  });

  it('pings as before when nothing is waiting', () => {
    const result = hook({ event: 'Stop', lastMessage: 'Done.' }, 'claude', fakeInbox());
    expect(result.action).toBe('sent');
    expect(result.reason).toBeUndefined();
    expect(queued('proj-clankers')[1]).toContain('waiting for you');
  });

  it('blocks again when new replies arrived while stop_hook_active', () => {
    const inbox = fakeInbox(['first', 'second']);
    expect(hook({ event: 'Stop' }, 'claude', inbox).action).toBe('blocked');
    const again = hook({ event: 'Stop', stopHookActive: true }, 'claude', inbox);
    expect(again).toMatchObject({ action: 'blocked', reason: 'second' });
  });

  it('pings once the agent stops after our block, though stop_hook_active is set', () => {
    const inbox = fakeInbox(['reply']);
    hook({ event: 'Stop' }, 'claude', inbox);
    const after = hook(
      { event: 'Stop', stopHookActive: true, lastMessage: 'Did it.' },
      'claude',
      inbox,
    );
    expect(after.action).toBe('sent');
    expect(queued('proj-clankers')[1]).toContain('> Did it.');
  });

  it('ignores a stop another hook continued after the post-block ping', () => {
    const inbox = fakeInbox(['reply']);
    hook({ event: 'Stop' }, 'claude', inbox);
    expect(hook({ event: 'Stop', stopHookActive: true }, 'claude', inbox).action).toBe('sent');
    // Some other Stop hook kept it going; when it stops again it isn't ours to report.
    expect(hook({ event: 'Stop', stopHookActive: true }, 'claude', inbox).action).toBe('ignored');
  });

  it("doesn't count a block from an earlier turn", () => {
    const inbox = fakeInbox(['reply']);
    hook({ event: 'Stop' }, 'claude', inbox);
    // The agent's next stop never reached us; Nick prompts a new turn.
    hook({ event: 'UserPromptSubmit' }, 'claude', inbox);
    // Another tool's Stop hook continues this turn's stop: not waiting yet.
    expect(hook({ event: 'Stop', stopHookActive: true }, 'claude', inbox).action).toBe('ignored');
  });

  it('rolls back the take when the block cannot be recorded', () => {
    const takeThenProbe: StopInboxCheck = () => {
      store.appendEvent({ kind: 'probe' });
      return 'reply';
    };
    const append = store.appendEvent.bind(store);
    store.appendEvent = (event) => {
      if (event.kind === 'hook') throw new Error('disk full');
      return append(event);
    };
    expect(() => hook({ event: 'Stop' }, 'claude', takeThenProbe)).toThrow('disk full');
    store.appendEvent = append;
    const probes = store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE kind = 'probe'").get();
    expect(probes).toEqual({ n: 0 });
  });

  it("tells me in the ping when replies haven't reached the agent", () => {
    expect(stopText({ ...base, event: 'Stop' }, 2)).toContain(
      '_2 replies from you not read yet: they reach it at its next `check_inbox` or stop._',
    );
    expect(stopText({ ...base, event: 'Stop' }, 1)).toContain('_1 reply from you');
    expect(stopText({ ...base, event: 'Stop' }, 0)).not.toContain('not read yet');
  });

  it('loop guard: stops blocking at the hourly cap, leaving the replies unread', () => {
    const inbox = fakeInbox(Array.from({ length: 20 }, (_, i) => `reply ${i}`));
    for (let i = 0; i < LIMITS.stopBlocksPerSession; i++) {
      const result = hook({ event: 'Stop', stopHookActive: i > 0 }, 'claude', inbox);
      expect(result.action).toBe('blocked');
    }
    const capped = hook({ event: 'Stop', stopHookActive: true }, 'claude', inbox);
    expect(capped.action).toBe('sent');
    expect(inbox.calls).toBe(LIMITS.stopBlocksPerSession);
    advance(60 * 60_000 + 1000);
    expect(hook({ event: 'Stop' }, 'claude', inbox).action).toBe('blocked');
  });

  it('counts the cap per session', () => {
    const inbox = fakeInbox(Array.from({ length: 20 }, (_, i) => `reply ${i}`));
    for (let i = 0; i < LIMITS.stopBlocksPerSession; i++) hook({ event: 'Stop' }, 'claude', inbox);
    const other = hook({ event: 'Stop', appSessionId: 'app-456' }, 'claude', inbox);
    expect(other.action).toBe('blocked');
  });

  it('audits each block without copying my message', () => {
    hook({ event: 'Stop' }, 'claude', fakeInbox(['secret plan B']));
    const rows = store.db.prepare("SELECT data FROM events WHERE kind = 'hook'").all() as {
      data: string;
    }[];
    expect(rows.map((row) => JSON.parse(row.data) as unknown)).toContainEqual(
      expect.objectContaining({ event: 'Stop', action: 'blocked' }),
    );
    expect(JSON.stringify(rows)).not.toContain('secret plan B');
  });

  it('never blocks other events', () => {
    const inbox = fakeInbox(['reply']);
    for (const event of ['SessionStart', 'PermissionRequest', 'Notification', 'UserPromptSubmit']) {
      expect(hook({ event }, 'claude', inbox).action).not.toBe('blocked');
    }
    expect(inbox.calls).toBe(0);
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
    hook({ event: 'PreToolUse' });
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
