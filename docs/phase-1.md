# Phase 1: outbound pings

Status: **in progress**: PR 1 (broker core) built on `phase-1/broker-core` (2026-11-17)

Goal: a session on any of the three apps can post to its Slack thread, and
DM me when it is blocked. Design and phases: clankers
`docs/slack-integration-plan.md`; Phase 0 results: [phase-0.md](spikes/phase-0.md).

## Decisions

| Topic                          | Decision                                                                                                                                                                                                                                                 |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Session identity               | **Hook mints the ID.** The `SessionStart` hook (Claude, Codex) registers the session with the broker and injects its bus ID (`platform/project/short-id`) as context; the agent passes it to MCP tools. Copilot has no hooks, so `register()` mints one. |
| Auth tokens                    | **Per platform:** `AGENT_BUS_TOKEN_CLAUDE`, `AGENT_BUS_TOKEN_CODEX`, `AGENT_BUS_TOKEN_COPILOT` (user env vars). The broker stamps the platform from the token; hooks use their platform's token. `AGENT_BUS_TOKEN` is retired with the spike.            |
| SQLite                         | **`node:sqlite`** (built in; no native build).                                                                                                                                                                                                           |
| Delivery                       | Feature branch with a few PRs (below); a separate clankers PR for wiring and standards. Commit and open PRs only when asked.                                                                                                                             |
| `fyi` urgency                  | Stored only; the daily digest arrives in Phase 2.                                                                                                                                                                                                        |
| Missing `#proj-<name>` channel | Post to `#agents` instead (the bot can't create channels).                                                                                                                                                                                               |

## Layout

```text
src/
  shared/   config (zod), guard (moved from spike), ids, types
  broker/   store (SQLite), slack (Bolt + post queue), http (/mcp, /hook), main.ts
  cli/      hook.ts (agent-bus hook <platform> <event>)
scripts/    install-task.ps1 (Task Scheduler)
```

## Work

### PR 1: broker core

- [x] Config: zod-validated env (`SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`,
      per-platform tokens, my Slack user ID, port, data dir
      `%LOCALAPPDATA%\agent-bus\`); fail fast with a clear message, never
      print token values
- [x] Store: `sessions`, `events` (append-only audit), `outbox`; versioned
      migrations; idempotent writes
- [x] Slack: Bolt Socket Mode with reconnect logging; per-channel queue
      (â‰¤ 1 msg/s, honours `429 Retry-After`, persisted through `outbox`);
      routing `urgent` â†’ DM, `normal` â†’ session thread, `fyi` â†’ stored;
      per-platform name/icon via `chat:write.customize`
- [x] HTTP on `127.0.0.1`: guard (Host, Origin, per-platform bearer) on
      every route; `/mcp` streamable HTTP with `register(purpose, session?)`
      and `notify_human(text, urgency, session)`; progress heartbeats ready
      for `ask_human`
- [x] Tests: guard and tokenâ†’platform mapping, queue pacing and 429,
      routing, migrations, MCP tools against a fake Slack client

### PR 2: hooks and spike removal

- [ ] `/hook` endpoint and `src/cli/hook.ts`: forward payload with a short
      timeout, print the platform's output format, always exit 0
- [ ] `SessionStart` â†’ register + inject bus ID; Claude `Notification`
      (`permission_prompt`) â†’ urgent; Codex `PermissionRequest` â†’ urgent,
      no decision (in-app prompt proceeds); `Stop` â†’ normal thread post;
      per-session throttle
- [ ] Remove `src/spike/`, `.mcp.json`, `.claude/settings.json`, `.codex/`,
      `.github/hooks/` spike wiring and `spike:server`

### PR 3: run at login

- [ ] `scripts/install-task.ps1`: hidden Task Scheduler task at logon,
      restart on failure, logs in the data dir
- [ ] README setup section

### clankers PR

- [ ] `install.ps1`: Claude user MCP entry + hooks; Codex
      `~/.codex/config.toml` `[mcp_servers]` + `hooks.json`; link
      `global/AGENTS.md` â†’ `~/.codex/AGENTS.md`
- [ ] `standards/agent-comms.md` v1 (when to ping, what context, bus ID
      usage), linked from `global/AGENTS.md`
- [ ] Update the plan's Phase 1 checklist

### Verify

- [ ] Each app: a session posts to its thread and DMs me when blocked
- [ ] Copilot: added by hand in Customize â€º MCP; `notify_human` works

## Build notes

- **PR 1 is tested only against a fake Slack.** The live check (real
  Socket Mode, posts in `#proj-clankers`, a DM) waits for `SLACK_USER_ID`
  and the per-platform tokens to be set.
- Delivery is at-least-once: a crash between Slack accepting a post and the
  outbox marking it sent repeats that post on restart.
- Lanes are keyed by channel name, so a project without its own channel and
  `#agents` itself can each send about 1 msg/s to `#agents`. Fine at 3–5
  agents; key lanes by channel ID if it ever trips rate limits.
- `register` takes an optional `project`; without one the session is
  `platform/misc/xxxx` and posts in `#agents`.
- `node:sqlite` prints an ExperimentalWarning; `npm run broker` passes
  `--disable-warning=ExperimentalWarning`.

## To check during the build

- Codex `SessionStart` hook can add context (Claude's can).
- Codex and Copilot honour progress notifications (needed in Phase 2).
