# Phase 1: outbound pings

Status: **in progress**: PR 1 (broker core) merged; PR 2 (hooks, spike removal) on `phase-1/hooks` (2026-11-17)

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
| Permission pings               | **`PermissionRequest` on both Claude and Codex** (its payload has the command; Claude's `Notification` only names the tool). Claude's `permission_prompt` notification is also handled and shares the throttle, so wiring both never double-DMs.         |
| Thread roots                   | Posted lazily, on a session's first thread post, so short sessions stay out of Slack.                                                                                                                                                                    |

## Layout

```text
src/
  shared/   config (zod), guard, hook protocol, session IDs, platforms
  broker/   store (SQLite), slack (Bolt + post queue), http (/mcp, /hook, /health), service, main.ts
  cli/      hook.ts (node src/cli/hook.ts <platform> [--event NAME])
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
      (≤ 1 msg/s, honours `429 Retry-After`, persisted through `outbox`);
      routing `urgent` → DM, `normal` → session thread, `fyi` → stored;
      per-platform name/icon via `chat:write.customize`
- [x] HTTP on `127.0.0.1`: guard (Host, Origin, per-platform bearer) on
      every route; `/mcp` streamable HTTP with `register(purpose, session?)`
      and `notify_human(text, urgency, session)`; progress heartbeats ready
      for `ask_human`
- [x] Tests: guard and token→platform mapping, queue pacing and 429,
      routing, migrations, MCP tools against a fake Slack client

### PR 2: hooks and spike removal

- [x] `/hook` endpoint and `src/cli/hook.ts`: forward selected fields with a
      short timeout (2 s SessionStart, 3 s otherwise), print the platform's
      output format, always exit 0
- [x] `SessionStart` → map app session to bus session + inject bus ID;
      `PermissionRequest` (both) and Claude `Notification`
      (`permission_prompt`) → urgent DM, no decision (in-app prompt
      proceeds); `Stop` → normal thread post; per-session throttles
      (2 min permission, 10 min stop)
- [x] Remove `src/spike/`, `.mcp.json`, `.claude/settings.json`, `.codex/`,
      `.github/hooks/` spike wiring and `spike:server`; delete local
      `spike-logs/`

### PR 3: run at login

- [ ] `scripts/install-task.ps1`: hidden Task Scheduler task at logon,
      restart on failure, logs in the data dir
- [ ] README setup section

### clankers PR

- [ ] `install.ps1`: Claude user MCP entry + hooks (`SessionStart`,
      `PermissionRequest`, `Stop`); Codex `~/.codex/config.toml`
      `[mcp_servers]` + `hooks.json` (same events); link
      `global/AGENTS.md` → `~/.codex/AGENTS.md`
- [ ] `standards/agent-comms.md` v1 (when to ping, what context, bus ID
      usage), linked from `global/AGENTS.md`
- [ ] Update the plan's Phase 1 checklist

### Verify

- [ ] Each app: a session posts to its thread and DMs me when blocked
- [ ] Copilot: added by hand in Customize › MCP; `notify_human` works

## Build notes

- **Tested only against a fake Slack so far.** The live check (real
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
- The hook sends only the fields in `src/shared/hook-protocol.ts`: no
  prompts, transcripts or full tool input; the tool summary is the command,
  file path, URL or first question.
- Hook-created sessions don't count against the hourly `register` cap (an
  agent can't create them; the app's session start does).
- The Phase 0 stdio bridge went with the spike; it's in git history
  (`9062a63`) if a client ever needs stdio.

## To check in the live test

- Codex `SessionStart` honours `hookSpecificOutput.additionalContext` (docs
  say yes; the docs fetch was partly a summary, so confirm).
- Codex `PermissionRequest` with empty output falls through to the normal
  prompt (Phase 0 log-only mode suggests yes).
- Codex passes the user's env vars to hook commands (its MCP
  `bearer_token_env_var` reads them, so likely).
- Codex and Copilot honour progress notifications (needed in Phase 2).
