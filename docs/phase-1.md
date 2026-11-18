# Phase 1: outbound pings

Status: **complete** (2026-11-17): agent-bus PRs #1–#5 and clankers #6 merged; the broker starts at sign-in; Claude Code, Codex and Copilot verified live

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
scripts/    install-task.ps1 (Task Scheduler), run-broker.ps1 (launcher with restarts)
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

### PR 3: run at login and live-test fixes

- [x] `scripts/install-task.ps1`: current-user Task Scheduler task at
      logon running hidden `scripts/run-broker.ps1`, which restarts the
      broker after a crash and stops on exit code 78 (config or port)
- [x] `--log-to-file`: daily logs in the data dir, 14-day retention, Bolt
      warnings included; uncaught errors exit 1
- [x] README start-at-login section
- [x] Live-test fixes: Markdown → Slack mrkdwn; argument summary in
      approval DMs for MCP/other tools; `#agents` chosen up front when the
      bot isn't in the project channel; "Slack connecting" at info; README
      token command for Windows PowerShell 5.1

### clankers PR ([clankers#6](https://github.com/nickmagruder/clankers/pull/6), merged)

- [x] `install.ps1 -AgentBus`: Claude user MCP entry (`~/.claude.json`) +
      hooks (`SessionStart`, `PermissionRequest`, `Stop`); Codex
      `~/.codex/config.toml` `[mcp_servers]` + `hooks.json` (same events);
      `global/AGENTS.md` → `~/.codex/AGENTS.md` (symlink or generated copy)
- [x] `standards/agent-comms.md` v1 (when to ping, what context, bus ID
      usage), linked from `global/AGENTS.md`
- [x] Update the plan's Phase 1 checklist (run-at-login item still open there)

### Verify

- [x] Claude Code: session posts to its thread and DMs me when blocked
- [x] Codex: same, after trusting the hooks in Settings > Hooks
- [x] Copilot: added by hand in Customize › MCP; `notify_human` works
- [x] Broker starts at logon from the scheduled task

## Live results

### Claude Code (desktop, 2026-11-17)

| Check                                                        | Result                                                                                                                                          |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Broker connects to Slack, `/health` with a platform token    | ✅ connected in < 0.3 s; `/health` → `{"platform":"claude","slack":"connected"}`; no token → 401                                                |
| User-level MCP entry with `${AGENT_BUS_TOKEN_CLAUDE}`        | ✅ expanded, once Claude was **fully restarted** after the token was set (before that: 401 "Missing or invalid bearer token")                   |
| `SessionStart` hook adds the bus ID to context               | ✅ `claude/agent-bus/38bc`, project and branch detected                                                                                         |
| `Stop` hook → thread root + "Turn finished"                  | ✅ in `#agents` (no `#proj-agent-bus`); name "Claude Code · agent-bus" and icon shown                                                           |
| `PermissionRequest` hook → DM                                | ✅ DM names the tool; later prompts in the burst recorded as `throttled`                                                                        |
| `register` (hook-minted ID) and `notify_human` normal/urgent | ✅ purpose line and status update in the thread, urgent DM; all 6 posts sent on the first attempt                                               |
| Findings                                                     | Raw `**bold**` in snippets; MCP approval DMs had no detail; `register` reported `#proj-agent-bus` while posting to `#agents`; all fixed in PR 3 |

### Codex (desktop, 2026-11-17, broker 0.4.0 from the logon task)

| Check                                                 | Result                                                                                                                                                                               |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Hooks trusted from user config                        | ✅ `PermissionRequest`, `SessionStart`, `Stop` listed under Settings > Hooks › User config and enabled                                                                               |
| `SessionStart` `hookSpecificOutput.additionalContext` | ✅ the agent quoted `codex/agent-bus/ce85` (settles the open docs question)                                                                                                          |
| User env vars reach hook commands                     | ✅ hooks authenticated with `AGENT_BUS_TOKEN_CODEX`; no rejected requests in the broker log                                                                                          |
| Channel chosen up front                               | ✅ session created with channel `agents`                                                                                                                                             |
| `Stop` hook → thread root + "Turn finished"           | ✅ name "Codex · agent-bus" and icon shown; two later stops `throttled`                                                                                                              |
| `PermissionRequest` with empty output                 | ✅ DM sent and the in-app "Allow …" prompt still appeared (empty output falls through)                                                                                               |
| MCP via `bearer_token_env_var`, `notify_human` normal | ✅ status update in the thread; all 4 posts sent on the first attempt                                                                                                                |
| Findings                                              | `git status` needed no approval (sandbox), so the only DM was the approval for `notify_human` itself: Codex asks on every MCP call. Fixed in 0.4.1: no DMs for agent-bus's own tools |

### Copilot (desktop, 2026-11-17, MCP added by hand)

| Check                                        | Result                                                                                                                                                                                 |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MCP with `Bearer ${AGENT_BUS_TOKEN_COPILOT}` | ✅ connected once Copilot had the token; two earlier attempts (05:05, 05:07 UTC) got 401s, each 16 requests including OAuth discovery probes (`/.well-known/oauth-protected-resource`) |
| `register` without a hook-minted ID          | ✅ minted `copilot/agent-bus/9d12`; branch passed by the agent (Copilot's worktree branch `nickmagruder-reimagined-disco`); channel `agents` chosen up front                           |
| `notify_human` normal and urgent             | ✅ status update in the thread, urgent DM; all 3 posts sent on the first attempt                                                                                                       |
| Hooks                                        | n/a: Copilot desktop hooks still don't run (Phase 0), so no automatic pings, as expected                                                                                               |

### Start at sign-in (2026-11-17, sign out and back in)

| Check                       | Result                                                                                                                                                                                                                                                 |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Logon trigger runs the task | ✅ hidden launcher started 21:24:16; "starting broker" at 21:24:36                                                                                                                                                                                     |
| Broker comes up             | ✅ Slack connected and listening at 21:25:15: about **38 s** after the node process started (a restart from a terminal takes under 3 s)                                                                                                                |
| Apps that start at sign-in  | ⚠️ Claude started at 21:24:42, before the broker listened: agent-bus showed ECONNREFUSED and the session's `SessionStart` hook got no bus ID. Reconnecting agent-bus from the MCP menu fixes the session; later hooks work, and new sessions get an ID |

## Build notes

- Delivery is at-least-once: a crash between Slack accepting a post and the
  outbox marking it sent repeats that post on restart.
- New sessions use `#agents` directly when the bot's channel list (loaded at
  startup) shows no `#proj-<name>`; before the list loads, the queue still
  falls back per post, and lanes are then keyed by the requested name.
- `register` takes an optional `project`; without one the session is
  `platform/misc/xxxx` and posts in `#agents`.
- `node:sqlite` prints an ExperimentalWarning; `npm run broker` passes
  `--disable-warning=ExperimentalWarning`.
- The hook sends only the fields in `src/shared/hook-protocol.ts`: no
  prompts, transcripts or full tool input; the tool summary is the command,
  file path, URL or first question, else up to three short scalar arguments
  (names matching token/secret/password/key/auth/content/body are skipped).
- Every app and the broker read environment variables only at start: after
  setting one, restart them (a Claude MCP 401 was exactly this).
- Hook-created sessions don't count against the hourly `register` cap (an
  agent can't create them; the app's session start does).
- The Phase 0 stdio bridge went with the spike; it's in git history
  (`9062a63`) if a client ever needs stdio.

- Approval prompts for agent-bus's own tools (`mcp__agent-bus__*` in
  Claude, `mcp__agent_bus__*` in Codex) send no DM; they're audited as
  `own_tool`. Choosing "Always allow" for them in Codex also avoids the
  in-app prompt.
- At sign-in the broker can take ~40 s to listen, so an app that starts
  with Windows may miss it: reconnect agent-bus from the app's MCP menu. If
  this bites often, check whether Claude Code retries a failed MCP server on
  its own before changing the broker's startup order (most of the delay is
  likely Node loading under sign-in load, before broker code runs).

## Carried into Phase 2

- Codex and Copilot honour progress notifications (needed for `ask_human`).
- The sign-in race above, if it turns out to matter in practice.
