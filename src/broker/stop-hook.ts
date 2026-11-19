import type { Inbox, InboxTake } from './inbox.ts';
import { inboxText } from './mcp.ts';
import { LIMITS, type StopInboxCheck, type StopOffers } from './service.ts';
import type { SessionRecord, Store } from './store.ts';

/** Audit events for one Stop-hook offer of my replies. */
const OFFER = {
  offered: 'stop.offered',
  confirmed: 'stop.confirmed',
  returned: 'stop.returned',
} as const;

interface Offer {
  messageIds: number[];
  questionIds: string[];
}

/**
 * Stop-hook delivery of my Slack replies, at least once.
 *
 * `check` takes the session's undelivered replies and question outcomes
 * (marked delivered via `stop_hook`, so check_inbox can't hand them over a
 * second time) and records the offer. If the response never reaches the
 * hook (timed out, connection dropped), `settle` puts them back at once.
 * Otherwise the offer stays open until the next turn event (see StopOffers):
 * the app proves it acted on the block with a `stop_hook_active` Stop, and
 * only then do the replies get ✅; any other turn event puts them back for
 * the next stop or check_inbox.
 */
export class StopDelivery implements StopOffers {
  private readonly inbox: Inbox;
  private readonly store: Store;
  private taken: { session: SessionRecord; take: InboxTake } | undefined;
  private settled = false;

  constructor(inbox: Inbox, store: Store) {
    this.inbox = inbox;
    this.store = store;
  }

  readonly check: StopInboxCheck = (session) => {
    const take = this.inbox.take(session, 'stop_hook', LIMITS.stopTakePerBlock, { react: false });
    if (take.messages.length === 0 && take.outcomes.length === 0) return undefined;
    this.taken = { session, take };
    const offer: Offer = {
      messageIds: take.messages.map((m) => m.id),
      questionIds: take.outcomes.map((q) => q.id),
    };
    this.store.appendEvent({
      kind: OFFER.offered,
      platform: session.platform,
      sessionId: session.id,
      data: { ...offer },
    });
    return stopReason(take);
  };

  /** `written`: the whole response was handed to the socket before it closed. */
  settle(written: boolean): void {
    if (this.settled || !this.taken) return;
    this.settled = true;
    if (written) return; // the next turn event confirms or returns the offer
    const { session, take } = this.taken;
    this.store.transaction(() => {
      this.inbox.untake(session, take, 'stop_hook');
      this.closeOffer(session, OFFER.returned, 'unwritten');
    });
  }

  confirm(session: SessionRecord): void {
    const offer = this.openOffer(session);
    if (!offer) return;
    this.closeOffer(session, OFFER.confirmed, 'stop_hook_active');
    this.inbox.confirmIds(offer.messageIds, offer.questionIds);
  }

  putBack(session: SessionRecord, reason: string): void {
    const offer = this.openOffer(session);
    if (!offer) return;
    this.store.transaction(() => {
      this.inbox.untakeIds(session, offer.messageIds, offer.questionIds, 'stop_hook');
      this.closeOffer(session, OFFER.returned, reason);
    });
  }

  /** The session's last offer, if neither confirmed nor returned since. */
  private openOffer(session: SessionRecord): Offer | undefined {
    const last = this.store.latestSessionEvent(session.id, Object.values(OFFER));
    if (last?.kind !== OFFER.offered) return undefined;
    const { messageIds, questionIds } = last.data as Partial<Offer>;
    return { messageIds: messageIds ?? [], questionIds: questionIds ?? [] };
  }

  private closeOffer(session: SessionRecord, kind: string, reason: string): void {
    this.store.appendEvent({
      kind,
      platform: session.platform,
      sessionId: session.id,
      data: { reason },
    });
  }
}

export function stopReason(take: InboxTake): string {
  return (
    'agent-bus: Nick replied in Slack before you stopped. Read his reply and act on it ' +
    '(answer him with notify_human if he asked something), then finish your turn.\n\n' +
    inboxText(take.messages, take.outcomes, take.remaining)
  );
}
