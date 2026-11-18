import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { Platform } from '../shared/platform.ts';
import { BusError, URGENCIES, type BusService } from './service.ts';

export const SERVER_INFO = { name: 'agent-bus', version: '0.4.2' } as const;

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
export function createBusMcpServer(service: BusService, platform: Platform): McpServer {
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

  return server;
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
