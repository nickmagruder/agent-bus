import path from 'node:path';
import { z } from 'zod';

export const DEFAULT_PORT = 47823;

/** Repo root, so hook commands work whatever the caller's working directory. */
export const repoRoot = path.resolve(import.meta.dirname, '..', '..');

export function logDirFrom(env: NodeJS.ProcessEnv = process.env): string {
  return env.AGENT_BUS_LOG_DIR ?? path.join(repoRoot, 'spike-logs');
}

const serverEnvSchema = z.object({
  AGENT_BUS_TOKEN: z
    .string({ error: 'AGENT_BUS_TOKEN is not set (open a new terminal after setting it)' })
    .min(32, 'AGENT_BUS_TOKEN must be at least 32 characters'),
  AGENT_BUS_PORT: z.coerce.number().int().min(0).max(65535).default(DEFAULT_PORT),
});

export interface ServerConfig {
  token: string;
  port: number;
  logDir: string;
}

export function loadServerConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const parsed = serverEnvSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid environment:\n${z.prettifyError(parsed.error)}`);
  }
  return {
    token: parsed.data.AGENT_BUS_TOKEN,
    port: parsed.data.AGENT_BUS_PORT,
    logDir: logDirFrom(env),
  };
}
