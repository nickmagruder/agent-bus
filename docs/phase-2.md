# Phase 2: I answer from Slack

Status: **in progress** (2026-11-18): PR 1 (inbound Slack and inbox,
[#7](https://github.com/nickmagruder/agent-bus/pull/7)) and PR 2 (questions,
[#8](https://github.com/nickmagruder/agent-bus/pull/8)) merged and tested
live with Slack (see Live results). Next: PR 3 (hooks).

Goal: an agent on any of the three apps can ask me a question and get my
answer from Slack (buttons or free text), and anything I write in a
session's thread reaches that session. Design: [design.md](design.md);
Phase 1: [phase-1.md](phase-1.md).

## What exists to build on

- `BusService` (rules, routing, caps, audit) and `Store` (sessions with
  `slack_channel_id` + `thread_ts`, append-only `events`, persisted `outbox`).
- `SlackConnection.app` (Bolt) is exposed for message and action handlers
  (PR 1 registers the `message` handler).
- `startHeartbeat()` sends `notifications/progress` (or a log message) every
  60 s. Confirmed to reset Claude Code's 300 s idle timer; **untested on
  Codex (300 s) and Copilot (180 s)**.
- `/mcp` is stateless streamable HTTP: one server per request, so a held
  tool call is just an open SSE response. A broker restart drops it.
- Hooks: `SessionStart`, `PermissionRequest`, Claude `Notification`, `Stop`.
  Rule today: hooks never block or decide. Phase 2 changes that **for `Stop`
  only** (see below); `AGENTS.md` and its tests change with it.

## Proposed design

### Data (migrations 3 and 4)

| Table                    | Fields                                                                                                                                                                                                                                         |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `inbox` (v3, PR 1)       | id, session_id, sender (`human`), slack_user, body, slack channel + ts (unique: idempotent on Slack retries), created, delivered_at, delivered_via (`check_inbox`; later `wait_for_reply`/`ask_human`/`stop_hook`)                             |
| `questions` (v4, PR 2)   | id (`q-xxxxxx`), session_id, text, options (JSON, ≤ 5), default_answer, state (`open`/`answered`/`expired`/`canceled`), answer, answered_by, answer_source (`button`/`reply`), slack channel + ts, created, remind_at, expires_at, answered_at |
| `inbox.question_id` (v4) | nullable; set when a reply answers a question                                                                                                                                                                                                  |

Questions got their own migration so PR 2 can shape the table without
editing migration 3.

Every state change also goes to `events`.

### MCP tools

| Tool                                                                 | Behaviour                                                                                                                                                                                                                                                             |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ask_human(session, question, options?, default?, timeout_minutes?)` | Posts the question (with buttons when `options` are given; a free-text reply always works), then holds with heartbeats until answered or the **hold limit**. Returns `{state: "answered", answer}` or `{state: "pending", question_id}`. Counts as `urgent` for caps. |
| `wait_for_reply(session, question_id?, timeout_seconds?)`            | Holds (same limit) for the answer to `question_id`, or for any new inbox message when omitted.                                                                                                                                                                        |
| `check_inbox(session)`                                               | Returns undelivered inbox messages and marks them delivered. Never blocks.                                                                                                                                                                                            |

Replies are returned as `From Nick (verified Slack user)`, with the time and
which question they answer. Only text I typed in Slack is ever labelled as
mine.

### Slack inbound

- Bolt handlers for `message` events (session threads and the DM) and
  `block_actions` (buttons). Ack immediately, then work.
- **Sender gating:** only `SLACK_USER_ID`. Anything else (other users, bots,
  the bot itself, edits, `subtype` messages) is dropped and audited as
  `inbound.dropped`.
- **Routing:**
  - a reply in a session's thread → that session's inbox; if the session has
    exactly one open question, it also answers it;
  - a reply in the thread of a question message → answers that question;
  - a reply under a post a session sent outside its thread (an urgent DM)
    → that session's inbox;
  - a top-level message or an unknown thread → not routed; in my DM the bot
    answers with a hint ("reply in a thread"), at most once an hour.
    Top-level channel messages get no hint, so I can still talk in
    `#agents`.
- **Buttons:** `action_id` carries the question ID; first answer wins
  (compare-and-swap on `state = 'open'`), then `chat.update` replaces the
  buttons with "Answered: X by Nick at 14:02". Late clicks get an ephemeral
  "already answered".
- Reactions on my reply show where it is: 📥 when it's in a session's
  inbox, ✅ when the agent has read it (needs `reactions:write`, already in
  the plan's scopes). A failed reaction is only logged.

### Reminder and timeout

- A scheduler tick (every 30 s) finds questions past `remind_at` (one
  reminder DM) or past `expires_at`.
- On expiry: state `expired`, the question message is edited to "Expired;
  agent took the default: …", and the agent gets `{state: "expired",
default}` from its next `wait_for_reply` / `check_inbox` / Stop hook. Never
  "approve" by default: the default is what the agent said it would do.
- Survives restarts: times are stored, the tick runs on start.

### Stop-hook inbox check (Claude Code, Codex)

- `Stop` asks the broker for undelivered inbox messages. If there are any,
  it prints `{"decision":"block","reason":"…"}` with the messages (labelled
  as mine) and marks them delivered, so the agent keeps going with my reply.
- No messages → today's behaviour ("turn finished" post, throttled).
- Loop guard: at most 6 blocks per session per hour
  (`LIMITS.stopBlocksPerSession`); when `stop_hook_active` is set, block
  only if _new_ messages arrived since the last block (delivered replies are
  never handed over twice). At most 5 replies per block; the rest wait.
- When the agent stops again after our block (`stop_hook_active`, nothing
  new), I get the usual "waiting for you" post; a stop continued by some
  other Stop hook is still ignored.
- Copilot's Stop hook can't run, so its replies are never taken by one.
- Broker down or slow (15 s timeout for `Stop`) → no output, the agent stops
  normally. Replies count as delivered only once the broker has written the
  response; if the hook gave up first, they go back to the inbox
  (`inbox.undelivered`) for the next stop or `check_inbox`. Left: a hook that
  aborts after the response is written but before it reads it
  ([#41](https://github.com/nickmagruder/agent-bus/issues/41)).
- The "waiting for you" post says how many of my replies the agent hasn't
  read yet (e.g. past the cap).

### Daily digest

- Once a day in `#agents`: `fyi` items since the last digest, grouped by
  session; open and expired questions; sessions seen that day.
- Sent on the first tick after the digest time; if the broker was off, it
  sends one catch-up digest at start (never more than one per day).
- Nothing to report → no post.

Built in 0.9.0 ([#23](https://github.com/nickmagruder/agent-bus/issues/23)):

- `fyi` text is stored in `digest_items` (migration 5); before this only an
  audit event without the text was written.
- A slot is today's date once 08:00 local has passed, else the previous
  calendar day (calendar arithmetic: days around DST changes are 23 or 25
  hours long). A slot later than the last `digest.done` slot is due, so a
  tick every 5 minutes posts the daily digest and the tick at broker start
  catches up a missed one. Slots only move forward: each is posted at most
  once, and a clock set back never re-posts an older one. Local time comes
  from the machine's zone.
- Covers everything since the previous digest (the first one ever: 24
  hours). Sections go in order of importance: questions, then `fyi` items,
  then sessions seen. The post stops at the first line that doesn't fit in
  about 3,500 characters and ends with "not shown: N fyi items, M sessions",
  so a section never shows gaps or a heading without its body. Items are
  marked digested even when cut, so nothing piles up.
- `fyi` previews are the first two lines, clipped to 300 characters, with
  code fences dropped and a lone backtick removed.
- An empty slot is still recorded, so an `fyi` at 09:00 waits for tomorrow.

Merged PRs, built in 0.10.0 ([#24](https://github.com/nickmagruder/agent-bus/issues/24)):
agents merge clankers PRs without my review, so the digest lists them right
after questions. `AGENT_BUS_DIGEST_REPOS` names the repos (nothing private
is hardcoded in this public repo); `src/broker/github.ts` reads
`GET /repos/{repo}/pulls?state=closed&sort=updated` (up to 3 pages of 50)
and keeps PRs merged into the default branch since the last digest. No
token is needed for public repos (one call a day fits the anonymous limit);
`AGENT_BUS_GITHUB_TOKEN`, a read-only fine-grained token, covers private
ones. `gh` isn't used: it would lend the broker a full-scope token.

Details settled in review:

- **Window:** each `digest.done` records `until`, the time taken _before_
  its GitHub call, and the next digest starts there, so a PR merged during
  the call isn't lost between two digests. GitHub's times have no
  milliseconds, so the start is compared to the second.
- **Links:** a PR is listed only if its link is exactly
  `https://github.com/{repo}/pull/{number}`, compared without regard to case
  (GitHub answers in the repo's canonical case). Anything else is dropped
  and logged with a count.
- **Agent:** only real markers count: Claude Code's "Generated with
  [Claude Code]" footer, the Codex cloud task link, or the Copilot coding
  agent's own account. A PR that merely mentions Codex or Copilot isn't
  attributed to them.
- **Limits:** if 3 pages don't reach back to the window start, the digest
  says older merged PRs weren't listed, and the broker logs it. A PR seen on
  two pages is listed once. 403 and 429 log a rate-limit hint, and an
  anonymous 404 logs a token hint. A repo that fails is skipped and logged.
- Repo names must be `owner/name`: no `.` or `..` names, and no owner
  starting or ending with `-`.

### Sign-in race

Most of the ~40 s is Node starting under sign-in load, so making the broker
start faster is uncertain work. The cost of the race is (a) a manual MCP
reconnect and (b) the first session missing its bus ID. Proposal: fix (b)
only, with a `UserPromptSubmit` hook that injects the bus ID when the
session hasn't received one yet (both apps support context from that event),
and leave (a) to the app's reconnect (decided below).

Built in 0.8.0 ([#22](https://github.com/nickmagruder/agent-bus/issues/22)):
each prompt re-adds the bus ID until the broker can tell the agent has it,
counted since the last `SessionStart` it saw:

- the agent used the ID in an MCP call (`session.used`, recorded once), or
- a response carrying it was written within 1 s of the request
  (`hook.context_delivered` with `fast: yes`), well inside the hook's 2 s
  wait, or
- 3 slower responses were written (one surely got through).

A written response alone isn't proof: `finish` fires when the response is
handed to the OS, even if the hook has already timed out (found in review).
`SessionStart` always adds the ID, since after `/clear` or compaction the
agent has lost it.

Known limit: if a `/clear` or compaction `SessionStart` misses the broker
(down or restarting), the broker can't know the agent lost its ID, so
prompts stay quiet. The agent can still call `register` for a new ID.
Context from `UserPromptSubmit` is not verified live on either app yet
([#25](https://github.com/nickmagruder/agent-bus/issues/25)).

## Decisions

| Topic                                         | Decision                                                                                                                                                              |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hold limit for `ask_human` / `wait_for_reply` | **150 s on every app**, then `pending`; the agent calls `wait_for_reply` again. Raise per platform once Codex and Copilot are shown to honour progress notifications. |
| Where questions are posted                    | **DM** with the buttons (sound, phone), plus a one-line pointer in the session thread. A reply in the DM message's thread or in the session thread answers it.        |
| Reminder and expiry defaults                  | **Remind at 15 min, expire at 60 min**; an agent may pass its own timeout (capped).                                                                                   |
| Digest time                                   | **08:00 local** in `#agents`, covering the previous day; one catch-up at broker start if missed.                                                                      |
| Sign-in race                                  | **`UserPromptSubmit` hook** injects the bus ID on the first prompt when `SessionStart` missed it; the MCP reconnect stays manual.                                     |
| Hooks that block                              | **`Stop` may block** (`decision: block`) to deliver my Slack replies, with tests for every path. `PermissionRequest` still never decides (Phase 4).                   |
| Delivery                                      | Feature branch with a few PRs (below), plus a clankers PR. Commit and open PRs only when asked.                                                                       |

## Work

### PR 1: inbound Slack and inbox

- [x] Check the Slack app (Nick): Interactivity on; event subscriptions
      `message.channels`, `message.im` (and `message.groups` if a project
      channel is private); `reactions:write` scope (all shown working live,
      2026-11-18)
- [x] Migration 3: `inbox` (questions move to migration 4 in PR 2)
- [x] Bolt `message` handler (`src/broker/slack/inbound.ts`) and routing
      (`src/broker/inbox.ts`): sender gating, thread → session and DM-post →
      session routing, idempotent on Slack retries, 📥/✅ reactions, DM hint,
      audit
- [x] `check_inbox` tool (owning platform only; pages of 20)
- [x] Tests: gating (other user, bot, bot with my user ID, subtypes, edits,
      empty), routing (thread, DM post, other channel, top-level, thread
      root), retries, long messages, files, hint throttle, ownership of
      `check_inbox` end to end
- [x] Live: a reply in a session thread reaches `check_inbox` (2026-11-18,
      see Live results)

### PR 2: questions

- [x] `ask_human`, `wait_for_reply` with heartbeats and the hold limit;
      `pending` return. `default_action` is required. A question counts as
      an urgent notification for the caps; at most 3 open per session
- [x] Migration 4: `questions`, `inbox.question_id`, `outbox.blocks`; a reply
      under a question's DM or its reminder (or in the session thread with
      one open question) answers it
- [x] Block Kit question DM with buttons; `block_actions` handler (gating,
      compare-and-swap, `chat.update`, ephemeral reply to late or foreign
      clicks); a question DM still queued is rewritten instead of edited
- [x] Scheduler (`Questions.tick`, every 30 s and at start): one reminder
      DM, expiry to the agent's default, message edits
- [x] Outcomes reach the agent once, through `ask_human`, `wait_for_reply`
      or `check_inbox`; the answering reply gets ✅ when delivered
- [x] Tests: answered by button / reply / reminder reply / expired; double
      click; late click; foreign click; Slack retry of an answering reply;
      caps and open limit; v2 and v3 upgrades; nested transactions; end to
      end over `/mcp` (pending → `wait_for_reply`, answer during the hold,
      ownership, message during `wait_for_reply`)
- [ ] Not tested: a broker restart during a held call, and a client
      disconnect mid-hold: [#26](https://github.com/nickmagruder/agent-bus/issues/26)
- [x] Live: answered by button from the phone and by thread reply; left
      to remind and expire (2026-11-18, see Live results)

### Remaining work (GitHub issues)

From 2026-11-18, status lives in the
[Phase 2 milestone](https://github.com/nickmagruder/agent-bus/milestone/3);
this doc keeps the design, decisions and live results.

- PR 3, hooks: [#21](https://github.com/nickmagruder/agent-bus/issues/21)
  Stop-hook inbox check (0.7.0), [#22](https://github.com/nickmagruder/agent-bus/issues/22)
  `UserPromptSubmit` bus-ID injection (0.8.0)
- PR 4: [#23](https://github.com/nickmagruder/agent-bus/issues/23) daily
  digest (0.9.0), [#24](https://github.com/nickmagruder/agent-bus/issues/24) clankers
  PRs in the digest (0.10.0)
- clankers PR: [#32](https://github.com/nickmagruder/agent-bus/issues/32)
- Verify on each app: [#25](https://github.com/nickmagruder/agent-bus/issues/25)
- Test gap from PR 2: [#26](https://github.com/nickmagruder/agent-bus/issues/26)
- Follow-ups: [#27](https://github.com/nickmagruder/agent-bus/issues/27)
  quieter approval DMs, [#28](https://github.com/nickmagruder/agent-bus/issues/28)
  grace period before approval DMs,
  [#29](https://github.com/nickmagruder/agent-bus/issues/29) reminder DM
  styling, [#30](https://github.com/nickmagruder/agent-bus/issues/30)
  live-test MCP client

Shipped: PR 1 [#7](https://github.com/nickmagruder/agent-bus/pull/7)
([#18](https://github.com/nickmagruder/agent-bus/issues/18)), PR 2
[#8](https://github.com/nickmagruder/agent-bus/pull/8)
([#19](https://github.com/nickmagruder/agent-bus/issues/19)).

## Live results

### Broker 0.6.0 with Slack, driven by an MCP client script (2026-11-18)

The Claude session's own agent-bus MCP connection was down (ECONNREFUSED
since the session started), so the tools were called by a small MCP client
using `AGENT_BUS_TOKEN_CLAUDE` and the session's real bus ID
(`claude/agent-bus/43b2`, created by its `Stop` hook). This exercises the
broker, Slack and my phone, but **not the Claude app's own MCP client**.
That client is now `scripts/mcp-call.ts`
([#30](https://github.com/nickmagruder/agent-bus/issues/30)); see the
README's "Calling a tool by hand".

| Test                                   | Result                                                                                                                                                                                      |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Button answer from the phone        | ✅ `ask_human` returned `answered` / "It works" / `button` after 113 s; one heartbeat at 60 s; DM edited to "Answered (button): It works", buttons gone                                     |
| 2. Text reply in the question's thread | ✅ `ask_human` returned `pending` at 150 s (heartbeats at 60 and 120 s); my thread reply answered `q-92b0d7` as `reply`; `wait_for_reply(question_id)` returned it at once                  |
| 3. Plain reply in the session thread   | ✅ routed from `#agents` to the session; `check_inbox` returned it labelled as mine; no reaction errors logged                                                                              |
| 4. Unanswered question (5 min timeout) | ✅ one reminder DM at 2½ min; expired at 5 min; DM edited to "Expired …: the agent went with …"; a waiting `wait_for_reply` (no ID) woke 9 s later with the expired outcome and the default |
| Echoes of the bot's own edits          | ✅ arrive as `message_changed` and are dropped (`inbound.dropped`, reason `subtype`)                                                                                                        |
| Slack app settings                     | ✅ Interactivity, `message.im`, `message.channels` and `reactions:write` all work                                                                                                           |

Findings:

- **Approval DMs flood a testing session.** Every permission prompt
  (Bash, PowerShell, each Claude in Chrome action) sends a 🚨 DM, throttled
  to one per 2 minutes. Fine for real blocks, noisy for read-only tools.
- The reminder DM is posted under the bot's own name and icon, not the
  agent's (`style()` isn't applied to it); cosmetic. Fixed in 0.10.1
  ([#29](https://github.com/nickmagruder/agent-bus/issues/29)).
- Not yet covered live: Codex and Copilot (heartbeats past 300 s / 180 s),
  the Claude app's own MCP client, a foreign user's or bot's reply, the
  top-level DM hint.
