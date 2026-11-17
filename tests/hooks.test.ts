import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  armPermission,
  armStop,
  claimFirstStop,
  disarmAll,
  isStopArmed,
  readPermissionArm,
} from '../src/spike/arm.ts';
import {
  classifyEvent,
  eventName,
  parseHookArgs,
  permissionDecisionOutput,
  sessionIdOf,
  stopBlockOutput,
} from '../src/spike/hook-output.ts';

describe('parseHookArgs', () => {
  it('reads platform and optional event', () => {
    expect(parseHookArgs(['--platform', 'copilot', '--event', 'agentStop'])).toEqual({
      platform: 'copilot',
      event: 'agentStop',
    });
  });

  it.each([[[]], [['--platform', 'cursor']]])('rejects %j', (argv) => {
    expect(() => parseHookArgs(argv)).toThrow(/--platform/);
  });

  it('rejects unknown flags', () => {
    expect(() => parseHookArgs(['--platform', 'claude', '--mode', 'x'])).toThrow();
  });
});

describe('event helpers', () => {
  it.each([
    ['Stop', 'stop'],
    ['agentStop', 'stop'],
    ['PermissionRequest', 'permission'],
    ['Notification', 'other'],
    [undefined, 'other'],
  ])('classifies %s as %s', (event, expected) => {
    expect(classifyEvent(event)).toBe(expected);
  });

  it('prefers the --event flag over the payload', () => {
    expect(eventName({ platform: 'claude', event: 'X' }, { hook_event_name: 'Stop' })).toBe('X');
    expect(eventName({ platform: 'claude', event: undefined }, { hook_event_name: 'Stop' })).toBe(
      'Stop',
    );
    expect(eventName({ platform: 'claude', event: undefined }, null)).toBeUndefined();
  });

  it('finds the session id in snake or camel case', () => {
    expect(sessionIdOf({ session_id: 'a' })).toBe('a');
    expect(sessionIdOf({ sessionId: 'b' })).toBe('b');
    expect(sessionIdOf({})).toBe('unknown');
  });
});

describe('hook outputs', () => {
  it('blocks a stop with a reason', () => {
    expect(stopBlockOutput('why')).toEqual({ decision: 'block', reason: 'why' });
  });

  it('formats permission decisions', () => {
    expect(permissionDecisionOutput('allow')).toEqual({
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
    });
    expect(permissionDecisionOutput('deny', 'no')).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'deny', message: 'no' },
      },
    });
  });
});

describe('arming', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'agent-bus-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('is disarmed by default', async () => {
    expect(await isStopArmed(dir)).toBe(false);
    expect(await readPermissionArm(dir)).toBeUndefined();
  });

  it('arms and disarms', async () => {
    await armStop(dir);
    await armPermission(dir, { seconds: 5, decision: 'deny' });
    expect(await isStopArmed(dir)).toBe(true);
    expect(await readPermissionArm(dir)).toEqual({ seconds: 5, decision: 'deny' });
    await disarmAll(dir);
    expect(await isStopArmed(dir)).toBe(false);
    expect(await readPermissionArm(dir)).toBeUndefined();
  });

  it('rejects an invalid permission arm', async () => {
    await expect(armPermission(dir, { seconds: -1, decision: 'deny' })).rejects.toThrow();
  });

  it('blocks only the first stop per session, so a stop can never loop', async () => {
    expect(await claimFirstStop(dir, 'session/1')).toBe(true);
    expect(await claimFirstStop(dir, 'session/1')).toBe(false);
    expect(await claimFirstStop(dir, 'session-2')).toBe(true);
  });
});
