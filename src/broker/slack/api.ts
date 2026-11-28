import {
  WebAPIPlatformError,
  WebAPIRateLimitedError,
  WebClient,
  type ConversationsOpenResponse,
} from '@slack/web-api';

export interface PostMessageArgs {
  channel: string;
  text: string;
  threadTs?: string;
  username?: string;
  icon?: string;
  /** Block Kit blocks; `text` is then the notification fallback. */
  blocks?: unknown[];
}

/**
 * The few Slack Web API calls the broker makes. The queue and channel
 * directory depend on this interface, so tests use a fake.
 */
export interface SlackApi {
  postMessage(args: PostMessageArgs): Promise<{ channel: string; ts: string }>;
  /** Opens (or finds) the DM channel with a user. */
  openDm(userId: string): Promise<string>;
  /** Channels the bot is a member of, by name (without `#`). */
  memberChannels(): Promise<Map<string, string>>;
  /** Adds an emoji reaction to a message; an existing reaction is not an error. */
  addReaction(channel: string, ts: string, name: string): Promise<void>;
  /** Replaces a message the bot posted (e.g. a question's buttons once answered). */
  updateMessage(channel: string, ts: string, text: string, blocks?: unknown[]): Promise<void>;
}

/**
 * `network`: Slack never answered (offline, DNS, timeout): retried until the
 * post is too old (#105). `transient`: Slack answered with an error that may
 * pass: retried a few times. `permanent`: won't fix itself.
 */
export type SlackFailure = 'rate_limited' | 'permanent' | 'transient' | 'network';

/** A Slack call failed; `kind` tells the queue whether to wait, retry or give up. */
export class SlackSendError extends Error {
  readonly kind: SlackFailure;
  readonly retryAfterMs: number;

  constructor(kind: SlackFailure, message: string, retryAfterMs = 0) {
    super(message);
    this.name = 'SlackSendError';
    this.kind = kind;
    this.retryAfterMs = retryAfterMs;
  }
}

/** Slack errors that won't fix themselves on retry. */
const PERMANENT_ERRORS = new Set([
  'account_inactive',
  'cant_update_message',
  'channel_not_found',
  'edit_window_closed',
  'invalid_auth',
  'invalid_blocks',
  'is_archived',
  'message_not_found',
  'missing_scope',
  'msg_too_long',
  'no_text',
  'not_authed',
  'not_in_channel',
  'token_revoked',
  'user_not_found',
]);

export function classifySlackError(error: unknown): SlackSendError {
  if (error instanceof SlackSendError) return error;
  if (error instanceof WebAPIRateLimitedError) {
    return new SlackSendError('rate_limited', 'rate_limited', error.retryAfter * 1000);
  }
  if (error instanceof WebAPIPlatformError) {
    const code = error.data.error;
    return new SlackSendError(PERMANENT_ERRORS.has(code) ? 'permanent' : 'transient', code);
  }
  // No answer from Slack at all (fetch failed, ENOTFOUND, a timeout): the network.
  return new SlackSendError(
    'network',
    error instanceof Error ? error.message : 'unknown Slack error',
  );
}

/** The real Slack API. Rate limits are surfaced to the queue rather than retried here. */
export function createWebSlackApi(botToken: string): SlackApi {
  const client = new WebClient(botToken, {
    rejectRateLimitedCalls: true,
    retryConfig: { retries: 0 },
    timeout: 15_000,
  });

  return {
    async postMessage(args) {
      try {
        const result = await client.chat.postMessage({
          channel: args.channel,
          text: args.text,
          ...(args.threadTs ? { thread_ts: args.threadTs } : {}),
          ...(args.username ? { username: args.username } : {}),
          ...(args.icon ? { icon_emoji: args.icon } : {}),
          ...(args.blocks ? { blocks: args.blocks as never } : {}),
          unfurl_links: false,
          unfurl_media: false,
        });
        if (!result.ts || !result.channel) {
          throw new SlackSendError('transient', 'postMessage returned no ts');
        }
        return { channel: result.channel, ts: result.ts };
      } catch (error) {
        throw classifySlackError(error);
      }
    },

    async openDm(userId) {
      try {
        const result: ConversationsOpenResponse = await client.conversations.open({
          users: userId,
        });
        const id = result.channel?.id;
        if (!id) throw new SlackSendError('transient', 'conversations.open returned no channel');
        return id;
      } catch (error) {
        throw classifySlackError(error);
      }
    },

    async memberChannels() {
      const channels = new Map<string, string>();
      try {
        let cursor: string | undefined;
        do {
          const page = await client.users.conversations({
            types: 'public_channel',
            exclude_archived: true,
            limit: 200,
            ...(cursor ? { cursor } : {}),
          });
          for (const channel of page.channels ?? []) {
            if (channel.id && channel.name) channels.set(channel.name, channel.id);
          }
          cursor = page.response_metadata?.next_cursor || undefined;
        } while (cursor);
      } catch (error) {
        throw classifySlackError(error);
      }
      return channels;
    },

    async addReaction(channel, ts, name) {
      try {
        await client.reactions.add({ channel, timestamp: ts, name });
      } catch (error) {
        if (error instanceof WebAPIPlatformError && error.data.error === 'already_reacted') return;
        throw classifySlackError(error);
      }
    },

    async updateMessage(channel, ts, text, blocks) {
      try {
        await client.chat.update({
          channel,
          ts,
          text,
          ...(blocks ? { blocks: blocks as never } : {}),
        });
      } catch (error) {
        throw classifySlackError(error);
      }
    },
  };
}
