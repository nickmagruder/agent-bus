import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { Platform } from '../shared/platform.ts';
import type { Inbox } from './inbox.ts';
import { BusError, URGENCIES, type BusService } from './service.ts';
import type { InboxRecord } from './store.ts';

export const SERVER_INFO = { name: 'agent-bus', version: '0.5.0' } as const;

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
export function createBusMcpServer(
  service: BusService,
  inbox: Inbox,
  platform: Platform,
): McpServer {
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
        const { messages, remaining } = inbox.take(owned);
        return {
          content: [{ type: 'text', text: inboxText(messages, remaining) }],
          structuredContent: {
            messages: messages.map((m) => ({
              id: m.id,
              at: m.createdAt,
              from: 'nick',
              text: m.body,
            })),
            remaining,
          },
        };
      }),
  );

  return server;
}

/**
 * Inbox messages for the agent. Every one was typed by Nick's own Slack
 * account (the broker drops everything else), so the label says so.
 */
export function inboxText(messages: readonly InboxRecord[], remaining: number): string {
  if (messages.length === 0) return 'No new messages from Nick.';
  const count = messages.length === 1 ? '1 message' : `${messages.length} messages`;
  const body = messages.map((m) => `[${m.createdAt}]\n${m.body}`).join('\n\n');
  const more = remaining > 0 ? `\n\n${remaining} more waiting: call check_inbox again.` : '';
  return `${count} from Nick, sent from his own Slack account (verified by agent-bus):\n\n${body}${more}`;
}

/** Turns a BusError into a tool error the agent can read; anything else is a bug. */
function run(work: () => CallToolResult): CallToolResult {
  try {
    return work();
  } catch (error) {
    if (error instanceof BusError) {
      return { isError: true, content: [{ type: 'text', text: error.message }] };
    }
    throw error;
  }
}
