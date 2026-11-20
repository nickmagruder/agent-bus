import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, describe, expect, it } from 'vitest';
import type { Logger } from '../../src/broker/log.ts';
import { startBroker, type Broker } from '../../src/broker/main.ts';
import { FakeSlack, TOKENS, USER_ID } from './fakes.ts';

/** `AGENT_BUS_HOLD_SECONDS` reaches the MCP tools (#68). */
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function start(holdSeconds: number | undefined) {
  const dir = await mkdtemp(path.join(tmpdir(), 'agent-bus-hold-'));
  const lines: { level: string; message: string; data?: Record<string, unknown> }[] = [];
  const log: Logger = (level, message, data) => lines.push({ level, message, data });
  const broker: Broker = await startBroker(
    {
      port: 0,
      dataDir: dir,
      tokens: TOKENS,
      slack: { botToken: 'xoxb-test', appToken: 'xapp-test', userId: USER_ID },
      holdSeconds,
    },
    {
      log,
      slackApi: new FakeSlack(),
      connection: null,
      queueOptions: { minIntervalMs: 0 },
      digest: null,
      tickMs: 60_000,
    },
  );
  const client = new Client({ name: 'vitest-hold', version: '0.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${broker.port}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${TOKENS.claude}` } },
    }),
  );
  cleanups.push(async () => {
    await client.close();
    await broker.stop();
    await rm(dir, { recursive: true, force: true });
  });
  const { tools } = await client.listTools();
  const tool = (name: string) => {
    const found = tools.find((t) => t.name === name);
    if (!found) throw new Error(`no ${name} tool`);
    return found;
  };
  return { lines, tool };
}

describe('AGENT_BUS_HOLD_SECONDS (#68)', () => {
  it('raises the hold limit the tools use and logs it', async () => {
    const { lines, tool } = await start(360);
    expect(tool('ask_human').description).toContain('Waits up to 360 s');
    expect(tool('wait_for_reply').description).toContain('Wait up to 360 s');
    const timeout = (tool('wait_for_reply').inputSchema.properties ?? {})['timeout_seconds'] as {
      maximum?: number;
    };
    expect(timeout.maximum).toBe(360);
    expect(lines).toContainEqual({
      level: 'info',
      message: 'hold limit set by AGENT_BUS_HOLD_SECONDS',
      data: { seconds: 360 },
    });
  });

  it('keeps the 150 s default and logs nothing when unset', async () => {
    const { lines, tool } = await start(undefined);
    expect(tool('ask_human').description).toContain('Waits up to 150 s');
    expect(lines.some((l) => l.message.includes('AGENT_BUS_HOLD_SECONDS'))).toBe(false);
  });
});
