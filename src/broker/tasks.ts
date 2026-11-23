import type { Platform } from '../shared/platform.ts';
import { NO_PROJECT, projectSlug } from '../shared/session-id.ts';
import { BusError, type BusErrorCode, type BusService } from './service.ts';
import type { SessionRecord, Store } from './store.ts';
import type { TaskEvents } from './task-slack.ts';
import { TaskStore, type TaskRecord, type TaskResult } from './task-store.ts';
import { canMoveTask, type TaskState } from '../shared/task-states.ts';

/**
 * Phase 3 task rules (#59): create, list, claim and update. Decisions D1,
 * D2, D5, D7 and grilling Q4, Q13, Q14, Q17, Q18, Q20, Q21 in docs/phase-3.md. Every call needs
 * the caller's session key; sender, time and parent come from the broker,
 * never from arguments (D4, T3). Refusals are audited without the text.
 */
export const TASK_LIMITS = {
  /** A task may spawn one sub-task: hops 0 and 1, never 2 (D5). */
  maxHops: 1,
  /** New tasks one session may create in an hour (D5). */
  createdPerSessionPerHour: 10,
  /** Open tasks for one target: a named session, or one pool (D5). */
  openPerTarget: 3,
  /** Tasks awaiting my approval, counted on the creator's platform (Q17). */
  awaitingApprovalPerPlatform: 5,
  /** Characters in a title. */
  titleMax: 120,
  /** Characters in a brief, a note, a result or a message (Q17). */
  textMax: 4000,
  /** How long a task waits for my approval before it expires (Q15). */
  approvalTtlMs: 8 * 60 * 60_000,
  /** Tasks in one list_tasks result. */
  listMax: 50,
  /** Links in one result, each at most `linkMax` characters, `https:` only (T12). */
  resultLinks: 10,
  linkMax: 500,
} as const;

const HOUR_MS = 60 * 60_000;

/**
 * Token-shaped strings a task must never carry (T10): agent-bus platform
 * tokens and session keys, Slack tokens, GitHub tokens. A match refuses the
 * whole call; nothing is stored, posted or audited with it.
 */
const SECRET_PATTERNS: readonly RegExp[] = [
  // A value assigned to an agent-bus token; the variable's name alone is fine.
  /AGENT_BUS_TOKEN_[A-Z]+\s*[=:]\s*\S{16,}/,
  // A session key, even glued to a word (no \b).
  /abk_[A-Za-z0-9_-]{20,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
  /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  /\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}/,
  /\bxoxe[.-][A-Za-z0-9.-]{10,}/,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/,
  /\bxapp-[A-Za-z0-9-]{10,}/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}/,
  /\bgithub_pat_[A-Za-z0-9_]{30,}/,
];

export function holdsSecret(text: string): boolean {
  return SECRET_PATTERNS.some((pattern) => pattern.test(text));
}

/** Where a task goes: a named session, or any session of a platform in a project. */
export type TaskTarget = { session: string } | { platform: Platform; project: string };

export interface CreateTaskInput {
  platform: Platform;
  session: string;
  key: string | undefined;
  title: string;
  brief: string;
  to: TaskTarget;
  /**
   * Which held task this is a sub-task of. Needed when the caller holds more
   * than one; with exactly one held task, that one is the parent (Q4).
   */
  forTask?: string | undefined;
}

export interface ClaimTaskInput {
  platform: Platform;
  session: string;
  key: string | undefined;
  task: string;
}

/**
 * update_task's moves, by who may make them:
 * - the holder: input-required (with a note: the question), working (back
 *   from input-required), completed (with a result), failed (with a note),
 *   submitted (gives it back), or a note alone (no state);
 * - a named target: rejected, while the task is approved and unclaimed;
 * - the creator: canceled, any time before it ends.
 */
export interface UpdateTaskInput {
  platform: Platform;
  session: string;
  key: string | undefined;
  task: string;
  state?: TaskState | undefined;
  note?: string | undefined;
  result?: TaskResult | undefined;
}

export interface ListTasksInput {
  platform: Platform;
  session: string;
  key: string | undefined;
  /** One task by ID; refused like an unknown ID when the caller can't see it (T7). */
  task?: string | undefined;
}

export class TaskService {
  private readonly store: Store;
  private readonly service: BusService;
  private readonly tasks: TaskStore;
  private readonly now: () => Date;
  /** Slack's side of each change (#61), run in the same transaction; none in some tests. */
  private readonly events: TaskEvents | undefined;

  constructor(
    store: Store,
    service: BusService,
    now: () => Date = service.clock,
    events?: TaskEvents,
  ) {
    this.store = store;
    this.service = service;
    this.tasks = new TaskStore(store, now);
    this.now = now;
    this.events = events;
  }

  /**
   * Opens a task for another platform's session or pool. It waits for my
   * approval (D2) before the target can see or claim it. The parent is the
   * task the caller holds (Q4); a third hop or a loop back to an earlier
   * creator is refused (D5, Q18).
   */
  createTask(input: CreateTaskInput): TaskRecord {
    const caller = this.service.requireKeyedSession(
      input.platform,
      input.session,
      input.key,
      'create_task',
    );
    const refuse = (code: BusErrorCode, message: string): never => {
      this.deny(caller, code, 'create_task');
      throw new BusError(code, message);
    };

    if (input.title.length > TASK_LIMITS.titleMax || input.brief.length > TASK_LIMITS.textMax) {
      refuse(
        'too_long',
        `Keep the title under ${TASK_LIMITS.titleMax} and the brief under ${TASK_LIMITS.textMax} characters.`,
      );
    }
    if (holdsSecret(input.title) || holdsSecret(input.brief)) {
      refuse(
        'secret_in_text',
        'The task holds something that looks like a token or key. Tasks never carry secrets: ' +
          'remove it and describe where the other agent can find what it needs.',
      );
    }

    const target = this.resolveTarget(caller, input.to, refuse);

    const parent = this.parentFor(caller, input.forTask, refuse);
    if (parent) {
      if (parent.hops + 1 > TASK_LIMITS.maxHops) {
        refuse(
          'hop_limit',
          `You're working on ${parent.id}, which is already a sub-task: a task may spawn only one ` +
            'level of sub-task. Finish it, or set it to input-required and ask its creator.',
        );
      }
      if (this.loopsBack(parent, target)) {
        refuse(
          'task_loop',
          `That would hand work back to a session earlier in ${parent.id}'s chain. ` +
            'Use update_task with state input-required to ask its creator instead.',
        );
      }
    }

    const since = new Date(this.now().getTime() - HOUR_MS);
    if (
      this.store.countEvents({ kind: 'task.created', sessionId: caller.id, since }) >=
      TASK_LIMITS.createdPerSessionPerHour
    ) {
      refuse('too_many_tasks', 'Too many new tasks from this session this hour; try again later.');
    }
    if (this.tasks.countOpenForTarget(target, caller.platform) >= TASK_LIMITS.openPerTarget) {
      refuse('too_many_tasks', 'Too many open tasks for that target; wait for some to finish.');
    }
    if (
      this.tasks.countAwaitingApproval(caller.platform) >= TASK_LIMITS.awaitingApprovalPerPlatform
    ) {
      refuse(
        'too_many_tasks',
        `Too many tasks from ${caller.platform} already wait for Nick's approval; ` +
          'try again once he has answered some.',
      );
    }

    return this.store.transaction(() => {
      const task = this.tasks.insertTask({
        createdBy: caller.id,
        title: input.title,
        brief: input.brief,
        targetSession: 'session' in target ? target.session : null,
        targetPlatform: target.platform,
        targetProject: target.project,
        parentId: parent?.id ?? null,
        approvalExpiresAt: new Date(this.now().getTime() + TASK_LIMITS.approvalTtlMs),
      });
      this.events?.created(task);
      return task;
    });
  }

  /**
   * The tasks the caller may see (TaskStore.visibleTasks), or one of them by
   * ID. A task it can't see gets the same answer as an ID that doesn't exist
   * (T7), so nobody can probe for other sessions' tasks.
   */
  listTasks(input: ListTasksInput): TaskRecord[] {
    const caller = this.service.requireKeyedSession(
      input.platform,
      input.session,
      input.key,
      'list_tasks',
    );
    if (input.task === undefined) return this.tasks.visibleTasks(caller, TASK_LIMITS.listMax);
    const task = this.tasks.getTask(input.task);
    if (!task || !canSee(task, caller)) {
      this.deny(caller, 'unknown_task', 'list_tasks');
      throw new BusError('unknown_task', `Unknown task "${input.task.slice(0, 20)}".`);
    }
    return [task];
  }

  /**
   * Claims an approved, unclaimed task: a named target its own task, or a
   * pool member a task for its platform and project. Of two racing claims
   * exactly one wins; the other is told who has it (T13).
   */
  claimTask(input: ClaimTaskInput): TaskRecord {
    // An approved task aimed at the caller stays visible to claim_task once
    // claimed, so a session that lost the race hears who won (T13).
    const { caller, task } = this.visibleTask(
      input,
      'claim_task',
      (found, who) => found.approval === 'approved' && aimedAt(found, who),
    );
    const refuse = this.refuser(caller, 'claim_task');
    if (!aimedAt(task, caller)) refuse('not_allowed', `${task.id} isn't for you to claim.`);
    if (task.approval !== 'approved') {
      refuse('bad_state', `${task.id} still waits for Nick's approval.`);
    }
    const claimed = this.store.transaction(() => {
      const after = this.tasks.moveTask(task.id, {
        from: 'submitted',
        to: 'working',
        by: caller.id,
        holder: caller.id,
      });
      if (after) this.events?.moved(after, 'submitted', caller.id);
      return after;
    });
    if (claimed) return claimed;
    const now = this.tasks.getTask(task.id);
    return refuse(
      'task_taken',
      now?.holder
        ? `${task.id} was already claimed by ${now.holder}.`
        : `${task.id} can't be claimed: it's ${now?.state ?? 'gone'}.`,
    );
  }

  /** Moves or annotates a task, by the rules on UpdateTaskInput. */
  updateTask(input: UpdateTaskInput): TaskRecord {
    const { caller, task } = this.visibleTask(input, 'update_task');
    const refuse = this.refuser(caller, 'update_task');
    const note = input.note;
    if (note !== undefined) this.checkText(note, refuse);
    if (input.result && input.state !== 'completed') {
      return refuse('bad_result', 'A result goes only with state completed.');
    }
    const result = input.result ? this.checkResult(input.result, refuse) : undefined;
    const isHolder = task.holder === caller.id;
    const notHolder = (): never =>
      refuse('not_allowed', `Only the session working on ${task.id} can do that.`);
    const lost = (): never =>
      refuse('bad_state', `${task.id} changed meanwhile; read it again with list_tasks.`);

    if (input.state === undefined) {
      if (note === undefined) return refuse('bad_state', 'Give a state, a note, or both.');
      if (!isHolder) return notHolder();
      const noted = this.store.transaction(() => {
        const after = this.tasks.noteTask(task.id, caller.id, note);
        if (after) this.events?.noted(after, caller.id);
        return after;
      });
      return noted ?? lost();
    }

    const to = input.state;
    const held = task.state === 'working' || task.state === 'input-required';
    let from: TaskState;
    if (to === 'canceled') {
      if (task.createdBy !== caller.id) {
        return refuse('not_allowed', `Only the session that created ${task.id} can cancel it.`);
      }
      from = task.state;
    } else if (to === 'rejected') {
      if (task.targetSession !== caller.id) {
        return refuse('not_allowed', `Only the session ${task.id} was sent to can reject it.`);
      }
      if (!note) return refuse('bad_state', 'Say why in a note when you reject a task.');
      from = 'submitted';
    } else {
      if (!isHolder || !held) return notHolder();
      from = task.state;
      if ((to === 'input-required' || to === 'failed') && !note) {
        return refuse('bad_state', `Say why in a note when you set ${to}.`);
      }
      if (to === 'completed' && !result) {
        return refuse('bad_result', 'Give a result when you complete a task.');
      }
    }
    if (task.state !== from || !canMoveTask(from, to)) {
      return refuse('bad_state', `${task.id} is ${task.state}; it can't move to ${to}.`);
    }

    // The move and its notice commit together, so a notice is never lost.
    const moved = this.store.transaction(() => {
      const after = this.tasks.moveTask(task.id, {
        from,
        to,
        by: caller.id,
        ...(held ? { expectedHolder: task.holder ?? '' } : {}),
        ...(note !== undefined ? { statusMessage: note } : {}),
        ...(result ? { result } : {}),
      });
      if (after) {
        this.notify(after, to, task.holder);
        this.events?.moved(after, from, caller.id);
      }
      return after;
    });
    return moved ?? lost();
  }

  /**
   * The fixed notices for a move (Q21): the creator hears input-required,
   * completed, failed and rejected; whoever held it, or the named target of
   * an approved task, hears it was canceled. Delivery is #60's.
   */
  private notify(task: TaskRecord, to: TaskState, previousHolder: string | null): void {
    if (to === 'input-required' || to === 'completed' || to === 'failed' || to === 'rejected') {
      this.tasks.addNotice(task.createdBy, task.id, to);
    } else if (to === 'canceled') {
      // A named target hears only of a task it could see (approved, T7).
      const target = previousHolder ?? (task.approval === 'approved' ? task.targetSession : null);
      if (target) this.tasks.addNotice(target, task.id, 'canceled');
    }
  }

  /** The keyed caller and a task it can see; anything else is `unknown_task` (T7). */
  private visibleTask(
    input: { platform: Platform; session: string; key: string | undefined; task: string },
    action: string,
    also: (task: TaskRecord, caller: SessionRecord) => boolean = () => false,
  ): { caller: SessionRecord; task: TaskRecord } {
    const caller = this.service.requireKeyedSession(
      input.platform,
      input.session,
      input.key,
      action,
    );
    const task = this.tasks.getTask(input.task);
    if (!task || !(canSee(task, caller) || also(task, caller))) {
      this.deny(caller, 'unknown_task', action);
      throw new BusError('unknown_task', `Unknown task "${input.task.slice(0, 20)}".`);
    }
    return { caller, task };
  }

  /**
   * The parent of a new task (Q4): the held task named by `forTask`, or the
   * only one the caller holds. Holding several without naming one is refused
   * rather than guessed.
   */
  private parentFor(
    caller: SessionRecord,
    forTask: string | undefined,
    refuse: (code: BusErrorCode, message: string) => never,
  ): TaskRecord | undefined {
    const held = this.tasks.heldTasks(caller.id);
    if (forTask !== undefined) {
      const parent = held.find((task) => task.id === forTask);
      return parent ?? refuse('which_task', `You aren't working on "${forTask.slice(0, 20)}".`);
    }
    if (held.length > 1) {
      return refuse(
        'which_task',
        `You're working on ${held.map((task) => task.id).join(', ')}: pass for_task to say which ` +
          'one this is a sub-task of.',
      );
    }
    return held[0];
  }

  private checkText(text: string, refuse: (code: BusErrorCode, message: string) => never): void {
    if (text.length > TASK_LIMITS.textMax) {
      refuse('too_long', `Keep notes and results under ${TASK_LIMITS.textMax} characters.`);
    }
    if (holdsSecret(text)) {
      refuse(
        'secret_in_text',
        'That holds something that looks like a token or key. Tasks never carry secrets.',
      );
    }
  }

  /**
   * A result is text plus `https:` links (T10, T11, T12), returned with each
   * link as the parsed URL's own form. Refused: other schemes, whitespace or
   * control characters (which URL parsing would silently drop), a user name
   * or password, an over-long link, or anything token-shaped.
   */
  private checkResult(
    result: TaskResult,
    refuse: (code: BusErrorCode, message: string) => never,
  ): TaskResult {
    this.checkText(result.text, refuse);
    if (result.links.length > TASK_LIMITS.resultLinks) {
      refuse('bad_result', `At most ${TASK_LIMITS.resultLinks} links in a result.`);
    }
    const links = result.links.map((link) => {
      // No whitespace and no control characters (code points up to 0x1f, and 0x7f).
      const plain =
        !/\s/.test(link) &&
        [...link].every((char) => {
          const code = char.codePointAt(0) ?? 0;
          return code > 0x1f && code !== 0x7f;
        });
      let url: URL | undefined;
      try {
        url = new URL(link);
      } catch {
        url = undefined;
      }
      if (
        !plain ||
        !url ||
        url.protocol !== 'https:' ||
        url.username !== '' ||
        url.password !== '' ||
        link.length > TASK_LIMITS.linkMax
      ) {
        return refuse(
          'bad_result',
          'Result links must be plain https: URLs, without spaces or a user name and password.',
        );
      }
      if (holdsSecret(link)) {
        refuse('secret_in_text', 'A link holds something that looks like a token or key.');
      }
      return url.href;
    });
    return { text: result.text, links };
  }

  private refuser(caller: SessionRecord, action: string) {
    return (code: BusErrorCode, message: string): never => {
      this.deny(caller, code, action);
      throw new BusError(code, message);
    };
  }

  /**
   * Checks a target against D1 (cross-platform only) and Q13 (Copilot only
   * as a pool), returning it with the platform and project filled in.
   */
  private resolveTarget(
    caller: SessionRecord,
    to: TaskTarget,
    refuse: (code: BusErrorCode, message: string) => never,
  ):
    | { session: string; platform: Platform; project: string }
    | { platform: Platform; project: string } {
    if ('session' in to) {
      const target = this.store.getSession(to.session);
      if (!target) return refuse('unknown_target', `Unknown session "${to.session.slice(0, 80)}".`);
      if (target.platform === caller.platform) {
        return refuse(
          'same_platform',
          'Tasks go to another platform only; use your own app to work with sessions on yours.',
        );
      }
      if (target.platform === 'copilot') {
        return refuse(
          'invalid_target',
          "Copilot session IDs change when it restarts, so send it to Copilot's pool: " +
            'to_platform "copilot" and to_project instead of to_session.',
        );
      }
      return { session: target.id, platform: target.platform, project: target.project };
    }
    if (to.platform === caller.platform) {
      return refuse(
        'same_platform',
        'Tasks go to another platform only; use your own app to work with sessions on yours.',
      );
    }
    const project = projectSlug(to.project);
    if (project === NO_PROJECT && to.project.trim().toLowerCase() !== NO_PROJECT) {
      return refuse(
        'invalid_target',
        "That project name can't be used; give the repo or folder name.",
      );
    }
    return { platform: to.platform, project };
  }

  /**
   * Whether `target` is a session (or a pool holding one) that created a task
   * earlier in `held`'s chain: A → B → A (Q18).
   */
  private loopsBack(
    held: TaskRecord,
    target: TaskTarget & { platform: Platform; project: string },
  ): boolean {
    for (let task: TaskRecord | undefined = held; task;) {
      const creator = this.store.getSession(task.createdBy);
      if (
        'session' in target
          ? target.session === task.createdBy
          : creator && creator.platform === target.platform && creator.project === target.project
      ) {
        return true;
      }
      task = task.parentId ? this.tasks.getTask(task.parentId) : undefined;
    }
    return false;
  }

  private deny(caller: SessionRecord, reason: BusErrorCode, action: string): void {
    this.store.appendEvent({
      kind: 'denied',
      platform: caller.platform,
      sessionId: caller.id,
      data: { action, reason },
    });
  }
}

/** Whether a task is for this session: named for it, or for its platform and project's pool. */
function aimedAt(task: TaskRecord, caller: SessionRecord): boolean {
  return task.targetSession === null
    ? task.targetPlatform === caller.platform && task.targetProject === caller.project
    : task.targetSession === caller.id;
}

/** The single-task form of TaskStore.visibleTasks: the two must agree (tested). */
export function canSee(task: TaskRecord, caller: SessionRecord): boolean {
  if (task.createdBy === caller.id || task.holder === caller.id) return true;
  if (task.approval !== 'approved') return false;
  if (task.targetSession !== null) return task.targetSession === caller.id;
  return (
    task.state === 'submitted' &&
    task.targetPlatform === caller.platform &&
    task.targetProject === caller.project
  );
}
