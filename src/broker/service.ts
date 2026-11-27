import { postStyle, type Platform } from '../shared/platform.ts';
import { newSessionId, NO_PROJECT, projectSlug } from '../shared/session-id.ts';
import { hashSessionKey, mintSessionKey, sessionKeyMatches } from '../shared/session-key.ts';
import { escapeSlackText, toSlackMrkdwn } from '../shared/slack-text.ts';
import { FALLBACK_CHANNEL } from './slack/directory.ts';
import {
  newQuestionId,
  QUESTION_LIMITS,
  questionMessage,
  questionPointer,
  questionTimes,
} from './questions.ts';
import {
  DM_TARGET,
  found,
  type HeldPingRecord,
  type QuestionRecord,
  type SessionRecord,
  type Store,
} from './store.ts';

export const URGENCIES = ['urgent', 'normal', 'fyi'] as const;
export type Urgency = (typeof URGENCIES)[number];

/** Per-hour caps that stop a looping agent from flooding Slack or my DMs. */
export const LIMITS = {
  /** Sessions an agent may create through `register` (hooks create theirs from app sessions). */
  registerPerPlatform: 30,
  notifyPerSession: 60,
  urgentPerSession: 10,
  /** Stop-hook blocks (Slack replies handed to the agent): the loop guard. */
  stopBlocksPerSession: 6,
  /** Replies handed over in one Stop-hook block; the rest wait for the next. */
  stopTakePerBlock: 5,
  /**
   * A hook response carrying the bus ID counts as delivered when written
   * within this long of the request arriving: well inside the hook's 2 s wait.
   */
  contextConfirmMs: 1000,
  /** Slow responses carrying the bus ID after which prompts stop re-sending it. */
  contextSlowDeliveries: 3,
} as const;

/** Agent cards (#58): who an agent could hand work to. */
export const AGENT_CARDS = {
  /** A session counts as around when it called a tool or a hook fired this recently. */
  seenWithinMs: 2 * 60 * 60_000,
  /** At most this many cards in one list, most recently seen first. */
  max: 50,
} as const;

/**
 * An agent card: deliberately small (grilling Q6). Never the key or its
 * hash, the app's own session ID (which can fetch a session's key through
 * /hook, T14) or Slack thread IDs. `branch` and `purpose` are the agent's
 * own words.
 */
export interface AgentCard {
  session: string;
  platform: Platform;
  project: string;
  branch: string | null;
  purpose: string | null;
  lastSeen: string;
}

export interface ListAgentsInput {
  platform: Platform;
  session: string;
  key: string | undefined;
  /** Only this project (a repo or folder name, slugged like register's). */
  project?: string | undefined;
  /** Only this platform. */
  onPlatform?: Platform | undefined;
}

/** Minimum gap between hook pings of one kind for one session. */
export const HOOK_THROTTLE_MS = {
  /** Permission prompts often come in bursts; one DM brings me to the app. */
  permission: 2 * 60_000,
  /** Stop fires after every turn; one "waiting for you" per stretch is enough. */
  stop: 10 * 60_000,
} as const;

/**
 * Approval DMs wait out a grace period: a prompt I answer in the app within
 * it never buzzes Slack. Any later sign the session moved on cancels the DM.
 */
export const APPROVAL = {
  graceMs: 60_000,
  /** How often held DMs are checked. */
  tickMs: 10_000,
  /** A held DM older than this (e.g. the broker was down) is dropped, not sent late. */
  staleMs: 15 * 60_000,
} as const;

/** How soon Claude's Notification follows the PermissionRequest for one prompt. */
const READ_ONLY_PAIR_MS = 10_000;

/** Hook events that are the permission prompt itself, not a sign it was answered. */
const PROMPT_EVENTS: ReadonlySet<string> = new Set(['PermissionRequest', 'Notification']);

const HOUR_MS = 60 * 60_000;
const SNIPPET_CHARS = 300;

export type BusErrorCode =
  | 'unknown_session'
  | 'wrong_platform'
  | 'missing_key'
  | 'bad_key'
  | 'rate_limited'
  | 'too_many_questions'
  | 'unknown_question'
  // Phase 3 tasks (#59)
  | 'unknown_task'
  | 'unknown_target'
  | 'invalid_target'
  | 'same_platform'
  | 'hop_limit'
  | 'task_loop'
  | 'too_many_tasks'
  | 'too_long'
  | 'secret_in_text'
  | 'which_task'
  | 'not_allowed'
  | 'task_taken'
  | 'bad_state'
  | 'bad_result'
  // Repo leases (#31)
  | 'not_leased';

export interface AskInput {
  platform: Platform;
  session: string;
  question: string;
  options?: readonly string[] | undefined;
  /** What the agent will do if I don't answer in time. */
  defaultAnswer: string;
  timeoutMinutes?: number | undefined;
}

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
  /**
   * The session's current key. With `session`, a matching key gets a new
   * one (the old stops working); without it, register still updates the
   * purpose but hands out no key (#65).
   */
  key?: string | undefined;
}

export interface RegisterResult {
  session: SessionRecord;
  created: boolean;
  /** A new secret key for the session, when one was issued. */
  key?: string;
  /** Set when the project was never seen before: likely a typo (grilling Q13). */
  warning?: string;
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
  /** A browser `computer` call's `action` argument (screenshot, left_click, …). */
  toolAction?: string | undefined;
  lastMessage?: string | undefined;
  stopHookActive?: boolean | undefined;
}

export type HookAction =
  | 'context'
  /** A permission prompt: its DM waits out the grace period (APPROVAL). */
  | 'held'
  /** Stop only: the agent was kept going with my Slack replies as the reason. */
  | 'blocked'
  | 'sent'
  | 'throttled'
  | 'rate_limited'
  | 'ignored'
  /** SessionEnd only: the ended session's leases were released (#100). */
  | 'released'
  /** An approval prompt for agent-bus's own tools: no DM (see isOwnToolPrompt). */
  | 'own_tool'
  /** An approval prompt for a tool that only reads: no DM (see isReadOnlyToolPrompt). */
  | 'read_only';

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

/** Claude Code's built-in tools that only read (files, the web, background output). */
const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  'Read',
  'Glob',
  'Grep',
  'LS',
  'NotebookRead',
  'WebFetch',
  'WebSearch',
  'BashOutput',
  'ListMcpResourcesTool',
  'ReadMcpResourceTool',
]);

/** Verbs an MCP tool's name starts with when it only reads. */
const READ_VERBS: ReadonlySet<string> = new Set([
  'get',
  'list',
  'read',
  'search',
  'find',
  'fetch',
  'describe',
  'view',
]);

/**
 * Words that make a name starting with a read verb a write after all
 * (`find_and_replace`, `get_or_create_user`, `list_and_delete_old`). Any of
 * them, as a whole `_`-separated word anywhere in the name, means a DM.
 */
const WRITE_WORDS: ReadonlySet<string> = new Set([
  'and',
  'or',
  'then',
  'create',
  'update',
  'upsert',
  'insert',
  'delete',
  'remove',
  'drop',
  'purge',
  'clear',
  'reset',
  'replace',
  'write',
  'set',
  'put',
  'post',
  'patch',
  'send',
  'add',
  'edit',
  'modify',
  'move',
  'rename',
  'copy',
  'archive',
  'mark',
  'assign',
  'merge',
  'close',
  'submit',
  'publish',
  'upload',
  'save',
  'apply',
  'approve',
  'reject',
  'cancel',
  'run',
  'exec',
  'execute',
  'invoke',
  'trigger',
  'start',
  'stop',
  'kill',
  'enable',
  'disable',
  'toggle',
  'pay',
  'buy',
  'transfer',
]);

/** `mcp__server__tool`: the tool part is words joined by single underscores. */
const MCP_TOOL = /^mcp__[^_]+(?:_[^_]+)*__([A-Za-z0-9]+(?:_[A-Za-z0-9]+)*)$/;

/**
 * An MCP tool named like a read: its first word is a read verb and no word
 * is a write word. The browser tools' tab listing counts too. Only the tool
 * part is matched, never the server name.
 */
export function isReadOnlyMcpTool(tool: string): boolean {
  const name = MCP_TOOL.exec(tool)?.[1]?.toLowerCase();
  if (!name) return false;
  if (name === 'tabs_context' || name === 'tabs_context_mcp') return true;
  const [verb = '', ...rest] = name.split('_');
  return READ_VERBS.has(verb) && !rest.some((word) => WRITE_WORDS.has(word));
}

/** A browser `computer` tool; only its screenshot and zoom actions just look. */
const COMPUTER_TOOL = /^mcp__[^_]+(?:_[^_]+)*__computer$/i;
const LOOK_ONLY_ACTIONS: ReadonlySet<string> = new Set(['screenshot', 'zoom']);

/** Claude's permission_prompt notification names the tool only in its message. */
const PROMPT_TOOL = /permission to use ([A-Za-z0-9_-]+)/i;

/**
 * An approval prompt for a tool that only reads, so a DM isn't worth a
 * buzz (#27): Claude Code's read tools, MCP tools named like reads, and a
 * browser screenshot or zoom (from the call's own `action` argument, not
 * its display summary). Shell commands always DM: there's no safe way to
 * tell a read-only command from the outside.
 */
export function isReadOnlyToolPrompt(input: HookInput): boolean {
  const tool = input.toolName ?? PROMPT_TOOL.exec(input.message ?? '')?.[1];
  if (!tool) return false;
  if (READ_ONLY_TOOLS.has(tool) || isReadOnlyMcpTool(tool)) return true;
  return COMPUTER_TOOL.test(tool) && LOOK_ONLY_ACTIONS.has(input.toolAction ?? '');
}

export interface HookResult {
  session: string;
  action: HookAction;
  /** Text for the app to add to the model's context (SessionStart, UserPromptSubmit). */
  context?: string;
  /** Why the agent must keep going (Stop, action `blocked`): my replies, labelled as mine. */
  reason?: string;
}

/**
 * Takes a session's undelivered Slack replies for a Stop hook, marking them
 * delivered, and returns them as the block reason; undefined when there are
 * none. Supplied by the HTTP layer, which owns the inbox.
 */
export type StopInboxCheck = (session: SessionRecord) => string | undefined;

/**
 * What became of the replies the last Stop block handed over. The hook's
 * response being written doesn't prove the agent read it, so the offer
 * stays open until the next turn event says:
 * - `confirm`: a Stop with `stop_hook_active`, the app's proof it kept the
 *   agent going with our reason (✅ on the replies);
 * - `putBack`: a Stop without it, a new prompt or a session start, so the
 *   block never reached the agent (the replies go back to the inbox).
 */
export interface StopOffers {
  confirm(session: SessionRecord): void;
  putBack(session: SessionRecord, reason: string): void;
}

/** Hook events that end or begin a turn (see lastStopBlocked). */
const TURN_EVENTS = ['Stop', 'UserPromptSubmit', 'SessionStart'] as const;

/** Platforms whose Stop hooks run and honour `decision: block` (Phase 0). */
const STOP_BLOCK_PLATFORMS: ReadonlySet<Platform> = new Set(['claude', 'codex']);

/** Platforms whose hooks run and print added context (Copilot's desktop hooks don't run). */
const CONTEXT_PLATFORMS: ReadonlySet<Platform> = STOP_BLOCK_PLATFORMS;

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

  /** The broker's clock, for services built on this one (tasks). */
  get clock(): () => Date {
    return this.now;
  }

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

  private leases: LeaseHooks | undefined;

  /** Turns on repo leases at SessionStart and the broken-lease notice on a prompt (#31). */
  useLeases(leases: LeaseHooks): void {
    this.leases = leases;
  }

  // MCP tools

  register(input: RegisterInput): RegisterResult {
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

    const project = input.project ? projectSlug(input.project) : NO_PROJECT;
    const warning = this.projectWarning(input.project, project);
    const session = this.store.transaction(() => {
      const record = this.createSession({
        platform: input.platform,
        project: input.project,
        branch: input.branch,
        purpose: input.purpose,
        source: 'mcp',
      });
      this.announce(record);
      return { record, key: this.issueKey(record, 'register') };
    });
    this.queue.kick();
    return {
      session: this.reload(session.record.id),
      created: true,
      key: session.key,
      ...(warning ? { warning } : {}),
    };
  }

  /**
   * Why a new session's project looks wrong (grilling Q13), if it does: a
   * name no session has used before (likely a typo), or a name that isn't
   * usable as a project at all and so fell back to no project.
   */
  private projectWarning(given: string | undefined, project: string): string | undefined {
    if (given && project === NO_PROJECT && given.trim().toLowerCase() !== NO_PROJECT) {
      return (
        "The project name you gave can't be used (it needs letters or digits), so this " +
        'session has no project and posts to #agents. ' +
        'Register again with the repo or folder name if you meant one.'
      );
    }
    if (project === NO_PROJECT || this.store.projectSeen(project)) return undefined;
    return (
      `No session has worked in project "${project}" before. If that's a typo, register ` +
      'again with the right project: tasks for a project only reach sessions in it.'
    );
  }

  /**
   * Cards of the sessions seen in the last AGENT_CARDS.seenWithinMs, on every
   * platform (the caller's own included, but never the caller), optionally
   * narrowed to one project or platform. Needs the caller's session key (#65).
   */
  listAgents(input: ListAgentsInput): AgentCard[] {
    const caller = this.requireKeyedSession(
      input.platform,
      input.session,
      input.key,
      'list_agents',
    );
    const project = input.project === undefined ? undefined : projectSlug(input.project);
    // A name that doesn't slug (empty, "???") falls back to "misc"; asking for
    // it matches nothing rather than the sessions with no project.
    const unusable =
      input.project !== undefined &&
      project === NO_PROJECT &&
      input.project.trim().toLowerCase() !== NO_PROJECT;
    if (unusable) return [];
    return this.store
      .sessionsSeenFiltered({
        since: new Date(this.now().getTime() - AGENT_CARDS.seenWithinMs),
        excludeId: caller.id,
        project,
        platform: input.onPlatform,
        limit: AGENT_CARDS.max,
      })
      .map((session) => ({
        session: session.id,
        platform: session.platform,
        project: session.project,
        branch: session.branch,
        purpose: session.purpose,
        lastSeen: session.lastSeenAt,
      }));
  }

  notify(input: NotifyInput): { route: Route } {
    const session = this.ownedSession(input.platform, input.session, 'notify');
    const route = this.deliver(session, input.urgency, toSlackMrkdwn(input.text), {
      source: 'mcp',
      text: input.text,
    });
    return { route };
  }

  /**
   * Asks me a question: a DM with buttons (when there are options) and a
   * pointer in the session's thread. Counts as an urgent notification for
   * the caps; at most QUESTION_LIMITS.openPerSession open at once.
   */
  ask(input: AskInput): QuestionRecord {
    const session = this.ownedSession(input.platform, input.session, 'ask_human');
    const open = this.store.openQuestions(session.id).length;
    if (open >= QUESTION_LIMITS.openPerSession) {
      this.deny(session.platform, session.id, 'too_many_questions', 'ask_human');
      throw new BusError(
        'too_many_questions',
        `This session already has ${open} open questions; wait for answers (wait_for_reply) before asking more.`,
      );
    }
    this.checkCaps(session, 'urgent', 'ask_human');

    const times = questionTimes(this.now(), input.timeoutMinutes);
    const question = this.store.transaction(() => {
      let id = newQuestionId();
      while (this.store.getQuestion(id)) id = newQuestionId();
      const record = this.store.insertQuestion({
        id,
        sessionId: session.id,
        text: input.question,
        options: input.options ?? [],
        defaultAnswer: input.defaultAnswer,
        ...times,
      });
      this.store.touchSession(session.id);
      this.store.appendEvent({
        kind: 'notify',
        platform: session.platform,
        sessionId: session.id,
        data: { urgency: 'urgent', route: 'dm', source: 'ask_human', questionId: id },
      });
      const message = questionMessage(session, record);
      const post = this.store.enqueue({
        target: DM_TARGET,
        sessionId: session.id,
        text: message.text,
        blocks: message.blocks,
        ...style(session),
      });
      this.store.setQuestionPost(id, 'post', post.id);
      this.postInThread(session, questionPointer(record));
      return found(this.store.getQuestion(id), `question ${id}`);
    });
    this.queue.kick();
    return question;
  }

  /** A question this platform's session asked. */
  requireQuestion(platform: Platform, sessionId: string, questionId: string): QuestionRecord {
    const session = this.requireSession(platform, sessionId, 'wait_for_reply');
    const question = this.store.getQuestion(questionId);
    if (!question || question.sessionId !== session.id) {
      this.deny(platform, session.id, 'unknown_question', 'wait_for_reply', questionId);
      throw new BusError(
        'unknown_question',
        `Unknown question "${questionId}" for session ${session.id}.`,
      );
    }
    return question;
  }

  // Hooks

  /**
   * Handles one hook event. Hooks ping me and hand the agent its bus ID; they
   * never allow or deny anything. The one decision is Stop's: when I've
   * replied in Slack, it blocks the stop (up to a per-session cap) so the
   * agent reads my replies and keeps going.
   */
  hook(
    platform: Platform,
    input: HookInput,
    stopInbox?: StopInboxCheck,
    offers?: StopOffers,
  ): HookResult {
    if (input.event === 'SessionEnd') return this.sessionEnd(platform, input);
    const session = this.hookSession(platform, input);
    // Settle the last Stop block's offer first: a Stop that puts it back can
    // then offer the same replies again.
    if (offers && STOP_BLOCK_PLATFORMS.has(platform)) {
      if (input.event === 'Stop' && input.stopHookActive) offers.confirm(session);
      else if ((TURN_EVENTS as readonly string[]).includes(input.event)) {
        offers.putBack(session, input.event);
      }
    }
    let action: HookAction = 'ignored';
    let context: string | undefined;
    let reason: string | undefined;

    // Anything but the prompt itself means the session moved on: a prompt it
    // was waiting on has been answered in the app, so its held DM is dropped.
    if (!PROMPT_EVENTS.has(input.event)) this.cancelHeldPings(session, input.event);

    switch (input.event) {
      case 'SessionStart':
        action = 'context';
        context = joinContext(
          sessionContext(session, this.issueKey(session, 'hook')),
          this.leases?.atSessionStart(session),
        );
        break;
      case 'UserPromptSubmit': {
        // The sign-in race: SessionStart ran before the broker was up, so the
        // agent never got its bus ID. Hand it over on the first prompt instead.
        const id = this.contextDelivered(session)
          ? undefined
          : sessionContext(session, this.issueKey(session, 'hook'));
        context = joinContext(id, this.leases?.atPrompt(session));
        if (context) action = 'context';
        break;
      }
      case 'PermissionRequest':
        action = this.holdPermission(session, input);
        break;
      case 'Notification':
        if (input.notificationType === 'permission_prompt') {
          action = this.holdPermission(session, input);
        }
        break;
      case 'Stop':
        // Taking the replies and recording the block commit together, so a
        // failed audit write can't leave replies marked delivered but unsent.
        reason = this.store.transaction(() => {
          const found = this.stopBlockReason(platform, session, stopInbox);
          if (found) this.auditHook(platform, session, input, 'blocked');
          return found;
        });
        if (reason) {
          return { session: session.id, action: 'blocked', reason };
        }
        if (!input.stopHookActive || this.lastStopBlocked(session)) {
          // stop_hook_active: a Stop hook already kept the agent going. If it was
          // ours, the agent has now dealt with my replies and really is waiting.
          action = this.hookPing(
            session,
            'stop',
            'normal',
            stopText(input, this.store.countUndelivered(session.id)),
          );
        }
        break;
    }

    this.auditHook(platform, session, input, action);
    return {
      session: session.id,
      action,
      ...(context ? { context } : {}),
      ...(reason ? { reason } : {}),
    };
  }

  /**
   * My undelivered replies as a block reason, or undefined: none waiting, a
   * platform whose Stop hook can't block, or the loop guard's cap reached
   * (the replies then wait for check_inbox or a later stop).
   */
  private stopBlockReason(
    platform: Platform,
    session: SessionRecord,
    stopInbox: StopInboxCheck | undefined,
  ): string | undefined {
    if (!stopInbox || !STOP_BLOCK_PLATFORMS.has(platform)) return undefined;
    const since = new Date(this.now().getTime() - HOUR_MS);
    const blocks = this.store.countEvents({
      kind: 'hook',
      sessionId: session.id,
      since,
      dataField: { name: 'action', value: 'blocked' },
    });
    if (blocks >= LIMITS.stopBlocksPerSession) return undefined;
    return stopInbox(session);
  }

  private auditHook(
    platform: Platform,
    session: SessionRecord,
    input: HookInput,
    action: HookAction,
  ): void {
    this.store.appendEvent({
      kind: 'hook',
      platform,
      sessionId: session.id,
      data: { event: input.event, action, source: input.source ?? null },
    });
  }

  /**
   * Records that a hook response carrying the bus ID was written to the hook
   * (Claude Code and Codex print it as added context). Called by the HTTP
   * layer on the response's 'finish', with how long the request took.
   * Written isn't read: the hook may already have timed out. So only a fast
   * response counts as delivered; a slow one counts towards the re-send cap.
   */
  markContextDelivered(
    platform: Platform,
    sessionId: string,
    event: string,
    elapsedMs: number,
  ): void {
    if (!CONTEXT_PLATFORMS.has(platform)) return;
    const fast = elapsedMs <= LIMITS.contextConfirmMs;
    this.store.appendEvent({
      kind: 'hook.context_delivered',
      platform,
      sessionId,
      data: { event, elapsedMs: Math.round(elapsedMs), fast: fast ? 'yes' : 'no' },
    });
  }

  /**
   * Whether the agent has its bus ID, as far as the broker can tell, since
   * the last SessionStart it saw (after /clear or compaction the agent starts
   * over): it used the ID in an MCP call, a response carrying it was written
   * quickly, or enough slow ones were written that one surely got through.
   */
  private contextDelivered(session: SessionRecord): boolean {
    const start = this.store.latestEvent({
      kind: 'hook',
      sessionId: session.id,
      dataField: { name: 'event', value: 'SessionStart' },
    });
    const after = { sessionId: session.id, afterId: Number(start?.eventId ?? 0) };
    if (this.store.countEventsAfter({ kind: 'session.used', ...after }) > 0) return true;
    const delivered = (fast?: 'yes') =>
      this.store.countEventsAfter({
        kind: 'hook.context_delivered',
        ...after,
        ...(fast ? { dataField: { name: 'fast', value: fast } } : {}),
      });
    return delivered('yes') > 0 || delivered() >= LIMITS.contextSlowDeliveries;
  }

  /**
   * Notes that the agent used this session's ID in an MCP call, which proves
   * it has the ID. Once per SessionStart (see contextDelivered).
   */
  private markUsed(session: SessionRecord, action: string): void {
    const start = this.store.latestEvent({
      kind: 'hook',
      sessionId: session.id,
      dataField: { name: 'event', value: 'SessionStart' },
    });
    const afterId = Number(start?.eventId ?? 0);
    if (this.store.countEventsAfter({ kind: 'session.used', sessionId: session.id, afterId }) > 0) {
      return;
    }
    this.store.appendEvent({
      kind: 'session.used',
      platform: session.platform,
      sessionId: session.id,
      data: { action },
    });
  }

  /**
   * Whether this turn's previous Stop was our block. A later prompt or
   * session start begins a new turn, so an old block doesn't count.
   */
  private lastStopBlocked(session: SessionRecord): boolean {
    const last = this.store.latestEvent({
      kind: 'hook',
      sessionId: session.id,
      dataField: { name: 'event', value: TURN_EVENTS },
    });
    return last?.event === 'Stop' && last.action === 'blocked';
  }

  /**
   * SessionEnd (Claude Code: exit, /clear, /resume, logout; Codex: close,
   * archive, 30 min idle): the session's leases are released at once instead
   * of lapsing after 2 h idle (#100), and any held approval DM is dropped.
   * Advisory in both apps, so nothing comes back. An app session the broker
   * never saw creates nothing. Apps without the event (Copilot) are unchanged.
   * A session that comes back (Codex after idling) re-claims at its next
   * prompt (`Leases.atPrompt`).
   */
  private sessionEnd(platform: Platform, input: HookInput): HookResult {
    const session = this.store.findByAppSession(platform, input.appSessionId);
    if (!session) return { session: '', action: 'ignored' };
    this.cancelHeldPings(session, input.event);
    const released = this.leases?.atSessionEnd(session) ?? [];
    const action: HookAction = released.length > 0 ? 'released' : 'ignored';
    this.auditHook(platform, session, input, action);
    return { session: session.id, action };
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

  /**
   * Holds the approval DM for a permission prompt (see APPROVAL). Claude
   * sends both a PermissionRequest and a permission_prompt Notification for
   * one prompt, so a Notification joins a DM already held; a new
   * PermissionRequest means the earlier prompt was answered and replaces it.
   */
  private holdPermission(session: SessionRecord, input: HookInput): HookAction {
    if (isOwnToolPrompt(input)) return 'own_tool';
    // A read-only prompt leaves any held DM alone: parallel subagents share a
    // session, so it may be for a write prompt that still waits.
    if (isReadOnlyToolPrompt(input)) return 'read_only';
    const held = this.store.heldPings(session.id).filter((ping) => ping.kind === 'permission');
    if (input.event === 'Notification') {
      if (held.length > 0) return 'held';
      // Claude's notification for the read-only prompt just handled may name
      // the tool by its display name; it's the same prompt.
      if (this.justSkippedReadOnly(session)) return 'read_only';
    }
    this.store.transaction(() => {
      for (const ping of held) this.closeHeldPing(ping, 'cancelled', 'superseded');
      const ping = this.store.holdPing({
        sessionId: session.id,
        kind: 'permission',
        text: permissionText(input),
        dueAt: new Date(this.now().getTime() + APPROVAL.graceMs),
      });
      this.store.appendEvent({
        kind: 'ping.held',
        platform: session.platform,
        sessionId: session.id,
        data: { pingId: ping.id, kind: ping.kind, event: input.event },
      });
    });
    return 'held';
  }

  /**
   * Whether the session's last hook event was a read-only PermissionRequest,
   * within READ_ONLY_PAIR_MS: Claude's Notification for it follows at once.
   */
  private justSkippedReadOnly(session: SessionRecord): boolean {
    const last = this.store.latestEvent({ kind: 'hook', sessionId: session.id });
    if (last?.event !== 'PermissionRequest' || last.action !== 'read_only') return false;
    const at = typeof last.eventAt === 'string' ? Date.parse(last.eventAt) : Number.NaN;
    return this.now().getTime() - at <= READ_ONLY_PAIR_MS;
  }

  /** Drops a session's held DMs: it has moved on (`reason` says how). */
  private cancelHeldPings(session: SessionRecord, reason: string): void {
    const held = this.store.heldPings(session.id);
    if (held.length === 0) return;
    this.store.transaction(() => {
      for (const ping of held) this.closeHeldPing(ping, 'cancelled', reason);
    });
  }

  /**
   * Sends the held DMs whose grace period is over, keeping the per-session
   * throttle. A held DM older than APPROVAL.staleMs is dropped instead.
   * Returns how many were sent. Run by the broker every APPROVAL.tickMs.
   */
  flushHeldPings(): number {
    const now = this.now();
    let sent = 0;
    for (const ping of this.store.duePings(now)) {
      const session = this.store.getSession(ping.sessionId);
      if (!session) {
        this.closeHeldPing(ping, 'stale', 'no_session');
        continue;
      }
      if (now.getTime() - Date.parse(ping.createdAt) > APPROVAL.staleMs) {
        this.closeHeldPing(ping, 'stale', 'too_old');
        continue;
      }
      const action = this.store.transaction(() => {
        const result = this.hookPing(session, 'permission', 'urgent', ping.text);
        this.store.closeHeldPing(ping.id, result === 'sent' ? 'sent' : 'throttled');
        this.store.appendEvent({
          kind: 'ping.flushed',
          platform: session.platform,
          sessionId: session.id,
          data: { pingId: ping.id, action: result },
        });
        return result;
      });
      if (action === 'sent') sent++;
    }
    return sent;
  }

  private closeHeldPing(ping: HeldPingRecord, state: 'cancelled' | 'stale', reason: string): void {
    if (!this.store.closeHeldPing(ping.id, state)) return;
    this.store.appendEvent({
      kind: `ping.${state}`,
      sessionId: ping.sessionId,
      data: { pingId: ping.id, kind: ping.kind, reason },
    });
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
    this.checkCaps(session, urgency, 'notify');
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
      } else {
        this.store.addDigestItem(session.id, mrkdwn);
      }
    });
    if (route !== 'digest') this.queue.kick();
    return route;
  }

  /** The per-session hourly caps; every post (and every question) counts. */
  private checkCaps(session: SessionRecord, urgency: Urgency, action: string): void {
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
      this.deny(session.platform, session.id, 'rate_limited', action);
      throw new BusError(
        'rate_limited',
        'Notification limit reached for this session; batch updates or wait before sending more.',
      );
    }
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

  private reregister(input: RegisterInput, id: string): RegisterResult {
    // A wrong key is refused before anything changes; no key (or an empty
    // one) is the Phase 1-2 call (#66 makes it required later).
    const session = !input.key
      ? this.ownedSession(input.platform, id, 'register')
      : this.keyedSession(input.platform, id, input.key, 'register');
    const purposeChanged = input.purpose !== session.purpose;
    const key = this.store.transaction(() => {
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
      return input.key ? this.issueKey(updated, 'register') : undefined;
    });
    this.queue.kick();
    return { session: this.reload(id), created: false, ...(key ? { key } : {}) };
  }

  /**
   * A session the caller may act on, proven by its key as well as the
   * platform token (#65): without the key, any session of the same platform
   * could act as another. For the Phase 3 task and lease tools; Phase 1-2
   * tools adopt it in #66. A missing or wrong key is refused and audited,
   * and the key itself is never written anywhere.
   */
  requireKeyedSession(
    platform: Platform,
    id: string,
    key: string | undefined,
    action: string,
  ): SessionRecord {
    const session = this.keyedSession(platform, id, key, action);
    this.store.touchSession(session.id);
    return session;
  }

  private keyedSession(
    platform: Platform,
    id: string,
    key: string | undefined,
    action: string,
  ): SessionRecord {
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
    if (!key) {
      this.deny(platform, null, 'missing_key', action, id);
      throw new BusError(
        'missing_key',
        "This tool needs your session key: pass it as `key`. It's in your startup context; " +
          'if you lost it, call register without a session to start a new one.',
      );
    }
    const stored = this.store.sessionKeyHash(id);
    if (!stored || !sessionKeyMatches(key, stored)) {
      this.deny(platform, null, 'bad_key', action, id);
      throw new BusError(
        'bad_key',
        `That isn't the current key for session "${id}". Use the newest key your context ` +
          'gave you (each new one replaces the last); if you have none, call register without a session.',
      );
    }
    // ownedSession repeats the lookup on purpose: it is the one place that marks
    // the session used and drops held pings, and that must happen only once
    // the key has matched.
    return this.ownedSession(platform, id, action);
  }

  /** Gives a session a new key, replacing any earlier one; returns the key (#65). */
  private issueKey(session: SessionRecord, source: 'register' | 'hook'): string {
    const key = mintSessionKey();
    this.store.transaction(() => {
      this.store.setSessionKeyHash(session.id, hashSessionKey(key));
      this.store.appendEvent({
        kind: 'session.key_issued',
        platform: session.platform,
        sessionId: session.id,
        data: { source },
      });
    });
    return key;
  }

  /** A session the calling platform may act on (for tools outside this class, e.g. check_inbox). */
  requireSession(platform: Platform, id: string, action: string): SessionRecord {
    const session = this.ownedSession(platform, id, action);
    this.store.touchSession(session.id);
    return session;
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
    this.markUsed(session, action);
    // An agent can't call tools while a permission prompt waits on me, so a
    // call means any prompt was answered in the app.
    this.cancelHeldPings(session, 'mcp');
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
  return postStyle(session.platform, session.project);
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

/** What leases add to a hook's context (#31): see `leases.ts`. */
export interface LeaseHooks {
  atSessionStart(session: SessionRecord): string | undefined;
  atPrompt(session: SessionRecord): string | undefined;
  /** Releases the ended session's leases; the repos it let go (#100). */
  atSessionEnd(session: SessionRecord): string[];
}

function joinContext(...parts: (string | undefined)[]): string | undefined {
  const present = parts.filter((part): part is string => Boolean(part));
  return present.length > 0 ? present.join('\n\n') : undefined;
}

export function sessionContext(session: SessionRecord, key: string): string {
  return (
    `agent-bus: this session's bus ID is ${session.id}. ` +
    'Pass it as `session` to the agent-bus MCP tools ' +
    '(register, notify_human, ask_human, wait_for_reply, check_inbox). ' +
    `Its secret key is ${key}: pass it as \`key\` to agent-bus tools that ask for one. ` +
    'Never post, share or write the key anywhere else; a newer key replaces this one.'
  );
}

export function permissionText(input: HookInput): string {
  const tool = input.toolName ? `*${escapeSlackText(input.toolName)}*` : 'a tool';
  const detail = input.toolSummary ?? input.message;
  const block = detail ? `\n${codeBlock(detail)}` : '';
  return `:lock: Waiting for your approval to use ${tool}${block}\nAnswer in the app.`;
}

/** `waiting`: my replies the agent hasn't read (e.g. past the Stop-hook cap). */
export function stopText(input: HookInput, waiting = 0): string {
  const snippet = input.lastMessage ? `\n${quote(input.lastMessage)}` : '';
  const replies = waiting === 1 ? '1 reply' : `${waiting} replies`;
  const unread =
    waiting > 0
      ? `\n_${replies} from you not read yet: they reach it at its next \`check_inbox\` or stop._`
      : '';
  return `:hourglass_flowing_sand: Turn finished; waiting for you${snippet}${unread}`;
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
