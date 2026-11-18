# agent-bus

Local broker that connects Claude Code, OpenAI Codex and GitHub Copilot
desktop sessions to the `clankers` Slack workspace and to each other:

- agents ping me in Slack when they're blocked on me,
- I answer (and, for lower-risk actions, approve) from Slack,
- agents hand tasks to each other across platforms.

Design, decisions and phases: [clankers `docs/slack-integration-plan.md`](https://github.com/nickmagruder/clankers/blob/main/docs/slack-integration-plan.md).

**Current stage: Phase 1** (outbound pings). Broker core (`src/broker/`) and
hook CLI (`src/cli/`) are in; start-at-login and app wiring are still to come.
Plan and checklist: [docs/phase-1.md](docs/phase-1.md). Phase 0 results:
[docs/spikes/phase-0.md](docs/spikes/phase-0.md) (the spike code itself was
removed in 0.3.0; it's in git history at `9062a63`).

## How the broker works

- **One Slack connection** (Socket Mode via Bolt; reconnects on its own).
- **MCP endpoint** at `http://127.0.0.1:47823/mcp` (stateless streamable
  HTTP). Every request must pass Host and Origin checks and carry one of the
  per-platform bearer tokens; the token decides the caller's platform.
- **Tools:** `register(purpose, project?, branch?, session?)` announces a
  session in `#proj-<project>` (or `#agents`) and returns its ID
  (`platform/project/xxxx`); `notify_human(session, text, urgency)` routes
  `urgent` → DM to me, `normal` → the session's thread, `fyi` → stored for
  the Phase 2 digest. Per-session and per-platform hourly caps stop loops.
- **SQLite** (`%LOCALAPPDATA%\agent-bus\bus.db`, `node:sqlite`): sessions,
  an append-only audit log of every call and denial, and the outbox. Posts go
  out per channel at about one a second, honour Slack's `Retry-After`, and
  survive a restart.
- `GET /health` (same auth) reports the Slack connection state.

## Hooks (Claude Code, Codex)

`src/cli/hook.ts` is the hook command. It reads the app's hook payload,
sends a few fields to `POST /hook` with the platform's token, and always
exits 0, so a stopped broker never blocks an agent. Prompts, transcripts and
full tool input stay local; only a one-line tool summary (command, file or
question) and a short message snippet are sent.

```text
node C:/Users/nickm/source/repos/agent-bus/src/cli/hook.ts claude   # or codex
```

| Event               | What happens                                                                                                                          |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `SessionStart`      | Maps the app session to a bus session and adds its ID (`claude/agent-bus/3f2a`) to the agent's context. Nothing is posted.            |
| `PermissionRequest` | Urgent DM with the tool and command; at most one per session per 2 minutes. The hook prints nothing: the app's own prompt decides.    |
| `Notification`      | Claude `permission_prompt` only: same DM, sharing the 2-minute throttle with `PermissionRequest`.                                     |
| `Stop`              | "Turn finished; waiting for you" with a snippet in the session's thread; at most one per 10 minutes. Skipped when `stop_hook_active`. |

A session's thread root is posted on its first thread post, so short
sessions that never post stay out of Slack. Wiring into each app's user
config comes with the clankers `install.ps1` change.

## Setup

Requires Node 24+ and, for the pre-commit secret scan, gitleaks
(`winget install Gitleaks.Gitleaks`).

```bash
npm install
git config core.hooksPath .githooks
```

Environment (user environment variables, never files):

| Variable                  | Purpose                                                        |
| ------------------------- | -------------------------------------------------------------- |
| `AGENT_BUS_TOKEN_CLAUDE`  | Bearer token for Claude Code (≥ 32 chars, unique per platform) |
| `AGENT_BUS_TOKEN_CODEX`   | Bearer token for Codex                                         |
| `AGENT_BUS_TOKEN_COPILOT` | Bearer token for Copilot                                       |
| `SLACK_BOT_TOKEN`         | `xoxb-` bot token                                              |
| `SLACK_APP_TOKEN`         | `xapp-` Socket Mode token                                      |
| `SLACK_USER_ID`           | My Slack member ID (urgent DMs go here)                        |
| `AGENT_BUS_PORT`          | Optional; default `47823`                                      |
| `AGENT_BUS_DATA_DIR`      | Optional; default `%LOCALAPPDATA%\agent-bus`                   |

The hook CLI reads `AGENT_BUS_TOKEN_<PLATFORM>` and `AGENT_BUS_PORT` too.
`AGENT_BUS_TOKEN` (Phase 0) is no longer used and can be deleted.

Generate the platform tokens without displaying them:

```powershell
foreach ($p in 'CLAUDE','CODEX','COPILOT') { [Environment]::SetEnvironmentVariable("AGENT_BUS_TOKEN_$p", [Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)), 'User') }
```

The bot must be in `#agents` (the fallback) and in each `#proj-<name>`
channel it should post to.

## Scripts

| Command          | What it does                            |
| ---------------- | --------------------------------------- |
| `npm run broker` | Start the broker                        |
| `npm run check`  | Typecheck, lint, format check and tests |
| `npm test`       | Vitest                                  |

## Changelog

### 0.3.0 (2026-11-17)

- Hook CLI (`src/cli/hook.ts`) and `POST /hook`: `SessionStart` gives each
  Claude Code / Codex session its bus ID as context; `PermissionRequest` (and
  Claude's `permission_prompt` notification) DMs me with the command;
  `Stop` posts "waiting for you" in the session thread. Per-session
  throttles; hooks never return allow/deny or block.
- Sessions found by the app's own session ID; announced in Slack lazily on
  their first thread post (schema v2 migration).
- `register` accepts a hook-minted session ID; sessions created by hooks
  don't count against the hourly `register` cap.
- Removed the Phase 0 spike: `src/spike/`, its tests, the repo `.mcp.json`,
  `.claude/settings.json`, `.codex/` and `.github/hooks/` wiring, and the
  `spike:server` script. Local `spike-logs/` deleted.

### 0.2.0 (2026-11-17)

- Phase 1 broker core (`src/broker/`): Socket Mode connection, per-channel
  persisted post queue with rate-limit handling, hardened MCP endpoint with
  `register` and `notify_human`, SQLite store with an append-only audit log,
  progress-heartbeat helper for long tool calls.
- Per-platform bearer tokens (`AGENT_BUS_TOKEN_CLAUDE` / `_CODEX` /
  `_COPILOT`) identify the caller; `SLACK_USER_ID` sets where urgent DMs go.
- Guard moved to `src/shared/guard.ts` and extended to map tokens to platforms.
- Agent text is escaped before posting, so it can't trigger `@channel`
  mentions or disguise links.
- New dependencies: `@slack/bolt` (Socket Mode and, from Phase 2, buttons)
  and `@slack/web-api` (posting with rate limits surfaced to the queue).
  SQLite uses Node's built-in `node:sqlite`.

### 0.1.1 (2026-11-17)

- Phase 0 results for Claude Code and Codex recorded in `docs/spikes/phase-0.md`.
- Spike `hold` tool takes `heartbeatSeconds` (progress or log notifications).
- `src/spike/stdio-bridge.ts`: stdio MCP server that forwards to the HTTP
  spike server, as a fallback for clients that can't use HTTP.
- Copilot hook commands use absolute paths so they work from Copilot's own
  working copies.

### 0.1.0 (2026-11-17)

- Scaffold: TypeScript run by Node 24 directly, Vitest, ESLint, Prettier,
  GitHub Actions CI with gitleaks, pre-commit secret scan.
- Phase 0 spike tools: local MCP echo server (`whoami`, `hold`) with Host,
  Origin and bearer-token checks; hook logger with armable Stop-block and
  permission-wait tests; per-app wiring for Claude Code, Codex and Copilot.
- `jiti` dev dependency: lets ESLint load its TypeScript config file.
