# agent-bus design

Status (2026-11-18): Phases 0 and 1 complete; Phase 2 in progress. Each
phase's plan, decisions and live results live in its own doc:
[Phase 0](spikes/phase-0.md), [Phase 1](phase-1.md), [Phase 2](phase-2.md).

This document is the overall design: goals, what the platforms allow, the
architecture, safety rules and the phase roadmap. It started as a plan in my
private config repo and moved here when the repo went public.

## Goals

Connect three coding-agent platforms to one Slack workspace so that:

1. **Agents can ask me for input.** A blocked session (a permission prompt, a
   question, a finished task waiting for review) pings me in Slack.
2. **I can answer from Slack.** My reply, or a button, reaches the waiting
   session.
3. **Agents can coordinate across platforms.** A Claude Code session can hand
   work to a Codex session or ask a Copilot session something, and I can watch
   it all in Slack.

Platforms, all used through their **desktop apps** today:

| Platform       | Surface now                  | Later                 |
| -------------- | ---------------------------- | --------------------- |
| Claude Code    | Claude desktop app, Code tab | CLI / headless agents |
| OpenAI Codex   | Codex desktop app            | Codex CLI             |
| GitHub Copilot | GitHub Copilot desktop app   | Copilot CLI           |

## What each platform can do

The design is limited by the weakest platform. Verified in the
[Phase 0 spikes](spikes/phase-0.md):

| Capability                                | Claude Code (desktop)                                               | Codex (desktop)                                                                | Copilot (desktop)                                |
| ----------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------ |
| **MCP servers**                           | Yes (user or project config)                                        | Yes, from user config only (`~/.codex/config.toml`)                            | Yes (Customize › MCP)                            |
| **MCP tool-call timeout**                 | 300 s; progress notifications keep a call alive                     | 300 s                                                                          | 180 s                                            |
| **Lifecycle hooks**                       | Yes: `SessionStart`, `PermissionRequest`, `Notification`, `Stop`, … | Yes: `SessionStart`, `PermissionRequest`, `Stop`, … (trusted once in Settings) | Not in the desktop app                           |
| **Push a message into a running session** | Channels exist for the CLI only, not the desktop app                | Not documented                                                                 | Not documented                                   |
| **Native agent-to-agent**                 | Cross-session messaging, agent teams (Claude only)                  | Parallel cloud tasks (no messaging)                                            | Agent HQ runs several vendors on one GitHub task |
| **Shared instructions file**              | `CLAUDE.md` (imports `AGENTS.md`)                                   | `AGENTS.md`                                                                    | `AGENTS.md` / Copilot instructions               |

**Consequences:**

- **Outbound (agent → Slack) is easy everywhere** through an MCP tool, plus
  hooks where available.
- **Inbound (Slack → agent) can't be pushed into any desktop app today.** Three
  substitutes, in order of preference:
  1. **Blocking tool call:** `ask_human` / `wait_for_reply` hold until I answer
     (or return `pending` before the app's tool timeout). Works on all three.
  2. **Stop-hook inbox check:** when a session is about to stop, its `Stop`
     hook asks the broker for unread messages and, if there are any, hands
     them to the agent as the reason to keep going (Claude Code, Codex;
     Phase 2).
  3. **Inbox polling:** the agent calls `check_inbox` at natural checkpoints.
     Works everywhere, least reliable.
- **Remote approvals** would use the `PermissionRequest` hook: post
  Approve/Deny, wait a few minutes, return allow/deny, else fall back to the
  in-app prompt. That's Phase 4; until then hooks only notify.
- **Use native features where they exist.** Claude ↔ Claude coordination
  stays on Claude Code's own features; the bus is for **cross-platform**
  traffic and for **me**.

## Architecture

```text
 Slack                                         this PC
┌──────────────────────┐  Socket Mode  ┌───────────────────────────────┐
│ #agents  #proj-*     │◄─────────────►│ agent-bus broker (1 process)  │
│ DM: me ↔ bot         │  (outbound    │  - the only Slack connection  │
└──────────────────────┘   WebSocket,  │  - MCP server on              │
                           no public   │    http://127.0.0.1:47823/mcp │
                           URL)        │  - hook endpoint /hook        │
                                       │  - sessions, inboxes,         │
                                       │    questions, audit (SQLite)  │
                                       └──▲──────────▲──────────▲──────┘
                              MCP + hooks │ MCP+hooks│      MCP │
                                ┌─────────┴─┐ ┌──────┴────┐ ┌───┴─────────┐
                                │Claude Code│ │  Codex    │ │  Copilot    │
                                │ desktop   │ │  desktop  │ │  desktop    │
                                └───────────┘ └───────────┘ └─────────────┘
```

Key choices:

- **One broker, one Slack connection.** Slack allows up to 10 Socket Mode
  connections per app and sends each event to _any_ of them, so per-session
  connections would misroute replies.
- **The broker is a local HTTP MCP server** (stateless streamable HTTP on
  `127.0.0.1`). All three apps support HTTP MCP, so each points at one URL: no
  per-platform shim, no per-session process.
- **Hooks call a tiny CLI** (`src/cli/hook.ts <platform>`) that forwards a
  few fields of the hook payload to the broker and always exits 0, so a
  stopped broker never blocks an agent.
- **Session identity** is `platform/project/xxxx` (for example
  `codex/esri-exporter/3f2a`). The `SessionStart` hook mints it on Claude Code
  and Codex; Copilot's agent calls `register`.
- **SQLite with idempotent writes** (`node:sqlite`), not a workflow engine:
  waits last minutes to hours on one PC, but pending questions, the post queue
  and reminders must survive a restart.
- **Slack layout:** `#proj-<name>` per project with one thread per session;
  `#agents` as the fallback and, later, for cross-agent tasks; DMs with the bot
  for urgent items only; a daily digest for `fyi` items.

### MCP tools

| Tool                                        | Status  | Purpose                                                                |
| ------------------------------------------- | ------- | ---------------------------------------------------------------------- |
| `register(purpose, project?, branch?)`      | Phase 1 | Announce the session; returns its ID                                   |
| `notify_human(session, text, urgency)`      | Phase 1 | `urgent` → DM, `normal` → session thread, `fyi` → digest; doesn't wait |
| `check_inbox(session)`                      | Phase 2 | My Slack replies to the session and its questions' outcomes            |
| `ask_human(session, question, options?, …)` | Phase 2 | DM with buttons; waits up to 150 s, then returns `pending`             |
| `wait_for_reply(session, question_id?)`     | Phase 2 | Waits again for one question or anything new                           |
| `create_task`, `claim_task`, `update_task`  | Phase 3 | Structured handoffs between agents, claimed atomically                 |
| `list_agents`, `list_tasks`, `send_message` | Phase 3 | Who's online, what's open, discussion on a task                        |

Phase 3 records follow [A2A](https://a2a-protocol.org/)'s shapes (an agent card
per session; tasks moving `submitted` → `working` → `input-required` →
`completed` / `failed` / `canceled`) while the transport stays MCP, leaving room
for an A2A endpoint later. `input-required` maps directly onto "needs a human".

## Safety rules

Enforced in the broker, not left to agent instructions:

- **Localhost only:** bind `127.0.0.1`; check `Host` and `Origin` on every
  request (DNS-rebinding protection); require a bearer token even on
  localhost. Built on `@modelcontextprotocol/sdk` ≥ 1.24.
- **Identity comes from the connection, not the message.** Each platform has
  its own token and the broker stamps the sender; an agent can't claim to be
  another agent or me.
- **Sender gating:** only my Slack user ID can answer, send to a session or
  press buttons. Everything else is dropped and audited (without its text).
- **Hooks only notify.** They never return allow/deny or block a stop until
  Phase 4, and then only with tests for every path.
- **Minimal hook data:** prompts, transcripts and full tool input stay on the
  machine; only the fields in `src/shared/hook-protocol.ts` are sent.
- **Escaping:** agent text can't trigger `@channel` or disguise links.
- **Loop protection:** per-session and per-platform hourly caps; throttled
  hook pings; at most three open questions per session.
- **Safe timeouts:** an unanswered question expires to the agent's own
  `default_action`; an unanswered approval (Phase 4) falls back to the app,
  never to "allow".
- **Agent messages are data.** From Phase 3, messages between agents carry
  provenance and an untrusted label, and the receiving agent re-authorizes
  any action on its own rules. No agent can approve another's permission
  prompt.
- **Audit everything:** an append-only log of every call, post, answer and
  denial.
- **Secrets** live in user environment variables, never in files; gitleaks
  runs before commit and in CI.

## Phases

| Phase | Scope                                                                                                      | Status      |
| ----- | ---------------------------------------------------------------------------------------------------------- | ----------- |
| 0     | Spikes: MCP, hooks and timeouts on each desktop app                                                        | Done        |
| 1     | Outbound pings: broker, `register`, `notify_human`, hook pings, start at login; verified on all three apps | Done        |
| 2     | I answer from Slack: inbox, `ask_human` with buttons, reminders and expiry, Stop-hook inbox check, digest  | In progress |
| 3     | Cross-platform tasks and handoffs: agent cards, task board, provenance and signing, hop and rate limits    | Planned     |
| 4     | Remote approvals for lower-risk actions via `PermissionRequest`; risky actions stay app-only               | Planned     |
| 5     | CLI agents: Claude Code channels for true push, Codex/Copilot equivalents, optional A2A, OpenTelemetry     | Later       |

## Decisions

| Topic                | Decision                                                                                                                                               |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Primary surface      | Desktop apps for all three platforms; CLI agents later (Phase 5)                                                                                       |
| Build vs adopt       | Build from scratch. Existing buses (Marcus, agmsg, Coral, Agent Room) were references only                                                             |
| Approvals from Slack | Tiered: buttons only for lower-risk actions; pushes, deletes and outward-facing actions are approvable only in the app; unanswered approvals fall back |
| Agent-to-agent scope | Fire-and-forget structured handoffs first; agents blocking on each other only if missed                                                                |
| Ping policy          | DM only when blocked (`urgent`); status to the session thread (`normal`); everything else to the digest (`fyi`). Finished tasks don't DM               |
| Durable state        | SQLite in the broker, not a workflow engine                                                                                                            |

## Risks

- **No push into desktop apps.** An idle session won't see a message until it
  calls a tool or a hook fires.
- **Copilot desktop has no hooks**, so no automatic pings for it; it still
  works through the MCP tools its agent calls.
- **Blocking tools vs timeouts:** `ask_human` returns `pending` well before
  each app's tool timeout.
- **Prompt injection across agents:** guardrails in prompts alone leave most
  agents vulnerable; the broker-side controls carry the weight.
- **Vendor overlap:** native agent teams and Agent HQ may make parts of this
  redundant; keep the broker small.
- Slack's free plan keeps 90 days of history; the SQLite audit log is the
  record.

## Sources

Platform docs:

- [Claude Code channels](https://code.claude.com/docs/en/channels),
  [desktop](https://code.claude.com/docs/en/desktop)
- [Codex hooks](https://developers.openai.com/codex/hooks),
  [Codex config sample](https://developers.openai.com/codex/config-sample)
- [Customize the GitHub Copilot app](https://docs.github.com/en/copilot/how-tos/github-copilot-app/customize-github-copilot-app)
- [Slack Socket Mode](https://docs.slack.dev/apis/events-api/using-socket-mode/),
  [Slack rate limits](https://docs.slack.dev/apis/web-api/rate-limits)

Security and human-in-the-loop:

- [MCP TypeScript SDK DNS-rebinding advisory](https://github.com/modelcontextprotocol/typescript-sdk/security/advisories/GHSA-w48q-cv73-mx4w)
- [CSA: MCP transport trust gap](https://labs.cloudsecurityalliance.org/research/csa-research-note-mcp-transport-trust-gap-20261109-csa-style/)
- [Prompt injection in multi-agent systems (ICML 2026 workshop)](https://icml.cc/virtual/2026/67971)
- [Three attack surfaces in multi-agent communication](https://tianpan.co/blog/2026/04/10/three-attack-surfaces-multi-agent-communication)
- [Human-in-the-loop: when to add an approval gate](https://alejandrorioja.com/human-in-the-loop-ai-agents-when-to-build-an-approval-gate/)
