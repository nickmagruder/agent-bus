import { SlackSendError, type PostMessageArgs, type SlackApi } from '../../src/broker/slack/api.ts';
import type { Platform } from '../../src/shared/platform.ts';

export const TOKENS: Record<Platform, string> = {
  claude: 'c'.repeat(48),
  codex: 'x'.repeat(48),
  copilot: 'p'.repeat(48),
};

export const USER_ID = 'U0123ABCD';

/** In-memory Slack: records posts and can fail the next calls on demand. */
export class FakeSlack implements SlackApi {
  readonly posts: (PostMessageArgs & { ts: string })[] = [];
  channels = new Map([
    ['agents', 'C_AGENTS'],
    ['proj-clankers', 'C_CLANKERS'],
  ]);
  failures: SlackSendError[] = [];
  memberChannelCalls = 0;
  private counter = 0;

  async postMessage(args: PostMessageArgs) {
    const failure = this.failures.shift();
    if (failure) throw failure;
    const ts = `1700000000.${String(++this.counter).padStart(6, '0')}`;
    this.posts.push({ ...args, ts });
    return { channel: args.channel, ts };
  }

  async openDm(userId: string) {
    return `D_${userId}`;
  }

  async memberChannels() {
    this.memberChannelCalls++;
    return new Map(this.channels);
  }
}
