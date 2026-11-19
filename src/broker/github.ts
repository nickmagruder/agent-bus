import { z } from 'zod';
import { REPO_PATTERN } from '../shared/config.ts';

/** A pull request merged into its repo's default branch. */
export interface MergedPr {
  repo: string;
  number: number;
  title: string;
  url: string;
  author: string;
  /** The coding agent that opened it, when the PR says so (see agentOf). */
  agent: string | undefined;
  mergedAt: string;
}

/** One repo's merged PRs, and what the client couldn't show. */
export interface MergedPrs {
  prs: MergedPr[];
  /** The page limit was reached before the window's start: older PRs are missing. */
  truncated: boolean;
  /** PRs left out because their link wasn't the repo's own PR URL. */
  dropped: number;
}

/** Read-only GitHub access for the digest (replaced by a fake in tests). */
export interface GitHubApi {
  mergedPullRequests(repo: string, since: Date): Promise<MergedPrs>;
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
  base: z.object({
    ref: z.string(),
    repo: z.object({ default_branch: z.string() }).nullable(),
  }),
});

type Pull = z.infer<typeof pullSchema>;

/**
 * The coding agent behind a PR, from markers the agents themselves add:
 * Claude Code's "Generated with [Claude Code]" footer, the Codex cloud task
 * link, or the Copilot coding agent's own GitHub account. A PR that only
 * mentions Codex or Copilot in its text isn't attributed to them.
 */
export function agentOf(
  body: string | null | undefined,
  author: string | undefined,
): string | undefined {
  if (author && /^copilot(-swe-agent\[bot\])?$/i.test(author)) return 'Copilot';
  if (!body) return undefined;
  if (/generated with \[claude code\]/i.test(body)) return 'Claude Code';
  if (linksIn(body).some(isCodexTaskLink)) return 'Codex';
  return undefined;
}

/** The http(s) links in a text, parsed; anything that isn't a valid URL is skipped. */
function linksIn(text: string): URL[] {
  const links: URL[] = [];
  for (const [candidate] of text.matchAll(/https?:\/\/[^\s)<>\]"']+/gi)) {
    try {
      links.push(new URL(candidate));
    } catch {
      // not a URL after all
    }
  }
  return links;
}

/** A Codex cloud task link: exactly chatgpt.com, under /codex/tasks/. */
function isCodexTaskLink(link: URL): boolean {
  return (
    link.protocol === 'https:' &&
    link.host === 'chatgpt.com' &&
    link.pathname.startsWith('/codex/tasks/')
  );
}

/**
 * Whether `url` is exactly this repo's page for PR `number`. GitHub answers
 * with the repo's canonical case, and owner/name are case-insensitive.
 */
export function isOwnPrUrl(url: string, repo: string, number: number): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return (
    parsed.protocol === 'https:' &&
    parsed.host === 'github.com' &&
    parsed.username === '' &&
    parsed.password === '' &&
    parsed.search === '' &&
    parsed.hash === '' &&
    parsed.pathname.toLowerCase() === `/${repo.toLowerCase()}/pull/${number}`
  );
}

/** Whole seconds: GitHub's timestamps have no milliseconds. */
function toSecond(date: Date): number {
  return Math.floor(date.getTime() / 1000) * 1000;
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

  const fetchPage = async (repo: string, page: number): Promise<Pull[]> => {
    const url =
      `${GITHUB.apiUrl}/repos/${repo}/pulls?state=closed&sort=updated&direction=desc` +
      `&per_page=${GITHUB.perPage}&page=${page}`;
    const response = await doFetch(url, {
      headers,
      signal: AbortSignal.timeout(options.timeoutMs ?? GITHUB.timeoutMs),
    });
    if (!response.ok) {
      throw new Error(
        `GitHub answered ${response.status} for ${repo}${statusHint(response.status)}`,
      );
    }
    return z.array(pullSchema).parse(await response.json());
  };

  const statusHint = (status: number): string => {
    // GitHub hides private repos from anonymous callers behind a 404.
    if (status === 404 && !options.token) return ' (private repo? set AGENT_BUS_GITHUB_TOKEN)';
    if (status === 403 || status === 429) return ' (rate limited? try again later)';
    return '';
  };

  return {
    async mergedPullRequests(repo, since) {
      if (!REPO_PATTERN.test(repo)) throw new Error(`not a GitHub repo name: ${repo}`);
      const from = toSecond(since);
      const merged = new Map<number, MergedPr>();
      let dropped = 0;
      let truncated = false;
      for (let page = 1; page <= GITHUB.maxPages; page++) {
        const pulls = await fetchPage(repo, page);
        for (const pull of pulls) {
          if (!pull.merged_at || Date.parse(pull.merged_at) < from) continue;
          // Only what landed on the default branch (main), as the digest promises.
          if (pull.base.repo && pull.base.ref !== pull.base.repo.default_branch) continue;
          // Links in the digest only ever point at this repo's own PRs.
          if (!isOwnPrUrl(pull.html_url, repo, pull.number)) {
            dropped++;
            continue;
          }
          // A PR updated between page requests can appear on two pages.
          merged.set(pull.number, {
            repo,
            number: pull.number,
            title: pull.title,
            url: pull.html_url,
            author: pull.user?.login ?? 'unknown',
            agent: agentOf(pull.body, pull.user?.login),
            mergedAt: pull.merged_at,
          });
        }
        // Sorted by last update, and a PR merged in the window was updated in
        // it too: once a page reaches back past `since`, nothing is left.
        const oldest = pulls.at(-1);
        const reachedStart = !oldest || Date.parse(oldest.updated_at) < from;
        if (pulls.length < GITHUB.perPage || reachedStart) break;
        if (page === GITHUB.maxPages) truncated = true;
      }
      const prs = [...merged.values()].sort((a, b) => a.mergedAt.localeCompare(b.mergedAt));
      return { prs, truncated, dropped };
    },
  };
}
