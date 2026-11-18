import type { App } from '@slack/bolt';
import type { InboundMessage, Inbox } from '../inbox.ts';
import { errorMessage, type Logger } from '../log.ts';

/**
 * Reduces a Slack `message` event to the fields the inbox routes on.
 * Returns undefined for events without a channel or ts.
 */
export function toInboundMessage(event: unknown): InboundMessage | undefined {
  if (typeof event !== 'object' || event === null) return undefined;
  const e = event as Record<string, unknown>;
  const channel = str(e.channel);
  const ts = str(e.ts);
  if (!channel || !ts) return undefined;
  return {
    channel,
    channelType: str(e.channel_type) ?? 'unknown',
    ts,
    threadTs: str(e.thread_ts),
    user: str(e.user),
    botId: str(e.bot_id),
    subtype: str(e.subtype),
    text: str(e.text) ?? '',
    hasFiles: Array.isArray(e.files) && e.files.length > 0,
  };
}

/**
 * Listens for messages in channels the bot is in and in my DM with it.
 * Needs the `message.channels` and `message.im` event subscriptions (and
 * `message.groups` for private channels). Bolt acknowledges each event;
 * routing is synchronous SQLite work, so nothing slow runs before the ack.
 */
export function registerInbound(app: App, inbox: Inbox, log: Logger): void {
  app.event('message', async ({ event }) => {
    const message = toInboundMessage(event);
    if (!message) return;
    try {
      const outcome = inbox.receive(message);
      if (outcome.action === 'routed') {
        log('info', 'Slack reply routed', { session: outcome.sessionId });
      }
    } catch (error) {
      log('error', 'Slack message handling failed', { error: errorMessage(error) });
    }
  });
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}
