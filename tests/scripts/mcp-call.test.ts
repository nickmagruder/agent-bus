import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { silentLogger } from '../../src/broker/log.ts';
import { startBroker, type Broker } from '../../src/broker/main.ts';
import { mcpCall, USAGE } from '../../scripts/mcp-call.ts';
import { FakeSlack, TOKENS, USER_ID } from '../broker/fakes.ts';

let dir: string;
let broker: Broker;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'agent-bus-mcp-call-'));
  broker = await startBroker(
    {
      port: 0,
      dataDir: dir,
      tokens: TOKENS,
      slack: { botToken: 'xoxb-test', appToken: 'xapp-test', userId: USER_ID },
    },
    { log: silentLogger, slackApi: new FakeSlack(), connection: null, digest: null },
  );
});

afterAll(async () => {
  await broker.stop();
  await rm(dir, { recursive: true, force: true });
});

const env = (platform: 'CLAUDE' | 'CODEX' = 'CLAUDE', token?: string) => ({
  [`AGENT_BUS_TOKEN_${platform}`]: token ?? (platform === 'CLAUDE' ? TOKENS.claude : TOKENS.codex),
  AGENT_BUS_PORT: String(broker.port),
});

describe('mcpCall', () => {
  it('calls a tool with JSON arguments and prints its text and structured result', async () => {
    const registered = await mcpCall({
      argv: ['claude', 'register', JSON.stringify({ purpose: 'Live test', project: 'agent-bus' })],
      env: env(),
    });
    expect(registered.exitCode).toBe(0);
    const session = /claude\/agent-bus\/[0-9a-f]{4}/.exec(registered.output)?.[0];
    expect(session).toBeDefined();

    const inbox = await mcpCall({
      argv: ['claude', 'check_inbox', JSON.stringify({ session })],
      env: env(),
    });
    expect(inbox).toEqual({
      output: expect.stringContaining('No new messages from Nick.') as string,
      exitCode: 0,
    });
    expect(inbox.output).toContain('"remaining": 0');
  });

  it('lists the tools', async () => {
    const listed = await mcpCall({ argv: ['codex', '--list'], env: env('CODEX') });
    expect(listed.exitCode).toBe(0);
    for (const tool of ['register', 'notify_human', 'check_inbox', 'ask_human', 'wait_for_reply']) {
      expect(listed.output).toContain(`${tool}:`);
    }
  });

  it("returns a tool error with exit code 1 (another platform's session)", async () => {
    const registered = await mcpCall({
      argv: ['claude', 'register', JSON.stringify({ purpose: 'Mine' })],
      env: env(),
    });
    const session = /claude\/[\w-]+\/[0-9a-f]{4}/.exec(registered.output)?.[0];
    const foreign = await mcpCall({
      argv: ['codex', 'check_inbox', JSON.stringify({ session })],
      env: env('CODEX'),
    });
    expect(foreign.exitCode).toBe(1);
    expect(foreign.output).toContain('another platform');
  });

  it('fails cleanly, without printing the token, when the broker refuses it', async () => {
    const wrong = 'w'.repeat(48);
    const result = await mcpCall({ argv: ['claude', '--list'], env: env('CLAUDE', wrong) });
    expect(result.exitCode).toBe(1);
    expect(result.output).toMatch(/^call failed: /);
    expect(result.output).not.toContain(wrong);
  });

  it.each([
    [[], USAGE],
    [['slack', 'register'], USAGE],
    [['claude'], USAGE],
    [['claude', 'register', '{oops'], 'arguments are not valid JSON'],
    [['claude', 'register', '[1,2]'], 'arguments must be a JSON object'],
  ])('rejects bad usage %j', async (argv, output) => {
    expect(await mcpCall({ argv, env: env() })).toEqual({ output, exitCode: 2 });
  });

  it('says which token is missing', async () => {
    expect(await mcpCall({ argv: ['codex', '--list'], env: {} })).toEqual({
      output: 'AGENT_BUS_TOKEN_CODEX is not set',
      exitCode: 2,
    });
  });
});
