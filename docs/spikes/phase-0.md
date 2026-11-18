# Phase 0 spikes: what each desktop app actually supports

Status: **complete** (2026-11-17)

> The spike code and wiring described below were removed in 0.3.0 (Phase 1
> PR 2). They're in git history at `9062a63`; the results stay here as the
> record.

The plan (then in my private config repo; now [design.md](../design.md)) marked several platform
capabilities as "verify". These spikes settle them before any broker code is
written. Nothing here talks to Slack.

## What's in the repo

| File                                      | Used by              | Purpose                                                                                                           |
| ----------------------------------------- | -------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `src/spike/echo-server.ts`                | all                  | Throwaway MCP server on `127.0.0.1:47823/mcp` with two tools: `whoami` and `hold`                                 |
| `src/spike/hook-logger.ts`                | all                  | Hook command: logs every payload; runs the armed tests                                                            |
| `src/spike/arm.ts`                        | you                  | Turns the active tests on and off                                                                                 |
| `.mcp.json`                               | Claude Code, Copilot | MCP server entry (token from `${AGENT_BUS_TOKEN}`)                                                                |
| `.claude/settings.json`                   | Claude Code          | Hooks: SessionStart, UserPromptSubmit, Notification, PermissionRequest, Stop                                      |
| `.codex/config.toml`, `.codex/hooks.json` | Codex                | MCP entry with `bearer_token_env_var`; hooks: SessionStart, UserPromptSubmit, PermissionRequest, PreToolUse, Stop |
| `.github/hooks/agent-bus-spike.json`      | Copilot              | Hooks: sessionStart, userPromptSubmitted, preToolUse, postToolUse, agentStop, sessionEnd, errorOccurred           |

Everything logs to `spike-logs/` (gitignored): `mcp.jsonl` for the server,
`hooks.jsonl` for hooks. Hook payloads include your prompts and tool input,
so delete `spike-logs/` when the spikes are done.

By default the hooks **only log**. The two active tests change agent
behaviour only while armed:

```powershell
node src/spike/arm.ts stop                                   # block each session's first stop once
node src/spike/arm.ts permission --seconds 120 --decision deny
node src/spike/arm.ts status
node src/spike/arm.ts off                                    # back to log-only
```

The permission test uses **deny** on purpose: it proves the hook can wait and
decide without ever auto-approving anything.

## Setup (once)

1. `AGENT_BUS_TOKEN` is already set as a user environment variable. **Quit
   and reopen** Claude, Codex and Copilot so they see it.
2. In a terminal in this folder: `npm run spike:server`. Leave it running.
3. Open this folder (the agent-bus clone) as the project
   in each app, and trust it when asked. Codex also asks you to review and
   trust the hooks (Settings > Hooks).

## Tests per app

Run each in a fresh session in this folder.

1. **MCP connects:** ask "Call the agent-bus-spike whoami tool with note
   `<app name>`." Check `mcp.jsonl` for `clientInfo`.
   - Copilot: if the tool isn't listed, add the server by hand in
     Customize > MCP (URL above, header `Authorization: Bearer <token>`).
     Note whether `.mcp.json` was picked up and whether `${AGENT_BUS_TOKEN}`
     was expanded (a `rejected` 401 line in `mcp.jsonl` means it wasn't).
2. **Tool-call timeout:** ask "Call agent-bus-spike hold with seconds 900."
   Look for `hold-end` (completed) or `client-disconnected` and its
   `elapsedSeconds` in `mcp.jsonl`. That number caps how long `ask_human` can
   block. If it completes, the limit is above 15 minutes.
3. **Hooks fire:** after the session above, check `hooks.jsonl` for this
   platform's events and note which ones appeared and what fields they carry.
4. **Stop-hook nudge:** `node src/spike/arm.ts stop`, start a new session, ask
   any small question. Pass = the agent continues and replies `PINEAPPLE`
   before stopping. Then `node src/spike/arm.ts off`.
5. **Permission wait** (Claude Code, Codex): `node src/spike/arm.ts permission
--seconds 120 --decision deny`, then ask the agent to run a shell command
   that needs approval (e.g. `git status`). Don't answer the in-app prompt.
   Pass = after about 2 minutes the command is denied with "Denied by the
   agent-bus spike." Then `node src/spike/arm.ts off`.
6. **Global instructions:** ask "What files of instructions did you load at
   startup?" Note whether it mentions a global `AGENTS.md` and from where.

## Results

Fill in as you go; these answers replace the "verify" cells in the plan.

| Question                                    | Claude Code (desktop 2.1.325, 2026-11-17)                                                                                                                                                                                                                       | Codex                                                                                                                                        | Copilot (desktop, 2026-11-17)                                                                                                                                            |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| MCP server from repo config connects?       | ✅ `.mcp.json`, after a one-time approval; probes `server/discover` first                                                                                                                                                                                       | ❌ project `.codex/config.toml` `[mcp_servers]` ignored; ✅ user `~/.codex/config.toml` works (HTTP and stdio bridge)                        | ✅ `.mcp.json` once the folder is trusted (Customize › Repository customizations); manual Customize › MCP › Add server also works                                        |
| Token from env var expanded in config?      | ✅ `${AGENT_BUS_TOKEN}` in `headers`                                                                                                                                                                                                                            | ✅ `bearer_token_env_var`; stdio needs `env_vars = ["AGENT_BUS_TOKEN"]` passthrough                                                          | ✅ `Bearer ${AGENT_BUS_TOKEN}` header                                                                                                                                    |
| `clientInfo` name / user-agent              | `claude-code` 2.1.325 / `claude-code/2.1.325 (claude-desktop, agent-sdk/0.3.325)`                                                                                                                                                                               | `codex-mcp-client` 0.169.0-alpha.11.1 (same user-agent); desktop app 26.1111                                                                 | `copilot-cli` 1.0.106-8.unstable (desktop app bundles Copilot CLI); protocol `2025-11-25`; probes `server/discover`                                                      |
| Tool-call timeout (s)                       | **300 s of silence** (idle, not total). Raise per server with `"timeout"` (ms) in `.mcp.json`, or `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT` (ms; `0` = off). ✅ **Progress notifications reset it**: a 600 s hold with `heartbeatSeconds` 60 completed (9 heartbeats) | **300 s** (sends a progress token, so heartbeats likely extend it; untested)                                                                 | **180 s** (sends a progress token, so heartbeats likely extend it; untested)                                                                                             |
| Every MCP tool call needs approval?         | Once per tool unless "Always allow"                                                                                                                                                                                                                             | Yes, per call ("Allow once" / "Always allow"); fires `PreToolUse` + `PermissionRequest`                                                      | Not prompted in the session tested                                                                                                                                       |
| Hook events seen                            | ✅ SessionStart, UserPromptSubmit, Stop, PermissionRequest, Notification (`permission_prompt`) from project `.claude/settings.json`                                                                                                                             | ✅ SessionStart, UserPromptSubmit, PreToolUse, PermissionRequest, Stop from project `.codex/hooks.json` (after trusting in Settings > Hooks) | ❌ none: the app tries to invoke `.github/hooks` but fails (`hooks.invoke … Session not found`, `no hook session` in `~/.copilot/logs/process-*.log`); bug in this build |
| Stop hook can nudge the agent to continue?  | ✅ `{"decision":"block","reason":…}`; reason shows in the transcript; payload has `stop_hook_active` and `last_assistant_message`                                                                                                                               | ✅ same JSON; reason shows as "Hook feedback"; payload has `stop_hook_active`, `last_assistant_message`, `turn_id`                           | ❌ (hooks don't run)                                                                                                                                                     |
| PermissionRequest hook can wait and decide? | ✅ waited 120 s, deny honoured; the in-app prompt appears in parallel and **an in-app answer wins**; a later hook answer is ignored                                                                                                                             | ✅ waited 120 s, deny honoured (MCP tool call never reached the server)                                                                      | ❌ (no such event; hooks don't run)                                                                                                                                      |
| Loads a global `AGENTS.md`? From where?     | Yes, via `~/.claude/CLAUDE.md` → clankers (known setup)                                                                                                                                                                                                         | ❌ only the project `AGENTS.md`; no `~/.codex/AGENTS.md` exists, so clankers rules don't reach Codex                                         | Not tested                                                                                                                                                               |

### Notes

- Codex desktop needs MCP servers in the **user** config, so the broker's
  Codex wiring goes in `~/.codex/config.toml` (via `install.ps1`), not the
  repo. Codex's own logs live in `~/.codex/logs_2.sqlite` (table `logs`).
- The stdio bridge (`src/spike/stdio-bridge.ts`) also works for Codex; keep
  it as a fallback for clients that can't do HTTP.
- An earlier Codex "connection failed" and Claude "transport dropped
  mid-call" were caused by the spike server being stopped (Ctrl+C in its
  window), not by the clients. Run the server in its own terminal.
- Copilot desktop runs sessions in its own git worktree
  (`copilot-worktrees/agent-bus/<name>`) cut from the latest commit, and
  renames the branch per task. Repo config it needs must be committed.
- Copilot is **MCP-only** for now: no hooks means no automatic pings, Stop
  nudges or Slack approvals. `notify_human` / `ask_human` still work because
  the agent calls them. Recheck hooks on a newer Copilot build.

**Design consequence:** `ask_human` can block as long as needed if the
broker sends `notifications/progress` about every 60 s (confirmed on Claude
Code; Codex and Copilot send progress tokens too). Fallback: return
"pending" within the shortest limit (Copilot, 180 s) and have the agent call
`wait_for_reply` again.

**Slack app features (checked 2026-11-17):** none change the broker design.

- _Agents › Agent experience_: AI-assistant UI (top-bar entry, side-by-side
  panel, named threads). Optional Phase 5 nicety for talking to agents;
  leave off.
- _Agents › Slack MCP Server_: lets the app call Slack's MCP server on
  behalf of users. Not needed; the broker uses the Web API with the bot token.
- _MCP Servers_: Slack calls an external MCP server at a public URL. Not
  used: the broker stays on `127.0.0.1`.

## After the spikes

- Record results here and update the plan's capability table.
- Write the ADR in clankers (`docs/decisions/`).
- Delete `spike-logs/`; the spike code is removed when the real broker lands.
