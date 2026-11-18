/**
 * Phase 0 spike: a throwaway MCP server that records how each desktop app
 * (Claude Code, Codex, Copilot) connects and how long it lets a tool call run.
 * Not the real broker; delete once the spike results are recorded.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { loadServerConfig, type ServerConfig } from './config.ts';
import { checkRequest } from './guard.ts';
import { jsonlLogger, type Logger } from './log.ts';

const MAX_BODY_BYTES = 1_000_000;
const MAX_HOLD_SECONDS = 1800;

interface CallContext {
  userAgent: string | undefined;
}

export function createSpikeMcpServer(log: Logger, context: CallContext): McpServer {
  const server = new McpServer(
    { name: 'agent-bus-spike', version: '0.1.0' },
    // Logging lets the hold heartbeat fall back to log messages when the client sends no progress token.
    { capabilities: { logging: {} } },
  );

  server.registerTool(
    'whoami',
    {
      title: 'Spike: who am I',
      description:
        'agent-bus Phase 0 spike. Records that this client called the server and echoes back what the server saw.',
      inputSchema: { note: z.string().max(500).optional() },
    },
    async ({ note }) => {
      await log('tool', { tool: 'whoami', note, userAgent: context.userAgent });
      return {
        content: [
          {
            type: 'text',
            text: `agent-bus spike got your call at ${new Date().toISOString()} (user-agent: ${context.userAgent ?? 'none'}).`,
          },
        ],
      };
    },
  );

  server.registerTool(
    'hold',
    {
      title: 'Spike: hold',
      description:
        'agent-bus Phase 0 spike. Waits the given number of seconds before returning, to measure how long this client lets a tool call run.',
      inputSchema: {
        seconds: z.number().int().min(1).max(MAX_HOLD_SECONDS),
        heartbeatSeconds: z
          .number()
          .int()
          .min(1)
          .max(MAX_HOLD_SECONDS)
          .optional()
          .describe(
            'If set, send a progress (or log) notification this often while holding, to test whether that keeps the call alive.',
          ),
      },
    },
    async ({ seconds, heartbeatSeconds }, extra) => {
      const started = Date.now();
      const progressToken = extra._meta?.progressToken;
      await log('hold-start', {
        seconds,
        heartbeatSeconds,
        progressToken: progressToken ?? null,
        userAgent: context.userAgent,
      });
      const step = (heartbeatSeconds ?? seconds) * 1000;
      const deadline = started + seconds * 1000;
      let outcome = 'completed';
      let heartbeats = 0;
      try {
        while (Date.now() < deadline) {
          await sleep(Math.min(step, deadline - Date.now()), undefined, { signal: extra.signal });
          if (!heartbeatSeconds || Date.now() >= deadline) continue;
          heartbeats++;
          const elapsed = Math.round((Date.now() - started) / 1000);
          // Progress needs a token from the client; without one, fall back to a log message.
          await extra.sendNotification(
            progressToken === undefined
              ? {
                  method: 'notifications/message',
                  params: { level: 'info', data: `agent-bus spike: still holding (${elapsed}s)` },
                }
              : {
                  method: 'notifications/progress',
                  params: {
                    progressToken,
                    progress: elapsed,
                    total: seconds,
                    message: 'agent-bus spike: still holding',
                  },
                },
          );
          await log('hold-heartbeat', {
            via: progressToken === undefined ? 'log' : 'progress',
            elapsedSeconds: elapsed,
            userAgent: context.userAgent,
          });
        }
      } catch {
        outcome = 'cancelled';
      }
      const elapsedSeconds = (Date.now() - started) / 1000;
      await log('hold-end', {
        seconds,
        outcome,
        elapsedSeconds,
        heartbeats,
        userAgent: context.userAgent,
      });
      return { content: [{ type: 'text', text: `Held for ${elapsedSeconds}s (${outcome}).` }] };
    },
  );

  return server;
}

/** Pulls out what the spike needs to know from one JSON-RPC message or batch. */
export function summarizeRpc(body: unknown): Record<string, unknown>[] {
  const messages = Array.isArray(body) ? body : [body];
  return messages.map((message: unknown) => {
    if (typeof message !== 'object' || message === null) return { invalid: true };
    const { method, id, params } = message as {
      method?: unknown;
      id?: unknown;
      params?: Record<string, unknown>;
    };
    const summary: Record<string, unknown> = { method, id };
    if (method === 'initialize') {
      summary.clientInfo = params?.clientInfo;
      summary.protocolVersion = params?.protocolVersion;
    }
    if (method === 'tools/call') summary.tool = params?.name;
    return summary;
  });
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error('Request body too large');
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function reject(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' }).end(message);
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  config: ServerConfig,
  log: Logger,
): Promise<void> {
  const userAgent = req.headers['user-agent'];
  const verdict = checkRequest(
    {
      host: req.headers.host,
      origin: firstHeader(req.headers.origin),
      authorization: req.headers.authorization,
    },
    config,
  );
  if (!verdict.ok) {
    await log('rejected', {
      status: verdict.status,
      reason: verdict.reason,
      host: req.headers.host,
      userAgent,
    });
    reject(res, verdict.status, verdict.reason);
    return;
  }
  if (req.url !== '/mcp') return reject(res, 404, 'Not found');
  // Stateless server: no GET event stream and no DELETE of sessions.
  if (req.method !== 'POST') {
    res.setHeader('allow', 'POST');
    return reject(res, 405, 'Method not allowed');
  }

  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    return reject(res, 400, error instanceof Error ? error.message : 'Bad request');
  }

  const started = Date.now();
  const messages = summarizeRpc(body);
  await log('request', { userAgent, messages });

  const server = createSpikeMcpServer(log, { userAgent });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => {
    if (!res.writableFinished) {
      // The client gave up before we answered: this is the timeout we're measuring.
      void log('client-disconnected', {
        userAgent,
        messages,
        elapsedSeconds: (Date.now() - started) / 1000,
      });
    }
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}

export interface RunningServer {
  server: Server;
  port: number;
  close: () => Promise<void>;
}

/** Starts the spike server on 127.0.0.1. Port 0 picks a free port (used by tests). */
export async function startSpikeServer(config: ServerConfig): Promise<RunningServer> {
  const log = jsonlLogger(config.logDir, 'mcp.jsonl');
  const live: ServerConfig = { ...config };
  const server = createServer((req, res) => {
    handleRequest(req, res, live, log).catch((error: unknown) => {
      console.error('agent-bus spike: request failed', error);
      if (!res.headersSent) reject(res, 500, 'Internal error');
    });
  });
  await new Promise<void>((resolve) => server.listen(config.port, '127.0.0.1', resolve));
  live.port = (server.address() as AddressInfo).port;
  return {
    server,
    port: live.port,
    close: () => new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}

if (import.meta.main) {
  const config = loadServerConfig();
  const running = await startSpikeServer(config);
  console.log(`agent-bus spike listening on http://127.0.0.1:${running.port}/mcp`);
  console.log(`Logging to ${config.logDir}. Press Ctrl+C to stop.`);
}
