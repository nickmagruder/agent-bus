import type { Logger } from '../log.ts';
import { DM_TARGET, type Store } from '../store.ts';
import type { ConnectionState } from './connection.ts';

/**
 * Socket Mode watchdog (#106). After a network loss the Socket Mode client
 * can stay on "reconnecting" for good while the Web API still works: my
 * clicks and replies are then dropped without a trace. If the link hasn't
 * been `connected` for `stuckAfterMs`, I get one DM (posts still go out)
 * and the broker asks to be restarted, which the login launcher does.
 */
export const SLACK_WATCHDOG = {
  tickMs: 30_000,
  /** Down this long (never connected since start counts too): DM me and restart. */
  stuckAfterMs: 5 * 60_000,
};

/** Audit kind for an outage: `state` is `down` (DM queued) or `back` (link restored). */
export const OUTAGE_EVENT = 'slack.outage';

export interface SlackWatchdogOptions {
  connection: { readonly state: ConnectionState };
  store: Store;
  /** Sends queued posts now. */
  kick: () => void;
  log: Logger;
  /** Called once when the link is stuck: the broker exits so the launcher restarts it. */
  onStuck?: () => void;
  now?: () => Date;
  stuckAfterMs?: number;
}

/** The newest outage event, kept in memory so connected ticks don't query. */
interface Outage {
  state: 'down' | 'back';
  since: string;
  /** The "down" DM's outbox row. */
  post?: number;
}

export class SlackWatchdog {
  private readonly options: SlackWatchdogOptions;
  private readonly now: () => Date;
  private readonly stuckAfterMs: number;
  /** When the link was last seen not connected after being connected (or at start). */
  private downSince: Date | undefined;
  private stuck = false;
  private outage: Outage | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(options: SlackWatchdogOptions) {
    this.options = options;
    this.now = options.now ?? (() => new Date());
    this.stuckAfterMs = options.stuckAfterMs ?? SLACK_WATCHDOG.stuckAfterMs;
    // Startup counts: a link that never connects is as stuck as one that dropped.
    this.downSince = this.now();
    // An outage DMed before a restart is still open: don't DM it again, and say when it ends.
    this.outage = readOutage(options.store);
  }

  start(tickMs: number = SLACK_WATCHDOG.tickMs): void {
    this.timer = setInterval(() => this.safeTick(), tickMs);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  tick(): void {
    const { connection, store } = this.options;
    if (connection.state === 'connected') {
      this.downSince = undefined;
      this.stuck = false;
      this.announceBack();
      return;
    }
    const now = this.now();
    this.downSince ??= now;
    if (this.stuck || now.getTime() - this.downSince.getTime() < this.stuckAfterMs) return;
    this.stuck = true;
    const since = this.downSince.toISOString();
    if (this.needsDownDm()) {
      // A retry after a failed DM keeps the outage's first start.
      const outageSince = this.outage?.state === 'down' ? this.outage.since : since;
      this.outage = store.transaction(() => {
        const post = store.enqueue({ target: DM_TARGET, text: downText(outageSince) });
        store.appendEvent({
          kind: OUTAGE_EVENT,
          data: { state: 'down', since: outageSince, slack: connection.state, post: post.id },
        });
        return { state: 'down' as const, since: outageSince, post: post.id };
      });
      this.options.kick();
    }
    this.options.log('warn', 'Slack link stuck; restarting the broker', {
      state: connection.state,
      since,
    });
    store.appendEvent({ kind: 'slack.stuck', data: { state: connection.state, since } });
    this.options.onStuck?.();
  }

  /**
   * One "down" DM per outage, across restarts. A DM the queue gave up on
   * (the Web API failing too) doesn't count: it's queued again.
   */
  private needsDownDm(): boolean {
    if (this.outage?.state !== 'down') return true;
    if (this.outage.post === undefined) return false;
    return this.options.store.getPost(this.outage.post)?.state === 'failed';
  }

  /** Connected again after a "down" DM (maybe from before a restart): tell me, once. */
  private announceBack(): void {
    if (this.outage?.state !== 'down') return;
    const { store } = this.options;
    const { since } = this.outage;
    const until = this.now().toISOString();
    this.outage = store.transaction(() => {
      store.enqueue({ target: DM_TARGET, text: backText(since, until) });
      store.appendEvent({ kind: OUTAGE_EVENT, data: { state: 'back', since, until } });
      return { state: 'back' as const, since };
    });
    this.options.kick();
  }

  private safeTick(): void {
    try {
      this.tick();
    } catch (error) {
      this.options.log('error', 'Slack watchdog tick failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

function readOutage(store: Store): Outage | undefined {
  const last = store.latestEventOfKind(OUTAGE_EVENT);
  if (!last) return undefined;
  const { state, since, post } = last.data;
  return {
    state: state === 'down' ? 'down' : 'back',
    since: typeof since === 'string' ? since : last.at,
    ...(typeof post === 'number' ? { post } : {}),
  };
}

export function downText(since: string): string {
  return (
    `:warning: agent-bus has had no Slack link for clicks and replies since ${when(since)}: ` +
    "buttons and replies in Slack aren't reaching agents. Restarting the broker to recover; " +
    "I'll say when it's back."
  );
}

export function backText(since: string, until: string): string {
  return (
    `:white_check_mark: agent-bus's Slack link is back (down from ${when(since)} to ${when(until)}). ` +
    'Clicks and replies from that time were lost: click or reply again if one mattered.'
  );
}

/** A date and time for Slack ("Mon, Nov 23, 3:05 PM"). */
function when(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}
