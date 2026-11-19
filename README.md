# agent-bus

**Version:** 0.6.5 · [MIT license](LICENSE)

[![ci](https://github.com/nickmagruder/agent-bus/actions/workflows/ci.yml/badge.svg)](https://github.com/nickmagruder/agent-bus/actions/workflows/ci.yml)
[![codeql](https://github.com/nickmagruder/agent-bus/actions/workflows/codeql.yml/badge.svg)](https://github.com/nickmagruder/agent-bus/actions/workflows/codeql.yml)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/nickmagruder/agent-bus/badge)](https://scorecard.dev/viewer/?uri=github.com/nickmagruder/agent-bus)

A local broker that connects AI coding agents (Claude Code, OpenAI Codex and
GitHub Copilot desktop sessions) to Slack and to each other:

- agents ping me in Slack when they're blocked on me,
- I answer their questions from Slack (buttons or a reply in a thread),
- later: I approve lower-risk actions from Slack, and agents hand tasks to
  each other across platforms.

## Why

I run several coding agents at once, on three different platforms, and they
spend a lot of time waiting for me: a permission prompt, a question, a
finished turn. The desktop apps can't push a message into a running session
and don't talk to each other, so agent-bus gives them one shared, local
place to reach me (Slack, on my phone) and, from Phase 3, each other.

It's a personal tool, built in the open. It runs on one Windows machine,
talks to one Slack workspace, and answers only to one Slack user.

## How it works

```text
 Slack                                         this PC
┌──────────────────────┐  Socket Mode  ┌───────────────────────────────┐
│ #agents  #proj-*     │◄─────────────►│ agent-bus broker (1 process)  │
│ DM: me ↔ bot         │  (outbound    │  MCP  http://127.0.0.1/mcp    │
└──────────────────────┘   WebSocket)  │  hooks  /hook   SQLite store  │
                                       └──▲──────────▲──────────▲──────┘
                              MCP + hooks │ MCP+hooks│      MCP │
                                ┌─────────┴─┐ ┌──────┴────┐ ┌───┴─────────┐
                                │Claude Code│ │  Codex    │ │  Copilot    │
                                └───────────┘ └───────────┘ └─────────────┘
```

- **One broker process** holds the only Slack connection (Socket Mode via
  Bolt; outbound WebSocket, so no public URL) and reconnects on its own.
- **Agents call MCP tools** at `http://127.0.0.1:47823/mcp` (stateless
  streamable HTTP). Each platform has its own bearer token, which tells the
  broker who's calling.
- **Hooks** (Claude Code and Codex) send a few fields of each lifecycle event
  to `POST /hook`, so pings happen even when the agent doesn't think to send
  one.
- **SQLite** (`node:sqlite`) keeps sessions, inboxes, questions, the outgoing
  post queue and an append-only audit log, so nothing is lost on a restart.
- **Slack layout:** one thread per session in `#proj-<project>` (or
  `#agents` when the bot isn't in that channel); urgent items DM me.

The full design (platform capabilities, architecture, safety rules, roadmap
and decisions) is in [docs/design.md](docs/design.md).

## Status

| Phase | What                                                                                   | Status                         |
| ----- | -------------------------------------------------------------------------------------- | ------------------------------ |
| 0     | Spikes: MCP, hooks and timeouts on each app                                            | [Done](docs/spikes/phase-0.md) |
| 1     | Outbound pings, hook pings, start at login; verified on Claude Code, Codex and Copilot | [Done](docs/phase-1.md)        |
| 2     | Answering from Slack: inbox, `ask_human` with buttons, reminders and expiry            | [In progress](docs/phase-2.md) |
| 3     | Cross-platform task handoffs between agents                                            | Planned                        |
| 4     | Approving lower-risk actions from Slack                                                | Planned                        |
| 5     | CLI agents, true push, optional A2A endpoint                                           | Later                          |

## Features

### MCP tools

| Tool                                                                       | What it does                                                                                                                                                                                     |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `register(purpose, project?, branch?, session?)`                           | Announces a session in `#proj-<project>` (or `#agents`) and returns its ID (`platform/project/xxxx`)                                                                                             |
| `notify_human(session, text, urgency)`                                     | `urgent` → DM to me, `normal` → the session's thread, `fyi` → the daily digest in `#agents` (08:00 local). Per-session and per-platform hourly caps stop loops                                   |
| `check_inbox(session)`                                                     | Returns my Slack replies to the session and the outcomes of its questions                                                                                                                        |
| `ask_human(session, question, options?, default_action, timeout_minutes?)` | DMs me the question with buttons for up to five options (a reply in its thread works too) and waits up to 150 s, then returns `pending` with a question ID. A pointer goes in the session thread |
| `wait_for_reply(session, question_id?)`                                    | Waits again, for one question or for anything new                                                                                                                                                |

Questions get one reminder at 15 minutes. At the timeout (default 60) the
question expires and the agent takes its own `default_action`. The first
answer wins, and the DM is edited to show the outcome.

### Replies from Slack

A reply I write in a session's thread, or under a DM a session sent me, goes
to that session's inbox. Only messages from `SLACK_USER_ID` count; other
users, bots, edits and joins are dropped and audited without their text. 📥
on my reply means it's queued, ✅ that the agent read it. Top-level DMs to the
bot get a "reply in a thread" hint (at most hourly).

### Hooks (Claude Code, Codex)

`src/cli/hook.ts` is the hook command. It reads the app's hook payload, sends
a few fields to `POST /hook` with the platform's token, and always exits 0, so
a stopped broker never blocks an agent. Prompts, transcripts and full tool
input stay local; only a one-line tool summary (command, file or question,
else up to three short arguments, never ones named like secrets or bodies)
and a short message snippet are sent.

| Event               | What happens                                                                                                                                                                                                         |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SessionStart`      | Maps the app session to a bus session and adds its ID (`claude/agent-bus/3f2a`) to the agent's context. Nothing is posted.                                                                                           |
| `PermissionRequest` | Urgent DM with the tool and command; at most one per session per 2 minutes. The hook prints nothing: the app's own prompt decides. No DM for agent-bus's own tools (`mcp__agent-bus__*`, Codex `mcp__agent_bus__*`). |
| `Notification`      | Claude `permission_prompt` only: same DM, sharing the 2-minute throttle with `PermissionRequest`.                                                                                                                    |
| `Stop`              | "Turn finished; waiting for you" with a snippet in the session's thread; at most one per 10 minutes. Skipped when `stop_hook_active`.                                                                                |

A session's thread root is posted on its first thread post, so short sessions
that never post stay out of Slack. Copilot's desktop app has no hooks, so it
uses the MCP tools only.

## Security model

agent-bus can relay my answers to agents (and, in Phase 4, approvals), so the
broker enforces its rules itself rather than trusting agent instructions:

- **Localhost only.** The broker binds `127.0.0.1`. Every request needs a
  matching `Host` and a bearer token, even on localhost, and an `Origin`
  header, when sent, must be a local one (DNS-rebinding protection).
- **Identity from the connection.** Each platform has its own token; the
  broker stamps the caller's platform, and a session can only read its own
  inbox and questions.
- **Sender gating.** Only my Slack user ID can answer or press buttons;
  everything else is dropped and audited.
- **Hooks don't decide.** They never return allow/deny. The one block is
  `Stop`: when I've replied in Slack, it hands the agent my replies (labelled
  as mine) so it keeps going, at most 6 times per session per hour.
- **Minimal data leaves the machine.** Hooks send only the fields in
  [`src/shared/hook-protocol.ts`](src/shared/hook-protocol.ts), with size
  limits.
- **Escaped output.** Agent text can't trigger `@channel` or disguise links.
- **Caps and throttles** stop runaway agents from flooding Slack.
- **Secrets** are user environment variables, never files; gitleaks runs
  before every commit and in CI.

To report a vulnerability, see [SECURITY.md](SECURITY.md).

## Requirements

- Windows (the start-at-login scripts are PowerShell; the broker itself is
  plain Node and should run elsewhere, untested)
- Node 24+ (TypeScript runs directly through Node's type stripping; no build)
- A Slack workspace where you can install an app
- [gitleaks](https://github.com/gitleaks/gitleaks) for the pre-commit secret
  scan (`winget install Gitleaks.Gitleaks`); commits fail without it

## Setup

### 1. Install

```bash
git clone https://github.com/nickmagruder/agent-bus.git
cd agent-bus
npm install   # also installs the git hooks (husky)
```

### 2. Create the Slack app

- Turn on **Socket Mode** and **Interactivity**.
- Bot token scopes: `chat:write`, `chat:write.customize`, `channels:history`,
  `channels:read`, `groups:history`, `im:history`, `im:write`,
  `reactions:write`, `users:read`.
- Event subscriptions (bot events): `message.channels`, `message.im` (and
  `message.groups` for private project channels).
- An app-level token with `connections:write`.
- Install it to the workspace, create `#agents` (and any `#proj-<name>`
  channels), and invite the bot to each.

### 3. Set environment variables

User environment variables, never files:

| Variable                  | Purpose                                                        |
| ------------------------- | -------------------------------------------------------------- |
| `AGENT_BUS_TOKEN_CLAUDE`  | Bearer token for Claude Code (≥ 32 chars, unique per platform) |
| `AGENT_BUS_TOKEN_CODEX`   | Bearer token for Codex                                         |
| `AGENT_BUS_TOKEN_COPILOT` | Bearer token for Copilot                                       |
| `SLACK_BOT_TOKEN`         | `xoxb-` bot token                                              |
| `SLACK_APP_TOKEN`         | `xapp-` Socket Mode token                                      |
| `SLACK_USER_ID`           | Your Slack member ID (urgent DMs go here; only you can answer) |
| `AGENT_BUS_PORT`          | Optional; default `47823`                                      |
| `AGENT_BUS_DATA_DIR`      | Optional; default `%LOCALAPPDATA%\agent-bus`                   |

The hook CLI reads `AGENT_BUS_TOKEN_<PLATFORM>` and `AGENT_BUS_PORT` too.

Generate the platform tokens without displaying them (Windows PowerShell 5.1
and PowerShell 7):

```powershell
foreach ($p in 'CLAUDE','CODEX','COPILOT') { $b = New-Object byte[] 32; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); [Environment]::SetEnvironmentVariable("AGENT_BUS_TOKEN_$p", [Convert]::ToBase64String($b), 'User') }
```

### 4. Start the broker at login

```powershell
.\scripts\install-task.ps1 -WhatIf     # preview
.\scripts\install-task.ps1 -StartNow   # register and start now
.\scripts\install-task.ps1 -Restart    # after pulling new code or changing env vars
.\scripts\install-task.ps1 -Uninstall
```

Registers a scheduled task, **agent-bus broker**, for your user only (no
admin rights). At logon a hidden Windows PowerShell runs
`scripts/run-broker.ps1`, which starts the broker with `--log-to-file` and
restarts it after a crash (5 s, doubling to 5 min). It stops retrying on exit
code 78: an invalid environment or the port already in use, which a restart
can't fix. Stop any broker you started by hand before `-StartNow`.
`-Restart` and `-Uninstall` stop the launcher first, then the broker it
started (matched by its absolute `main.ts` path, so a hand-started broker is
left alone).

Logs: `%LOCALAPPDATA%\agent-bus\logs\broker-YYYY-MM-DD.log` (JSON lines, local
date, kept 14 days) and `launcher.log`. `GET /health` (same auth) reports the
Slack connection state.

### 5. Connect the apps

Replace `<repo>` with the absolute path of your clone, using forward slashes.

**Claude Code:** MCP server in `~/.claude.json` (Claude expands `${VAR}` in
headers) and hooks in `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "agent-bus": {
      "type": "http",
      "url": "http://127.0.0.1:47823/mcp",
      "headers": { "Authorization": "Bearer ${AGENT_BUS_TOKEN_CLAUDE}" }
    }
  }
}
```

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          { "type": "command", "command": "node \"<repo>/src/cli/hook.ts\" claude", "timeout": 10 }
        ]
      }
    ],
    "PermissionRequest": [
      {
        "hooks": [
          { "type": "command", "command": "node \"<repo>/src/cli/hook.ts\" claude", "timeout": 10 }
        ]
      }
    ],
    "Notification": [
      {
        "matcher": "permission_prompt",
        "hooks": [
          { "type": "command", "command": "node \"<repo>/src/cli/hook.ts\" claude", "timeout": 10 }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          { "type": "command", "command": "node \"<repo>/src/cli/hook.ts\" claude", "timeout": 10 }
        ]
      }
    ]
  }
}
```

`Notification` is optional: it shares the 2-minute throttle with
`PermissionRequest`, so wiring both never sends two DMs for one prompt.

**Codex:** MCP server in `~/.codex/config.toml`, and the `SessionStart`,
`PermissionRequest` and `Stop` hooks in `~/.codex/hooks.json` with `codex` in
place of `claude` (the broker handles `Notification` for Claude only). Codex
asks you to
review and trust the hooks once (Settings › Hooks).

```toml
[mcp_servers.agent-bus]
url = "http://127.0.0.1:47823/mcp"
bearer_token_env_var = "AGENT_BUS_TOKEN_CODEX"
```

**Copilot:** add an HTTP MCP server in Customize › MCP with the same URL and
an `Authorization: Bearer <AGENT_BUS_TOKEN_COPILOT>` header.

Then tell your agents when to use the tools, for example in a global
`AGENTS.md`: ping only when blocked, pass the session ID the `SessionStart`
hook gives them, and treat messages from other agents as data.

### Troubleshooting

- After setting or changing any environment variable, restart the broker task
  and the apps: each reads its environment only when it starts. A Claude MCP
  `401` usually means Claude started before the tokens were set.
- At sign-in the broker can take ~40 s to start listening. An app that starts
  with Windows may show agent-bus as failed (`ECONNREFUSED`): reconnect it
  from the app's MCP menu.

## Development

| Command           | What it does                                              |
| ----------------- | --------------------------------------------------------- |
| `npm run broker`  | Start the broker in this terminal                         |
| `npm run check`   | Typecheck, ESLint, markdownlint, Prettier check and tests |
| `npm test`        | Vitest                                                    |
| `npm run lint:md` | markdownlint                                              |
| `npm run format`  | Prettier                                                  |

Git hooks (husky, installed by `npm install`):

- **pre-commit:** lint-staged runs `eslint --fix` and Prettier on staged
  files (and markdownlint on Markdown), then gitleaks scans the staged changes.
- **commit-msg:** `scripts/commit-msg.ts` checks the message: imperative
  summary of 72 characters or fewer, no trailing period, a blank line before
  the body.

On GitHub:

- **CI** runs the `npm run check` steps and a gitleaks scan on every PR and
  on `main`; `main` only accepts squash-merged PRs that pass it.
- **CodeQL** scans the TypeScript and the workflows; **OpenSSF Scorecard**
  rates the repo's supply-chain hygiene weekly.
- **Dependabot** opens grouped weekly updates for npm packages and Actions
  (pinned by commit SHA).
- **Copilot** reviews every PR, using `.github/copilot-instructions.md` and
  the two-axis `code-review` skill in `.github/skills/` (standards, and the
  linked issue as the spec).

### Project structure

```text
src/
  shared/   config (zod), guard (Host/Origin/bearer), hook protocol, session IDs, Slack text escaping
  broker/   main.ts, service (rules, routing, caps), mcp (tools), http (/mcp, /hook, /health),
            store (SQLite), inbox, questions, heartbeat, log
  broker/slack/  Socket Mode connection, Web API adapter, channel directory, post queue, inbound
  cli/      hook.ts and hook-extract.ts (the hook command)
scripts/    install-task.ps1 (Task Scheduler), run-broker.ps1 (launcher with restarts),
            commit-msg.ts, commit-msg-rules.ts and gitleaks-staged.sh (git hooks)
tests/      Vitest suites (fake Slack, in-memory SQLite)
docs/       design, phase plans and live results
.github/    workflows (ci, codeql, scorecard), Dependabot, Copilot instructions and
            review skill, issue forms, PR template
.husky/     pre-commit and commit-msg hooks
```

## Contributing

This is a personal tool, but issues and suggestions are welcome: open a
[GitHub issue](https://github.com/nickmagruder/agent-bus/issues). See
[CONTRIBUTING.md](CONTRIBUTING.md) for the coding standards and how changes
are made.

## Changelog

### 0.9.0 (2026-11-18)

- **Daily digest** ([#23](https://github.com/nickmagruder/agent-bus/issues/23)):
  at 08:00 local the broker posts to `#agents` what happened since the last
  digest: `fyi` notifications grouped by session, open questions and those
  that expired, and the sessions seen. A digest missed while the broker was
  off is sent once at start; nothing to report means no post. `fyi` text is
  now stored for it (schema v5, `digest_items`).

### 0.7.0 (2026-11-18)

- **Stop-hook inbox check** ([#21](https://github.com/nickmagruder/agent-bus/issues/21)):
  when a Claude Code or Codex session is about to stop and I've replied in
  Slack, its `Stop` hook prints `{"decision":"block"}` with my replies (up to
  5, labelled as mine) as the reason, marks them delivered (`stop_hook`) and
  reacts ✅. With `stop_hook_active`, it blocks again only for newer replies;
  once the agent stops after our block, I get the usual "waiting for you"
  post. Loop guard: 6 blocks per session per hour, then replies wait for
  `check_inbox`. Copilot replies are never taken by a Stop hook.
- Replies count as delivered (✅) only once the hook response is written; if
  the hook gave up first, they go back to the inbox. The Stop hook waits up
  to 15 s (was 3 s). Taking the replies and auditing the block commit
  together.
- "Waiting for you" posts say how many of my replies the agent hasn't read.

### 0.6.5 (2026-11-18)

- `docs/going-public.md` is done: step 7 merged in CrashMap and esri-exporter (CrashMap is now MIT-licensed), Scorecard has run on `main`, and the remaining follow-ups are linked as issues

### 0.6.4 (2026-11-18)

- `docs/going-public.md`: step 7 (repo standards for CrashMap and esri-exporter) recorded with its PRs, decisions and follow-ups; step 4's Copilot check ticked
- The vendored `code-review` skill now says it is a vendored copy of the clankers `pr-review` skill, not the canonical one

### 0.6.3 (2026-11-18)

- Work is tracked on the
  [AI Orchestration board](https://github.com/users/nickmagruder/projects/5)
  (with clankers); `AGENTS.md` says to add new issues to it.
- `.github/skills/code-review` synced from the canonical clankers
  `skills/pr-review`.
- `docs/going-public.md`: boards and clankers standards recorded; code-notes
  keeps its worktree flow; clankers merges after a Copilot review.

### 0.6.2 (2026-11-18)

- Repo is public: secret scanning with push protection, Dependabot alerts
  and security updates, private vulnerability reporting; squash-only merges;
  a ruleset on `main` (PR and passing `check` required, no force pushes,
  automatic Copilot review).
- Git hooks via husky (set up by `npm install`): lint-staged (ESLint,
  Prettier, markdownlint) then the gitleaks scan on pre-commit;
  `scripts/commit-msg.ts` checks commit messages. `.githooks/` and the
  `core.hooksPath` step are gone. New dev dependencies: `husky`,
  `lint-staged`, `markdownlint-cli2`.
- `.nvmrc` (Node 24); `engines` is `>=24 <25`. `npm run check` includes
  markdownlint (`npm run lint:md`).
- CI actions on current majors, pinned by commit SHA; `gitleaks-action` v3.
  New workflows: CodeQL (TypeScript and Actions, `security-extended`) and
  OpenSSF Scorecard; Dependabot version updates for npm and Actions.
- Copilot review setup: `.github/copilot-instructions.md`, path-scoped
  security instructions, and a `code-review` skill adapted from
  `mattpocock/skills` (MIT).
- GitHub issues track the work: phase labels and milestones, issue forms
  (bug, task), a PR template.

### 0.6.1 (2026-11-18)

- Docs for going public: README rewritten for new readers (why, how it
  works, status, security model, Slack app and per-app setup, project
  structure); `docs/design.md` holds the overall design, moved from my
  private config repo; machine-specific paths replaced.
- MIT `LICENSE`, `SECURITY.md` and `CONTRIBUTING.md`.
- `docs/going-public.md`: plan for going public and the repo standards that
  follow (tooling, Copilot review, GitHub issues).

### 0.6.0 (2026-11-18)

- `ask_human`: agents ask me a question by DM, with buttons for up to five
  options and a free-text reply in the DM's thread; a pointer goes in the
  session thread. The call waits up to 150 s (with progress heartbeats),
  then returns `pending`; `wait_for_reply` waits again, for one question or
  for anything new. A `default_action` is required.
- First answer wins (button or reply); later or foreign clicks get an
  ephemeral note. The DM is edited to show the outcome.
- One reminder DM at 15 minutes; at the timeout (default 60 minutes) the
  question expires and the agent is told to take its own default. Reminders
  and expiries survive a restart.
- Questions count as urgent notifications for the caps; at most three open
  per session.
- Schema v4: `questions`, `inbox.question_id`, `outbox.blocks`. Nested
  store transactions join the outer one.
- Needs **Interactivity** turned on in the Slack app for the buttons.

### 0.5.0 (2026-11-18)

- Phase 2 starts: my Slack replies reach agents. A reply in a session's
  thread (or under an urgent DM it sent) goes to the session's inbox;
  `check_inbox` hands it to the agent, labelled as sent from my own Slack
  account. Sender gating: only `SLACK_USER_ID`; everything else is dropped
  and audited without its text. Slack retries are idempotent.
- Reactions show progress: 📥 queued, ✅ read by the agent.
- Schema v3: `inbox` table. Plan: [docs/phase-2.md](docs/phase-2.md).

### 0.4.2 (2026-11-17)

- `install-task.ps1 -Restart` / `-Uninstall`: stop the hidden launcher by
  process ID and wait for it before stopping the broker.
  `Stop-ScheduledTask` returns before the launcher has exited, so the old
  launcher could see its broker die and try to restart it.

### 0.4.1 (2026-11-17)

- No approval DM for agent-bus's own tools: asking me to approve an agent's
  message to me was noise, and Codex asks on every MCP call. Recorded in the
  audit log as `own_tool`.
- `install-task.ps1 -Restart` (and `-Uninstall`) stop the task's broker
  process too, not just the launcher.
- Codex and Copilot live results recorded in `docs/phase-1.md`: all three
  apps verified.

### 0.4.0 (2026-11-17)

- Start at login: `scripts/install-task.ps1` (current-user scheduled task)
  and `scripts/run-broker.ps1` (launcher that restarts after a crash).
- `--log-to-file`: daily JSON-lines logs in `<data dir>\logs`, kept 14 days;
  Bolt and Socket Mode warnings go there too. Uncaught errors exit 1 (the
  launcher restarts); an invalid environment or a busy port exits 78 (it
  doesn't), with a clear "port in use" message.
- Agent text is converted from Markdown to Slack mrkdwn after escaping.
- Approval DMs summarise MCP and other tools by their first short
  arguments; argument names that look like secrets or bodies are skipped.
- New sessions go straight to `#agents` when the bot isn't in
  `#proj-<project>`, so `register` reports the channel actually used.
- "Slack connecting" logs at info, not warn.
- README token command works in Windows PowerShell 5.1.
- Live test on Claude Code recorded in `docs/phase-1.md`.

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
