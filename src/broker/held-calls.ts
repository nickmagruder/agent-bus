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
export class HeldCalls {
  private readonly calls = new Map<string, Set<AbortController>>();

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

  /** Ends the matching held calls; returns how many. */
  cancel(platform: Platform, requestId: RequestId, reason = 'cancelled by the client'): number {
    const set = this.calls.get(HeldCalls.key(platform, requestId));
    if (!set) return 0;
    for (const controller of set) controller.abort(reason);
    return set.size;
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
