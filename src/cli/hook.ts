/**
 * Hook command for Claude Code and Codex (Copilot desktop hooks don't run yet).
 *
 *   node <repo>/src/cli/hook.ts claude|codex|copilot [--event NAME]
 *
 * Reads the app's hook payload from stdin, forwards the useful fields to the
 * local broker (`POST /hook`) with this platform's token, and prints the
 * app's expected output. It must never fail the agent: any problem (broker
 * down, token missing, bad payload) is noted on stderr and it exits 0.
 */
import { parseArgs } from 'node:util';
import { DEFAULT_PORT } from '../shared/config.ts';
import type { HookResponse } from '../shared/hook-protocol.ts';
import { PLATFORMS, type Platform } from '../shared/platform.ts';
import { extractHookRequest, findRepo, renderHookOutput } from './hook-extract.ts';

/**
 * SessionStart delays the session's first turn, so it gets the shortest wait.
 * Stop isn't latency-sensitive and may carry my Slack replies: give a busy
 * broker longer before the agent stops without them.
 */
const TIMEOUT_MS = { SessionStart: 2000, Stop: 15_000, default: 3000 } as const;

export function timeoutFor(event: string): number {
  if (event === 'SessionStart') return TIMEOUT_MS.SessionStart;
  if (event === 'Stop') return TIMEOUT_MS.Stop;
  return TIMEOUT_MS.default;
}

export interface HookRunOptions {
  argv: string[];
  stdin: string;
  env: NodeJS.ProcessEnv;
  cwd: string;
  fetch?: typeof fetch;
}

export interface HookRunResult {
  stdout: string;
  /** Why nothing was sent, for stderr. Never contains a token. */
  note?: string;
}

export async function runHook(options: HookRunOptions): Promise<HookRunResult> {
  const { values, positionals } = parseArgs({
    args: options.argv,
    options: { event: { type: 'string' } },
    allowPositionals: true,
    strict: true,
  });
  const platform = positionals[0] as Platform;
  if (!PLATFORMS.includes(platform)) {
    return { stdout: '', note: `first argument must be one of ${PLATFORMS.join(', ')}` };
  }

  const token = options.env[`AGENT_BUS_TOKEN_${platform.toUpperCase()}`];
  if (!token) return { stdout: '', note: `AGENT_BUS_TOKEN_${platform.toUpperCase()} is not set` };

  let payload: unknown;
  try {
    payload = JSON.parse(options.stdin);
  } catch {
    return { stdout: '', note: 'hook payload is not JSON' };
  }
  const payloadCwd = (payload as { cwd?: unknown } | null)?.cwd;
  const cwd = typeof payloadCwd === 'string' ? payloadCwd : options.cwd;
  const request = extractHookRequest(payload, { event: values.event, repo: findRepo(cwd) });
  if (!request) return { stdout: '', note: 'hook payload has no event or session ID' };

  const port = Number(options.env.AGENT_BUS_PORT ?? DEFAULT_PORT);
  const timeout = timeoutFor(request.event);
  const doFetch = options.fetch ?? fetch;
  const response = await doFetch(`http://127.0.0.1:${port}/hook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(timeout),
  });
  if (!response.ok) {
    return { stdout: '', note: `broker answered ${response.status}` };
  }
  const result = (await response.json()) as HookResponse;
  return { stdout: renderHookOutput(platform, request.event, result) };
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

if (import.meta.main) {
  try {
    const result = await runHook({
      argv: process.argv.slice(2),
      stdin: await readStdin(),
      env: process.env,
      cwd: process.cwd(),
    });
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.note) process.stderr.write(`agent-bus hook: ${result.note}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`agent-bus hook: ${message}\n`);
  }
  process.exitCode = 0;
}
