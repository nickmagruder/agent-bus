import { request } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startSpikeServer, summarizeRpc, type RunningServer } from '../src/spike/echo-server.ts';

const token = 't'.repeat(48);
let dir: string;
let running: RunningServer;

function rawPost(headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port: running.port, path: '/mcp', method: 'POST', headers },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.on('error', reject);
    req.end('{}');
  });
}

async function connectClient(): Promise<Client> {
  const client = new Client({ name: 'vitest', version: '0.0.0' });
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${running.port}/mcp`),
    { requestInit: { headers: { authorization: `Bearer ${token}` } } },
  );
  await client.connect(transport);
  return client;
}

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'agent-bus-'));
  running = await startSpikeServer({ token, port: 0, logDir: dir });
});

afterAll(async () => {
  await running.close();
  await rm(dir, { recursive: true, force: true });
});

describe('spike server security', () => {
  it('rejects a request without a token', async () => {
    expect(await rawPost({ host: `127.0.0.1:${running.port}` })).toBe(401);
  });

  it('rejects a foreign Host even with a valid token', async () => {
    expect(
      await rawPost({ host: `evil.example:${running.port}`, authorization: `Bearer ${token}` }),
    ).toBe(403);
  });

  it('rejects a foreign Origin even with a valid token', async () => {
    expect(
      await rawPost({
        host: `127.0.0.1:${running.port}`,
        origin: 'https://evil.example',
        authorization: `Bearer ${token}`,
      }),
    ).toBe(403);
  });
});

describe('spike server tools', () => {
  it('lists the spike tools and answers whoami', async () => {
    const client = await connectClient();
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(['hold', 'whoami']);

    const result = await client.callTool({ name: 'whoami', arguments: { note: 'hi' } });
    expect(JSON.stringify(result.content)).toContain('agent-bus spike got your call');
    await client.close();
  });

  it('holds for the requested time', async () => {
    const client = await connectClient();
    const result = await client.callTool({ name: 'hold', arguments: { seconds: 1 } });
    expect(JSON.stringify(result.content)).toMatch(/Held for 1(\.\d+)?s \(completed\)/);
    await client.close();
  });

  it('sends progress heartbeats while holding when the client asks for progress', async () => {
    const client = await connectClient();
    const progress: number[] = [];
    const result = await client.callTool(
      { name: 'hold', arguments: { seconds: 3, heartbeatSeconds: 1 } },
      undefined,
      { onprogress: (update) => progress.push(update.progress) },
    );
    expect(JSON.stringify(result.content)).toContain('(completed)');
    expect(progress.length).toBeGreaterThanOrEqual(2);
    await client.close();
  });

  it('logs initialize with the client name', async () => {
    const log = await readFile(path.join(dir, 'mcp.jsonl'), 'utf8');
    expect(log).toContain('"clientInfo":{"name":"vitest"');
    expect(log).toContain('"kind":"rejected"');
  });
});

describe('summarizeRpc', () => {
  it('summarizes single messages and batches', () => {
    expect(summarizeRpc({ method: 'tools/call', id: 1, params: { name: 'hold' } })).toEqual([
      { method: 'tools/call', id: 1, tool: 'hold' },
    ]);
    expect(summarizeRpc([null])).toEqual([{ invalid: true }]);
  });
});
