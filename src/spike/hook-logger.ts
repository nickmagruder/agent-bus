/**
 * Phase 0 spike: hook command for Claude Code, Codex and Copilot.
 *
 * Logs every hook payload to spike-logs/hooks.jsonl. When armed (see arm.ts)
 * it also tests the two tricks the plan relies on:
 * - Stop: block the first stop per session and hand the agent a reason.
 * - PermissionRequest: wait, then answer allow/deny from the hook.
 *
 * It never fails the agent: on any error it writes to stderr and exits 0.
 *
 *   node src/spike/hook-logger.ts --platform claude|codex|copilot [--event NAME]
 */
import { setTimeout as sleep } from 'node:timers/promises';
import { claimFirstStop, isStopArmed, readPermissionArm } from './arm.ts';
import { logDirFrom } from './config.ts';
import {
  classifyEvent,
  eventName,
  parseHookArgs,
  permissionDecisionOutput,
  sessionIdOf,
  stopBlockOutput,
} from './hook-output.ts';
import { jsonlLogger } from './log.ts';

export const STOP_REASON =
  'agent-bus spike: Stop-hook test. Reply with exactly the word PINEAPPLE, then stop.';

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function parsePayload(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return { unparsed: raw };
  }
}

async function main(): Promise<void> {
  const args = parseHookArgs(process.argv.slice(2));
  const logDir = logDirFrom();
  const log = jsonlLogger(logDir, 'hooks.jsonl');
  const payload = parsePayload(await readStdin());
  const event = eventName(args, payload);
  const sessionId = sessionIdOf(payload);
  await log('hook', { platform: args.platform, event, sessionId, cwd: process.cwd(), payload });

  const action = classifyEvent(event);
  if (
    action === 'stop' &&
    (await isStopArmed(logDir)) &&
    (await claimFirstStop(logDir, sessionId))
  ) {
    await log('stop-blocked', { platform: args.platform, sessionId });
    process.stdout.write(JSON.stringify(stopBlockOutput(STOP_REASON)));
    return;
  }

  if (action === 'permission') {
    const arm = await readPermissionArm(logDir);
    if (!arm) return;
    const started = Date.now();
    await sleep(arm.seconds * 1000);
    await log('permission-decided', {
      platform: args.platform,
      sessionId,
      decision: arm.decision,
      waitedSeconds: (Date.now() - started) / 1000,
    });
    process.stdout.write(JSON.stringify(permissionDecisionOutput(arm.decision)));
  }
}

try {
  await main();
} catch (error) {
  console.error('agent-bus spike hook failed:', error);
}
