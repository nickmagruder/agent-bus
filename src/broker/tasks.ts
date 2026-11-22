import type { Platform } from '../shared/platform.ts';
import { NO_PROJECT, projectSlug } from '../shared/session-id.ts';
import { BusError, type BusErrorCode, type BusService } from './service.ts';
import type { SessionRecord, Store } from './store.ts';
import { TaskStore, type TaskRecord } from './task-store.ts';

/**
 * Phase 3 task rules (#59, part 1: create and list). Decisions D1, D2, D5,
 * D7 and grilling Q4, Q13, Q17, Q18, Q20 in docs/phase-3.md. Every call needs
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

  constructor(store: Store, service: BusService, now: () => Date = service.clock) {
    this.store = store;
    this.service = service;
    this.tasks = new TaskStore(store, now);
    this.now = now;
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

    const held = this.tasks.heldTasks(caller.id);
    const parent = held[0];
    for (const task of held) {
      if (task.hops + 1 > TASK_LIMITS.maxHops) {
        refuse(
          'hop_limit',
          `You're working on ${task.id}, which is already a sub-task: a task may spawn only one ` +
            'level of sub-task. Finish it, or set it to input-required and ask its creator.',
        );
      }
      if (this.loopsBack(task, target)) {
        refuse(
          'task_loop',
          `That would hand work back to a session earlier in ${task.id}'s chain. ` +
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

    return this.tasks.insertTask({
      createdBy: caller.id,
      title: input.title,
      brief: input.brief,
      targetSession: 'session' in target ? target.session : null,
      targetPlatform: target.platform,
      targetProject: target.project,
      parentId: parent?.id ?? null,
      approvalExpiresAt: new Date(this.now().getTime() + TASK_LIMITS.approvalTtlMs),
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
