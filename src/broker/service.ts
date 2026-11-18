import { PLATFORM_STYLE, type Platform } from '../shared/platform.ts';
import { newSessionId, NO_PROJECT, projectSlug } from '../shared/session-id.ts';
import { escapeSlackText, toSlackMrkdwn } from '../shared/slack-text.ts';
import { FALLBACK_CHANNEL } from './slack/directory.ts';
import { DM_TARGET, found, type SessionRecord, type Store } from './store.ts';

export const URGENCIES = ['urgent', 'normal', 'fyi'] as const;
export type Urgency = (typeof URGENCIES)[number];

/** Per-hour caps that stop a looping agent from flooding Slack or my DMs. */
export const LIMITS = {
  /** Sessions an agent may create through `register` (hooks create theirs from app sessions). */
  registerPerPlatform: 30,
  notifyPerSession: 60,
  urgentPerSession: 10,
} as const;

/** Minimum gap between hook pings of one kind for one session. */
export const HOOK_THROTTLE_MS = {
  /** Permission prompts often come in bursts; one DM brings me to the app. */
  permission: 2 * 60_000,
  /** Stop fires after every turn; one "waiting for you" per stretch is enough. */
  stop: 10 * 60_000,
} as const;

const HOUR_MS = 60 * 60_000;
const SNIPPET_CHARS = 300;

export type BusErrorCode = 'unknown_session' | 'wrong_platform' | 'rate_limited';

/** An error the calling agent should see and can act on. */
export class BusError extends Error {
  readonly code: BusErrorCode;

  constructor(code: BusErrorCode, message: string) {
    super(message);
    this.name = 'BusError';
    this.code = code;
  }
}

export interface RegisterInput {
  platform: Platform;
  purpose: string;
  project?: string | undefined;
  branch?: string | undefined;
  /** A bus ID minted earlier (by a hook, or a previous register call). */
  session?: string | undefined;
}

export interface NotifyInput {
  platform: Platform;
  session: string;
  text: string;
  urgency: Urgency;
}

/** What the hook CLI extracted from an app's hook payload (already size-limited). */
export interface HookInput {
  event: string;
  appSessionId: string;
  project?: string | undefined;
  branch?: string | undefined;
  cwd?: string | undefined;
  source?: string | undefined;
  notificationType?: string | undefined;
  message?: string | undefined;
  toolName?: string | undefined;
  toolSummary?: string | undefined;
  lastMessage?: string | undefined;
  stopHookActive?: boolean | undefined;
}

export type HookAction =
  | 'context'
  | 'sent'
  | 'throttled'
  | 'rate_limited'
  | 'ignored'
  /** An approval prompt for agent-bus's own tools: no DM (see isOwnToolPrompt). */
  | 'own_tool';

/**
 * agent-bus's own MCP tools as the apps name them: Claude Code
 * `mcp__agent-bus__register`, Codex `mcp__agent_bus__notify_human`.
 */
const OWN_TOOL = /\bmcp__agent[-_]bus__/i;

/**
 * An approval prompt for one of agent-bus's own tools. A DM asking me to
 * approve an agent's message to me is noise: the message itself arrives once
 * approved, and Codex asks on every MCP call. Claude's permission_prompt
 * notification carries the tool name only in its message text.
 */
export function isOwnToolPrompt(input: HookInput): boolean {
  return OWN_TOOL.test(input.toolName ?? '') || OWN_TOOL.test(input.message ?? '');
}

export interface HookResult {
  session: string;
  action: HookAction;
  /** Text for the app to add to the model's context (SessionStart). */
  context?: string;
}

export type Route = 'dm' | 'thread' | 'digest';

type HookKind = keyof typeof HOOK_THROTTLE_MS;

/** The bot's channel membership, when known (see ChannelDirectory.isMember). */
export interface ChannelMembership {
  isMember(name: string): boolean | undefined;
}

/**
 * The broker's rules: who may act on which session, where each message goes,
 * and how often. Everything here is written to the audit log.
 */
export class BusService {
  private readonly store: Store;
  private readonly queue: { kick(): void };
  private readonly now: () => Date;
  private readonly channels: ChannelMembership | undefined;

  constructor(
    store: Store,
    queue: { kick(): void },
    now: () => Date = () => new Date(),
    channels?: ChannelMembership,
  ) {
    this.store = store;
    this.queue = queue;
    this.now = now;
    this.channels = channels;
  }

  // MCP tools

  register(input: RegisterInput): { session: SessionRecord; created: boolean } {
    if (input.session) return this.reregister(input, input.session);

    const created = this.store.countEvents({
      kind: 'session.created',
      platform: input.platform,
      since: this.hourAgo(),
      dataField: { name: 'source', value: 'mcp' },
    });
    if (created >= LIMITS.registerPerPlatform) {
      this.deny(input.platform, null, 'rate_limited', 'register');
      throw new BusError('rate_limited', 'Too many new sessions this hour; try again later.');
    }

    const session = this.store.transaction(() => {
      const record = this.createSession({
        platform: input.platform,
        project: input.project,
        branch: input.branch,
        purpose: input.purpose,
        source: 'mcp',
      });
      this.announce(record);
      return record;
    });
    this.queue.kick();
    return { session: this.reload(session.id), created: true };
  }

  notify(input: NotifyInput): { route: Route } {
    const session = this.ownedSession(input.platform, input.session, 'notify');
    const route = this.deliver(session, input.urgency, toSlackMrkdwn(input.text), {
      source: 'mcp',
      text: input.text,
    });
    return { route };
  }

  // Hooks

  /**
   * Handles one hook event. Hooks never decide anything for the app (no
   * allow/deny, no blocking); they only ping me and hand the agent its bus ID.
   */
  hook(platform: Platform, input: HookInput): HookResult {
    const session = this.hookSession(platform, input);
    let action: HookAction = 'ignored';
    let context: string | undefined;

    switch (input.event) {
      case 'SessionStart':
        action = 'context';
        context = sessionContext(session);
        break;
      case 'PermissionRequest':
        action = isOwnToolPrompt(input)
          ? 'own_tool'
          : this.hookPing(session, 'permission', 'urgent', permissionText(input));
        break;
      case 'Notification':
        if (input.notificationType === 'permission_prompt') {
          action = isOwnToolPrompt(input)
            ? 'own_tool'
            : this.hookPing(session, 'permission', 'urgent', permissionText(input));
        }
        break;
      case 'Stop':
        // A Stop hook (ours or another) already kept the agent going; it isn't waiting yet.
        if (!input.stopHookActive) {
          action = this.hookPing(session, 'stop', 'normal', stopText(input));
        }
        break;
    }

    this.store.appendEvent({
      kind: 'hook',
      platform,
      sessionId: session.id,
      data: { event: input.event, action, source: input.source ?? null },
    });
    return { session: session.id, action, ...(context ? { context } : {}) };
  }

  /** Finds the bus session for an app session, creating it on first sight. */
  private hookSession(platform: Platform, input: HookInput): SessionRecord {
    const existing = this.store.findByAppSession(platform, input.appSessionId);
    if (existing) {
      this.store.touchSession(existing.id, input.branch ? { branch: input.branch } : {});
      return this.reload(existing.id);
    }
    return this.store.transaction(() =>
      this.createSession({
        platform,
        project: input.project,
        branch: input.branch,
        purpose: undefined,
        appSessionId: input.appSessionId,
        source: 'hook',
        cwd: input.cwd,
      }),
    );
  }

  private hookPing(
    session: SessionRecord,
    kind: HookKind,
    urgency: Urgency,
    mrkdwn: string,
  ): HookAction {
    const since = new Date(this.now().getTime() - HOOK_THROTTLE_MS[kind]);
    const recent = this.store.countEvents({
      kind: 'notify',
      sessionId: session.id,
      since,
      dataField: { name: 'hook', value: kind },
    });
    if (recent > 0) return 'throttled';
    try {
      this.deliver(session, urgency, mrkdwn, { source: 'hook', hook: kind });
      return 'sent';
    } catch (error) {
      if (error instanceof BusError && error.code === 'rate_limited') return 'rate_limited';
      throw error;
    }
  }

  // Shared rules

  /** Applies the per-session caps, audits, and queues the post. `mrkdwn` must already be escaped. */
  private deliver(
    session: SessionRecord,
    urgency: Urgency,
    mrkdwn: string,
    audit: Record<string, unknown>,
  ): Route {
    const since = this.hourAgo();
    const sent = this.store.countEvents({ kind: 'notify', sessionId: session.id, since });
    const urgentSent =
      urgency === 'urgent'
        ? this.store.countEvents({
            kind: 'notify',
            sessionId: session.id,
            since,
            dataField: { name: 'urgency', value: 'urgent' },
          })
        : 0;
    if (sent >= LIMITS.notifyPerSession || urgentSent >= LIMITS.urgentPerSession) {
      this.deny(session.platform, session.id, 'rate_limited', 'notify');
      throw new BusError(
        'rate_limited',
        'Notification limit reached for this session; batch updates or wait before sending more.',
      );
    }

    const route: Route = urgency === 'urgent' ? 'dm' : urgency === 'normal' ? 'thread' : 'digest';
    this.store.transaction(() => {
      this.store.touchSession(session.id);
      this.store.appendEvent({
        kind: 'notify',
        platform: session.platform,
        sessionId: session.id,
        data: { urgency, route, ...audit },
      });
      if (route === 'dm') {
        this.store.enqueue({
          target: DM_TARGET,
          sessionId: session.id,
          text: urgentText(session, mrkdwn),
          ...style(session),
        });
      } else if (route === 'thread') {
        this.postInThread(session, mrkdwn);
      }
    });
    if (route !== 'digest') this.queue.kick();
    return route;
  }

  private createSession(input: {
    platform: Platform;
    project: string | undefined;
    branch: string | undefined;
    purpose: string | undefined;
    appSessionId?: string;
    source: 'mcp' | 'hook';
    cwd?: string | undefined;
  }): SessionRecord {
    const project = input.project ? projectSlug(input.project) : NO_PROJECT;
    const projectChannel = `proj-${project}`;
    // When the channel list isn't loaded yet, keep the project channel; the
    // post queue still falls back to #agents if the bot isn't in it.
    const channel =
      project === NO_PROJECT || this.channels?.isMember(projectChannel) === false
        ? FALLBACK_CHANNEL
        : projectChannel;
    let id = newSessionId(input.platform, project);
    while (this.store.getSession(id)) id = newSessionId(input.platform, project);
    const session = this.store.insertSession({
      id,
      platform: input.platform,
      project,
      branch: input.branch ?? null,
      purpose: input.purpose ?? null,
      channel,
      appSessionId: input.appSessionId ?? null,
    });
    this.store.appendEvent({
      kind: 'session.created',
      platform: input.platform,
      sessionId: id,
      data: {
        source: input.source,
        project,
        branch: input.branch ?? null,
        purpose: input.purpose ?? null,
        ...(input.cwd ? { cwd: input.cwd } : {}),
      },
    });
    return session;
  }

  /** Queues the thread root once per session; it becomes the thread for later posts. */
  private announce(session: SessionRecord): void {
    if (session.announcedAt) return;
    this.store.enqueue({
      target: session.channel,
      sessionId: session.id,
      inThread: true,
      text: sessionStartText(session),
      ...style(session),
    });
    this.store.markAnnounced(session.id);
  }

  private postInThread(session: SessionRecord, mrkdwn: string): void {
    this.announce(this.reload(session.id));
    this.store.enqueue({
      target: session.channel,
      sessionId: session.id,
      inThread: true,
      text: mrkdwn,
      ...style(session),
    });
  }

  private reregister(
    input: RegisterInput,
    id: string,
  ): { session: SessionRecord; created: boolean } {
    const session = this.ownedSession(input.platform, id, 'register');
    const purposeChanged = input.purpose !== session.purpose;
    this.store.transaction(() => {
      this.store.touchSession(id, {
        purpose: input.purpose,
        ...(input.branch ? { branch: input.branch } : {}),
      });
      this.store.appendEvent({
        kind: 'session.registered',
        platform: input.platform,
        sessionId: id,
        data: { purpose: input.purpose, branch: input.branch ?? null },
      });
      const updated = this.reload(id);
      if (!updated.announcedAt) {
        // The root post carries the purpose, so no separate purpose post.
        this.announce(updated);
      } else if (purposeChanged) {
        this.postInThread(updated, `*Purpose:* ${toSlackMrkdwn(input.purpose)}`);
      }
    });
    this.queue.kick();
    return { session: this.reload(id), created: false };
  }

  /** A session the calling platform may act on. Identity comes from the token, not the ID. */
  private ownedSession(platform: Platform, id: string, action: string): SessionRecord {
    const session = this.store.getSession(id);
    if (!session) {
      this.deny(platform, null, 'unknown_session', action, id);
      throw new BusError(
        'unknown_session',
        `Unknown session "${id}". Call register without a session to get one.`,
      );
    }
    if (session.platform !== platform) {
      this.deny(platform, null, 'wrong_platform', action, id);
      throw new BusError('wrong_platform', `Session "${id}" belongs to another platform.`);
    }
    return session;
  }

  private deny(
    platform: Platform,
    sessionId: string | null,
    reason: BusErrorCode,
    action: string,
    claimed?: string,
  ): void {
    this.store.appendEvent({
      kind: 'denied',
      platform,
      sessionId,
      data: { action, reason, ...(claimed ? { claimedSession: claimed } : {}) },
    });
  }

  private reload(id: string): SessionRecord {
    return found(this.store.getSession(id), `session ${id}`);
  }

  private hourAgo(): Date {
    return new Date(this.now().getTime() - HOUR_MS);
  }
}

function style(session: SessionRecord): { username: string; icon: string } {
  const { label, icon } = PLATFORM_STYLE[session.platform];
  return { username: `${label} · ${session.project}`, icon };
}

export function sessionStartText(session: SessionRecord): string {
  const branch = session.branch ? ` on \`${escapeSlackText(session.branch)}\`` : '';
  const purpose = session.purpose ? `\n> ${toSlackMrkdwn(session.purpose)}` : '';
  return `:large_green_circle: *Session started* \`${session.id}\`${branch}${purpose}`;
}

/** `mrkdwn` must already be escaped. */
export function urgentText(session: SessionRecord, mrkdwn: string): string {
  return `:rotating_light: \`${session.id}\` needs you\n${mrkdwn}`;
}

export function sessionContext(session: SessionRecord): string {
  return (
    `agent-bus: this session's bus ID is ${session.id}. ` +
    'Pass it as `session` to the agent-bus MCP tools (register, notify_human).'
  );
}

export function permissionText(input: HookInput): string {
  const tool = input.toolName ? `*${escapeSlackText(input.toolName)}*` : 'a tool';
  const detail = input.toolSummary ?? input.message;
  const block = detail ? `\n${codeBlock(detail)}` : '';
  return `:lock: Waiting for your approval to use ${tool}${block}\nAnswer in the app.`;
}

export function stopText(input: HookInput): string {
  const snippet = input.lastMessage ? `\n${quote(input.lastMessage)}` : '';
  return `:hourglass_flowing_sand: Turn finished; waiting for you${snippet}`;
}

function truncate(text: string, max = SNIPPET_CHARS): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

function codeBlock(text: string): string {
  // A ``` inside the text would end the block early.
  return '```' + escapeSlackText(truncate(text)).replaceAll('```', "'''") + '```';
}

function quote(text: string): string {
  return toSlackMrkdwn(truncate(text))
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
}
