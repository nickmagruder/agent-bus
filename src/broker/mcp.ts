import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { Platform } from '../shared/platform.ts';
import { startHeartbeat, type HeartbeatTarget } from './heartbeat.ts';
import type { Inbox } from './inbox.ts';
import { outcomeText, QUESTION_LIMITS, type Notifier, type Questions } from './questions.ts';
import { BusError, URGENCIES, type BusService } from './service.ts';
import type { InboxRecord, QuestionRecord } from './store.ts';

export const SERVER_INFO = { name: 'agent-bus', version: '0.10.0' } as const;

export interface McpDeps {
  service: BusService;
  inbox: Inbox;
  questions: Questions;
  notifier: Notifier;
  /** Hold limit for ask_human / wait_for_reply (tests shorten it). */
  holdMs?: number | undefined;
}

const sessionArg = z
  .string()
  .max(80)
  .describe(
    'Your agent-bus session ID, e.g. "claude/agent-bus/3f2a", from register or startup context.',
  );

/**
 * One MCP server per request (the HTTP transport is stateless). `platform`
 * comes from the bearer token, never from tool arguments.
 */
export function createBusMcpServer(deps: McpDeps, platform: Platform): McpServer {
  const { service, inbox, questions, notifier } = deps;
  const holdMs = deps.holdMs ?? QUESTION_LIMITS.holdMs;
  const server = new McpServer(SERVER_INFO, { capabilities: { logging: {} } });

  server.registerTool(
    'register',
    {
      title: 'Register with agent-bus',
      description:
        'Announce this session in Slack and get its agent-bus session ID. Call once near the start of a task. ' +
        'If your startup context already gave you a session ID, pass it as `session`.',
      inputSchema: {
        purpose: z.string().min(1).max(200).describe('One line: what this session is working on.'),
        project: z
          .string()
          .max(60)
          .optional()
          .describe('Repository or folder name; decides the Slack channel (#proj-<name>).'),
        branch: z.string().max(100).optional(),
        session: sessionArg.optional(),
      },
    },
    async ({ purpose, project, branch, session }) =>
      run(() => {
        const result = service.register({ platform, purpose, project, branch, session });
        return {
          content: [
            {
              type: 'text',
              text:
                `Registered as ${result.session.id} (Slack #${result.session.channel}). ` +
                'Pass this as `session` to notify_human.',
            },
          ],
          structuredContent: { session: result.session.id, channel: result.session.channel },
        };
      }),
  );

  server.registerTool(
    'notify_human',
    {
      title: 'Notify Nick in Slack',
      description:
        'Send Nick a message in Slack; returns immediately. urgent = you are blocked on him (DM). ' +
        'normal = status update in the session thread. fyi = daily digest. Do not use urgent for finished work.',
      inputSchema: {
        session: sessionArg,
        text: z
          .string()
          .min(1)
          .max(3000)
          .describe('Self-contained: project, what you are doing, and what you need.'),
        urgency: z.enum(URGENCIES).default('normal'),
      },
    },
    async ({ session, text, urgency }) =>
      run(() => {
        const { route } = service.notify({ platform, session, text, urgency });
        const where = { dm: 'DM to Nick', thread: 'session thread', digest: 'daily digest' }[route];
        return { content: [{ type: 'text', text: `Queued for the ${where}.` }] };
      }),
  );

  server.registerTool(
    'check_inbox',
    {
      title: "Check Nick's Slack replies",
      description:
        "Return Nick's new Slack replies to this session (replies in the session's thread or under a DM " +
        'it sent), oldest first, and mark them read. Never blocks. Call at natural checkpoints, and before ' +
        'finishing when you asked Nick something.',
      inputSchema: { session: sessionArg },
    },
    async ({ session }) =>
      run(() => {
        const owned = service.requireSession(platform, session, 'check_inbox');
        return inboxResult(inbox.take(owned, 'check_inbox'));
      }),
  );

  server.registerTool(
    'ask_human',
    {
      title: 'Ask Nick a question in Slack',
      description:
        'Ask Nick a question he must answer (DM with optional buttons; he can also reply in text). ' +
        `Waits up to ${Math.round(holdMs / 1000)} s for his answer. If none yet, returns state "pending" with ` +
        'a question_id: carry on with work that does not depend on it and call wait_for_reply later. ' +
        'Always give default_action: what you will do if he does not answer before the question expires. ' +
        'Use only when blocked on him; otherwise use notify_human.',
      inputSchema: {
        session: sessionArg,
        question: z
          .string()
          .min(1)
          .max(QUESTION_LIMITS.questionChars)
          .describe('Self-contained: what you are doing, what you need decided, and the risk.'),
        options: z
          .array(z.string().min(1).max(QUESTION_LIMITS.optionChars))
          .max(QUESTION_LIMITS.maxOptions)
          .refine((list) => new Set(list).size === list.length, 'options must be unique')
          .optional()
          .describe('Up to 5 short answers shown as buttons.'),
        default_action: z
          .string()
          .min(1)
          .max(500)
          .describe(
            'What you will do if Nick does not answer in time. Never "proceed with the risky option".',
          ),
        timeout_minutes: z
          .number()
          .int()
          .min(QUESTION_LIMITS.minTimeoutMinutes)
          .max(QUESTION_LIMITS.maxTimeoutMinutes)
          .optional()
          .describe(
            `When the question expires (default ${QUESTION_LIMITS.defaultTimeoutMinutes}).`,
          ),
      },
    },
    async ({ session, question, options, default_action, timeout_minutes }, extra) =>
      runAsync(async () => {
        const asked = service.ask({
          platform,
          session,
          question,
          options,
          defaultAnswer: default_action,
          timeoutMinutes: timeout_minutes,
        });
        const outcome = await hold(asked.sessionId, extra, holdMs, () =>
          questions.takeOutcome(asked.id, 'ask_human'),
        );
        return outcome ? questionResult(outcome) : pendingResult(asked);
      }),
  );

  server.registerTool(
    'wait_for_reply',
    {
      title: "Wait for Nick's reply",
      description:
        `Wait up to ${Math.round(holdMs / 1000)} s for Nick: for the answer to question_id, or (without it) for ` +
        'any new message or question outcome for this session. Returns "pending" if nothing arrived; ' +
        'call again or carry on and check_inbox later.',
      inputSchema: {
        session: sessionArg,
        question_id: z.string().max(20).optional().describe('From ask_human, e.g. "q-3f2a1b".'),
        timeout_seconds: z
          .number()
          .int()
          .min(1)
          .max(Math.max(1, Math.round(holdMs / 1000)))
          .optional()
          .describe('How long to wait at most (default and maximum: the hold limit).'),
      },
    },
    async ({ session, question_id, timeout_seconds }, extra) =>
      runAsync(async () => {
        const ms =
          timeout_seconds === undefined ? holdMs : Math.min(timeout_seconds * 1000, holdMs);
        if (question_id) {
          const asked = service.requireQuestion(platform, session, question_id);
          const outcome = await hold(asked.sessionId, extra, ms, () =>
            questions.takeOutcome(asked.id, 'wait_for_reply'),
          );
          return outcome ? questionResult(outcome) : pendingResult(asked);
        }
        const owned = service.requireSession(platform, session, 'wait_for_reply');
        const taken = await hold(owned.id, extra, ms, () => {
          const result = inbox.take(owned, 'wait_for_reply');
          return result.messages.length > 0 || result.outcomes.length > 0 ? result : undefined;
        });
        if (taken) return inboxResult(taken);
        return {
          content: [
            {
              type: 'text',
              text: 'Nothing new from Nick yet. Call wait_for_reply again, or carry on and check_inbox later.',
            },
          ],
          structuredContent: { state: 'pending' },
        };
      }),
  );

  /**
   * Holds a tool call until `check` returns something, `ms` passes or the
   * client goes away, with progress heartbeats so the client doesn't time out.
   */
  async function hold<T>(
    sessionId: string,
    extra: HeartbeatTarget & { signal: AbortSignal },
    ms: number,
    check: () => T | undefined,
  ): Promise<T | undefined> {
    const deadline = Date.now() + ms;
    const stop = startHeartbeat(extra, 'Waiting for Nick in Slack');
    try {
      for (;;) {
        const result = check();
        if (result !== undefined) return result;
        const left = deadline - Date.now();
        if (left <= 0) return undefined;
        if ((await notifier.wait(sessionId, left, extra.signal)) === 'aborted') return undefined;
      }
    } finally {
      stop();
    }
  }

  return server;
}

function inboxResult(taken: {
  messages: readonly InboxRecord[];
  outcomes: readonly QuestionRecord[];
  remaining: number;
}): CallToolResult {
  return {
    content: [{ type: 'text', text: inboxText(taken.messages, taken.outcomes, taken.remaining) }],
    structuredContent: {
      messages: taken.messages.map((m) => ({
        id: m.id,
        at: m.createdAt,
        from: 'nick',
        text: m.body,
      })),
      outcomes: taken.outcomes.map(outcomeData),
      remaining: taken.remaining,
    },
  };
}

function questionResult(question: QuestionRecord): CallToolResult {
  return {
    content: [{ type: 'text', text: outcomeText(question) }],
    structuredContent: outcomeData(question),
  };
}

function pendingResult(question: QuestionRecord): CallToolResult {
  return {
    content: [
      {
        type: 'text',
        text:
          `No answer yet: ${question.id} is still open in Slack (expires ${question.expiresAt}). ` +
          'Carry on with work that does not depend on it, then call wait_for_reply with ' +
          `question_id "${question.id}" (or check_inbox). If it expires, go with your default_action.`,
      },
    ],
    structuredContent: {
      state: 'pending',
      question_id: question.id,
      expires_at: question.expiresAt,
    },
  };
}

function outcomeData(question: QuestionRecord): Record<string, unknown> {
  return {
    state: question.state,
    question_id: question.id,
    ...(question.state === 'answered'
      ? { answer: question.answer, source: question.answerSource }
      : { default_action: question.defaultAnswer }),
  };
}

/**
 * Inbox messages and question outcomes for the agent. Every message was
 * typed by Nick's own Slack account (the broker drops everything else), so
 * the label says so.
 */
export function inboxText(
  messages: readonly InboxRecord[],
  outcomes: readonly QuestionRecord[],
  remaining: number,
): string {
  if (messages.length === 0 && outcomes.length === 0) return 'No new messages from Nick.';
  const parts = outcomes.map(outcomeText);
  if (messages.length > 0) {
    const count = messages.length === 1 ? '1 message' : `${messages.length} messages`;
    const body = messages.map((m) => `[${m.createdAt}]\n${m.body}`).join('\n\n');
    parts.push(
      `${count} from Nick, sent from his own Slack account (verified by agent-bus):\n\n${body}`,
    );
  }
  if (remaining > 0) parts.push(`${remaining} more waiting: call check_inbox again.`);
  return parts.join('\n\n');
}

/** Turns a BusError into a tool error the agent can read; anything else is a bug. */
function run(work: () => CallToolResult): CallToolResult {
  try {
    return work();
  } catch (error) {
    return busError(error);
  }
}

async function runAsync(work: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await work();
  } catch (error) {
    return busError(error);
  }
}

function busError(error: unknown): CallToolResult {
  if (error instanceof BusError) {
    return { isError: true, content: [{ type: 'text', text: error.message }] };
  }
  throw error;
}
