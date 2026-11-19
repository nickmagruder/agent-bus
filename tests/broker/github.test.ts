import { describe, expect, it } from 'vitest';
import { agentOf, createGitHubApi, GITHUB, isOwnPrUrl } from '../../src/broker/github.ts';

const REPO = 'octo/clankers';
const SINCE = new Date('2026-11-17T16:00:00Z');

interface FakePull {
  number: number;
  title?: string;
  merged_at: string | null;
  updated_at?: string;
  body?: string | null;
  user?: { login: string } | null;
  html_url?: string;
  base?: { ref: string; repo: { default_branch: string } | null };
}

function pull(p: FakePull) {
  return {
    title: `PR ${p.number}`,
    html_url: `https://github.com/${REPO}/pull/${p.number}`,
    updated_at: p.merged_at ?? '2026-11-18T00:00:00Z',
    body: null,
    user: { login: 'octocat' },
    base: { ref: 'main', repo: { default_branch: 'main' } },
    ...p,
  };
}

/** A fake `fetch` serving pages of PRs, recording each request. */
function fakeFetch(pages: unknown[][], status = 200) {
  const calls: { url: string; headers: Record<string, string>; signal: unknown }[] = [];
  const doFetch = (async (url: string, init?: RequestInit) => {
    calls.push({
      url,
      headers: (init?.headers ?? {}) as Record<string, string>,
      signal: init?.signal,
    });
    const page = Number(new URL(url).searchParams.get('page'));
    return new Response(JSON.stringify(pages[page - 1] ?? []), { status });
  }) as typeof fetch;
  return { doFetch, calls };
}

const list = (pages: unknown[][], repo = REPO) =>
  createGitHubApi({ fetch: fakeFetch(pages).doFetch }).mergedPullRequests(repo, SINCE);

describe('createGitHubApi', () => {
  it('returns PRs merged since the last digest, oldest first, with author and agent', async () => {
    const { doFetch, calls } = fakeFetch([
      [
        pull({
          number: 3,
          merged_at: '2026-11-18T10:00:00Z',
          body: 'Fix\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)',
        }),
        pull({ number: 2, merged_at: null }), // closed without merging
        pull({ number: 1, merged_at: '2026-11-17T20:00:00Z', user: { login: 'nick' } }),
        pull({ number: 0, merged_at: '2026-11-16T09:00:00Z' }), // before the last digest
      ],
    ]);
    const result = await createGitHubApi({ fetch: doFetch }).mergedPullRequests(REPO, SINCE);
    expect(result.prs).toEqual([
      expect.objectContaining({ number: 1, author: 'nick', agent: undefined }),
      expect.objectContaining({
        number: 3,
        repo: REPO,
        url: `https://github.com/${REPO}/pull/3`,
        agent: 'Claude Code',
      }),
    ]);
    expect(result).toMatchObject({ truncated: false, dropped: 0 });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(
      `${GITHUB.apiUrl}/repos/${REPO}/pulls?state=closed&sort=updated&direction=desc&per_page=${GITHUB.perPage}&page=1`,
    );
    expect(calls[0]?.signal).toBeInstanceOf(AbortSignal);
  });

  it('keeps a PR merged in the same second as the window start (GitHub has no ms)', async () => {
    const since = new Date('2026-11-17T16:00:00.400Z');
    const { doFetch } = fakeFetch([[pull({ number: 9, merged_at: '2026-11-17T16:00:00Z' })]]);
    const result = await createGitHubApi({ fetch: doFetch }).mergedPullRequests(REPO, since);
    expect(result.prs.map((p) => p.number)).toEqual([9]);
  });

  it('lists only PRs merged into the default branch', async () => {
    const result = await list([
      [
        pull({ number: 1, merged_at: '2026-11-18T10:00:00Z' }),
        pull({
          number: 2,
          merged_at: '2026-11-18T10:00:00Z',
          base: { ref: 'release/1.0', repo: { default_branch: 'main' } },
        }),
        pull({
          number: 3,
          merged_at: '2026-11-18T10:00:00Z',
          base: { ref: 'trunk', repo: { default_branch: 'trunk' } },
        }),
      ],
    ]);
    expect(result.prs.map((p) => p.number)).toEqual([1, 3]);
  });

  it('matches a repo configured in different case (GitHub answers in canonical case)', async () => {
    const result = await list(
      [[pull({ number: 4, merged_at: '2026-11-18T10:00:00Z' })]],
      'Octo/Clankers',
    );
    expect(result.prs.map((p) => p.number)).toEqual([4]);
    expect(result.dropped).toBe(0);
  });

  it("drops and counts a PR whose link isn't exactly this repo's own PR", async () => {
    const result = await list([
      [
        pull({
          number: 5,
          merged_at: '2026-11-18T10:00:00Z',
          html_url: 'https://evil.example/octo/clankers/pull/5',
        }),
        pull({
          number: 6,
          merged_at: '2026-11-18T10:00:00Z',
          html_url: 'https://github.com/other/repo/pull/6',
        }),
        pull({
          number: 7,
          merged_at: '2026-11-18T10:00:00Z',
          html_url: 'https://github.com/octo/clankers/pull/8', // another PR's link
        }),
      ],
    ]);
    expect(result.prs).toEqual([]);
    expect(result.dropped).toBe(3);
  });

  it('sends a token only when one is configured', async () => {
    const without = fakeFetch([[]]);
    await createGitHubApi({ fetch: without.doFetch }).mergedPullRequests(REPO, SINCE);
    expect(without.calls[0]?.headers.authorization).toBeUndefined();
    expect(without.calls[0]?.headers['user-agent']).toBe('agent-bus');

    const withToken = fakeFetch([[]]);
    await createGitHubApi({
      fetch: withToken.doFetch,
      token: 'github_pat_test',
    }).mergedPullRequests(REPO, SINCE);
    expect(withToken.calls[0]?.headers.authorization).toBe('Bearer github_pat_test');
  });

  it('reads further pages only while they still reach back to the last digest', async () => {
    const recent = (n: number) => pull({ number: n, merged_at: '2026-11-18T10:00:00Z' });
    const full = Array.from({ length: GITHUB.perPage }, (_, i) => recent(1000 + i));
    const { doFetch, calls } = fakeFetch([
      full,
      [recent(1), pull({ number: 0, merged_at: null, updated_at: '2026-11-10T00:00:00Z' })],
      [recent(99)],
    ]);
    const result = await createGitHubApi({ fetch: doFetch }).mergedPullRequests(REPO, SINCE);
    expect(calls).toHaveLength(2);
    expect(result.prs).toHaveLength(GITHUB.perPage + 1);
    expect(result.truncated).toBe(false);
  });

  it('says when it stopped at the page limit before reaching the window start', async () => {
    const page = (offset: number) =>
      Array.from({ length: GITHUB.perPage }, (_, i) =>
        pull({ number: offset + i, merged_at: '2026-11-18T10:00:00Z' }),
      );
    const { doFetch, calls } = fakeFetch([page(0), page(100), page(200), page(300)]);
    const result = await createGitHubApi({ fetch: doFetch }).mergedPullRequests(REPO, SINCE);
    expect(calls).toHaveLength(GITHUB.maxPages);
    expect(result.truncated).toBe(true);
  });

  it('lists a PR once even if it moved onto the next page between requests', async () => {
    const full = Array.from({ length: GITHUB.perPage }, (_, i) =>
      pull({ number: i, merged_at: '2026-11-18T10:00:00Z' }),
    );
    const result = await list([
      full,
      [full.at(-1), pull({ number: 999, merged_at: null, updated_at: '2026-11-01T00:00:00Z' })],
    ]);
    expect(result.prs).toHaveLength(GITHUB.perPage);
  });

  it('hints at the token when a repo is hidden from anonymous calls', async () => {
    const hidden = fakeFetch([[]], 404);
    await expect(
      createGitHubApi({ fetch: hidden.doFetch }).mergedPullRequests(REPO, SINCE),
    ).rejects.toThrow(
      'GitHub answered 404 for octo/clankers (private repo? set AGENT_BUS_GITHUB_TOKEN)',
    );
    await expect(
      createGitHubApi({ fetch: hidden.doFetch, token: 't' }).mergedPullRequests(REPO, SINCE),
    ).rejects.toThrow(/^GitHub answered 404 for octo\/clankers$/);
  });

  it.each([403, 429])('hints at rate limiting on %i', async (status) => {
    const limited = fakeFetch([[]], status);
    await expect(
      createGitHubApi({ fetch: limited.doFetch, token: 'secret-token' }).mergedPullRequests(
        REPO,
        SINCE,
      ),
    ).rejects.toThrow(
      `GitHub answered ${status} for octo/clankers (rate limited? try again later)`,
    );
  });

  it('throws on a bad repo name or a malformed answer, never echoing the token', async () => {
    await expect(
      createGitHubApi({ fetch: fakeFetch([[]]).doFetch }).mergedPullRequests('octo/..', SINCE),
    ).rejects.toThrow('not a GitHub repo name');
    const malformed = fakeFetch([[{ number: 'one' }]]);
    const failure = createGitHubApi({
      fetch: malformed.doFetch,
      token: 'secret-token',
    }).mergedPullRequests(REPO, SINCE);
    await expect(failure).rejects.toThrow();
    await failure.catch((error: unknown) => {
      expect(String(error)).not.toContain('secret-token');
    });
  });

  it('gives up after its timeout', async () => {
    const hanging = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason as Error));
      })) as typeof fetch;
    await expect(
      createGitHubApi({ fetch: hanging, timeoutMs: 20 }).mergedPullRequests(REPO, SINCE),
    ).rejects.toThrow();
  });
});

describe('agentOf', () => {
  it.each([
    [
      'Body\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)',
      'nick',
      'Claude Code',
    ],
    // The footer still counts with lines after it.
    [
      'Body\n\n🤖 Generated with [Claude Code](https://x)\n\nCo-authored-by: a\nb\nc',
      'nick',
      'Claude Code',
    ],
    ['Body\n\nhttps://chatgpt.com/codex/tasks/task_e_123', 'nick', 'Codex'],
    ['Codex task: (https://chatgpt.com/codex/tasks/task_e_123).', 'nick', 'Codex'],
    // The link must be the host itself, not part of another URL or a lookalike host.
    ['See https://evil.example/?u=https://chatgpt.com/codex/tasks/x', 'nick', undefined],
    ['See https://chatgpt.com.evil.example/codex/tasks/x', 'nick', undefined],
    ['See http://chatgpt.com/codex/tasks/x', 'nick', undefined],
    ['See https://chatgpt.com/c/123', 'nick', undefined],
    ['Body', 'Copilot', 'Copilot'],
    ['Body', 'copilot-swe-agent[bot]', 'Copilot'],
    ['A plain human PR', 'nick', undefined],
    [null, 'nick', undefined],
  ])('%j by %s → %s', (body, author, agent) => {
    expect(agentOf(body, author)).toBe(agent);
  });

  it.each([
    'Thanks!\n\nNo Copilot review requested (quota).',
    'Also works with Codex now.',
    'This replaces the Codex wiring and the Copilot hooks.',
  ])('a human PR that mentions an agent is not attributed to it: %j', (body) => {
    expect(agentOf(body, 'nick')).toBeUndefined();
  });
});

describe('isOwnPrUrl', () => {
  it.each([
    ['https://github.com/octo/clankers/pull/5', 'octo/clankers', 5, true],
    ['https://github.com/Octo/Clankers/pull/5', 'octo/clankers', 5, true],
    ['https://github.com/octo/clankers/pull/5', 'OCTO/CLANKERS', 5, true],
    ['https://github.com/octo/clankers/pull/6', 'octo/clankers', 5, false],
    ['https://github.com/octo/clankers/pull/5/files', 'octo/clankers', 5, false],
    ['https://github.com/octo/clankers/pull/5?x=1', 'octo/clankers', 5, false],
    ['http://github.com/octo/clankers/pull/5', 'octo/clankers', 5, false],
    ['https://github.com.evil.example/octo/clankers/pull/5', 'octo/clankers', 5, false],
    ['https://user@github.com/octo/clankers/pull/5', 'octo/clankers', 5, false],
    ['not a url', 'octo/clankers', 5, false],
  ] as const)('%s for %s#%i → %s', (url, repo, number, own) => {
    expect(isOwnPrUrl(url, repo, number)).toBe(own);
  });
});
