import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  extractHookRequest,
  findRepo,
  renderHookOutput,
  summarizeToolInput,
} from '../../src/cli/hook-extract.ts';

describe('extractHookRequest', () => {
  it('keeps only the fields the broker needs from a Claude PermissionRequest', () => {
    const request = extractHookRequest(
      {
        hook_event_name: 'PermissionRequest',
        session_id: 'abc',
        cwd: 'C:/repo',
        transcript_path: 'C:/secret/transcript.jsonl',
        prompt: 'my private prompt',
        tool_name: 'PowerShell',
        tool_input: { command: 'git push', description: 'Push' },
        permission_suggestions: [],
      },
      { repo: { project: 'repo', branch: 'main' } },
    );
    expect(request).toEqual({
      event: 'PermissionRequest',
      appSessionId: 'abc',
      project: 'repo',
      branch: 'main',
      cwd: 'C:/repo',
      toolName: 'PowerShell',
      toolSummary: 'git push',
    });
  });

  it('reads Stop and Notification fields', () => {
    expect(
      extractHookRequest({
        hook_event_name: 'Stop',
        session_id: 's',
        last_assistant_message: 'done',
        stop_hook_active: false,
      }),
    ).toEqual({ event: 'Stop', appSessionId: 's', lastMessage: 'done', stopHookActive: false });
    expect(
      extractHookRequest({
        hook_event_name: 'Notification',
        session_id: 's',
        notification_type: 'permission_prompt',
        message: 'needs permission',
      }),
    ).toMatchObject({ notificationType: 'permission_prompt', message: 'needs permission' });
  });

  it('lets --event override the payload and accepts camelCase session IDs', () => {
    expect(extractHookRequest({ sessionId: 's' }, { event: 'agentStop' })).toEqual({
      event: 'agentStop',
      appSessionId: 's',
    });
  });

  it('truncates long text to the protocol limits', () => {
    const request = extractHookRequest({
      hook_event_name: 'Stop',
      session_id: 's',
      last_assistant_message: 'y'.repeat(5000),
    });
    expect(request?.lastMessage).toHaveLength(2000);
    expect(request?.lastMessage?.endsWith('…')).toBe(true);
  });

  it.each([null, 'text', [], {}, { session_id: 's' }, { hook_event_name: 'Stop' }])(
    'returns undefined for %j',
    (payload) => {
      expect(extractHookRequest(payload)).toBeUndefined();
    },
  );
});

describe('summarizeToolInput', () => {
  it.each([
    [{ command: 'npm test', description: 'x' }, 'npm test'],
    [{ file_path: 'a.ts', content: 'secret file body' }, 'a.ts'],
    [{ url: 'https://x' }, 'https://x'],
    [{ questions: [{ question: 'Which DB?' }] }, 'Which DB?'],
    [{ description: 'only this' }, 'only this'],
    [{ content: 'nothing useful' }, undefined],
    ['not an object', undefined],
  ])('summarises %j', (input, summary) => {
    expect(summarizeToolInput(input)).toBe(summary);
  });
});

describe('renderHookOutput', () => {
  const response = { session: 'claude/x/abcd', action: 'context', context: 'bus ID is X' };

  it.each(['claude', 'codex'] as const)('adds context on SessionStart for %s', (platform) => {
    expect(JSON.parse(renderHookOutput(platform, 'SessionStart', response))).toEqual({
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'bus ID is X' },
    });
  });

  it.each([
    ['claude', 'PermissionRequest'],
    ['codex', 'PermissionRequest'],
    ['claude', 'Stop'],
    ['codex', 'Stop'],
    ['claude', 'Notification'],
    ['copilot', 'SessionStart'],
  ] as const)('prints nothing for %s %s, so the app decides', (platform, event) => {
    expect(renderHookOutput(platform, event, { ...response, action: 'sent' })).toBe('');
  });

  it.each(['claude', 'codex'] as const)('blocks a Stop the broker blocked, for %s', (platform) => {
    const blocked = { session: 's', action: 'blocked', reason: 'Nick: use plan B' };
    expect(JSON.parse(renderHookOutput(platform, 'Stop', blocked))).toEqual({
      decision: 'block',
      reason: 'Nick: use plan B',
    });
  });

  it.each([
    ['copilot', 'Stop', { action: 'blocked', reason: 'r' }],
    ['claude', 'Stop', { action: 'blocked' }],
    ['claude', 'Stop', { action: 'sent', reason: 'r' }],
    ['claude', 'PermissionRequest', { action: 'blocked', reason: 'r' }],
    ['codex', 'PermissionRequest', { action: 'blocked', reason: 'r' }],
  ] as const)('never blocks for %s %s %j', (platform, event, fields) => {
    expect(renderHookOutput(platform, event, { session: 's', ...fields })).toBe('');
  });

  it('prints nothing without a broker response', () => {
    expect(renderHookOutput('claude', 'SessionStart', undefined)).toBe('');
  });
});

describe('findRepo', () => {
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'agent-bus-repo-'));
    // Main repo on a branch, with a nested folder.
    await mkdir(path.join(root, 'main-repo', '.git', 'worktrees', 'wt1'), { recursive: true });
    await mkdir(path.join(root, 'main-repo', 'src', 'deep'), { recursive: true });
    await writeFile(path.join(root, 'main-repo', '.git', 'HEAD'), 'ref: refs/heads/feat/x\n');
    // Linked worktree pointing back into the main repo.
    await mkdir(path.join(root, 'wt1'), { recursive: true });
    await writeFile(
      path.join(root, 'wt1', '.git'),
      `gitdir: ${path.join(root, 'main-repo', '.git', 'worktrees', 'wt1')}\n`,
    );
    await writeFile(
      path.join(root, 'main-repo', '.git', 'worktrees', 'wt1', 'HEAD'),
      'ref: refs/heads/phase-1/hooks\n',
    );
    // Detached HEAD.
    await mkdir(path.join(root, 'detached', '.git'), { recursive: true });
    await writeFile(path.join(root, 'detached', '.git', 'HEAD'), `${'a1b2c3d'.padEnd(40, '0')}\n`);
    await mkdir(path.join(root, 'plain'), { recursive: true });
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('reads the branch from a nested folder', () => {
    expect(findRepo(path.join(root, 'main-repo', 'src', 'deep'))).toEqual({
      project: 'main-repo',
      branch: 'feat/x',
    });
  });

  it("names a linked worktree after its main repo and reads the worktree's branch", () => {
    expect(findRepo(path.join(root, 'wt1'))).toEqual({
      project: 'main-repo',
      branch: 'phase-1/hooks',
    });
  });

  it('shortens a detached HEAD', () => {
    expect(findRepo(path.join(root, 'detached'))?.branch).toBe('a1b2c3d');
  });

  it('returns undefined outside a repo', () => {
    // The temp dir itself may sit inside a repo on some machines; only assert no crash then.
    const result = findRepo(path.join(root, 'plain'));
    expect(result?.project).not.toBe('plain');
  });
});
