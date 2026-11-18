/**
 * Phase 0 spike: stdio MCP server that forwards every message to the HTTP
 * spike server. For clients that can launch local MCP programs but can't
 * reach 127.0.0.1 over HTTP themselves (Codex desktop, see phase-0.md).
 *
 * stdout carries the MCP protocol only; diagnostics go to spike-logs/bridge.jsonl.
 * If the HTTP side fails, requests get a JSON-RPC error with the real cause,
 * so the agent can report it.
 *
 *   node src/spike/stdio-bridge.ts        (reads AGENT_BUS_TOKEN, AGENT_BUS_PORT)
 */
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { loadServerConfig } from './config.ts';
import { jsonlLogger } from './log.ts';

export function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = (error as { cause?: unknown }).cause;
  return cause === undefined ? error.message : `${error.message} (cause: ${describeError(cause)})`;
}

/** The JSON-RPC error reply for a request we couldn't forward; notifications get none. */
export function forwardFailure(
  message: JSONRPCMessage,
  error: unknown,
): JSONRPCMessage | undefined {
  if (!('id' in message) || !('method' in message)) return undefined;
  return {
    jsonrpc: '2.0',
    id: message.id,
    error: {
      code: -32000,
      message: `agent-bus bridge could not reach the server: ${describeError(error)}`,
    },
  };
}

async function main(): Promise<void> {
  const config = loadServerConfig();
  const log = jsonlLogger(config.logDir, 'bridge.jsonl');
  const url = new URL(`http://127.0.0.1:${config.port}/mcp`);
  const upstream = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { authorization: `Bearer ${config.token}` } },
  });
  const downstream = new StdioServerTransport();

  downstream.onmessage = (message) => {
    upstream.send(message).catch(async (error: unknown) => {
      await log('forward-failed', {
        method: 'method' in message ? message.method : undefined,
        error: describeError(error),
      });
      const reply = forwardFailure(message, error);
      if (reply) await downstream.send(reply);
    });
  };
  upstream.onmessage = (message) => {
    void downstream.send(message);
  };
  upstream.onerror = (error) => void log('upstream-error', { error: describeError(error) });
  downstream.onclose = () => {
    void upstream.close();
  };

  await upstream.start();
  await downstream.start();
  await log('started', { pid: process.pid, url: url.href, parentPid: process.ppid });
}

if (import.meta.main) {
  await main();
}
