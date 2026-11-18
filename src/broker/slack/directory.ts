import { DM_TARGET } from '../store.ts';
import { SlackSendError, type SlackApi } from './api.ts';

/** Where posts go when a project's `#proj-<name>` channel doesn't exist. */
export const FALLBACK_CHANNEL = 'agents';

const REFRESH_MS = 10 * 60_000;
const MISS_REFRESH_MS = 60_000;

/**
 * Turns outbox targets into Slack channel IDs. The bot can't create
 * channels, so a missing project channel falls back to `#agents`.
 */
export class ChannelDirectory {
  private channels = new Map<string, string>();
  private loadedAt = Number.NEGATIVE_INFINITY;
  private dmChannel: string | undefined;
  private readonly api: SlackApi;
  private readonly userId: string;
  private readonly now: () => number;

  constructor(api: SlackApi, userId: string, now: () => number = Date.now) {
    this.api = api;
    this.userId = userId;
    this.now = now;
  }

  async resolve(target: string): Promise<string> {
    if (target === DM_TARGET) {
      this.dmChannel ??= await this.api.openDm(this.userId);
      return this.dmChannel;
    }
    const age = this.now() - this.loadedAt;
    if (age > REFRESH_MS || (!this.channels.has(target) && age > MISS_REFRESH_MS)) {
      await this.refresh();
    }
    const id = this.channels.get(target) ?? this.channels.get(FALLBACK_CHANNEL);
    if (!id) {
      throw new SlackSendError(
        'permanent',
        `bot is not in #${target} or #${FALLBACK_CHANNEL}; invite it with /invite @clankers-bot`,
      );
    }
    return id;
  }

  /**
   * Whether the bot is in a channel, from the cached list: `undefined` until
   * the list has been loaded once. Lets new sessions pick `#agents` up front
   * when their project has no channel.
   */
  isMember(name: string): boolean | undefined {
    if (this.loadedAt === Number.NEGATIVE_INFINITY) return undefined;
    return this.channels.has(name);
  }

  /** Loads the channel list (the broker calls this at startup). */
  async refresh(): Promise<void> {
    this.channels = await this.api.memberChannels();
    this.loadedAt = this.now();
  }
}
