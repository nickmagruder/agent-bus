import type { Platform } from '../shared/platform.ts';

type RequestId = string | number;

/**
 * The held tool calls (ask_human, wait_for_reply) running anywhere in the
 * broker, so a cancel can find them. `/mcp` is stateless: a client's
 * `notifications/cancelled` arrives on its own POST, which a fresh MCP server
 * handles, never the server holding the call. Calls are keyed by platform
 * and JSON-RPC request ID. IDs are per client, so two clients of one platform
 * can share one: a cancel then also ends the other's hold early, which only
 * makes that call return "pending" sooner (it calls wait_for_reply again).
 */
/**
 * How long a held call that handed something over can still be undone by a
 * cancel. A client cancels locally first and sends `notifications/cancelled`
 * at once, so a cancel that arrives after the answer means the client
 * dropped it unread (MCP clients only cancel requests they haven't finished).
 */
export const UNDO_WINDOW_MS = 5000;

export class HeldCalls {
  private readonly calls = new Map<string, Set<AbortController>>();
  private readonly answered = new Map<string, Set<() => void>>();

  /** Registers a held call; its signal aborts on a matching cancel. Call `release` when the hold ends. */
  hold(platform: Platform, requestId: RequestId): { signal: AbortSignal; release: () => void } {
    const key = HeldCalls.key(platform, requestId);
    const controller = new AbortController();
    const set = this.calls.get(key) ?? new Set();
    set.add(controller);
    this.calls.set(key, set);
    return {
      signal: controller.signal,
      release: () => {
        set.delete(controller);
        if (set.size === 0 && this.calls.get(key) === set) this.calls.delete(key);
      },
    };
  }

  /**
   * Records that a held call answered with something it took (replies, an
   * outcome): a cancel for it within UNDO_WINDOW_MS runs `undo`, putting
   * them back for the next call.
   */
  answeredWith(platform: Platform, requestId: RequestId, undo: () => void): void {
    const key = HeldCalls.key(platform, requestId);
    const set = this.answered.get(key) ?? new Set();
    const entry = () => {
      forget();
      undo();
    };
    const forget = () => {
      clearTimeout(timer);
      set.delete(entry);
      if (set.size === 0 && this.answered.get(key) === set) this.answered.delete(key);
    };
    const timer = setTimeout(forget, UNDO_WINDOW_MS);
    timer.unref();
    set.add(entry);
    this.answered.set(key, set);
  }

  /**
   * Ends the matching held calls, or undoes the hand-over of one that just
   * answered (its client cancelled before reading the answer). Returns how
   * many calls it affected.
   */
  cancel(platform: Platform, requestId: RequestId, reason = 'cancelled by the client'): number {
    const key = HeldCalls.key(platform, requestId);
    const set = this.calls.get(key);
    if (set && set.size > 0) {
      for (const controller of set) controller.abort(reason);
      return set.size;
    }
    const answered = this.answered.get(key);
    if (!answered) return 0;
    const undos = [...answered];
    for (const undo of undos) undo();
    return undos.length;
  }

  /** Answered calls that can still be undone (tests). */
  get undoable(): number {
    let n = 0;
    for (const set of this.answered.values()) n += set.size;
    return n;
  }

  /** Ends every held call (the broker is stopping). */
  cancelAll(reason: string): void {
    for (const set of this.calls.values()) for (const controller of set) controller.abort(reason);
  }

  /** Resolves once no call is held, or after `ms`, whichever comes first. */
  async drained(ms: number): Promise<void> {
    const deadline = Date.now() + ms;
    while (this.size > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    // Let the ended calls' responses reach their sockets.
    await new Promise((resolve) => setImmediate(resolve));
  }

  /** Held calls registered right now (tests check nothing is left behind). */
  get size(): number {
    let n = 0;
    for (const set of this.calls.values()) n += set.size;
    return n;
  }

  private static key(platform: Platform, requestId: RequestId): string {
    return `${platform}\u0000${typeof requestId}\u0000${String(requestId)}`;
  }
}
