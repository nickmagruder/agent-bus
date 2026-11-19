import type { Inbox, InboxTake } from './inbox.ts';
import { inboxText } from './mcp.ts';
import { LIMITS, type StopInboxCheck } from './service.ts';
import type { SessionRecord } from './store.ts';

/**
 * One `/hook` request's Stop-hook delivery. `check` takes the session's
 * undelivered replies and question outcomes (via `stop_hook`, no ✅ yet) and
 * words them as the block reason. Once the response is done, `settle` either
 * confirms them (✅) or, if the response never reached the hook (it timed out
 * or the connection dropped), puts them back so they aren't lost.
 */
export class StopDelivery {
  private readonly inbox: Inbox;
  private taken: { session: SessionRecord; take: InboxTake } | undefined;
  private settled = false;

  constructor(inbox: Inbox) {
    this.inbox = inbox;
  }

  readonly check: StopInboxCheck = (session) => {
    const take = this.inbox.take(session, 'stop_hook', LIMITS.stopTakePerBlock, { react: false });
    if (take.messages.length === 0 && take.outcomes.length === 0) return undefined;
    this.taken = { session, take };
    return stopReason(take);
  };

  /** `written`: the whole response was handed to the socket before it closed. */
  settle(written: boolean): void {
    if (this.settled || !this.taken) return;
    this.settled = true;
    if (written) this.inbox.confirm(this.taken.take);
    else this.inbox.untake(this.taken.session, this.taken.take, 'stop_hook');
  }
}

export function stopReason(take: InboxTake): string {
  return (
    'agent-bus: Nick replied in Slack before you stopped. Read his reply and act on it ' +
    '(answer him with notify_human if he asked something), then finish your turn.\n\n' +
    inboxText(take.messages, take.outcomes, take.remaining)
  );
}
