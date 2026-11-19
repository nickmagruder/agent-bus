import { z } from 'zod';
import { REPO_PATTERN } from '../shared/config.ts';

/** A pull request merged into a repo's default branch. */
export interface MergedPr {
  repo: string;
  number: number;
  title: string;
  url: string;
  author: string;
  /** The coding agent that opened it, from the PR body's footer, when it says. */
  agent: string | undefined;
  mergedAt: string;
}

/** Read-only GitHub access for the digest (replaced by a fake in tests). */
export interface GitHubApi {
  mergedPullRequests(repo: string, since: Date): Promise<MergedPr[]>;
}

export const GITHUB = {
  apiUrl: 'https://api.github.com',
  timeoutMs: 10_000,
  perPage: 50,
  /** Pages of recently updated closed PRs to scan; plenty for one day. */
  maxPages: 3,
} as const;

const pullSchema = z.object({
  number: z.number().int(),
  title: z.string(),
  html_url: z.string(),
  merged_at: z.string().nullable(),
  updated_at: z.string(),
  body: z.string().nullable().optional(),
  user: z.object({ login: z.string() }).nullable(),
});

/** "Generated with [Claude Code]" and similar footers agents add to PR bodies. */
const AGENT_FOOTERS: readonly [RegExp, string][] = [
  [/generated with \[?claude code/i, 'Claude Code'],
  [/\bcodex\b/i, 'Codex'],
  [/\bcopilot\b/i, 'Copilot'],
];

export function agentFromBody(body: string | null | undefined): string | undefined {
  if (!body) return undefined;
  // Only the last lines: a PR that merely mentions Codex in its text isn't by Codex.
  const footer = body.trim().split('\n').slice(-3).join('\n');
  return AGENT_FOOTERS.find(([pattern]) => pattern.test(footer))?.[1];
}

/**
 * GitHub's REST API over `fetch`. With a token (a fine-grained, read-only
 * one is enough) it can read private repos; without one it reads public
 * repos within GitHub's anonymous rate limit, which one digest a day fits.
 */
export function createGitHubApi(
  options: { token?: string | undefined; fetch?: typeof fetch; timeoutMs?: number } = {},
): GitHubApi {
  const doFetch = options.fetch ?? fetch;
  const headers: Record<string, string> = {
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': 'agent-bus',
  };
  if (options.token) headers.authorization = `Bearer ${options.token}`;

  return {
    async mergedPullRequests(repo, since) {
      if (!REPO_PATTERN.test(repo)) throw new Error(`not a GitHub repo name: ${repo}`);
      const merged: MergedPr[] = [];
      for (let page = 1; page <= GITHUB.maxPages; page++) {
        const url =
          `${GITHUB.apiUrl}/repos/${repo}/pulls?state=closed&sort=updated&direction=desc` +
          `&per_page=${GITHUB.perPage}&page=${page}`;
        const response = await doFetch(url, {
          headers,
          signal: AbortSignal.timeout(options.timeoutMs ?? GITHUB.timeoutMs),
        });
        if (!response.ok) throw new Error(`GitHub answered ${response.status} for ${repo}`);
        const pulls = z.array(pullSchema).parse(await response.json());
        for (const pull of pulls) {
          if (!pull.merged_at || new Date(pull.merged_at) < since) continue;
          // Links in the digest only ever point at this repo's PRs.
          if (!pull.html_url.startsWith(`https://github.com/${repo}/pull/`)) continue;
          merged.push({
            repo,
            number: pull.number,
            title: pull.title,
            url: pull.html_url,
            author: pull.user?.login ?? 'unknown',
            agent: agentFromBody(pull.body),
            mergedAt: pull.merged_at,
          });
        }
        // Sorted by last update: once a page reaches back past `since`, stop.
        const oldest = pulls.at(-1);
        if (pulls.length < GITHUB.perPage || !oldest || new Date(oldest.updated_at) < since) break;
      }
      return merged.sort((a, b) => a.mergedAt.localeCompare(b.mergedAt));
    },
  };
}
