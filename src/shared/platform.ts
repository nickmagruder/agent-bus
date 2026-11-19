/** The agent platforms the broker accepts. Each has its own bearer token. */
export const PLATFORMS = ['claude', 'codex', 'copilot'] as const;

export type Platform = (typeof PLATFORMS)[number];

/** How each platform's posts look in Slack (`chat:write.customize`). */
export const PLATFORM_STYLE: Record<Platform, { label: string; icon: string }> = {
  claude: { label: 'Claude Code', icon: ':large_orange_circle:' },
  codex: { label: 'Codex', icon: ':white_circle:' },
  copilot: { label: 'Copilot', icon: ':large_purple_circle:' },
};

/**
 * The name and icon a session's posts appear under, e.g. "Claude Code ·
 * agent-bus" with the platform's circle. Every post a session causes uses it.
 */
export function postStyle(platform: Platform, project: string): { username: string; icon: string } {
  const { label, icon } = PLATFORM_STYLE[platform];
  return { username: `${label} · ${project}`, icon };
}
