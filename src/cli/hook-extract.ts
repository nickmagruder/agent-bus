import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { HOOK_LIMITS, type HookRequest, type HookResponse } from '../shared/hook-protocol.ts';
import type { Platform } from '../shared/platform.ts';

type Payload = Record<string, unknown>;

/**
 * Picks the fields the broker needs out of an app's hook payload. Prompts,
 * transcripts and full tool input never leave the machine's hook process
 * except as a short tool summary or message snippet.
 */
export function extractHookRequest(
  payload: unknown,
  options: { event?: string | undefined; repo?: RepoInfo | undefined } = {},
): HookRequest | undefined {
  if (!isRecord(payload)) return undefined;
  const event = options.event ?? str(payload.hook_event_name);
  const appSessionId = str(payload.session_id) ?? str(payload.sessionId);
  if (!event || !appSessionId) return undefined;

  const toolName = str(payload.tool_name);
  const request: HookRequest = {
    event: event.slice(0, 64),
    appSessionId: appSessionId.slice(0, HOOK_LIMITS.id),
    project: clip(options.repo?.project, HOOK_LIMITS.name),
    branch: clip(options.repo?.branch, HOOK_LIMITS.name),
    cwd: clip(str(payload.cwd), HOOK_LIMITS.path),
    source: clip(str(payload.source), 40),
    notificationType: clip(str(payload.notification_type), 60),
    message: clip(str(payload.message), HOOK_LIMITS.text),
    toolName: clip(toolName, HOOK_LIMITS.name),
    toolSummary: clip(summarizeToolInput(payload.tool_input), HOOK_LIMITS.text),
    lastMessage: clip(str(payload.last_assistant_message), HOOK_LIMITS.text),
    stopHookActive:
      typeof payload.stop_hook_active === 'boolean' ? payload.stop_hook_active : undefined,
  };
  return Object.fromEntries(
    Object.entries(request).filter(([, value]) => value !== undefined),
  ) as HookRequest;
}

/** Arguments never shown in a summary: likely secrets, or bulky bodies. */
const HIDDEN_ARGUMENT =
  /token|secret|password|passwd|api[_-]?key|auth|cookie|credential|content|body/i;
const ARGUMENT_CHARS = 80;
const MAX_ARGUMENTS = 3;

/**
 * The one line of a tool call I'd need to approve it: the command, file or
 * question; otherwise (MCP and other tools) up to three short scalar
 * arguments as `name: value`.
 */
export function summarizeToolInput(input: unknown): string | undefined {
  if (!isRecord(input)) return undefined;
  for (const key of ['command', 'file_path', 'path', 'url', 'pattern']) {
    const value = str(input[key]);
    if (value) return value;
  }
  const questions = input.questions;
  if (Array.isArray(questions) && isRecord(questions[0])) {
    const question = str(questions[0].question);
    if (question) return question;
  }
  return str(input.description) ?? summarizeArguments(input);
}

function summarizeArguments(input: Payload): string | undefined {
  const parts: string[] = [];
  for (const [name, value] of Object.entries(input)) {
    if (parts.length >= MAX_ARGUMENTS) break;
    if (HIDDEN_ARGUMENT.test(name)) continue;
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
      continue;
    }
    const text = String(value).replace(/\s+/g, ' ').trim();
    if (text) parts.push(`${name}: ${clip(text, ARGUMENT_CHARS)}`);
  }
  return parts.length > 0 ? parts.join('; ') : undefined;
}

/**
 * What the hook prints for the app. SessionStart adds the agent's bus ID as
 * context; a Stop the broker `blocked` prints `decision: block` with my Slack
 * replies as the reason, so the agent keeps going. Everything else prints
 * nothing: permission prompts are never answered from here.
 */
export function renderHookOutput(
  platform: Platform,
  event: string,
  response: HookResponse | undefined,
): string {
  // Copilot desktop hooks don't run (Phase 0); Claude Code and Codex share these shapes.
  if (!response || platform === 'copilot') return '';
  if (event === 'SessionStart' && response.context) {
    return JSON.stringify({
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: response.context },
    });
  }
  if (event === 'Stop' && response.action === 'blocked' && response.reason) {
    return JSON.stringify({ decision: 'block', reason: response.reason });
  }
  return '';
}

export interface RepoInfo {
  project: string;
  branch: string | undefined;
}

/**
 * Finds the git repo containing `cwd` and reads its branch from HEAD without
 * running git. In a linked worktree the project is the main repo's folder.
 */
export function findRepo(cwd: string): RepoInfo | undefined {
  let dir = path.resolve(cwd);
  for (let depth = 0; depth < 40; depth++) {
    const dotGit = path.join(dir, '.git');
    const kind = statKind(dotGit);
    if (kind === 'dir') {
      return { project: path.basename(dir), branch: readBranch(dotGit) };
    }
    if (kind === 'file') {
      const gitDir = readGitDirPointer(dotGit, dir);
      if (!gitDir) return { project: path.basename(dir), branch: undefined };
      const worktrees = `${path.sep}.git${path.sep}worktrees${path.sep}`;
      const at = gitDir.indexOf(worktrees);
      const project = at >= 0 ? path.basename(gitDir.slice(0, at)) : path.basename(dir);
      return { project, branch: readBranch(gitDir) };
    }
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
  return undefined;
}

function readBranch(gitDir: string): string | undefined {
  try {
    const head = readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
    const ref = /^ref: refs\/heads\/(.+)$/.exec(head);
    if (ref) return ref[1];
    return /^[0-9a-f]{40}$/.test(head) ? head.slice(0, 7) : undefined;
  } catch {
    return undefined;
  }
}

function readGitDirPointer(dotGitFile: string, dir: string): string | undefined {
  try {
    const match = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGitFile, 'utf8'));
    return match?.[1] ? path.resolve(dir, match[1].trim()) : undefined;
  } catch {
    return undefined;
  }
}

function statKind(file: string): 'dir' | 'file' | undefined {
  try {
    const stat = statSync(file);
    return stat.isDirectory() ? 'dir' : stat.isFile() ? 'file' : undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Payload {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function clip(value: string | undefined, max: number): string | undefined {
  if (value === undefined) return undefined;
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}
