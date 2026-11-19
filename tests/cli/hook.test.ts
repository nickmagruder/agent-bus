import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { silentLogger } from '../../src/broker/log.ts';
import { startBroker, type Broker } from '../../src/broker/main.ts';
import { runHook, timeoutFor } from '../../src/cli/hook.ts';
import { FakeSlack, TOKENS, USER_ID } from '../broker/fakes.ts';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
let dir: string;
let broker: Broker;
const slack = new FakeSlack();

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'agent-bus-hook-'));
  broker = await startBroker(
    {
      port: 0,
      dataDir: dir,
      tokens: TOKENS,
      slack: { botToken: 'xoxb-test', appToken: 'xapp-test', userId: USER_ID },
    },
    { log: silentLogger, slackApi: slack, connection: null, queueOptions: { minIntervalMs: 0 } },
  );
});

afterAll(async () => {
  await broker.stop();
  await rm(dir, { recursive: true, force: true });
});

function env(platform: 'CLAUDE' | 'CODEX' = 'CLAUDE'): NodeJS.ProcessEnv {
  const token = platform === 'CLAUDE' ? TOKENS.claude : TOKENS.codex;
  return { [`AGENT_BUS_TOKEN_${platform}`]: token, AGENT_BUS_PORT: String(broker.port) };
}

/** Bus-ID deliveries the broker has recorded for a platform. */
function delivered(platform: 'claude' | 'codex'): number {
  const row = broker.store.db
    .prepare(
      "SELECT COUNT(*) AS n FROM events WHERE kind = 'hook.context_delivered' AND platform = ?",
    )
    .get(platform) as { n: number };
  return Number(row.n);
}

function payload(fields: Record<string, unknown>): string {
  return JSON.stringify({ session_id: 'app-1', cwd: repoRoot, ...fields });
}

describe('runHook against the broker', () => {
  it('SessionStart prints the bus ID as added context', async () => {
    const result = await runHook({
      argv: ['claude'],
      stdin: payload({ hook_event_name: 'SessionStart', source: 'startup' }),
      env: env(),
      cwd: repoRoot,
    });
    const output = JSON.parse(result.stdout) as {
      hookSpecificOutput: { hookEventName: string; additionalContext: string };
    };
    expect(output.hookSpecificOutput.hookEventName).toBe('SessionStart');
    expect(output.hookSpecificOutput.additionalContext).toMatch(/claude\/agent-bus\/[0-9a-f]{4}/);
  });

  it('PermissionRequest DMs me and prints nothing, leaving the decision to the app', async () => {
    const result = await runHook({
      argv: ['codex'],
      stdin: payload({
        hook_event_name: 'PermissionRequest',
        tool_name: 'shell',
        tool_input: { command: 'rm -rf build' },
      }),
      env: env('CODEX'),
      cwd: repoRoot,
    });
    expect(result).toEqual({ stdout: '' });
    await broker.queue.idle();
    const dm = slack.posts.find((p) => p.channel === `D_${USER_ID}`);
    expect(dm?.text).toContain('rm -rf build');
    expect(dm?.username).toBe('Codex · agent-bus');
  });

  it('uses the platform from the token: a Codex token cannot post as Claude', async () => {
    await runHook({
      argv: ['claude'],
      stdin: payload({ hook_event_name: 'Stop', last_assistant_message: 'done' }),
      env: { AGENT_BUS_TOKEN_CLAUDE: TOKENS.codex, AGENT_BUS_PORT: String(broker.port) },
      cwd: repoRoot,
    });
    await broker.queue.idle();
    const stop = slack.posts.find((p) => p.text.includes('Turn finished'));
    expect(stop?.username).toBe('Codex · agent-bus');
  });

  it('notes a missing token without calling the broker', async () => {
    let called = false;
    const result = await runHook({
      argv: ['claude'],
      stdin: payload({ hook_event_name: 'Stop' }),
      env: {},
      cwd: repoRoot,
      fetch: (async () => {
        called = true;
        return new Response('{}');
      }) as typeof fetch,
    });
    expect(result).toEqual({ stdout: '', note: 'AGENT_BUS_TOKEN_CLAUDE is not set' });
    expect(called).toBe(false);
  });

  it.each([
    ['not JSON', '{nope', 'hook payload is not JSON'],
    ['null', 'null', 'hook payload has no event or session ID'],
    ['no session', JSON.stringify({ hook_event_name: 'Stop' }), 'hook payload has no event'],
  ])('handles a %s payload quietly', async (_, stdin, note) => {
    const result = await runHook({ argv: ['claude'], stdin, env: env(), cwd: repoRoot });
    expect(result.stdout).toBe('');
    expect(result.note).toContain(note);
  });

  it('rejects an unknown platform', async () => {
    const result = await runHook({ argv: ['gemini'], stdin: '{}', env: env(), cwd: repoRoot });
    expect(result.note).toContain('must be one of');
  });

  it('Stop hands my Slack reply to the agent once, then pings when it stops again', async () => {
    const start = await runHook({
      argv: ['claude'],
      stdin: payload({ session_id: 'app-stop', hook_event_name: 'SessionStart' }),
      env: env(),
      cwd: repoRoot,
    });
    const busId = /claude\/agent-bus\/[0-9a-f]{4}/.exec(start.stdout)?.[0] ?? '';
    broker.store.setThread(busId, 'C_STOP', '1700000100.000001');
    broker.inbox.receive({
      channel: 'C_STOP',
      channelType: 'channel',
      ts: '1700000100.000002',
      threadTs: '1700000100.000001',
      user: USER_ID,
      text: 'Use plan B',
      hasFiles: false,
    });

    const stop = (active: boolean) =>
      runHook({
        argv: ['claude'],
        stdin: payload({
          session_id: 'app-stop',
          hook_event_name: 'Stop',
          stop_hook_active: active,
          last_assistant_message: 'Done.',
        }),
        env: env(),
        cwd: repoRoot,
      });
    const blocked = JSON.parse((await stop(false)).stdout) as { decision: string; reason: string };
    expect(blocked.decision).toBe('block');
    expect(blocked.reason).toContain('Use plan B');
    expect(broker.store.countUndelivered(busId)).toBe(0);
    // ✅ once the response was written to the hook.
    await expect
      .poll(() => slack.reactions)
      .toContainEqual({ channel: 'C_STOP', ts: '1700000100.000002', name: 'white_check_mark' });
    // The agent dealt with it and stops again: no block, so the app stops normally.
    expect(await stop(true)).toEqual({ stdout: '' });
  });

  it('Stop prints nothing when the broker fails', async () => {
    const result = await runHook({
      argv: ['claude'],
      stdin: payload({ hook_event_name: 'Stop' }),
      env: env(),
      cwd: repoRoot,
      fetch: (async () => new Response('boom', { status: 500 })) as typeof fetch,
    });
    expect(result).toEqual({ stdout: '', note: 'broker answered 500' });
  });

  it('gives Stop the longest wait, SessionStart and UserPromptSubmit the shortest', () => {
    expect(timeoutFor('Stop')).toBe(15_000);
    expect(timeoutFor('SessionStart')).toBe(2000);
    expect(timeoutFor('UserPromptSubmit')).toBe(2000);
    expect(timeoutFor('PermissionRequest')).toBe(3000);
  });

  it('UserPromptSubmit hands over the bus ID when SessionStart missed, then stays quiet', async () => {
    const prompt = (sessionId: string) =>
      runHook({
        argv: ['codex'],
        stdin: payload({
          session_id: sessionId,
          hook_event_name: 'UserPromptSubmit',
          prompt: 'my secret prompt',
        }),
        env: env('CODEX'),
        cwd: repoRoot,
      });
    const first = JSON.parse((await prompt('app-race')).stdout) as {
      hookSpecificOutput: { hookEventName: string; additionalContext: string };
    };
    expect(first.hookSpecificOutput.hookEventName).toBe('UserPromptSubmit');
    expect(first.hookSpecificOutput.additionalContext).toMatch(/codex\/agent-bus\/[0-9a-f]{4}/);
    // Recorded (fast) once the response was written; the very next prompt adds nothing.
    await expect.poll(() => delivered('codex')).toBe(1);
    expect((await prompt('app-race')).stdout).toBe('');
    // The prompt itself never reaches the broker.
    const audit = JSON.stringify(broker.store.db.prepare('SELECT data FROM events').all());
    expect(audit).not.toContain('my secret prompt');
  });

  it('UserPromptSubmit stays quiet when SessionStart delivered the ID', async () => {
    const run = (event: string) =>
      runHook({
        argv: ['claude'],
        stdin: payload({ session_id: 'app-started', hook_event_name: event }),
        env: env(),
        cwd: repoRoot,
      });
    const before = delivered('claude');
    expect((await run('SessionStart')).stdout).toContain('additionalContext');
    await expect.poll(() => delivered('claude')).toBe(before + 1);
    expect((await run('UserPromptSubmit')).stdout).toBe('');
  });

  it('prints nothing when the broker refuses', async () => {
    const result = await runHook({
      argv: ['claude'],
      stdin: payload({ hook_event_name: 'SessionStart' }),
      env: env(),
      cwd: repoRoot,
      fetch: (async () => new Response('nope', { status: 500 })) as typeof fetch,
    });
    expect(result).toEqual({ stdout: '', note: 'broker answered 500' });
  });
});

describe('POST /hook', () => {
  function post(body: string, token = TOKENS.claude): Promise<number> {
    return new Promise((resolve, reject) => {
      const req = request(
        {
          host: '127.0.0.1',
          port: broker.port,
          path: '/hook',
          method: 'POST',
          headers: { host: `127.0.0.1:${broker.port}`, authorization: `Bearer ${token}` },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', reject);
      req.end(body);
    });
  }

  it('requires a platform token', async () => {
    expect(await post('{}', 'z'.repeat(48))).toBe(401);
  });

  it.each([
    ['missing session', { event: 'Stop' }],
    ['unknown field', { event: 'Stop', appSessionId: 'a', decision: 'allow' }],
    ['oversized text', { event: 'Stop', appSessionId: 'a', lastMessage: 'x'.repeat(2001) }],
    ['wrong type', { event: 'Stop', appSessionId: 'a', stopHookActive: 'yes' }],
  ])('rejects %s with 400', async (_, body) => {
    expect(await post(JSON.stringify(body))).toBe(400);
  });

  it('accepts a valid request', async () => {
    expect(await post(JSON.stringify({ event: 'UserPromptSubmit', appSessionId: 'a' }))).toBe(200);
  });
});

describe('hook process', () => {
  it.each(['SessionStart', 'UserPromptSubmit', 'Stop'])(
    'exits 0 with empty stdout when the broker is down (%s)',
    async (event) => {
      const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>(
        (resolve, reject) => {
          const child = spawn(
            process.execPath,
            [path.join(repoRoot, 'src/cli/hook.ts'), 'claude'],
            {
              env: { ...process.env, AGENT_BUS_TOKEN_CLAUDE: TOKENS.claude, AGENT_BUS_PORT: '1' },
            },
          );
          let stdout = '';
          let stderr = '';
          child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
          child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
          child.on('error', reject);
          child.on('close', (code) => resolve({ code, stdout, stderr }));
          child.stdin.end(payload({ hook_event_name: event }));
        },
      );
      expect(result.code).toBe(0);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('agent-bus hook:');
      expect(result.stderr).not.toContain(TOKENS.claude);
    },
  );
});
