# Memory

agent-bus's memory index (clankers `global/AGENTS.md` "Memory"): one line per
memory, each in its own file next to this one. Facts that mustn't be committed
to this public repo (IDs, local paths) are in `memory/local/` (gitignored),
indexed in `memory/local/MEMORY.md`.

- [Live Slack testing](live-slack-testing.md) — one step at a time; MCP client
  script when the session's agent-bus is down; look-only in Chrome
- [Broker restart](broker-restart.md) — use `install-task.ps1 -Restart`;
  Stop/Start-ScheduledTask leaves node holding the port
- [Copilot review off](copilot-review-paused.md) — quota gone; the rulesets'
  automatic Copilot review was removed 2026-11-22; local agents review
- [PR review sessions](pr-review-sessions.md) — request every PR's review
  right away; brief the linked reviewer by quoting and naming the policy
