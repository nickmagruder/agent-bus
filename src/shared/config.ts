import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { PLATFORMS, type Platform } from './platform.ts';

export const DEFAULT_PORT = 47823;

/** A GitHub repo as `owner/name`. */
export const REPO_PATTERN = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;

/** `AGENT_BUS_DIGEST_REPOS`: comma-separated `owner/name` list. */
const repoList = z
  .string()
  .optional()
  .transform((value) =>
    (value ?? '')
      .split(',')
      .map((repo) => repo.trim())
      .filter((repo) => repo.length > 0),
  )
  .refine(
    (repos) => repos.every((repo) => REPO_PATTERN.test(repo)),
    'AGENT_BUS_DIGEST_REPOS must be comma-separated owner/name repos',
  );

const platformToken = (name: string) =>
  z
    .string({ error: `${name} is not set (open a new terminal after setting it)` })
    .min(32, `${name} must be at least 32 characters`);

const envSchema = z
  .object({
    SLACK_BOT_TOKEN: z
      .string({ error: 'SLACK_BOT_TOKEN is not set' })
      .startsWith('xoxb-', 'SLACK_BOT_TOKEN must be a bot token (xoxb-…)'),
    SLACK_APP_TOKEN: z
      .string({ error: 'SLACK_APP_TOKEN is not set' })
      .startsWith('xapp-', 'SLACK_APP_TOKEN must be an app-level token (xapp-…)'),
    SLACK_USER_ID: z
      .string({ error: 'SLACK_USER_ID is not set (Slack profile › ⋮ › Copy member ID)' })
      .regex(/^[UW][A-Z0-9]{6,}$/, 'SLACK_USER_ID must be a Slack member ID like U0123ABCD'),
    AGENT_BUS_TOKEN_CLAUDE: platformToken('AGENT_BUS_TOKEN_CLAUDE'),
    AGENT_BUS_TOKEN_CODEX: platformToken('AGENT_BUS_TOKEN_CODEX'),
    AGENT_BUS_TOKEN_COPILOT: platformToken('AGENT_BUS_TOKEN_COPILOT'),
    AGENT_BUS_PORT: z.coerce.number().int().min(0).max(65535).default(DEFAULT_PORT),
    AGENT_BUS_DATA_DIR: z.string().min(1).optional(),
    AGENT_BUS_DIGEST_REPOS: repoList,
    AGENT_BUS_GITHUB_TOKEN: z.string().min(1).optional(),
    LOCALAPPDATA: z.string().optional(),
  })
  .refine(
    (env) =>
      new Set([env.AGENT_BUS_TOKEN_CLAUDE, env.AGENT_BUS_TOKEN_CODEX, env.AGENT_BUS_TOKEN_COPILOT])
        .size === PLATFORMS.length,
    // Identity comes from the token, so two platforms sharing one would be indistinguishable.
    'Each AGENT_BUS_TOKEN_<PLATFORM> must be different',
  );

export interface BrokerConfig {
  port: number;
  dataDir: string;
  /** Bearer token per platform; the token a caller presents decides its platform. */
  tokens: Record<Platform, string>;
  slack: { botToken: string; appToken: string; userId: string };
  /** Repos whose merged PRs the daily digest lists; a read-only token for private ones. */
  github?: { repos: string[]; token?: string | undefined };
}

export function defaultDataDir(localAppData: string | undefined): string {
  return path.join(localAppData ?? path.join(os.homedir(), '.local', 'share'), 'agent-bus');
}

/** Validates the environment. Error messages name variables, never their values. */
export function loadBrokerConfig(env: NodeJS.ProcessEnv = process.env): BrokerConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid environment:\n${z.prettifyError(parsed.error)}`);
  }
  const e = parsed.data;
  return {
    port: e.AGENT_BUS_PORT,
    dataDir: e.AGENT_BUS_DATA_DIR ?? defaultDataDir(e.LOCALAPPDATA),
    tokens: {
      claude: e.AGENT_BUS_TOKEN_CLAUDE,
      codex: e.AGENT_BUS_TOKEN_CODEX,
      copilot: e.AGENT_BUS_TOKEN_COPILOT,
    },
    slack: { botToken: e.SLACK_BOT_TOKEN, appToken: e.SLACK_APP_TOKEN, userId: e.SLACK_USER_ID },
    github: { repos: e.AGENT_BUS_DIGEST_REPOS, token: e.AGENT_BUS_GITHUB_TOKEN },
  };
}
