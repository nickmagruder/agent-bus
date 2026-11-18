import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startSpikeServer, type RunningServer } from '../src/spike/echo-server.ts';
import { describeError, forwardFailure } from '../src/spike/stdio-bridge.ts';

const token = 'b'.repeat(48);
const bridgePath = path.resolve(import.meta.dirname, '../src/spike/stdio-bridge.ts');
let dir: string;
let running: RunningServer;

function bridgeClient(env: Record<string, string>): {
  client: Client;
  transport: StdioClientTransport;
} {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [bridgePath],
    env: { ...(process.env as Record<string, string>), AGENT_BUS_LOG_DIR: dir, ...env },
    stderr: 'ignore',
  });
  return { client: new Client({ name: 'vitest-bridge', version: '0.0.0' }), transport };
}

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'agent-bus-'));
  running = await startSpikeServer({ token, port: 0, logDir: dir });
});

afterAll(async () => {
  await running.close();
  await rm(dir, { recursive: true, force: true });
});

describe('stdio bridge', () => {
  it('forwards tool calls to the HTTP server', async () => {
    const { client, transport } = bridgeClient({
      AGENT_BUS_TOKEN: token,
      AGENT_BUS_PORT: String(running.port),
    });
    await client.connect(transport);
    const result = await client.callTool({ name: 'whoami', arguments: { note: 'bridge' } });
    expect(JSON.stringify(result.content)).toContain('agent-bus spike got your call');
    await client.close();
  });

  it('reports the real cause when the server rejects it', async () => {
    const { client, transport } = bridgeClient({
      AGENT_BUS_TOKEN: 'w'.repeat(48),
      AGENT_BUS_PORT: String(running.port),
    });
    await expect(client.connect(transport)).rejects.toThrow(/agent-bus bridge could not reach/);
    await client.close();
  });
});

describe('bridge helpers', () => {
  it('includes nested causes', () => {
    const error = new Error('fetch failed', { cause: new Error('connect EACCES 127.0.0.1:47823') });
    expect(describeError(error)).toBe('fetch failed (cause: connect EACCES 127.0.0.1:47823)');
  });

  it('answers requests but not notifications', () => {
    expect(forwardFailure({ jsonrpc: '2.0', id: 7, method: 'tools/list' }, 'x')).toMatchObject({
      id: 7,
      error: { code: -32000 },
    });
    expect(
      forwardFailure({ jsonrpc: '2.0', method: 'notifications/initialized' }, 'x'),
    ).toBeUndefined();
  });
});
