import { describe, expect, it } from 'vitest';
import { agentFromBody, createGitHubApi, GITHUB } from '../../src/broker/github.ts';

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
}

function pull(p: FakePull) {
  return {
    title: `PR ${p.number}`,
    html_url: `https://github.com/${REPO}/pull/${p.number}`,
    updated_at: p.merged_at ?? '2026-11-18T00:00:00Z',
    body: null,
    user: { login: 'octocat' },
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
    const prs = await createGitHubApi({ fetch: doFetch }).mergedPullRequests(REPO, SINCE);
    expect(prs).toEqual([
      expect.objectContaining({ number: 1, author: 'nick', agent: undefined }),
      expect.objectContaining({
        number: 3,
        repo: REPO,
        url: `https://github.com/${REPO}/pull/3`,
        agent: 'Claude Code',
      }),
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(
      `${GITHUB.apiUrl}/repos/${REPO}/pulls?state=closed&sort=updated&direction=desc&per_page=${GITHUB.perPage}&page=1`,
    );
    expect(calls[0]?.signal).toBeInstanceOf(AbortSignal);
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
    const recent = (n: number) =>
      pull({ number: n, merged_at: '2026-11-18T10:00:00Z', updated_at: '2026-11-18T10:00:00Z' });
    const full = Array.from({ length: GITHUB.perPage }, (_, i) => recent(1000 + i));
    const { doFetch, calls } = fakeFetch([
      full,
      [recent(1), pull({ number: 0, merged_at: null, updated_at: '2026-11-10T00:00:00Z' })],
      [recent(99)],
    ]);
    const prs = await createGitHubApi({ fetch: doFetch }).mergedPullRequests(REPO, SINCE);
    expect(calls).toHaveLength(2);
    expect(prs).toHaveLength(GITHUB.perPage + 1);
  });

  it('stops after maxPages', async () => {
    const recent = Array.from({ length: GITHUB.perPage }, (_, i) =>
      pull({ number: i, merged_at: '2026-11-18T10:00:00Z' }),
    );
    const { doFetch, calls } = fakeFetch([recent, recent, recent, recent, recent]);
    await createGitHubApi({ fetch: doFetch }).mergedPullRequests(REPO, SINCE);
    expect(calls).toHaveLength(GITHUB.maxPages);
  });

  it("drops a PR whose link isn't this repo's own PR URL", async () => {
    const { doFetch } = fakeFetch([
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
      ],
    ]);
    expect(await createGitHubApi({ fetch: doFetch }).mergedPullRequests(REPO, SINCE)).toEqual([]);
  });

  it('throws on an error status, a bad repo name or a malformed answer', async () => {
    const failing = fakeFetch([[]], 403);
    await expect(
      createGitHubApi({ fetch: failing.doFetch }).mergedPullRequests(REPO, SINCE),
    ).rejects.toThrow('GitHub answered 403 for octo/clankers');
    await expect(
      createGitHubApi({ fetch: fakeFetch([[]]).doFetch }).mergedPullRequests('../../x', SINCE),
    ).rejects.toThrow('not a GitHub repo name');
    const malformed = fakeFetch([[{ number: 'one' }]]);
    await expect(
      createGitHubApi({ fetch: malformed.doFetch }).mergedPullRequests(REPO, SINCE),
    ).rejects.toThrow();
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

describe('agentFromBody', () => {
  it.each([
    ['Body\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)', 'Claude Code'],
    ['Body\n\nCreated by Codex', 'Codex'],
    ['Body\n\nOpened by GitHub Copilot', 'Copilot'],
    ['A plain human PR', undefined],
    [null, undefined],
  ])('%j → %s', (body, agent) => {
    expect(agentFromBody(body)).toBe(agent);
  });

  it('reads only the footer, not a mention in the text', () => {
    const body = 'This replaces the Codex wiring.\n\nLine 2\nLine 3\nLine 4\nThanks!';
    expect(agentFromBody(body)).toBeUndefined();
  });
});
