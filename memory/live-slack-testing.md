---
name: live-slack-testing
description: "How Nick likes live Slack tests of agent-bus run, and how to drive them when this session's agent-bus MCP is down"
type: feedback
---

Live tests with Nick in Slack go one numbered step at a time: say exactly where to tap or reply (which DM or thread, "reply in thread", not the main box), what he should see, then wait for "done"/"sent" and verify in the broker DB and logs before the next step.

- If this session's agent-bus MCP failed at start (ECONNREFUSED), drive the tools with `scripts/mcp-call.ts` (PR #47, 2026-11-19; until it merges, a small SDK client script: `Client` + `StreamableHTTPClientTransport`, `AGENT_BUS_TOKEN_CLAUDE`, `resetTimeoutOnProgress`) and the session's hook-made bus ID from Slack. Say this tests the broker and Slack, not the app's own MCP client.
- Nick is signed in to Slack in Chrome and allowed Claude in Chrome to look at the DM. Look only: never click or type there; his clicks are the test, and clicks from his browser would count as his answers. Exception: when Nick asks in that session to take control (2026-11-19 he did, for a timed reply), a reply sent for him is his answer; confirm the exact text first. That run he replied himself before I needed to.
- Timed checks: poll the DB read-only (`questions` table: `created_at`, `closed_at`, `delivered_at`, `delivered_via`) with a small node script rather than asking Nick for timings; it shows answer and delivery times to the ms.
- Restart the broker only with [[broker-restart]].
- Order matters: with one open question, a reply in the session thread answers it, so test plain thread messages before asking a question.

**Why:** 2026-11-18 Phase 2 live test: Nick asked "tell me what to do"; this order and method passed all four tests cleanly.

**How to apply:** any live agent-bus check (Phase 2 Codex/Copilot runs, PR 3 Stop-hook test). Slack locations: [[slack-workspace-ids]].
