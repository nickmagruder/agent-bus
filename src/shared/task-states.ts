/**
 * Task states (#57, decision D8): A2A v1.0 meanings with short lowercase
 * names in the tools and records, which agents read and type easily. The
 * `TASK_STATE_*` enums appear only on an A2A endpoint (Phase 5), through
 * A2A_TASK_STATE below, so that endpoint isn't a rename.
 */

/** States a task can be in, as stored and as the tools spell them. */
export const TASK_STATES = [
  'submitted',
  'working',
  'input-required',
  'completed',
  'failed',
  'canceled',
  'rejected',
] as const;

export type TaskState = (typeof TASK_STATES)[number];

/** States a task never leaves. */
export const TERMINAL_TASK_STATES: ReadonlySet<TaskState> = new Set([
  'completed',
  'failed',
  'canceled',
  'rejected',
]);

/**
 * Every internal name and its A2A v1.0 enum. `auth-required` (credentials
 * needed mid-task) is mapped for completeness but never used: tasks never
 * carry credentials or approvals (T10). `TASK_STATE_UNSPECIFIED` is A2A's
 * zero value, never a real state, so nothing maps to it.
 */
export const A2A_TASK_STATE = {
  submitted: 'TASK_STATE_SUBMITTED',
  working: 'TASK_STATE_WORKING',
  'input-required': 'TASK_STATE_INPUT_REQUIRED',
  completed: 'TASK_STATE_COMPLETED',
  failed: 'TASK_STATE_FAILED',
  canceled: 'TASK_STATE_CANCELED',
  rejected: 'TASK_STATE_REJECTED',
  'auth-required': 'TASK_STATE_AUTH_REQUIRED',
} as const satisfies Record<TaskState | 'auth-required', string>;

/**
 * The moves the store allows. Who may make each move (holder, creator, me)
 * is the tools' rule (#59); the store only refuses moves that make no sense.
 * - submitted: claimed (working), declined (rejected) or canceled.
 * - working: asks back (input-required), finishes, fails, is canceled, or is
 *   released by me when stuck (back to submitted, grilling Q8).
 * - input-required: answered (working), failed, canceled, or released when
 *   stuck (Q8 offers Cancel and Release whatever the holder is waiting on).
 *   It can't finish straight from here: the answer puts it back to working
 *   first, so "completed" always follows work.
 */
export const TASK_TRANSITIONS: Readonly<Record<TaskState, readonly TaskState[]>> = {
  submitted: ['working', 'rejected', 'canceled'],
  working: ['input-required', 'completed', 'failed', 'canceled', 'submitted'],
  'input-required': ['working', 'failed', 'canceled', 'submitted'],
  completed: [],
  failed: [],
  canceled: [],
  rejected: [],
};

export function canMoveTask(from: TaskState, to: TaskState): boolean {
  return TASK_TRANSITIONS[from].includes(to);
}
