/**
 * Calls one agent-bus MCP tool on the local broker and prints the result: for
 * live tests when a session's own MCP connection is down, or to try a tool by
 * hand.
 *
 *   node scripts/mcp-call.ts <platform> <tool> ['<json arguments>']
 *   node scripts/mcp-call.ts claude check_inbox '{"session":"claude/agent-bus/3f2a"}'
 *   node scripts/mcp-call.ts codex --list
 *
 * The platform's token comes from AGENT_BUS_TOKEN_<PLATFORM> and the port
 * from AGENT_BUS_PORT (default 47823), like the hook CLI. The token is sent
 * only to 127.0.0.1 and never printed. Messages it sends to Slack are real.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { DEFAULT_PORT } from '../src/shared/config.ts';
import { PLATFORMS, type Platform } from '../src/shared/platform.ts';

export const USAGE =
  "usage: node scripts/mcp-call.ts <claude|codex|copilot> <tool> ['<json arguments>']\n" +
  '       node scripts/mcp-call.ts <claude|codex|copilot> --list';

export interface McpCallOptions {
  argv: string[];
  env: NodeJS.ProcessEnv;
}

export interface McpCallResult {
  /** What to print on stdout. */
  output: string;
  exitCode: number;
}

/** Runs one call; errors come back as output and exit code 1, never thrown. */
export async function mcpCall(options: McpCallOptions): Promise<McpCallResult> {
  const [platformArg, tool, json] = options.argv;
  const platform = platformArg as Platform;
  if (!PLATFORMS.includes(platform) || !tool) return { output: USAGE, exitCode: 2 };

  const tokenName = `AGENT_BUS_TOKEN_${platform.toUpperCase()}`;
  const token = options.env[tokenName];
  if (!token) return { output: `${tokenName} is not set`, exitCode: 2 };

  let args: Record<string, unknown> = {};
  if (json !== undefined) {
    try {
      const parsed: unknown = JSON.parse(json);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return { output: 'arguments must be a JSON object', exitCode: 2 };
      }
      args = parsed as Record<string, unknown>;
    } catch {
      return { output: 'arguments are not valid JSON', exitCode: 2 };
    }
  }

  const port = Number(options.env.AGENT_BUS_PORT ?? DEFAULT_PORT);
  const client = new Client({ name: 'agent-bus-mcp-call', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  try {
    await client.connect(transport);
    if (tool === '--list') {
      const { tools } = await client.listTools();
      return { output: tools.map((t) => `${t.name}: ${t.title ?? ''}`).join('\n'), exitCode: 0 };
    }
    // Held tools (ask_human, wait_for_reply) can take minutes; heartbeats keep them alive.
    const result = await client.callTool({ name: tool, arguments: args }, undefined, {
      timeout: 10 * 60_000,
      resetTimeoutOnProgress: true,
    });
    const text = (result.content as { type: string; text?: string }[])
      .map((part) => (part.type === 'text' ? (part.text ?? '') : `[${part.type}]`))
      .join('\n');
    const structured = result.structuredContent
      ? `\n${JSON.stringify(result.structuredContent, null, 2)}`
      : '';
    return { output: `${text}${structured}`, exitCode: result.isError ? 1 : 0 };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Never echo the token, whatever the error says.
    return { output: `call failed: ${message.replaceAll(token, '<token>')}`, exitCode: 1 };
  } finally {
    await client.close().catch(() => undefined);
  }
}

if (import.meta.main) {
  const result = await mcpCall({ argv: process.argv.slice(2), env: process.env });
  const stream = result.exitCode === 0 ? process.stdout : process.stderr;
  stream.write(`${result.output}\n`);
  process.exitCode = result.exitCode;
}
