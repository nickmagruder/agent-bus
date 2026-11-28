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

/** Audit kind for an outage: `state` is `down` (DM sent) or `back` (link restored). */
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

export class SlackWatchdog {
  private readonly options: SlackWatchdogOptions;
  private readonly now: () => Date;
  private readonly stuckAfterMs: number;
  /** When the link was last seen not connected after being connected (or at start). */
  private downSince: Date | undefined;
  private stuck = false;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(options: SlackWatchdogOptions) {
    this.options = options;
    this.now = options.now ?? (() => new Date());
    this.stuckAfterMs = options.stuckAfterMs ?? SLACK_WATCHDOG.stuckAfterMs;
    // Startup counts: a link that never connects is as stuck as one that dropped.
    this.downSince = this.now();
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
    // One DM per outage, across restarts: skip it while the last one is unanswered by a "back".
    if (store.latestEventOfKind(OUTAGE_EVENT)?.data.state !== 'down') {
      const since = this.downSince.toISOString();
      store.transaction(() => {
        store.enqueue({ target: DM_TARGET, text: downText(since) });
        store.appendEvent({
          kind: OUTAGE_EVENT,
          data: { state: 'down', since, slack: connection.state },
        });
      });
      this.options.kick();
    }
    this.options.log('warn', 'Slack link stuck; restarting the broker', {
      state: connection.state,
      since: this.downSince.toISOString(),
    });
    store.appendEvent({
      kind: 'slack.stuck',
      data: { state: connection.state, since: this.downSince.toISOString() },
    });
    this.options.onStuck?.();
  }

  /** Connected again after a "down" DM (maybe from before a restart): tell me, once. */
  private announceBack(): void {
    const { store } = this.options;
    const last = store.latestEventOfKind(OUTAGE_EVENT);
    if (last?.data.state !== 'down') return;
    const since = typeof last.data.since === 'string' ? last.data.since : last.at;
    const until = this.now().toISOString();
    store.transaction(() => {
      store.enqueue({ target: DM_TARGET, text: backText(since, until) });
      store.appendEvent({ kind: OUTAGE_EVENT, data: { state: 'back', since, until } });
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

/** A day and time for Slack ("Mon 3:05 PM"). */
function when(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit',
  });
}
