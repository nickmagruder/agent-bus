import { z } from 'zod';

/**
 * The hook CLI → broker request (`POST /hook`). The CLI picks these fields
 * out of each app's hook payload and truncates them; the broker validates
 * again and rejects anything larger.
 */
export const HOOK_LIMITS = {
  id: 200,
  name: 200,
  path: 1000,
  text: 2000,
} as const;

const text = (max: number) => z.string().max(max).optional();

export const hookRequestSchema = z.strictObject({
  event: z.string().min(1).max(64),
  appSessionId: z.string().min(1).max(HOOK_LIMITS.id),
  project: text(HOOK_LIMITS.name),
  branch: text(HOOK_LIMITS.name),
  cwd: text(HOOK_LIMITS.path),
  source: text(40),
  notificationType: text(60),
  message: text(HOOK_LIMITS.text),
  toolName: text(HOOK_LIMITS.name),
  toolSummary: text(HOOK_LIMITS.text),
  lastMessage: text(HOOK_LIMITS.text),
  stopHookActive: z.boolean().optional(),
});

export type HookRequest = z.infer<typeof hookRequestSchema>;

export interface HookResponse {
  session: string;
  action: string;
  /** SessionStart, and UserPromptSubmit until delivered: the bus ID as added context. */
  context?: string;
  /** Stop with action `blocked`: my Slack replies, for `{"decision":"block","reason":…}`. */
  reason?: string;
}
