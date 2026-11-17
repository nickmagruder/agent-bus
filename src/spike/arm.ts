/**
 * Arms or disarms the spike's active hook tests. Hooks only log by default;
 * a test only changes agent behaviour while its arm file exists, so normal
 * sessions in this repo aren't affected.
 *
 *   node src/spike/arm.ts stop                                  block each session's first stop
 *   node src/spike/arm.ts permission --seconds 120 --decision deny
 *   node src/spike/arm.ts off                                   disarm everything
 *   node src/spike/arm.ts status
 */
import { mkdir, open, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { logDirFrom } from './config.ts';

const permissionArmSchema = z.object({
  seconds: z.number().int().min(0).max(900),
  decision: z.enum(['allow', 'deny']),
});
export type PermissionArm = z.infer<typeof permissionArmSchema>;

function armDir(logDir: string): string {
  return path.join(logDir, 'armed');
}

const stopArmFile = (logDir: string) => path.join(armDir(logDir), 'stop-block');
const permissionArmFile = (logDir: string) => path.join(armDir(logDir), 'permission-wait.json');

export async function isStopArmed(logDir: string): Promise<boolean> {
  try {
    await readFile(stopArmFile(logDir));
    return true;
  } catch {
    return false;
  }
}

export async function readPermissionArm(logDir: string): Promise<PermissionArm | undefined> {
  try {
    const raw = await readFile(permissionArmFile(logDir), 'utf8');
    return permissionArmSchema.parse(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

/**
 * True only the first time it's called for a session, so a blocked stop
 * can't loop: the agent gets one nudge, then is allowed to stop.
 */
export async function claimFirstStop(logDir: string, sessionId: string): Promise<boolean> {
  const dir = path.join(logDir, 'stop-markers');
  await mkdir(dir, { recursive: true });
  const safeId = sessionId.replace(/[^A-Za-z0-9_-]/g, '_');
  try {
    const handle = await open(path.join(dir, safeId), 'wx');
    await handle.close();
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
}

export async function armStop(logDir: string): Promise<void> {
  await mkdir(armDir(logDir), { recursive: true });
  await writeFile(stopArmFile(logDir), '');
}

export async function armPermission(logDir: string, arm: PermissionArm): Promise<void> {
  await mkdir(armDir(logDir), { recursive: true });
  await writeFile(permissionArmFile(logDir), JSON.stringify(permissionArmSchema.parse(arm)));
}

export async function disarmAll(logDir: string): Promise<void> {
  await rm(armDir(logDir), { recursive: true, force: true });
  await rm(path.join(logDir, 'stop-markers'), { recursive: true, force: true });
}

async function main(argv: string[]): Promise<void> {
  const logDir = logDirFrom();
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      seconds: { type: 'string', default: '120' },
      decision: { type: 'string', default: 'deny' },
    },
  });
  switch (positionals[0]) {
    case 'stop':
      await armStop(logDir);
      console.log('Armed: each session is blocked from stopping once.');
      break;
    case 'permission':
      await armPermission(logDir, {
        seconds: Number(values.seconds),
        decision: values.decision as PermissionArm['decision'],
      });
      console.log(`Armed: permission prompts wait ${values.seconds}s, then ${values.decision}.`);
      break;
    case 'off':
      await disarmAll(logDir);
      console.log('Disarmed: hooks only log.');
      break;
    case 'status':
      console.log({
        stop: await isStopArmed(logDir),
        permission: (await readPermissionArm(logDir)) ?? false,
      });
      break;
    default:
      throw new Error(
        'Usage: arm.ts stop | permission [--seconds N] [--decision allow|deny] | off | status',
      );
  }
}

if (import.meta.main) {
  await main(process.argv.slice(2));
}
