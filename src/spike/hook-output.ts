import { parseArgs } from 'node:util';

export const PLATFORMS = ['claude', 'codex', 'copilot'] as const;
export type Platform = (typeof PLATFORMS)[number];

export interface HookArgs {
  platform: Platform;
  /** Event name override, for platforms whose payload doesn't name the event (Copilot). */
  event: string | undefined;
}

export function parseHookArgs(argv: string[]): HookArgs {
  const { values } = parseArgs({
    args: argv,
    options: { platform: { type: 'string' }, event: { type: 'string' } },
    strict: true,
  });
  const platform = values.platform;
  if (!PLATFORMS.includes(platform as Platform)) {
    throw new Error(`--platform must be one of ${PLATFORMS.join(', ')}`);
  }
  return { platform: platform as Platform, event: values.event };
}

export type SpikeAction = 'stop' | 'permission' | 'other';

/** Maps each platform's event name onto the two behaviours the spike tests. */
export function classifyEvent(event: string | undefined): SpikeAction {
  switch (event) {
    case 'Stop':
    case 'agentStop':
      return 'stop';
    case 'PermissionRequest':
      return 'permission';
    default:
      return 'other';
  }
}

export function eventName(args: HookArgs, payload: unknown): string | undefined {
  if (args.event) return args.event;
  const value = (payload as { hook_event_name?: unknown } | null)?.hook_event_name;
  return typeof value === 'string' ? value : undefined;
}

export function sessionIdOf(payload: unknown): string {
  const record = payload as { session_id?: unknown; sessionId?: unknown } | null;
  const id = record?.session_id ?? record?.sessionId;
  return typeof id === 'string' && id.length > 0 ? id : 'unknown';
}

/** Claude Code and Codex share this Stop-hook shape for "keep going". */
export function stopBlockOutput(reason: string): Record<string, unknown> {
  return { decision: 'block', reason };
}

/** Claude Code and Codex share this PermissionRequest decision shape. */
export function permissionDecisionOutput(
  behavior: 'allow' | 'deny',
  message = 'Denied by the agent-bus spike.',
): Record<string, unknown> {
  return {
    hookSpecificOutput: {
      hookEventName: 'PermissionRequest',
      decision: behavior === 'deny' ? { behavior, message } : { behavior },
    },
  };
}
