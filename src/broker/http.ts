import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { checkRequest } from '../shared/guard.ts';
import { hookRequestSchema, type HookResponse } from '../shared/hook-protocol.ts';
import type { Platform } from '../shared/platform.ts';
import { errorMessage, type Logger } from './log.ts';
import { createBusMcpServer, type McpDeps } from './mcp.ts';
import { StopDelivery } from './stop-hook.ts';
import type { BusService } from './service.ts';
import type { Store } from './store.ts';
import { TaskService } from './tasks.ts';

const MAX_BODY_BYTES = 1_000_000;

export interface HttpOptions extends Omit<McpDeps, 'tasks'> {
  /** Phase 3 task rules; made from `store` and `service` when not given. */
  tasks?: TaskService | undefined;
  port: number;
  tokens: Record<Platform, string>;
  service: BusService;
  store: Store;
  log: Logger;
  /** Extra fields for GET /health (e.g. the Slack connection state). */
  health?: () => Record<string, unknown>;
}

/** The options a running server works with: the task service always filled in. */
type LiveOptions = HttpOptions & McpDeps;

export interface RunningHttpServer {
  server: Server;
  port: number;
  close: () => Promise<void>;
}

/** Starts the broker's HTTP server on 127.0.0.1. Port 0 picks a free port (tests). */
export async function startHttpServer(options: HttpOptions): Promise<RunningHttpServer> {
  const live: LiveOptions = {
    ...options,
    tasks: options.tasks ?? new TaskService(options.store, options.service),
  };
  const server = createServer((req, res) => {
    handle(req, res, live).catch((error: unknown) => {
      live.log('error', 'request failed', { url: req.url, error: errorMessage(error) });
      if (!res.headersSent) reply(res, 500, 'Internal error');
      else res.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  live.port = (server.address() as AddressInfo).port;
  return {
    server,
    port: live.port,
    close: () =>
      new Promise((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  options: LiveOptions,
): Promise<void> {
  const startedAt = performance.now();
  const verdict = checkRequest(
    {
      host: req.headers.host,
      origin: firstHeader(req.headers.origin),
      authorization: req.headers.authorization,
    },
    options,
  );
  if (!verdict.ok) {
    options.log('warn', 'request rejected', {
      status: verdict.status,
      reason: verdict.reason,
      url: req.url,
      userAgent: req.headers['user-agent'],
    });
    return reply(res, verdict.status, verdict.reason);
  }

  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  if (url.pathname === '/health') {
    if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
    return json(res, 200, { ok: true, platform: verdict.platform, ...options.health?.() });
  }
  if (url.pathname !== '/mcp' && url.pathname !== '/hook') return reply(res, 404, 'Not found');
  // Stateless MCP: no server-to-client GET stream and no session DELETE.
  if (req.method !== 'POST') return methodNotAllowed(res, 'POST');

  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    return reply(res, 400, errorMessage(error));
  }

  if (url.pathname === '/hook') {
    const parsed = hookRequestSchema.safeParse(body);
    if (!parsed.success) return reply(res, 400, 'Invalid hook request');
    const delivery = new StopDelivery(options.inbox, options.store);
    // A hook that already gave up (timed out, closed) can't be handed replies,
    // but its event still settles the last offer.
    const result: HookResponse = options.service.hook(
      verdict.platform,
      parsed.data,
      req.socket.destroyed ? undefined : delivery.check,
      delivery,
    );
    // Replies handed to a Stop hook count as delivered only once the response
    // is fully written ('finish'); a connection that closes first puts them
    // back. (writableFinished can't tell: Node sets it on a destroyed response.)
    // These run after the response, outside the request's error handling.
    const afterResponse = (what: string, work: () => void) => () => {
      try {
        work();
      } catch (error) {
        options.log('error', `hook ${what} failed`, { error: errorMessage(error) });
      }
    };
    let written = false;
    res.once('finish', () => (written = true));
    res.once(
      'close',
      afterResponse('delivery', () => delivery.settle(written)),
    );
    // The bus ID: UserPromptSubmit re-sends it until the broker can tell the
    // agent has it (see BusService.markContextDelivered).
    if (result.context) {
      const { session } = result;
      const { event } = parsed.data;
      res.once(
        'finish',
        afterResponse('context record', () =>
          options.service.markContextDelivered(
            verdict.platform,
            session,
            event,
            performance.now() - startedAt,
          ),
        ),
      );
    }
    return json(res, 200, result);
  }

  const server = createBusMcpServer(options, verdict.platform);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
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
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('Body is not valid JSON');
  }
}

function reply(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' }).end(message);
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}

function methodNotAllowed(res: ServerResponse, allow: string): void {
  res.setHeader('allow', allow);
  reply(res, 405, 'Method not allowed');
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
