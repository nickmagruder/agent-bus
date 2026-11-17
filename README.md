# agent-bus

Local broker that connects Claude Code, OpenAI Codex and GitHub Copilot
desktop sessions to the `clankers` Slack workspace and to each other:

- agents ping me in Slack when they're blocked on me,
- I answer (and, for lower-risk actions, approve) from Slack,
- agents hand tasks to each other across platforms.

Design, decisions and phases: [clankers `docs/slack-integration-plan.md`](https://github.com/nickmagruder/clankers/blob/main/docs/slack-integration-plan.md).

**Current stage: Phase 0.** The repo holds only throwaway spike tools that
check what each desktop app supports. See [docs/spikes/phase-0.md](docs/spikes/phase-0.md).

## Setup

Requires Node 24+ and, for the pre-commit secret scan, gitleaks
(`winget install Gitleaks.Gitleaks`).

```bash
npm install
git config core.hooksPath .githooks
```

Environment (user environment variables, never files):

| Variable          | Purpose                                           |
| ----------------- | ------------------------------------------------- |
| `AGENT_BUS_TOKEN` | Bearer token MCP clients send to the local server |
| `AGENT_BUS_PORT`  | Optional; default `47823`                         |
| `SLACK_BOT_TOKEN` | `xoxb-` bot token (from Phase 1)                  |
| `SLACK_APP_TOKEN` | `xapp-` Socket Mode token (from Phase 1)          |

## Scripts

| Command                | What it does                            |
| ---------------------- | --------------------------------------- |
| `npm run spike:server` | Start the Phase 0 spike MCP server      |
| `npm run check`        | Typecheck, lint, format check and tests |
| `npm test`             | Vitest                                  |

## Changelog

### 0.1.0 (2026-11-17)

- Scaffold: TypeScript run by Node 24 directly, Vitest, ESLint, Prettier,
  GitHub Actions CI with gitleaks, pre-commit secret scan.
- Phase 0 spike tools: local MCP echo server (`whoami`, `hold`) with Host,
  Origin and bearer-token checks; hook logger with armable Stop-block and
  permission-wait tests; per-app wiring for Claude Code, Codex and Copilot.
- `jiti` dev dependency: lets ESLint load its TypeScript config file.
